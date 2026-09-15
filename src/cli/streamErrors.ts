// Writing to a closed pipe (e.g. `zm categories --format table | head -n1`)
// makes Node emit an 'error' event on process.stdout/stderr; with no listener
// that's an uncaught exception (a stack trace on stderr, exit code 1), even
// though the command itself already succeeded. EPIPE specifically should
// exit quietly instead, leaving whatever exit code the command already
// produced unchanged. Any other stream error (e.g. ENOSPC) is a real
// problem and must still surface as a failure — this is exported as a pure
// classifier (rather than baking `process.exit`/`throw` directly into an
// 'error' listener) so both branches are unit-testable without a real
// stream or process.exit call.
export type StreamErrorAction = { type: 'exit'; code: number } | { type: 'rethrow' }

export function classifyWriteStreamError(err: NodeJS.ErrnoException, exitCodeSoFar: number | undefined): StreamErrorAction {
  if (err.code === 'EPIPE') return { type: 'exit', code: exitCodeSoFar ?? 0 }
  return { type: 'rethrow' }
}
