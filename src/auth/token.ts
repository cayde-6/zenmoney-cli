import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { ZmError } from '../errors.js'

export interface Keychain {
  get(): string | null
  set(token: string): void
  remove(): void
}

export type ExecFn = (file: string, args: string[], input?: string) => string

const defaultExec: ExecFn = (file, args, input) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], input })

const AUTH_FAILURE = () => new ZmError('AUTH', 'cannot save token to macOS Keychain', 'set ZENMONEY_TOKEN or retry')

// Characters that could break out of the double-quoted `security -i` batch
// command (see macKeychain.set below), plus any other control character
// (< 0x20, which also covers \n): none of these can appear in a real
// ZenMoney token. Shared with saveToken and with `zm auth`'s own
// pre-network check (src/cli/commands/sync.ts) so a token this invalid is
// rejected outright, before any keychain/config fallback logic or network
// call gets a chance to run.
const INVALID_TOKEN_CHARS = /["\\\x00-\x1f]/

export function validateTokenChars(token: string): void {
  if (INVALID_TOKEN_CHARS.test(token)) throw new ZmError('INVALID_ARGS', 'token contains invalid characters')
}

export function macKeychain(exec: ExecFn = defaultExec): Keychain {
  const getStored = (): string | null => {
    try {
      return exec('security', ['find-generic-password', '-s', 'zenmoney-cli', '-a', 'zm', '-w']).trim()
    } catch {
      return null
    }
  }
  return {
    get: getStored,
    set(token: string): void {
      // The token never goes through argv (visible to any local user via `ps`): it's
      // sent as a `security -i` batch command on stdin instead. That command line is
      // a double-quoted shell-ish string `security` parses itself, so characters that
      // could break out of the quoting must be rejected up front.
      validateTokenChars(token)
      try {
        exec('security', ['-i'], `add-generic-password -U -s zenmoney-cli -a zm -w "${token}"\n`)
      } catch {
        // Never let the underlying error escape: execFileSync's error (and security's
        // own stderr) can otherwise carry the token in its message.
        throw AUTH_FAILURE()
      }
      // `security -i` can report success (exit 0, no thrown error) even when the
      // batched command silently failed to store anything. Verify the value actually
      // landed before trusting it, so saveToken can fall back to config.json.
      if (getStored() !== token) throw AUTH_FAILURE()
    },
    remove(): void {
      try {
        exec('security', ['delete-generic-password', '-s', 'zenmoney-cli', '-a', 'zm'])
      } catch {
        // nothing to remove
      }
    },
  }
}

export interface TokenDeps {
  env: Record<string, string | undefined>
  keychain: Keychain | null
  configFile: string
}

function nonEmpty(s: string | null | undefined): string | null {
  const trimmed = s?.trim()
  return trimmed ? trimmed : null
}

function readConfig(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeConfig(file: string, obj: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 })
  // writeFileSync's mode only applies when the file is created; chmod explicitly
  // so an existing (possibly more permissive) config file also ends up at 0o600.
  chmodSync(file, 0o600)
}

export function resolveToken(deps: TokenDeps): string | null {
  const fromEnv = nonEmpty(deps.env.ZENMONEY_TOKEN)
  if (fromEnv) return fromEnv
  const fromKeychain = nonEmpty(deps.keychain?.get() ?? null)
  if (fromKeychain) return fromKeychain
  const config = readConfig(deps.configFile)
  return nonEmpty(typeof config.token === 'string' ? config.token : null)
}

export function saveToken(token: string, deps: TokenDeps): 'keychain' | 'config' {
  // Checked here too (not just inside macKeychain.set): this must fail outright
  // on any platform, including one with no keychain at all, rather than ever
  // silently falling back to writing the invalid token into config.json.
  validateTokenChars(token)
  if (deps.keychain) {
    try {
      deps.keychain.set(token)
      return 'keychain'
    } catch {
      // Falling back to config.json isn't enough on its own: if the Keychain still
      // holds an older token, resolveToken would keep preferring it over the config
      // file we're about to write, silently ignoring the token this call reports as
      // saved. Best-effort clear it (remove() already swallows its own errors), then
      // verify — if a different token is still there, the write truly can't be
      // trusted, so surface that instead of pretending it succeeded.
      deps.keychain.remove()
      const stillThere = deps.keychain.get()
      if (stillThere !== null && stillThere !== token) {
        throw new ZmError(
          'AUTH',
          'an older token in macOS Keychain could not be replaced',
          'remove it with: security delete-generic-password -s zenmoney-cli -a zm',
        )
      }
    }
  }
  const config = readConfig(deps.configFile)
  config.token = token
  writeConfig(deps.configFile, config)
  return 'config'
}

export function removeToken(deps: TokenDeps): void {
  deps.keychain?.remove()
  if (existsSync(deps.configFile)) {
    const config = readConfig(deps.configFile)
    delete config.token
    writeConfig(deps.configFile, config)
  }
}

export function requireToken(deps: TokenDeps): string {
  const token = resolveToken(deps)
  if (!token) throw new ZmError('AUTH', 'no ZenMoney token', 'run zm auth or set ZENMONEY_TOKEN')
  return token
}
