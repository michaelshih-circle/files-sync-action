import { expect, test, describe, it } from 'vitest';
import { convertValidBranchName } from './utils.js';
import { parseLatestChangelog } from './utils.js';

test.each([
  ['foo', 'foo'],
  ['foo-bar', 'foo-bar'],
  ['foo/bar', 'foo-bar'],
  ['foo//bar', 'foo-bar'],
  ['/foo', 'foo'],
  ['.foo', 'foo'],
  ['@{foo', 'foo'],
  ['foo\\bar', 'foobar'],
  ['foo~bar', 'foobar'],
  ['foo^bar', 'foobar'],
  ['foo:bar', 'foobar'],
  ['foo?bar', 'foobar'],
  ['foo*bar', 'foobar'],
  ['foo[]bar', 'foobar'],
  ['foo.', 'foo'],
])('convertValidBranchName', (input, expected) => {
  expect(convertValidBranchName(input)).toBe(expected);
});

describe('parseLatestChangelog', () => {
  it('should parse latest changelog entry correctly', () => {
    const changelog = `# Changelog

## [1.2.0] - 2024-01-15

### Added
- New feature A
- New feature B

### Fixed
- Bug fix C

## [1.1.0] - 2024-01-10

### Added
- Old feature D

### Fixed
- Old bug fix E
`;

    const result = parseLatestChangelog(changelog);
    expect(result).toBe(`## [1.2.0] - 2024-01-15

### Added
- New feature A
- New feature B

### Fixed
- Bug fix C`);
  });

  it('should return null if no changelog entries found', () => {
    const changelog = `# Changelog

This is just a description.
`;

    const result = parseLatestChangelog(changelog);
    expect(result).toBe(null);
  });

  it('should handle single entry changelog', () => {
    const changelog = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release
`;

    const result = parseLatestChangelog(changelog);
    expect(result).toBe(`## [1.0.0] - 2024-01-01

### Added
- Initial release`);
  });

  it('should handle trailing empty lines', () => {
    const changelog = `# Changelog

## [1.0.0] - 2024-01-01

### Added
- Initial release


## [0.9.0] - 2023-12-01

### Added
- Beta release
`;

    const result = parseLatestChangelog(changelog);
    expect(result).toBe(`## [1.0.0] - 2024-01-01

### Added
- Initial release`);
  });
});
