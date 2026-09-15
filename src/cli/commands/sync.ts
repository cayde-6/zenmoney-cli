import type { Command } from 'commander'
import type { AppContext } from '../context.js'
import { formatOf } from '../program.js'
import { printResult } from '../output.js'
import { fetchDiff } from '../../api/client.js'
import { requireToken, removeToken, saveToken, validateTokenChars } from '../../auth/token.js'
import { Store } from '../../store/store.js'
import { ZmError } from '../../errors.js'

// Pure keystroke-by-keystroke state machine behind promptHidden's raw-mode TTY
// reading, kept separate so it's unit-testable without a real terminal.
// Backspace (\x7f or \b) drops the last character; Enter (\r or \n) or Ctrl-D
// (\x04) finishes; Ctrl-C (\x03) finishes as cancelled. Escape sequences —
// CSI (arrow keys etc., ESC '[' ... a final byte in @-~), SS3 (ESC 'O' <char>,
// another common arrow-key encoding), and Alt+key (ESC <char>, both bytes
// arriving in the same chunk) — are dropped rather than inserted into the
// token. Stops at the first terminator in a chunk.
//
// A CSI/SS3 sequence can be split across two reads from the raw stdin stream
// (e.g. the terminal driver flushes ESC '[' in one chunk and the final byte in
// the next): `pendingEscape` carries the not-yet-terminated tail of such a
// sequence from the previous call, and the result's `pending` field reports
// one back when a chunk ends mid-sequence, so the caller can pass it into the
// next call instead of letting the tail leak into the token as regular chars.
//
// A bare ESC that is the very last byte of a chunk is genuinely ambiguous —
// it might be the start of a CSI/SS3 sequence whose next byte(s) just haven't
// arrived yet, or it might be a standalone Escape keypress. It becomes
// `pending` rather than being dropped immediately; the *next* call only keeps
// treating it as an escape intro if that next chunk actually starts one ('['
// or 'O'). Otherwise the pending ESC is dropped on its own (a real terminal
// writes an escape sequence as one atomic write, so this case — ESC arriving
// completely alone, with unrelated bytes only showing up in a later, separate
// read — means it really was just Escape) and the new chunk is scanned
// completely fresh, so none of its bytes are swallowed.
//
// While scanning an unfinished CSI (or SS3) sequence, a byte < 0x20 aborts
// it: that byte is never a legal CSI parameter/intermediate/final byte, so
// this is not actually an escape sequence, and the control byte (Enter,
// Ctrl-C, backspace, ...) must still be processed normally rather than
// silently consumed as if it were the sequence's terminator.
export function applyKeystrokes(
  buffer: string,
  chunk: string,
  pendingEscape = '',
): { value: string; done: boolean; cancelled: boolean; pending?: string } {
  let value = buffer
  const text = pendingEscape === '\x1b' && chunk[0] !== '[' && chunk[0] !== 'O' ? chunk : pendingEscape + chunk

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\x1b') {
      const next = text[i + 1]
      if (next === '[') {
        let j = i + 2
        let aborted = false
        while (j < text.length) {
          const b = text[j]!
          if (b < '\x20') { aborted = true; break }
          if (b >= '@' && b <= '~') break
          j++
        }
        if (j >= text.length) return { value, done: false, cancelled: false, pending: text.slice(i) }
        i = aborted ? j - 1 : j // aborted: back up so the for-loop's i++ reprocesses text[j] normally
        continue
      }
      if (next === 'O') {
        if (i + 2 >= text.length) return { value, done: false, cancelled: false, pending: text.slice(i) }
        const b = text[i + 2]!
        i = b < '\x20' ? i + 1 : i + 2 // aborted (b < 0x20): back up so b is reprocessed normally
        continue
      }
      if (next === undefined) return { value, done: false, cancelled: false, pending: text.slice(i) }
      i = i + 1 // Alt+key: ESC <char> within one chunk, consume both bytes
      continue
    }
    if (ch === '\x03') return { value, done: true, cancelled: true }
    if (ch === '\x04') return { value, done: true, cancelled: false }
    if (ch === '\r' || ch === '\n') return { value, done: true, cancelled: false }
    value = (ch === '\x7f' || ch === '\b') ? value.slice(0, -1) : value + ch
  }
  return { value, done: false, cancelled: false }
}

// Untested: no test in this task drives an actual TTY. Prompts on stderr and
// reads raw keystrokes from stdin (rawMode so the terminal itself never echoes
// the token), applying them via the unit-tested applyKeystrokes() above.
async function promptHidden(_ctx: AppContext, prompt: string): Promise<string> {
  process.stderr.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  try {
    let buffer = ''
    let pending = ''
    for await (const chunk of stdin) {
      const result = applyKeystrokes(buffer, chunk as string, pending)
      buffer = result.value
      pending = result.pending ?? ''
      if (result.done) {
        if (result.cancelled) throw new ZmError('INVALID_ARGS', 'cancelled')
        process.stderr.write('\n')
        return buffer
      }
    }
    throw new ZmError('INVALID_ARGS', 'empty token')
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}

export function registerSync(program: Command, ctx: AppContext): void {
  const tokenDeps = () => ({ env: ctx.env, keychain: ctx.keychain, configFile: ctx.paths.configFile })

  program.command('auth')
    .description('Validate and store a ZenMoney API token (or remove it with --logout)')
    .option('--token <token>', 'token value; otherwise read from stdin or prompt')
    .option('--logout', 'remove stored token')
    .addHelpText('after', '\nExamples:\n  zm auth\n  zm auth --token <token>\n  echo <token> | zm auth\n  zm auth --logout\n')
    .action(async (opts, cmd) => {
      const format = formatOf(cmd)
      if (opts.logout) {
        removeToken(tokenDeps())
        printResult({ data: { removed: true }, meta: {} }, format, ctx.stdout)
        return
      }
      // A missing --token, read from stdin (piped input, not a terminal), gets a
      // distinct "no token provided" error: an empty pipe is a caller mistake
      // (nothing was actually sent), not the same as a TTY prompt cancelled with
      // an empty answer.
      let token: string
      if (opts.token !== undefined) {
        token = opts.token.trim()
        if (!token) throw new ZmError('INVALID_ARGS', 'empty token')
      } else if (ctx.isTTY) {
        token = (await promptHidden(ctx, 'ZenMoney token: ')).trim()
        if (!token) throw new ZmError('INVALID_ARGS', 'empty token')
      } else {
        token = (await ctx.readStdin()).trim()
        if (!token) throw new ZmError('INVALID_ARGS', 'no token provided', 'pipe the token via stdin or run zm auth in a terminal')
      }
      // Validated before any network call: rejecting an invalid token (e.g. one
      // containing a stray newline from a two-line paste) must never depend on
      // reaching ZenMoney first, both to fail fast and so the token never ends
      // up in a request that could echo it back in an error message.
      validateTokenChars(token)
      await fetchDiff(token, Math.floor(ctx.now().getTime() / 1000), { fetch: ctx.fetch, now: ctx.now })
      printResult({ data: { saved: saveToken(token, tokenDeps()) }, meta: {} }, format, ctx.stdout)
    })

  program.command('sync')
    .description('Download changes from ZenMoney into the local cache')
    .option('--full', 'drop the cache and download everything')
    .addHelpText('after', '\nExamples:\n  zm sync\n  zm sync --full\n')
    .action(async (opts, cmd) => {
      const format = formatOf(cmd)
      const token = requireToken(tokenDeps())
      // Unlike ctx.openStore() (for read commands), sync must work before any cache
      // exists, so it opens the cache file directly rather than requiring NO_CACHE.
      const store = Store.open(ctx.paths.cacheDb)
      try {
        const full = Boolean(opts.full)
        // Fetch before touching the cache: if this throws (network/auth failure),
        // the existing cache must be left exactly as it was. --full's reset then
        // happens inside the same transaction as the upsert (see Store.applyDiff),
        // so a successful sync never leaves the store empty either.
        const diff = await fetchDiff(token, full ? 0 : store.getMeta().serverTimestamp, { fetch: ctx.fetch, now: ctx.now })
        const stats = store.applyDiff(diff, ctx.now(), full ? { reset: true } : undefined)
        printResult({ data: { ...stats, full }, meta: { lastSyncAt: store.getMeta().lastSyncAt } }, format, ctx.stdout)
      } finally {
        store.close()
      }
    })
}
