// node:sqlite (used by Store) emits an ExperimentalWarning on stderr on Node
// versions where it's still experimental. That would land in stderr right
// alongside our JSON error output and break JSON parsing for callers. Suppress
// only that specific warning, before anything that transitively imports
// node:sqlite is loaded — hence the dynamic imports below instead of static
// ones, which Node would hoist and run before this filter is installed.
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const name = typeof warning === 'string' ? (args[0] as string | { type?: string } | undefined) : warning.name
  const message = typeof warning === 'string' ? warning : warning.message
  const warningName = typeof name === 'string' ? name : (name as { type?: string } | undefined)?.type
  if (warningName === 'ExperimentalWarning' && /SQLite/i.test(message)) return
  // @ts-expect-error -- process.emitWarning has multiple overloads; forward args as received.
  return originalEmitWarning(warning, ...args)
}) as typeof process.emitWarning

// See src/cli/streamErrors.ts for why only EPIPE is swallowed here — any
// other stream error (e.g. ENOSPC) is rethrown and must still surface as a
// failure (an uncaught exception, non-zero exit), not be silently absorbed
// just because an 'error' listener now exists on the stream.
const { classifyWriteStreamError } = await import('./cli/streamErrors.js')
function handleStreamErrors(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    const action = classifyWriteStreamError(err, typeof process.exitCode === 'number' ? process.exitCode : undefined)
    if (action.type === 'exit') process.exit(action.code)
    else throw err
  })
}
handleStreamErrors(process.stdout)
handleStreamErrors(process.stderr)

const { run } = await import('./cli/program.js')
const { realContext } = await import('./cli/context.js')

process.exitCode = await run(process.argv, realContext())
