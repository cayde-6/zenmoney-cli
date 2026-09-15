// Type declaration for npm-published.mjs, so tests/scripts/npm-published.test.ts
// (which imports it) type-checks under NodeNext module resolution.
export function isPublished(
  name: string,
  version: string,
  run?: (file: string, args: string[], options: { encoding: 'utf8' }) => string,
): boolean

export const EXIT_PUBLISHED: 0
export const EXIT_NOT_PUBLISHED: 1
export const EXIT_USAGE_ERROR: 2
export const EXIT_UNEXPECTED_ERROR: 3

export function exitCodeFor(
  name: string | undefined,
  version: string | undefined,
  checkPublished?: (name: string, version: string) => boolean,
): 0 | 1 | 2 | 3
