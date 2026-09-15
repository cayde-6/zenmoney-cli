import { defineConfig } from 'tsup'
export default defineConfig({
  // tsup's default removeNodeProtocol strips the `node:` prefix from all node:
  // imports (assuming the bare name is always a valid legacy alias). node:sqlite
  // has no bare-name alias, so that default turns our external import into an
  // unresolvable `from "sqlite"` — keep the prefix.
  entry: ['src/bin.ts'], format: ['esm'], target: 'node22', platform: 'node',
  clean: true, banner: { js: '#!/usr/bin/env node' }, external: ['node:sqlite'], removeNodeProtocol: false,
})
