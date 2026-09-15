import { ZmError } from '../errors.js'
import type { ZmDiff } from './types.js'

export const DIFF_URL = 'https://api.zenmoney.ru/v8/diff/'

// A failed fetch's error message can itself carry the token: undici's own
// header-validation error embeds the full `Authorization` header value (e.g.
// `Headers.append: "Bearer <token>" is an invalid header value.`), so it must
// never be forwarded to the caller as-is. Any message that mentions the
// request headers is replaced outright with a generic one (its wording is
// unpredictable and always low-value); otherwise every literal occurrence of
// the token is scrubbed, in case it leaked into the message some other way.
function sanitizeNetworkMessage(message: string, token: string): string {
  if (/headers?/i.test(message)) return 'invalid request headers'
  return token ? message.split(token).join('***') : message
}

const DEFAULT_TIMEOUT_MS = 60_000
// setTimeout (which AbortSignal.timeout is built on) has an effectively
// 32-bit signed delay ceiling; anything above this either silently
// misbehaves or fires immediately depending on the runtime, so it's
// rejected up front rather than passed through.
const MAX_TIMEOUT_MS = 2_147_483_647
// Plain decimal digits only: `Number(raw)` alone is too permissive (accepts
// exponent notation like "1e3", hex like "0x10", and leading/trailing
// whitespace like " 5 "), none of which are a sane way to spell a millisecond
// count in an env var.
const TIMEOUT_RE = /^\d+$/

// `ZM_TIMEOUT_MS`: how long to wait for the ZenMoney API before giving up
// (default 60000ms). Validated up front so a bad value fails the same way
// regardless of which command triggers a network call.
export function parseTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.ZM_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_TIMEOUT_MS
  if (!TIMEOUT_RE.test(raw)) {
    throw new ZmError('INVALID_ARGS', `invalid ZM_TIMEOUT_MS: ${raw}`, 'must be a positive integer (milliseconds)')
  }
  const n = Number(raw)
  if (n < 1 || n > MAX_TIMEOUT_MS) {
    throw new ZmError('INVALID_ARGS', `invalid ZM_TIMEOUT_MS: ${raw}`, `must be between 1 and ${MAX_TIMEOUT_MS}`)
  }
  return n
}

// A fetch-level failure's `cause.code` (undici sets this for connection-level
// errors, e.g. ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT) is the most
// useful diagnostic detail available and never contains the token, so it's
// safe to append as-is after the (still scrubbed) message.
function causeCode(e: unknown): string | undefined {
  const cause = (e as { cause?: unknown } | null)?.cause
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export async function fetchDiff(
  token: string,
  serverTimestamp: number,
  deps: { fetch: typeof fetch; now: () => Date; timeoutMs?: number },
): Promise<ZmDiff> {
  let res: Response
  try {
    res = await deps.fetch(DIFF_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentClientTimestamp: Math.floor(deps.now().getTime() / 1000), serverTimestamp }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (e) {
    const sanitized = sanitizeNetworkMessage((e as Error).message, token)
    const code = causeCode(e)
    throw new ZmError(
      'NETWORK',
      `cannot reach ZenMoney: ${sanitized}${code ? ` (${code})` : ''}`,
      'check your connection and retry',
    )
  }
  if (res.status === 401 || res.status === 403) throw new ZmError('AUTH', 'ZenMoney rejected the token', 'run zm auth')
  if (!res.ok) {
    let bodyText: string
    try {
      bodyText = await res.text()
    } catch {
      // Reading the body itself failed (e.g. a truncated/aborted response):
      // there's nothing to report but the status, and definitely nothing to
      // scrub a token out of.
      throw new ZmError('NETWORK', `ZenMoney API error ${res.status}`)
    }
    // Scrub the token from the FULL body before truncating, not after: the
    // token can start anywhere, including straddling the 200-char cut point,
    // and slicing first would leave a truncated-but-still-identifiable prefix
    // of it sitting right at the boundary. Only the token itself is scrubbed
    // here (not the fuller sanitizeNetworkMessage heuristic above): a real API
    // error body legitimately mentioning "header" has nothing to do with the
    // undici header-validation leak that heuristic targets, and would lose
    // real diagnostic detail for no reason.
    const safeBody = (token ? bodyText.split(token).join('***') : bodyText).slice(0, 200)
    throw new ZmError('NETWORK', `ZenMoney API error ${res.status}: ${safeBody}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ZmError('NETWORK', 'invalid response from ZenMoney')
  }
  const bodyTimestamp = (body as { serverTimestamp?: unknown } | null)?.serverTimestamp
  if (typeof bodyTimestamp !== 'number') throw new ZmError('NETWORK', 'invalid response from ZenMoney')
  return body as ZmDiff
}
