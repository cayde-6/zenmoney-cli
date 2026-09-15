import { it, expect } from 'vitest'
import { printResult, printError } from '../../src/cli/output.js'
import { ZmError } from '../../src/errors.js'

it('prints json envelope', () => {
  let out = ''
  printResult({ data: [{ a: 1 }], meta: { m: 1 } }, 'json', s => { out += s })
  expect(JSON.parse(out)).toEqual({ data: [{ a: 1 }], meta: { m: 1 } })
})
it('renders array of flat objects as table, warnings last', () => {
  let out = ''
  printResult({ data: [{ name: 'Продукты', amount: 4500 }], meta: {}, warnings: ['w'] }, 'table', s => { out += s })
  expect(out).toMatch(/name\s+amount/)
  expect(out).toMatch(/Продукты\s+4500/)
  expect(out).toMatch(/warning: w/)
})
it('maps ZmError to exit code and json', () => {
  let err = ''
  const code = printError(new ZmError('AUTH', 'no token', 'run zm auth'), 'json', s => { err += s })
  expect(code).toBe(3)
  expect(JSON.parse(err)).toEqual({ error: { code: 'AUTH', message: 'no token', hint: 'run zm auth' } })
})
it('unknown errors exit 1', () => {
  expect(printError(new Error('boom'), 'json', () => {})).toBe(1)
})
it('strips redundant "error: " prefix from commander messages', () => {
  const e = Object.assign(new Error('error: too many arguments. Expected 0 arguments but got 1.'), {
    code: 'commander.excessArguments',
  })
  let out = ''
  printError(e, 'json', s => { out += s })
  expect(JSON.parse(out).error.message).toBe('too many arguments. Expected 0 arguments but got 1.')
})
