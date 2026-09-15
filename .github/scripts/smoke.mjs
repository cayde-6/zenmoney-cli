// End-to-end smoke test for the packed npm tarball: installs it globally into
// a throwaway prefix (never the runner's real global install) and runs the
// built `zm` binary from there, exactly as a real user would after `npm i -g`.
// A plain Node script (rather than a shell script) so it runs the same way on
// ubuntu/macos/windows runners — see .github/workflows/ci.yml's `smoke` job.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isWin = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', shell: isWin, ...opts })
}

// The tarball was packed by the workflow into .smoke/ (npm pack --pack-destination
// .smoke) — find it by extension rather than hardcoding the versioned filename.
const smokeDir = '.smoke'
const tarball = readdirSync(smokeDir).find(f => f.endsWith('.tgz'))
if (!tarball) throw new Error(`no .tgz found in ${smokeDir}`)
const tarballPath = join(smokeDir, tarball)

const prefix = mkdtempSync(join(tmpdir(), 'zm-smoke-prefix-'))
console.log(`installing ${tarballPath} globally into ${prefix}`)
run('npm', ['install', '-g', '--prefix', prefix, tarballPath], { stdio: 'inherit' })

const zmBin = isWin ? join(prefix, 'zm.cmd') : join(prefix, 'bin', 'zm')
if (!existsSync(zmBin)) throw new Error(`expected zm binary at ${zmBin} after global install`)

// Isolated HOME/XDG/Windows dirs, exactly like every other test in this
// repo — a smoke run must never touch the real home. src/paths.ts reads
// APPDATA/LOCALAPPDATA directly (not derived from HOME) on win32, so those
// need their own override too, or a Windows run would resolve its config/
// cache dirs into the real user profile despite HOME/USERPROFILE being
// overridden. ZM_DISABLE_KEYCHAIN=1 keeps it off the runner's real macOS
// Keychain too.
const home = mkdtempSync(join(tmpdir(), 'zm-smoke-home-'))
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  ZM_DISABLE_KEYCHAIN: '1',
}

function assertExitCode(label, args, expectedCode) {
  let code = 0
  let stdout = ''
  try {
    stdout = run(zmBin, args, { env })
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1
    stdout = e.stdout ?? ''
  }
  if (code !== expectedCode) {
    throw new Error(`${label}: expected exit code ${expectedCode}, got ${code}\n${stdout}`)
  }
  console.log(`ok: ${label} (exit ${code})`)
  return stdout
}

const version = assertExitCode('zm --version', ['--version'], 0).trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`zm --version printed an unexpected value: ${version}`)

assertExitCode('zm --help', ['--help'], 0)

// `zm status` must work with no token and no cache at all — it's the one
// command that always succeeds, by design (see src/cli/commands/status.ts).
const statusOut = assertExitCode('zm status', ['status'], 0)
const status = JSON.parse(statusOut)
if (status.data.cache.exists !== false) throw new Error(`zm status: expected no cache to exist yet, got ${statusOut}`)

console.log('smoke test passed')
