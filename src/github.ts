import * as T from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { getOctokit } from '@actions/github';
import type { Inputs } from './inputs.js';
import type { MergeMode, MergeStrategy } from './config.ts';

const handleErrorReason = (reason: unknown) => new Error(String(reason));

const removeAtMark = (input: string) => input.replace(/^@/, '');

const parseRepositoryName = (
  name: string,
): T.Either<Error, [owner: string, repo: string, branch: string | undefined]> => {
  const [fullName = '', branch] = name.split('@');
  const [owner, repo] = fullName.split('/');

  if (!owner || !repo) {
    return T.left(new Error(`Repository name must be in the "owner/repo" format. ("${name}" is an invalid format)`));
  }
  return T.right([owner, repo, branch]);
};

export type Repository = {
  default_branch: string;
};

export type PullRequest = {
  number: number;
  base: {
    sha: string;
  };
  head: {
    sha: string;
  };
  html_url: string;
};

export type Branch = {
  name: string;
  sha: string;
};

export type Commit = {
  message: string;
  sha: string;
};

export type CommitFileMode = '100644' | '100755' | '040000' | '160000' | '120000';

export type CommitFile = {
  path: string;
  mode?: CommitFileMode;
  content?: string;
  sha?: string | null; // null means delete the file
};

export type CommitDiffEntry = {
  filename: string;
};

export type GitHubRepositoryCommitParams = {
  parent: string;
  branch: string;
  files: CommitFile[];
  message: string;
  force: boolean;
};

export type GitHubRepositoryCreateOrUpdatePullRequestParams = {
  title: string;
  body: string;
  number?: number | null;
  branch: string;
};

export type GitHubRepositoryMergePullRequestParams = {
  number: number;
  mode: MergeMode;
  strategy: MergeStrategy;
  commitHeadline: string | null;
  commitBody: string | null;
};

export enum MergeResult {
  Unmergeable = 'The pull request cannot currently be merged.',
  AlreadyHandled = 'The pull request is already merged or set to auto-merge.',
  Prepared = 'The pull request was set to auto-merge.',
  Merged = 'The pull request was merged.',
}

export type TreeEntry = {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  mode: string;
};

export type GitHubRepository = {
  owner: string;
  name: string;
  createBranch: (name: string) => TE.TaskEither<Error, Branch>;
  deleteBranch: (name: string) => TE.TaskEither<Error, void>;
  commit: (params: GitHubRepositoryCommitParams) => TE.TaskEither<Error, Commit>;
  compareCommits: (base: string, head: string) => TE.TaskEither<Error, CommitDiffEntry[]>;
  getTreeFiles: (sha: string, paths?: string[]) => TE.TaskEither<Error, TreeEntry[]>;
  findExistingPullRequestByBranch: (branch: string) => TE.TaskEither<Error, PullRequest | null>;
  closePullRequest: (number: number) => TE.TaskEither<Error, void>;
  createOrUpdatePullRequest: (
    params: GitHubRepositoryCreateOrUpdatePullRequestParams,
  ) => TE.TaskEither<Error, PullRequest>;
  mergePullRequest: (params: GitHubRepositoryMergePullRequestParams) => TE.TaskEither<Error, MergeResult>;
  addPullRequestLabels: (number: number, labels: string[]) => TE.TaskEither<Error, void>;
  addPullRequestReviewers: (number: number, reviewers: string[]) => TE.TaskEither<Error, void>;
  addPullRequestAssignees: (number: number, assignees: string[]) => TE.TaskEither<Error, void>;
};

type CreateGitHubRepositoryParams = {
  octokit: ReturnType<typeof getOctokit>;
  name: string;
};

type GraphPullRequest = {
  id: string;
  isInMergeQueue: boolean;
  isMergeQueueEnabled: boolean;
  isDraft: boolean;
  state: string;
  mergeStateStatus: string;
  merged: boolean;
  headRefName: string;
  autoMergeRequest?: {
    mergeMethod: string;
  };
};

type GraphPullRequestMergeInput = {
  //authorEmail?: string; Probably should always be token's email
  //clientMutationId?: string; Unused GraphQL mechanic
  commitBody?: string;
  commitHeadline?: string;
  //expectedHeadOid?: string; Not needed, head is managed by this action
  mergeMethod?: string;
  pullRequestId: string;
};

const createGitHubRepository = TE.tryCatchK<Error, [CreateGitHubRepositoryParams], GitHubRepository>(
  async ({ octokit, name }) => {
    const parsed = parseRepositoryName(name);
    if (T.isLeft(parsed)) {
      throw parsed.left;
    }

    const defaults = {
      owner: parsed.right[0],
      repo: parsed.right[1],
    };

    console.log(`Debug - Getting repository info for: ${defaults.owner}/${defaults.repo}`);
    const { data: repo } = await octokit.rest.repos.get(defaults);
    const targetBranch = parsed.right[2] ?? repo.default_branch;
    console.log(`Debug - Repository info: default_branch=${repo.default_branch}, target_branch=${targetBranch}`);

    //--- MERGE SUPPORT START ---
    const getGraphPullRequest = async (number: number): Promise<GraphPullRequest> => {
      const {
        repository: { pullRequest: pr },
      } = await octokit.graphql<{ repository: { pullRequest: GraphPullRequest } }>(
        `
          query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                id
                isInMergeQueue
                isMergeQueueEnabled
                isDraft
                state
                mergeStateStatus
                merged
                headRefName
                autoMergeRequest {
                  mergeMethod
                }
              }
            }
          }
        `,
        {
          ...defaults,
          number,
        },
      );
      return pr;
    };

    const coerceMergeMode = (mode: MergeMode, gpr: GraphPullRequest): MergeMode => {
      // Must use auto for merge queue, unless bypassing
      if (gpr.isMergeQueueEnabled && mode !== 'admin') return 'auto';

      // Always immediate merge if possible
      const status = gpr.mergeStateStatus;
      if (status == 'CLEAN' || status == 'HAS_HOOKS' || status == 'UNSTABLE') return 'immediate';

      // Fall back to request
      return mode;
    };

    const disablePullRequestAutoMerge = async (id: string) => {
      await octokit.graphql(
        `
          mutation($id: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }
        `,
        {
          id,
        },
      );
    };

    const canMergePr = (gpr: GraphPullRequest, mode: MergeMode): boolean => {
      if (gpr.state !== 'OPEN') return false;
      if (mode === 'auto') return true;

      const blocked = gpr.mergeStateStatus === 'BLOCKED' && mode !== 'admin';
      const behind = gpr.mergeStateStatus === 'BEHIND' && mode !== 'admin';
      const dirty = gpr.mergeStateStatus === 'DIRTY';

      return !gpr.isDraft && !blocked && !behind && !dirty;
    };

    const enableGraphPullRequestAutoMerge = async (gprmi: GraphPullRequestMergeInput) => {
      await octokit.graphql(
        `
          mutation($input: EnablePullRequestAutoMergeInput!) {
            enablePullRequestAutoMerge(input: $input) {
              clientMutationId
            }
          }
        `,
        {
          input: {
            ...gprmi,
          },
        },
      );
    };

    const mergeGraphPullRequest = async (gprmi: GraphPullRequestMergeInput) => {
      await octokit.graphql(
        `
          mutation($input: MergePullRequestInput!) {
            mergePullRequest(input: $input) {
              clientMutationId
            }
          }
        `,
        {
          input: {
            ...gprmi,
          },
        },
      );
    };
    //--- MERGE SUPPORT END ---

    return {
      owner: defaults.owner,
      name: defaults.repo,

      createBranch: TE.tryCatchK(async (name) => {
        // get base branch
        const { data: base } = await octokit.rest.git.getRef({
          ...defaults,
          ref: `heads/${targetBranch}`,
        });

        // update exisiting branch
        const updated = await TE.tryCatch(async () => {
          const { data } = await octokit.rest.git.updateRef({
            ...defaults,
            ref: `heads/${name}`,
            sha: base.object.sha,
            force: true,
          });
          return data;
        }, handleErrorReason)();

        if (T.isRight(updated)) {
          return {
            name,
            sha: updated.right.object.sha,
          };
        }

        // create branch
        const { data: ref } = await octokit.rest.git.createRef({
          ...defaults,
          ref: `refs/heads/${name}`,
          sha: base.object.sha,
        });

        return {
          name,
          sha: ref.object.sha,
        };
      }, handleErrorReason),

      deleteBranch: TE.tryCatchK(async (name) => {
        await octokit.rest.git.deleteRef({
          ...defaults,
          ref: `heads/${name}`,
        });
      }, handleErrorReason),

      commit: TE.tryCatchK(async ({ parent, branch, files, message, force }) => {
        // create tree
        const treeEntries = files.map((file) => {
          if (file.sha === null) {
            // Delete file - GitHub API needs path, mode, type, and sha: null
            console.log(`Debug - Delete entry: path="${file.path}", mode="${file.mode}", type="blob", sha=null`);
            return {
              path: file.path,
              mode: file.mode!,
              type: 'blob' as const,
              sha: null,
            };
          } else {
            // Add/modify file
            console.log(`Debug - Add/modify entry: path="${file.path}", mode="${file.mode}"`);
            return {
              path: file.path,
              mode: file.mode!,
              content: file.content!,
            };
          }
        });

        console.log(`Debug - About to create tree with ${treeEntries.length} entries, base_tree: ${parent}`);
        console.log(`Debug - Tree entries:`, JSON.stringify(treeEntries, null, 2));

        // Check if we're creating an empty tree (all deletions)
        const hasNonDeletionEntries = treeEntries.some((entry) => entry.sha !== null);
        if (!hasNonDeletionEntries && treeEntries.length > 0) {
          console.log(`Debug - WARNING: All entries are deletions, this might create an empty tree`);
        }

        const { data: tree } = await octokit.rest.git.createTree({
          ...defaults,
          base_tree: parent,
          tree: treeEntries,
        });

        // commit
        const { data: commit } = await octokit.rest.git.createCommit({
          ...defaults,
          tree: tree.sha,
          message,
          parents: [parent],
        });

        // apply to branch
        await octokit.rest.git.updateRef({
          ...defaults,
          ref: `heads/${branch}`,
          sha: commit.sha,
          force,
        });

        return commit;
      }, handleErrorReason),

      compareCommits: TE.tryCatchK(async (base, head) => {
        const { data: diff } = await octokit.rest.repos.compareCommits({
          ...defaults,
          base,
          head,
        });

        return diff.files!;
      }, handleErrorReason),

      getTreeFiles: TE.tryCatchK(async (sha, paths) => {
        const { data: tree } = await octokit.rest.git.getTree({
          ...defaults,
          tree_sha: sha,
          recursive: 'true',
        });

        let files = tree.tree
          .filter((item) => item.type === 'blob')
          .map((item) => ({
            path: item.path!,
            type: 'blob' as const,
            sha: item.sha!,
            mode: item.mode!,
          }));

        // Filter by paths if provided
        if (paths && paths.length > 0) {
          files = files.filter((file) => paths.some((p) => file.path.startsWith(p)));
        }

        return files;
      }, handleErrorReason),

      findExistingPullRequestByBranch: TE.tryCatchK(async (branch) => {
        const { data: prs } = await octokit.rest.pulls.list({
          ...defaults,
          state: 'open',
          head: `${defaults.owner}:${branch}`,
        });

        return prs[0] ?? null;
      }, handleErrorReason),

      closePullRequest: TE.tryCatchK(async (number) => {
        await octokit.rest.pulls.update({
          ...defaults,
          pull_number: number,
          state: 'closed',
        });
      }, handleErrorReason),

      createOrUpdatePullRequest: TE.tryCatchK(async ({ title, body, number, branch }) => {
        if (number !== null && number !== undefined) {
          const { data } = await octokit.rest.pulls.update({
            ...defaults,
            base: targetBranch,
            pull_number: number,
            title,
            body,
          });
          return data;
        } else {
          const { data } = await octokit.rest.pulls.create({
            ...defaults,
            base: targetBranch,
            head: branch,
            title,
            body,
          });
          return data;
        }
      }, handleErrorReason),

      mergePullRequest: TE.tryCatchK(async ({ number, mode, strategy, commitHeadline, commitBody }) => {
        // Get GraphQl version of PR, as REST version isn't as complete
        const gpr = await getGraphPullRequest(number);

        // Handle pre-merge checks
        if (gpr.isInMergeQueue || gpr.merged) return MergeResult.AlreadyHandled;

        mode = coerceMergeMode(mode, gpr);
        if (gpr.autoMergeRequest) {
          if (mode === 'auto') {
            return MergeResult.AlreadyHandled; // Already set to auto
          } else {
            await disablePullRequestAutoMerge(gpr.id);
          }
        }

        if (!canMergePr(gpr, mode)) return MergeResult.Unmergeable;

        // Merge/Setup auto-merge
        const mergeInputs: GraphPullRequestMergeInput = {
          ...(commitBody && { commitBody }),
          ...(commitHeadline && { commitHeadline }),
          mergeMethod: strategy.toUpperCase(),
          pullRequestId: gpr.id,
        };

        if (mode == 'auto') {
          await enableGraphPullRequestAutoMerge(mergeInputs);
          return MergeResult.Prepared;
        } else {
          await mergeGraphPullRequest(mergeInputs);
          return MergeResult.Merged;
        }
      }, handleErrorReason),

      addPullRequestLabels: TE.tryCatchK(async (number, labels) => {
        await octokit.rest.issues.addLabels({
          ...defaults,
          issue_number: number,
          labels,
        });
      }, handleErrorReason),

      addPullRequestReviewers: TE.tryCatchK(async (number, original) => {
        const [reviewers, team_reviewers] = original.reduce<[string[], string[]]>(
          (acc, cur) => {
            const match = cur.match(/^team:(.+)$/);
            if (match !== null) {
              acc[1].push(removeAtMark(match[1]!));
            } else {
              acc[0].push(removeAtMark(cur));
            }
            return acc;
          },
          [[], []],
        );

        await octokit.rest.pulls.requestReviewers({
          ...defaults,
          pull_number: number,
          reviewers,
          team_reviewers,
        });
      }, handleErrorReason),

      addPullRequestAssignees: TE.tryCatchK(async (number, assignees) => {
        await octokit.rest.issues.addAssignees({
          ...defaults,
          issue_number: number,
          assignees: assignees.map((a) => removeAtMark(a)),
        });
      }, handleErrorReason),
    };
  },
  handleErrorReason,
);

export type GitHub = {
  initializeRepository: (name: string) => TE.TaskEither<Error, GitHubRepository>;
};

export const createGitHub = (inputs: Inputs): GitHub => {
  const octokit = getOctokit(inputs.github_token, {
    baseUrl: inputs.github_api_url,
  });

  return {
    initializeRepository: TE.tryCatchK(async (name) => {
      const repo = await createGitHubRepository({
        octokit,
        name,
      })();
      if (T.isLeft(repo)) {
        throw repo.left;
      }
      return repo.right;
    }, handleErrorReason),
  };
};
