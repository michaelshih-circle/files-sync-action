import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepmerge } from 'deepmerge-ts';
import type { PartialDeep, Simplify } from 'type-fest';

/**
 * Modules
 */
export const filename = (url: string): string => fileURLToPath(url);

export const dirname = (url: string): string => path.dirname(filename(url));

/**
 * Objects
 */
export const merge = <T, U>(x: PartialDeep<T>, y: PartialDeep<U>): Simplify<T & U> => {
  return deepmerge(x, y) as T & U;
};

/**
 * Git
 */
export const convertValidBranchName = (input: string): string => {
  let b = input.trim();
  b = b.replace(/^[./]+/, ''); // remove prefix '.' or '/'
  b = b.replace(/[/]+/g, '-'); // convert '/' to '-'
  b = b.replace(/[@{\\~^:?*[\]]+/g, ''); // remove invalid character
  b = b.replace(/[.]+$/, ''); // remove "." at the end of string
  return b;
};

export const splitCommitMessage = (message: string): { headline: string; body: string | null } => {
  const dividerIdx = message.indexOf('\n');
  const hasBody = dividerIdx !== -1;
  const headline = hasBody ? message.slice(0, dividerIdx) : message;
  const body = hasBody ? message.slice(dividerIdx + 1) : null;
  return { headline, body };
};

export const parseLatestChangelog = (changelogContent: string): string | null => {
  const lines = changelogContent.split('\n');
  const latestEntry: string[] = [];
  let foundFirstEntry = false;
  let inCurrentEntry = false;

  for (const line of lines) {
    // Skip initial heading and empty lines
    if (!foundFirstEntry && (line.trim() === '' || line.startsWith('# '))) {
      continue;
    }

    // Check if this is a version heading (## [version] or ## version)
    if (line.match(/^##\s+/)) {
      if (!foundFirstEntry) {
        // This is the first entry, start collecting
        foundFirstEntry = true;
        inCurrentEntry = true;
        latestEntry.push(line);
      } else {
        // This is the second entry, stop collecting
        break;
      }
    } else if (inCurrentEntry) {
      // We're in the first entry, collect this line
      latestEntry.push(line);
    }
  }

  if (latestEntry.length === 0) {
    return null;
  }

  // Clean up the entry (remove trailing empty lines)
  while (latestEntry.length > 0 && latestEntry[latestEntry.length - 1]?.trim() === '') {
    latestEntry.pop();
  }

  return latestEntry.join('\n');
};
