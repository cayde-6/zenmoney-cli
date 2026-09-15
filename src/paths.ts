import path from 'node:path'

export interface Paths {
  configDir: string
  configFile: string
  budgetDir: string
  cacheDir: string
  cacheDb: string
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
    : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'zm')
  const cacheDir = isWin
    ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'zm')
    : p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), 'zm')

  return {
    configDir,
    configFile: p.join(configDir, 'config.json'),
    budgetDir: p.join(configDir, 'budget'),
    cacheDir,
    cacheDb: p.join(cacheDir, 'zm.sqlite'),
  }
}
