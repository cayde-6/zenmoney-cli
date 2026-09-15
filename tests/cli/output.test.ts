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
  printResult({ data: [{ name: 'Groceries', amount: 4500 }], meta: {}, warnings: ['w'] }, 'table', s => { out += s })
  expect(out).toMatch(/name\s+amount/)
  expect(out).toMatch(/Groceries\s+4500/)
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
// A-9: column widths must be computed with a loop, not `Math.max(...bigArray)`
// (spreading a huge array into a function call blows the stack).
it('renders a very large table without throwing (no Math.max(...array) stack overflow)', () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: i, name: `row${i}` }))
  let out = ''
  expect(() => printResult({ data: rows, meta: {} }, 'table', s => { out += s })).not.toThrow()
  expect(out).toMatch(/^id\s+name/)
})
it('table format falls back to a raw JSON dump for non-array data', () => {
  let out = ''
  printResult({ data: { a: 1 }, meta: {} }, 'table', s => { out += s })
  expect(JSON.parse(out)).toEqual({ a: 1 })
})
it('table format falls back to a raw JSON dump for an empty array', () => {
  let out = ''
  printResult({ data: [], meta: {} }, 'table', s => { out += s })
  expect(JSON.parse(out)).toEqual([])
})
it('table format falls back to a raw JSON dump when an item has a nested object value', () => {
  let out = ''
  printResult({ data: [{ a: { nested: 1 } }], meta: {} }, 'table', s => { out += s })
  expect(JSON.parse(out)).toEqual([{ a: { nested: 1 } }])
})
it('table format falls back to a raw JSON dump for an array of non-objects', () => {
  let out = ''
  printResult({ data: [1, 2, 3], meta: {} }, 'table', s => { out += s })
  expect(JSON.parse(out)).toEqual([1, 2, 3])
})
it('table format uses an explicit env.table even when env.data itself is not flat', () => {
  let out = ''
  printResult({ data: { nested: { a: 1 } }, meta: {}, table: [{ key: 'x', amount: 5 }] }, 'table', s => { out += s })
  expect(out).toMatch(/key\s+amount/)
  expect(out).toMatch(/x\s+5/)
})
it('printError handles a thrown non-Error value', () => {
  let out = ''
  const code = printError('just a string', 'json', s => { out += s })
  expect(code).toBe(1)
  expect(JSON.parse(out)).toEqual({ error: { code: 'UNEXPECTED', message: 'just a string' } })
})
it('printError in table format writes error/hint as plain lines', () => {
  let out = ''
  printError(new ZmError('AUTH', 'no token', 'run zm auth'), 'table', s => { out += s })
  expect(out).toBe('error: no token\nhint: run zm auth\n')
})
it('strips redundant "error: " prefix from commander messages', () => {
  const e = Object.assign(new Error('error: too many arguments. Expected 0 arguments but got 1.'), {
    code: 'commander.excessArguments',
  })
  let out = ''
  printError(e, 'json', s => { out += s })
  expect(JSON.parse(out).error.message).toBe('too many arguments. Expected 0 arguments but got 1.')
})
