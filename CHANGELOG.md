# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-15

Initial release.

### Added

- **Auth & sync**: `zm auth` (token via prompt, stdin, `--token`, or
  `ZENMONEY_TOKEN`; macOS Keychain or `config.json` storage; `--logout`),
  `zm sync` (incremental and `--full`).
- **Reference data**: `zm users`, `zm accounts` (`--archived`),
  `zm categories` (`--tree`), `zm rates`.
- **Transactions**: `zm tx` with period (`--from`/`--to`/`--month`),
  category (parent includes subcategories), account, currency, owner,
  `--type`, `--search`, and `--limit` filters.
- **Analytics**: `zm spend` (by category/month/merchant, with `--tree`),
  `zm income` (by category/month), `zm compare` (two periods, by total or
  category), `zm recurring` (subscription/recurring-payment detection).
- **Budget**: `zm budget init` (template from real categories),
  `zm budget status` (plan vs actual, pace, unplanned spend),
  `zm budget suggest` (draft from historical medians).
- **Output**: `--format json|table` on every command; a `{ data, meta,
  warnings? }` JSON envelope; stable exit codes (0 success, 1 unexpected
  error, 2 invalid arguments, 3 auth, 4 network, 5 no local cache).
- **For agents**: `SKILL.md`, linked from `zm --help`, documenting the
  command reference, currency-safety rule, and common recipes.
