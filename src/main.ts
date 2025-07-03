import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as core from '@actions/core';
import { render } from 'ejs';
import glob from 'fast-glob';
import * as A from 'fp-ts/Array';
import * as T from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import mm from 'micromatch';
import { loadConfig } from './config.js';
import {
  GH_REPOSITORY,
  GH_RUN_ID,
  GH_RUN_NUMBER,
  GH_SERVER,
  GH_WORKFLOW,
  PR_FOOTER,
  defaultEntryConfig,
  defaultFile,
} from './constants.js';
import { createGitHub, MergeResult } from './github.js';
import { getInputs } from './inputs.js';
import { convertValidBranchName, merge, splitCommitMessage } from './utils.js';

const json = (input: unknown) => JSON.stringify(input, null, '  ');
const info = (key: string, value: string) => core.info(`${key.padStart(21)}: ${value}`);

const run = async (): Promise<number> => {
  const cwd = process.cwd();

  const inputs = getInputs();
  const github = createGitHub(inputs);

  // Function to get PR info for a specific file
  const getPrInfoForFile = async (filePath: string): Promise<{ title: string; number: number } | null> => {
    try {
      const sourceRepo = await github.initializeRepository(GH_REPOSITORY)();
      if (T.isRight(sourceRepo)) {
        // Get the last commit that modified this file
        const lastCommit = await sourceRepo.right.getLastCommitForFile(filePath)();
        if (T.isRight(lastCommit) && lastCommit.right) {
          // Find PRs that contain this commit
          const prs = await sourceRepo.right.findPullRequestsByCommit(lastCommit.right.sha)();
          if (T.isRight(prs) && prs.right.length > 0) {
            // Use the first (most recent) PR
            const pr = prs.right[0];
            if (pr) {
              return {
                title: pr.title,
                number: pr.number,
              };
            }
          }
        }
      }
    } catch (e) {
      core.debug(`Could not get PR info for file ${filePath}: ${e}`);
    }
    return null;
  };

  const config = await loadConfig(inputs.config_file)();
  if (T.isLeft(config)) {
    core.setFailed(`Load config error: ${inputs.config_file}#${config.left.message}`);
    return 1;
  }
  core.debug(`config: ${json(config.right)}`);

  const settings = config.right.settings;
  const prUrls = new Set<string>();
  const syncedFiles = new Set<string>();

  for (const [i, entry] of config.right.patterns.entries()) {
    core.info('	');

    const cfg = merge(
      defaultEntryConfig,
      merge(
        {
          commit: settings?.commit ?? {},
          branch: settings?.branch ?? {},
          pull_request: settings?.pull_request ?? {},
        },
        {
          commit: entry.commit ?? {},
          branch: entry.branch ?? {},
          pull_request: entry.pull_request ?? {},
        },
      ),
    );

    core.debug(`patterns.${i} - merged config: ${json(cfg)}`);

    // Resolve files and collect all configured paths
    const allConfiguredPaths = new Set<string>();
    const excludedPaths = new Set<string>();

    // First, collect all configured file paths (whether they exist or not) and excluded paths
    for (const f of entry.files) {
      const file = typeof f === 'string' ? { from: f, to: f, exclude: [] } : { ...f, exclude: f.exclude ?? [] };

      try {
        const filepath = path.resolve(cwd, file.from);
        const stat = await fs.stat(filepath);

        if (stat.isDirectory()) {
          const list = await glob('**/*', {
            absolute: false,
            onlyFiles: true,
            cwd: path.join(cwd, file.from),
          });

          // Add all files to configured paths
          for (const p of list) {
            allConfiguredPaths.add(path.join(file.to, p));
          }

          // Collect excluded files
          if (file.exclude.length > 0) {
            for (const p of list) {
              const fromPath = path.join(file.from, p);
              const toPath = path.join(file.to, p);
              // Check if this file matches any exclude pattern
              if (file.exclude.some((e) => mm.isMatch(fromPath, path.join(file.from, e)))) {
                excludedPaths.add(toPath);
                core.info(`Excluded file will be deleted if exists in target: ${toPath}`);
              }
            }
          }
        } else {
          allConfiguredPaths.add(file.to);
          // For single files, exclude is ignored (but we still track it)
        }
      } catch {
        // File/directory doesn't exist locally, but it's still a configured path
        allConfiguredPaths.add(file.to);
      }
    }

    // Then resolve only existing files
    const files = await pipe(
      entry.files.map((f, j) => {
        const id = `patterns.${i}.files.${j}`;

        return TE.tryCatch(
          async () => {
            const file =
              typeof f === 'string'
                ? {
                    ...defaultFile,
                    from: f,
                    to: f,
                  }
                : {
                    ...f,
                    exclude: f.exclude ?? defaultFile.exclude,
                  };

            const filepath = path.resolve(cwd, file.from);

            // Check if file/directory exists
            let stat;
            try {
              stat = await fs.stat(filepath);
            } catch {
              // File doesn't exist, return empty array
              core.info(
                `${id} - File/directory "${file.from}" doesn't exist, will be deleted from target repositories`,
              );
              return [];
            }

            let paths: [from: string, to: string][];

            if (stat.isDirectory()) {
              const list = await glob('**/*', {
                absolute: false,
                onlyFiles: true,
                cwd: path.join(cwd, file.from),
              });
              paths = list.map((p) => [path.join(file.from, p), path.join(file.to, p)]);
              if (file.exclude.length > 0) {
                paths = paths.filter(([from]) => file.exclude.every((e) => !mm.isMatch(from, path.join(file.from, e))));
              }
            } else {
              paths = [[file.from, file.to]];
              if (file.exclude.length > 0) {
                core.warning(`${id} - "exclude" specified for "${file.from}" was ignored because it is a single file.`);
              }
            }

            return await Promise.all(
              paths.map(async ([from, to]) => {
                const fpath = path.join(cwd, from);
                const raw = await fs.readFile(fpath, 'utf8');
                const stat = await fs.stat(fpath);
                const mode = (stat.mode & fs.constants.S_IXUSR) !== 0 ? '100755' : '100644';
                const content = entry.template !== undefined ? render(raw, entry.template) : raw;
                return {
                  from,
                  to,
                  mode,
                  content,
                } as const;
              }),
            );
          },
          (reason) => new Error(`${id} - File resolve error: ${reason}`),
        );
      }),
      A.sequence(TE.ApplicativePar),
      TE.map(A.flatten),
    )();

    if (T.isLeft(files)) {
      core.setFailed(files.left.message);
      return 1;
    }

    core.debug(`patterns.${i} - files:`);
    for (const file of files.right) {
      core.debug(`  - from "${file.from}" to "${file.to}"`);
    }

    // Commit to repository
    core.info(`Synchronize ${files.right.length} files:`);

    for (const name of entry.repositories) {
      core.info('	');

      const id = `patterns.${i} ${name}`;

      core.info(`Initializing repository: ${name}`);
      const repository = await github.initializeRepository(name)();
      if (T.isLeft(repository)) {
        core.setFailed(`${id} - Repository initializing error: ${repository.left.message}`);
        return 1;
      }

      const repo = repository.right;

      const branch = render(cfg.branch.format, {
        prefix: cfg.branch.prefix,
        repository: convertValidBranchName(GH_REPOSITORY),
        index: i,
      });

      info('Repository', name);
      info('Branch', branch);

      // Find existing PR
      const existingPr = await repo.findExistingPullRequestByBranch(branch)();
      if (T.isLeft(existingPr)) {
        core.setFailed(`${id} - Find existing pull request error: ${existingPr.left.message}`);
        return 1;
      }
      core.debug(`existing pull request: ${json(existingPr.right)}`);

      // Get parent SHA
      let parent: string;
      if (existingPr.right !== null) {
        if (cfg.pull_request.force) {
          parent = existingPr.right.base.sha;
        } else {
          parent = existingPr.right.head.sha;
        }
        info('Existing Pull Request', existingPr.right.html_url);
      } else {
        const b = await repo.createBranch(branch)();
        if (T.isLeft(b)) {
          core.setFailed(`${id} - Create branch error: ${b.left.message}`);
          return 1;
        }
        parent = b.right.sha;
      }
      info('Branch SHA', parent);

      // Get existing files in the target repository for deletion detection
      const syncPaths = files.right.map((f) => f.to);
      const allConfiguredPathsArray = Array.from(allConfiguredPaths);
      const uniquePaths = [
        ...new Set(
          allConfiguredPathsArray.map((p) => {
            const dir = path.dirname(p);
            return dir === '.' ? '' : dir;
          }),
        ),
      ];

      let filesToDelete: { path: string; sha: string; mode: string }[] = [];

      // Only check for files to delete if we have configured paths to manage
      if (allConfiguredPathsArray.length > 0) {
        // Get all existing files if we need to check root directory, otherwise filter by paths
        const hasRootFiles = uniquePaths.includes('');
        const nonRootPaths = uniquePaths.filter((p) => p !== '');
        const pathsToCheck = hasRootFiles ? undefined : nonRootPaths.length > 0 ? nonRootPaths : undefined;

        core.info(
          `Getting existing files from tree SHA: ${parent}, paths: ${pathsToCheck ? pathsToCheck.join(', ') : 'all'}`,
        );
        const existingFiles = await repo.getTreeFiles(parent, pathsToCheck)();
        if (T.isLeft(existingFiles)) {
          core.setFailed(`${id} - Get existing files error: ${existingFiles.left.message}`);
          return 1;
        }
        core.info(`Found ${existingFiles.right.length} existing files in target repository`);
        for (const existingFile of existingFiles.right) {
          core.info(`  - Existing file: ${existingFile.path} (mode: ${existingFile.mode})`);
        }

        if (excludedPaths.size > 0) {
          core.info(`Excluded paths that will be deleted if found: ${Array.from(excludedPaths).join(', ')}`);
        }

        // Determine files to delete
        const currentSyncFilePaths = new Set(files.right.map((f) => f.to));
        filesToDelete = existingFiles.right.filter((file) => {
          // Check if this file is explicitly excluded (should be deleted)
          if (excludedPaths.has(file.path)) {
            core.info(`File marked for deletion (excluded): ${file.path}`);
            return true;
          }

          // Check if this existing file should be managed by this sync pattern
          const isInSyncScope = uniquePaths.some((p) => {
            if (p === '') {
              // Root directory: only check files directly in root (no subdirectories)
              return !file.path.includes('/');
            } else {
              // Subdirectory: check if file is in this directory
              return file.path.startsWith(p + '/') || file.path === p;
            }
          });

          // File should be deleted if it's in scope but not in the current sync list
          return isInSyncScope && !currentSyncFilePaths.has(file.path);
        });
      }

      // Prepare files for commit (additions/modifications + deletions)
      const commitFiles = [
        ...files.right.map((file) => ({
          path: file.to,
          mode: file.mode,
          content: file.content,
        })),
        ...filesToDelete.map((file) => ({
          path: file.path,
          mode: file.mode as any, // mode is required even for deletions
          sha: null as string | null, // null means delete
        })),
      ];

      // Skip commit if no files to sync and no files to delete
      if (commitFiles.length === 0) {
        info('Status', 'No files to sync, skipping commit');

        // If there's an existing PR, close it and delete the branch
        if (existingPr.right !== null) {
          const res = await repo.closePullRequest(existingPr.right.number)();
          if (T.isLeft(res)) {
            core.setFailed(`${id} - Close pull request error: ${res.left.message}`);
            return 1;
          }
          core.debug(`${name}: #${existingPr.right.number} closed`);
        }

        const res = await repo.deleteBranch(branch)();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - Delete branch error: ${res.left.message}`);
          return 1;
        }
        core.debug(`${name}: branch "${branch}" deleted`);
        continue;
      }

      if (filesToDelete.length > 0) {
        info('Files to delete', filesToDelete.map((f) => f.path).join(', '));
        for (const file of filesToDelete) {
          core.info(`Debug - File: ${file.path}, Mode: "${file.mode}", SHA: ${file.sha}`);
        }
      }

      // Commit files
      const commit = await repo.commit({
        parent,
        branch,
        message: render(cfg.commit.format, {
          prefix: cfg.commit.prefix,
          subject: render(cfg.commit.subject, {
            repository: GH_REPOSITORY,
            index: i,
          }),
          repository: GH_REPOSITORY,
          index: i,
        }),
        files: commitFiles,
        force: cfg.pull_request.force,
      })();
      if (T.isLeft(commit)) {
        core.setFailed(`${id} - ${commit.left.message}`);
        return 1;
      }
      core.debug(`commit: ${json(commit.right)}`);
      info('Commit SHA', commit.right.sha);
      info('Commit', `"${commit.right.message}"`);

      const diff = await repo.compareCommits(
        existingPr.right !== null ? existingPr.right.base.sha : parent,
        commit.right.sha,
      )();
      if (T.isLeft(diff)) {
        core.setFailed(`${id} - Compare commits error: ${String(diff.left)}`);
        return 1;
      }
      core.debug(`diff: ${json(diff.right)}`);
      info('Changed Files', String(diff.right.length));

      // If there are no differences, the existing PR is close and the branch is delete.
      if (diff.right.length === 0) {
        info('Status', 'Skipping this process because the pull request already exists.');

        if (existingPr.right !== null) {
          const res = await repo.closePullRequest(existingPr.right.number)();
          if (T.isLeft(res)) {
            core.setFailed(`${id} - Close pull request error: ${res.left.message}`);
            return 1;
          }
          core.debug(`${name}: #${existingPr.right.number} closed`);
        }

        const res = await repo.deleteBranch(branch)();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - Delete branch error: ${res.left.message}`);
          return 1;
        }
        core.debug(`${name}: branch "${branch}" deleted`);
        continue;
      }

      // Create Pull Request
      const pr = await repo.createOrUpdatePullRequest({
        number: existingPr.right?.number ?? null,
        title: render(cfg.pull_request.title, {
          repository: GH_REPOSITORY,
          index: i,
        }),
        body: render([cfg.pull_request.body, PR_FOOTER].join('\n'), {
          github: GH_SERVER,
          repository: GH_REPOSITORY,
          workflow: GH_WORKFLOW,
          run: {
            id: GH_RUN_ID,
            number: GH_RUN_NUMBER,
            url: `${GH_SERVER}/${GH_REPOSITORY}/actions/runs/${GH_RUN_ID}`,
          },
          changes: await Promise.all(
            diff.right.map(async (d: any) => {
              const syncFile = files.right.find((f) => f.to === d.filename);
              const isDeleted = filesToDelete.some((f) => f.path === d.filename);

              // Get PR info for this specific file
              const prInfo = await getPrInfoForFile(syncFile?.from || d.filename);

              return {
                from: syncFile?.from,
                to: d.filename,
                deleted: isDeleted,
                pull_request_title: prInfo?.title || null,
                pull_request_number: prInfo?.number || null,
              };
            }),
          ),
          index: i,
          pull_request_titles: [],
        }),
        branch,
      })();
      if (T.isLeft(pr)) {
        core.setFailed(`${id} - Create(Update) pull request error: ${pr.left.message}`);
        return 1;
      }
      core.debug(`pull request: ${json(pr)}`);
      info('Pull Request', pr.right.html_url);

      // Add labels
      if (cfg.pull_request.labels.length > 0) {
        const res = await repo.addPullRequestLabels(pr.right.number, cfg.pull_request.labels)();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - Add labels error: ${res.left.message}`);
          return 1;
        }
        info('Labels', cfg.pull_request.labels.join(', '));
      } else {
        info('Labels', 'None');
      }

      // Add reviewers
      if (cfg.pull_request.reviewers.length > 0) {
        const res = await repo.addPullRequestReviewers(pr.right.number, cfg.pull_request.reviewers)();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - Add reviewers error: ${res.left.message}`);
          return 1;
        }
        info('Reviewers', cfg.pull_request.reviewers.join(', '));
      } else {
        info('Reviewers', 'None');
      }

      // Add assignees
      if (cfg.pull_request.assignees.length > 0) {
        const res = await repo.addPullRequestAssignees(pr.right.number, cfg.pull_request.assignees)();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - Add assignees error: ${res.left.message}`);
          return 1;
        }
        info('Assignees', cfg.pull_request.assignees.join(', '));
      } else {
        info('Assignees', 'None');
      }

      // Merge
      const mergeCfg = cfg.pull_request.merge;
      if (mergeCfg.mode !== 'disabled') {
        // Prepare message
        let commitHeadline = null;
        let commitBody = null;

        const cc = mergeCfg.commit;
        if (cc.format) {
          const message = render(cc.format, {
            prefix: cc.prefix ?? '',
            subject: cc.subject
              ? render(cc.subject, {
                  repository: GH_REPOSITORY,
                  index: i,
                })
              : '',
            repository: GH_REPOSITORY,
            index: i,
          });

          // Merge commit specifically needs headline to be separate
          ({ headline: commitHeadline, body: commitBody } = splitCommitMessage(message));
        }

        // Run merge
        const res = await repo.mergePullRequest({
          number: pr.right.number,
          mode: mergeCfg.mode,
          strategy: mergeCfg.strategy,
          commitHeadline,
          commitBody,
        })();
        if (T.isLeft(res)) {
          core.setFailed(`${id} - PR merge error: ${res.left.message}`);
          return 1;
        }
        const mergeRes = res.right;
        info('Pull Request Merge', mergeRes);

        if (mergeRes === MergeResult.Merged && mergeCfg.delete_branch) {
          const res = await repo.deleteBranch(branch)();
          if (T.isLeft(res)) {
            core.setFailed(`${id} - Delete branch error: ${res.left.message}`);
            return 1;
          }
          info('Branch Deleted', `${name}@${branch}`);
        }
      }

      info('Status', 'Complete');

      // Set ouptut values
      prUrls.add(pr.right.html_url);

      for (const { filename } of diff.right) {
        syncedFiles.add(filename);
      }
    }
  }

  core.setOutput('pull_request_urls', [...prUrls]);
  core.setOutput('synced_files', [...syncedFiles]);

  return 0;
};

try {
  const code = await run();
  process.exit(code);
} catch (e) {
  core.setFailed(e as Error);
  process.exit(1);
}
