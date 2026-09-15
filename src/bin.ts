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

const { run } = await import('./cli/program.js')
const { realContext } = await import('./cli/context.js')

process.exitCode = await run(process.argv, realContext())
