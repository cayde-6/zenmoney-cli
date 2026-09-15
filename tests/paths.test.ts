import { it, expect } from 'vitest'
import { resolvePaths } from '../src/paths.js'

it('uses XDG on unix', () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: '/x/cfg' }, 'darwin', '/home/u')
  expect(p.configDir).toBe('/x/cfg/zm')
  expect(p.cacheDb).toBe('/home/u/.cache/zm/zm.sqlite')
  expect(p.budgetDir).toBe('/x/cfg/zm/budget')
  expect(p.configFile).toBe('/x/cfg/zm/config.json')
})
it('uses APPDATA on windows', () => {
  const p = resolvePaths({ APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')
  expect(p.configDir).toBe('C:\\A\\zm')
  expect(p.cacheDir).toBe('C:\\L\\zm')
})
it('unix with no XDG env vars at all falls back under home', () => {
  const p = resolvePaths({}, 'linux', '/home/u')
  expect(p.configDir).toBe('/home/u/.config/zm')
  expect(p.cacheDb).toBe('/home/u/.cache/zm/zm.sqlite')
})
it('unix honors XDG_CACHE_HOME independently of XDG_CONFIG_HOME', () => {
  const p = resolvePaths({ XDG_CACHE_HOME: '/x/cache' }, 'linux', '/home/u')
  expect(p.cacheDb).toBe('/x/cache/zm/zm.sqlite')
  expect(p.configDir).toBe('/home/u/.config/zm')
})
it('windows with no APPDATA/LOCALAPPDATA falls back under home', () => {
  const p = resolvePaths({}, 'win32', 'C:\\Users\\u')
  expect(p.configDir).toBe('C:\\Users\\u\\AppData\\Roaming\\zm')
  expect(p.cacheDir).toBe('C:\\Users\\u\\AppData\\Local\\zm')
})
// A-22: per the XDG Base Directory spec, a relative XDG_*_HOME value is
// invalid and must be treated as unset (fall back to the default).
it('ignores a relative XDG_CONFIG_HOME/XDG_CACHE_HOME, falling back to defaults', () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: 'relative/cfg', XDG_CACHE_HOME: 'relative/cache' }, 'linux', '/home/u')
  expect(p.configDir).toBe('/home/u/.config/zm')
  expect(p.cacheDir).toBe('/home/u/.cache/zm')
})
it('still honors an absolute XDG_CONFIG_HOME/XDG_CACHE_HOME', () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: '/x/cfg', XDG_CACHE_HOME: '/x/cache' }, 'linux', '/home/u')
  expect(p.configDir).toBe('/x/cfg/zm')
  expect(p.cacheDir).toBe('/x/cache/zm')
})
