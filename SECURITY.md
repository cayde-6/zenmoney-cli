# Security Policy

## Supported versions

Until a stricter policy is defined, only the latest published release
receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Instead, report it privately via GitHub security advisories or by
contacting the maintainer directly through GitHub.

When reporting, include:

- affected version
- reproduction steps
- impact assessment
- whether a ZenMoney token, cache contents, or budget files may be exposed

## Secrets and privacy expectations

- never commit a real ZenMoney API token, or any file containing one
  (`config.json`, the SQLite cache, exported data)
- never share your local cache (`~/.cache/zm/zm.sqlite`) or budget yaml
  files (`~/.config/zm/budget/*.yaml`) — they can contain real account
  names, categories, and transaction amounts
- redact account names, merchant names, and amounts from logs, screenshots,
  and issue reports
- prefer `zm auth`'s prompt or piped stdin over `--token`, which ends up in
  shell history and is visible to other processes via the process list
