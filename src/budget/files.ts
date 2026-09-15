import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ZmError } from '../errors.js'

export interface LimitSpec { amount: number; currency: string }
export type RawLimit = number | { amount: number; currency?: string } | null
export interface BudgetFile { currency?: string; limits?: Record<string, RawLimit> }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// A limit map key of `__proto__`/`constructor`/`prototype` is rejected
// outright rather than merely tolerated: `limits[key] = ...` on the plain
// `{}` literal used for `result.limits` would treat `__proto__` as the
// special own-prototype setter rather than an ordinary property, silently
// mangling that one object's prototype instead of storing a real limit.
const FORBIDDEN_LIMIT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function validateLimit(value: unknown, key: string, source: string): RawLimit {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" must be a finite number >= 0`)
    }
    return value
  }
  if (isPlainObject(value)) {
    const amount = value.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" must have a finite "amount" >= 0`)
    }
    if (value.currency !== undefined && typeof value.currency !== 'string') {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" currency must be a string`)
    }
    return value.currency !== undefined ? { amount, currency: value.currency as string } : { amount }
  }
  throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" has an invalid shape`)
}

// Parses and validates one budget yaml file's shape. Does not resolve category
// names, uppercase currency codes, or merge with anything else — that's mergeBudget's job.
export function parseBudgetFile(text: string, source: string): BudgetFile {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ZmError('INVALID_ARGS', `${source}: invalid yaml: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (raw === null || raw === undefined) return {}
  if (!isPlainObject(raw)) throw new ZmError('INVALID_ARGS', `${source}: must be a yaml object`)

  for (const key of Object.keys(raw)) {
    if (key !== 'currency' && key !== 'limits') {
      throw new ZmError('INVALID_ARGS', `${source}: unknown key "${key}"`)
    }
  }

  const result: BudgetFile = {}
  if ('currency' in raw) {
    if (typeof raw.currency !== 'string') throw new ZmError('INVALID_ARGS', `${source}: "currency" must be a string`)
    result.currency = raw.currency
  }
  if ('limits' in raw) {
    // A `limits:` key followed only by comments (as `zm budget init` writes
    // before anything is uncommented) parses as `limits: null`, not `{}` —
    // treat that as an empty limits object rather than a shape error.
    if (raw.limits === null) {
      result.limits = {}
    } else {
      if (!isPlainObject(raw.limits)) throw new ZmError('INVALID_ARGS', `${source}: "limits" must be an object`)
      // Object.create(null) rather than `{}`: even a key this loop failed to
      // reject could otherwise silently mutate the object's prototype instead
      // of becoming a property (see FORBIDDEN_LIMIT_KEYS above).
      const limits: Record<string, RawLimit> = Object.create(null)
      for (const [key, value] of Object.entries(raw.limits)) {
        if (FORBIDDEN_LIMIT_KEYS.has(key)) {
          throw new ZmError('INVALID_ARGS', `${source}: limit key "${key}" is not allowed`)
        }
        limits[key] = validateLimit(value, key, source)
      }
      result.limits = limits
    }
  }
  return result
}

function toLimitSpec(raw: number | { amount: number; currency?: string }, fileCurrency: string | undefined, effectiveCurrency: string | undefined, key: string): LimitSpec {
  const amount = typeof raw === 'number' ? raw : raw.amount
  const ownCurrency = typeof raw === 'number' ? undefined : raw.currency
  const currency = ownCurrency ?? fileCurrency ?? effectiveCurrency
  if (!currency) throw new ZmError('INVALID_ARGS', `limit "${key}" has no currency`)
  return { amount, currency: currency.toUpperCase() }
}

// Merges the template (base) and a month override into one effective limit map.
// A month limit of `null` deletes the base's limit for that key.
export function mergeBudget(base: BudgetFile | null, month: BudgetFile | null): Map<string, LimitSpec> {
  const effectiveCurrency = month?.currency ?? base?.currency
  const result = new Map<string, LimitSpec>()

  for (const [key, raw] of Object.entries(base?.limits ?? {})) {
    if (raw === null) continue
    result.set(key, toLimitSpec(raw, base?.currency, effectiveCurrency, key))
  }
  for (const [key, raw] of Object.entries(month?.limits ?? {})) {
    if (raw === null) {
      result.delete(key)
      continue
    }
    result.set(key, toLimitSpec(raw, month?.currency, effectiveCurrency, key))
  }
  return result
}

// For each key in the effective (merged) limit map, which file its current
// value actually came from — the month file if it set (or overrode) that
// key, otherwise the template. Used to name a source in the "unknown budget
// category" warning (see budget/status.ts's unresolvedLimits).
function keySources(base: BudgetFile | null, month: BudgetFile | null, defaultPath: string, monthPath: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, raw] of Object.entries(base?.limits ?? {})) {
    if (raw === null) continue
    result.set(key, defaultPath)
  }
  for (const [key, raw] of Object.entries(month?.limits ?? {})) {
    if (raw === null) {
      result.delete(key)
      continue
    }
    result.set(key, monthPath)
  }
  return result
}

// Reads `<dir>/default.yaml` (template) and `<dir>/<month>.yaml` (override), if
// they exist, and merges them. Fails if neither is present.
export function loadBudget(dir: string, month: string): { limits: Map<string, LimitSpec>; sources: string[]; keySources: Map<string, string> } {
  const defaultPath = join(dir, 'default.yaml')
  const monthPath = join(dir, `${month}.yaml`)
  const sources: string[] = []

  let base: BudgetFile | null = null
  if (existsSync(defaultPath)) {
    base = parseBudgetFile(readFileSync(defaultPath, 'utf8'), defaultPath)
    sources.push(defaultPath)
  }
  let monthFile: BudgetFile | null = null
  if (existsSync(monthPath)) {
    monthFile = parseBudgetFile(readFileSync(monthPath, 'utf8'), monthPath)
    sources.push(monthPath)
  }
  if (sources.length === 0) {
    throw new ZmError('INVALID_ARGS', `no budget files found in ${dir}`, 'run zm budget init')
  }
  return { limits: mergeBudget(base, monthFile), sources, keySources: keySources(base, monthFile, defaultPath, monthPath) }
}
