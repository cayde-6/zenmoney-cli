import type { Store } from '../store/store.js'
import type { ZmAccount, ZmInstrument, ZmTag, ZmTransaction, ZmUser } from '../api/types.js'
import { ZmError } from '../errors.js'
import { matchOwners, type OwnersFile } from './owners.js'

export type TxType = 'expense' | 'income' | 'refund' | 'transfer' | 'debt'

export interface Tx {
  id: string; date: string; type: TxType
  amount: number; currency: string // primary side, positive
  accountId: string; accountTitle: string; ownerId: number
  // Owner name from owners.yaml's match against the primary-side account, or
  // null when there's no owners.yaml (see Dataset.ownerNames) or the account
  // is unassigned in it. Independent of `ownerId`, which is always the
  // ZenMoney user id regardless of owners.yaml.
  owner: string | null
  categoryId: string | null; topCategoryId: string | null
  categoryPath: string // 'Food/Cafe', 'Groceries', 'Uncategorized'
  merchant: string | null // merchant title, else payee
  payee: string | null // raw payee text as entered, independent of a resolved merchant
  comment: string | null
  hold: boolean // ZenMoney's own marker for a not-yet-settled/pending transaction; never affects classification/aggregation
  originalPayee: string | null // payee text ZenMoney recorded before any user edit/merchant resolution, if present
  counterpart?: { accountId: string; accountTitle: string; amount: number; currency: string } // transfer/debt other side
}

export interface Dataset {
  users: ZmUser[]; accounts: Map<string, ZmAccount>; tags: Map<string, ZmTag>
  instruments: Map<number, ZmInstrument>; txs: Tx[]
  // null when no owners.yaml exists at all — callers (see query/filters.ts's
  // resolveOwner vs. resolveOwnerName) use that to decide whether `--owner`
  // still means today's ZenMoney-user semantics (me/login/id) or the new
  // name/unassigned semantics. Non-null (even if empty) once the file exists.
  ownerNames: string[] | null
  ownerOf: Map<string, string> // accountId -> owner name, from owners.yaml; empty when ownerNames is null
}

export const NO_CATEGORY = 'Uncategorized'

export function classify(t: ZmTransaction, accounts: Map<string, ZmAccount>, tags: Map<string, ZmTag>): TxType {
  const incomeAccount = accounts.get(t.incomeAccount)
  const outcomeAccount = accounts.get(t.outcomeAccount)
  if (incomeAccount?.type === 'debt' || outcomeAccount?.type === 'debt') return 'debt'
  if (t.income > 0 && t.outcome > 0 && t.incomeAccount !== t.outcomeAccount) return 'transfer'
  if (t.outcome > 0) return 'expense'
  // t.income > 0 here: loadDataset already excludes transactions where both
  // income and outcome are 0 before ever calling classify, so this is the
  // only remaining case — no unreachable trailing `return 'expense'` needed.
  const firstTagId = t.tag?.[0] ?? null
  const firstTag = firstTagId ? tags.get(firstTagId) : undefined
  if (firstTag && firstTag.showOutcome && !firstTag.showIncome) return 'refund'
  return 'income'
}

export function categoryPath(tagId: string | null, tags: Map<string, ZmTag>): string {
  if (!tagId) return NO_CATEGORY
  const tag = tags.get(tagId)
  if (!tag) return NO_CATEGORY
  const titles: string[] = []
  let current: ZmTag | undefined = tag
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    titles.unshift(current.title.trim())
    current = current.parent ? tags.get(current.parent) : undefined
  }
  return titles.join('/')
}

function topCategoryIdOf(tagId: string | null, tags: Map<string, ZmTag>): string | null {
  if (!tagId) return null
  const tag = tags.get(tagId)
  if (!tag) return null
  if (!tag.parent) return tag.id
  // A parent id that doesn't resolve to any known tag (a dangling reference)
  // is treated as top-level under its own id, consistent with categoryPath
  // (which already falls back to the tag's own title in this case) and with
  // `categories --tree`.
  return tags.has(tag.parent) ? tag.parent : tag.id
}

// `ownersFile` is the already-parsed owners.yaml (see query/owners.ts's
// loadOwnersFile), or null/omitted when the family has no owners.yaml at
// all — every CLI command that opens a Dataset loads it once from
// ctx.paths.configDir and passes it through here, rather than this function
// touching the filesystem itself.
export function loadDataset(store: Store, ownersFile: OwnersFile | null = null): Dataset {
  const users = store.all('user')
  const accounts = new Map(store.all('account').map(a => [a.id, a]))
  const tags = new Map(store.all('tag').map(t => [t.id, t]))
  const instruments = new Map(store.all('instrument').map(i => [i.id, i]))
  const merchants = new Map(store.all('merchant').map(m => [m.id, m]))
  const ownerNames = ownersFile ? [...ownersFile.owners.keys()] : null
  const ownerOf = ownersFile ? matchOwners(accounts, ownersFile) : new Map<string, string>()

  const txs: Tx[] = []
  for (const t of store.all('transaction')) {
    if (t.deleted) continue
    if (t.income === 0 && t.outcome === 0) continue // carries no money, never a real expense/income
    const type = classify(t, accounts, tags)
    const firstTagId = t.tag?.[0] ?? null
    // A tag id that doesn't resolve to any known tag (deleted/never-synced)
    // is treated exactly like no tag at all: categoryId/topCategoryId null,
    // categoryPath the shared NO_CATEGORY constant.
    const catId = firstTagId !== null && tags.has(firstTagId) ? firstTagId : null
    const catPath = categoryPath(catId, tags)
    const topCategoryId = topCategoryIdOf(catId, tags)

    const payee = t.payee ? t.payee.trim() || null : null
    const merchantTitle = t.merchant ? merchants.get(t.merchant)?.title : undefined
    const merchant = merchantTitle ?? payee
    const comment = t.comment ? t.comment.trim() || null : null
    const hold = t.hold ?? false
    const originalPayee = t.originalPayee ? t.originalPayee.trim() || null : null

    let accountId: string, amount: number, instrumentId: number
    let counterpart: Tx['counterpart']

    if (type === 'expense') {
      accountId = t.outcomeAccount
      amount = t.outcome
      instrumentId = t.outcomeInstrument
    } else if (type === 'income' || type === 'refund') {
      accountId = t.incomeAccount
      amount = t.income
      instrumentId = t.incomeInstrument
    } else if (type === 'transfer') {
      accountId = t.outcomeAccount
      amount = t.outcome
      instrumentId = t.outcomeInstrument
      const cpAccount = accounts.get(t.incomeAccount)
      counterpart = {
        accountId: t.incomeAccount,
        accountTitle: cpAccount?.title ?? t.incomeAccount,
        amount: t.income,
        currency: instruments.get(t.incomeInstrument)?.shortTitle ?? '',
      }
    } else {
      // debt: primary side is the non-debt account
      const outcomeIsDebt = accounts.get(t.outcomeAccount)?.type === 'debt'
      if (outcomeIsDebt) {
        accountId = t.incomeAccount
        amount = t.income
        instrumentId = t.incomeInstrument
        const cpAccount = accounts.get(t.outcomeAccount)
        counterpart = {
          accountId: t.outcomeAccount,
          accountTitle: cpAccount?.title ?? t.outcomeAccount,
          amount: t.outcome,
          currency: instruments.get(t.outcomeInstrument)?.shortTitle ?? '',
        }
      } else {
        accountId = t.outcomeAccount
        amount = t.outcome
        instrumentId = t.outcomeInstrument
        const cpAccount = accounts.get(t.incomeAccount)
        counterpart = {
          accountId: t.incomeAccount,
          accountTitle: cpAccount?.title ?? t.incomeAccount,
          amount: t.income,
          currency: instruments.get(t.incomeInstrument)?.shortTitle ?? '',
        }
      }
    }

    const account = accounts.get(accountId)
    const ownerId = account?.user ?? t.user
    const owner = ownerOf.get(accountId) ?? null

    txs.push({
      id: t.id, date: t.date, type,
      amount, currency: instruments.get(instrumentId)?.shortTitle ?? '',
      accountId, accountTitle: account?.title ?? accountId, ownerId, owner,
      categoryId: catId, topCategoryId,
      categoryPath: catPath,
      merchant,
      payee,
      comment,
      hold,
      originalPayee,
      ...(counterpart ? { counterpart } : {}),
    })
  }

  txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))

  return { users, accounts, tags, instruments, txs, ownerNames, ownerOf }
}

// Spend = expense and refund txs (income/transfer/debt are never "spend").
// Shared by analytics/spend.ts, analytics/compare.ts, budget/status.ts and
// budget/suggest.ts so the definition can't drift between them.
export function isSpendTx(t: Tx): boolean {
  return t.type === 'expense' || t.type === 'refund'
}

// Net sum sign for a spend tx: expense adds, refund subtracts.
export function spendSign(t: Tx): number {
  return t.type === 'expense' ? t.amount : -t.amount
}

export function meUser(ds: Dataset): ZmUser {
  const user = ds.users.find(u => u.parent === null)
  if (!user) throw new ZmError('NO_CACHE', 'cache has no main user', 'run zm sync --full')
  return user
}

export type MerchantSource = 'merchant' | 'payee' | 'originalPayee' | 'comment'

// Shared by analytics/recurring.ts and analytics/spend.ts (`spend --by
// merchant`), so the two commands can never disagree on what a transaction's
// "merchant" is. Real ZenMoney expenses often have no merchant match and no
// payee at all — the only human-readable text is the free-form comment (e.g.
// a subscription name like 'Netflix' or 'iCloud') — so this falls back
// through merchant -> payee -> originalPayee -> comment, using the first one
// that's non-empty after trimming. `source` reports which field the label
// actually came from, so callers can tell a real merchant/payee match apart
// from a comment-derived guess.
export function merchantLabel(t: Tx): { label: string; source: MerchantSource } | null {
  const candidates: [string | null, MerchantSource][] = [
    [t.merchant, 'merchant'],
    [t.payee, 'payee'],
    [t.originalPayee, 'originalPayee'],
    [t.comment, 'comment'],
  ]
  for (const [value, source] of candidates) {
    const trimmed = value?.trim()
    if (trimmed) return { label: trimmed, source }
  }
  return null
}
