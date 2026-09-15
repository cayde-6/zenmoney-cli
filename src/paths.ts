import path from 'node:path'

export interface Paths {
  configDir: string
  configFile: string
  budgetDir: string
  cacheDir: string
  cacheDb: string
}

// Per the XDG Base Directory spec: "If $XDG_..._HOME is either not set or
// empty, a default equal to ... should be used. ... All paths set in these
// environment variables must be absolute. If a relative path is set, it
// should be considered equivalent to that variable being unset." A relative
// value is therefore ignored (falls back to the default) rather than being
// joined as-is, which would silently produce a path relative to the process
// cwd instead of the user's home.
function xdgHome(value: string | undefined, fallback: string, p: path.PlatformPath): string {
  return value !== undefined && p.isAbsolute(value) ? value : fallback
}

export function resolvePaths(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): Paths {
  const isWin = platform === 'win32'
  const p = isWin ? path.win32 : path.posix

  const configDir = isWin
    ? p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'zm')
    : p.join(xdgHome(env.XDG_CONFIG_HOME, p.join(home, '.config'), p), 'zm')
  const cacheDir = isWin
    ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'zm')
    : p.join(xdgHome(env.XDG_CACHE_HOME, p.join(home, '.cache'), p), 'zm')

  return {
    configDir,
    configFile: p.join(configDir, 'config.json'),
    budgetDir: p.join(configDir, 'budget'),
    cacheDir,
    cacheDb: p.join(cacheDir, 'zm.sqlite'),
  }
}
