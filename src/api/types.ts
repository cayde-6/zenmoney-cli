export interface ZmInstrument { id: number; title: string; shortTitle: string; symbol: string; rate: number; changed: number }
export interface ZmUser { id: number; login: string | null; currency: number; parent: number | null; changed: number }
export type AccountType = 'cash' | 'ccard' | 'checking' | 'loan' | 'deposit' | 'emoney' | 'debt'
export interface ZmAccount {
  id: string; user: number; instrument: number | null; type: AccountType; title: string
  balance: number | null; inBalance: boolean; archive: boolean; changed: number
}
export interface ZmTag {
  id: string; user: number; title: string; parent: string | null
  showIncome: boolean; showOutcome: boolean; archive?: boolean; changed: number
}
export interface ZmMerchant { id: string; user: number; title: string; changed: number }
export interface ZmTransaction {
  id: string; user: number; date: string
  income: number; outcome: number; incomeAccount: string; outcomeAccount: string
  incomeInstrument: number; outcomeInstrument: number
  tag: string[] | null; merchant: string | null; payee: string | null; comment: string | null
  deleted: boolean; created: number; changed: number
  // Present on some raw ZenMoney transactions but not otherwise modeled by
  // this CLI: kept on the type (and thus preserved verbatim in the cache's
  // raw json and in `zm tx` output) rather than silently dropped.
  // `hold` marks a not-yet-settled ("pending") transaction; it's classified
  // and aggregated exactly like a normal one — see docs/architecture.md.
  hold?: boolean
  opIncome?: number; opOutcome?: number
  opIncomeInstrument?: number; opOutcomeInstrument?: number
  originalPayee?: string | null
}
export interface ZmDeletion { id: string; object: string; stamp: number; user: number }
export interface ZmDiff {
  serverTimestamp: number
  instrument?: ZmInstrument[]; user?: ZmUser[]; account?: ZmAccount[]; tag?: ZmTag[]
  merchant?: ZmMerchant[]; transaction?: ZmTransaction[]; deletion?: ZmDeletion[]
  [other: string]: unknown
}
export type EntityKind = 'instrument' | 'user' | 'account' | 'tag' | 'merchant' | 'transaction'
export interface EntityMap {
  instrument: ZmInstrument; user: ZmUser; account: ZmAccount; tag: ZmTag; merchant: ZmMerchant; transaction: ZmTransaction
}
export const ENTITY_KINDS: EntityKind[] = ['instrument', 'user', 'account', 'tag', 'merchant', 'transaction']
