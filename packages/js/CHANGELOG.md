# Changelog

## Unreleased

### Changed

- `normalizeIr(node, { includeResolution: true })` no longer discards the
  `type` / `ret` / `retType` subtrees wholesale: the `origin.written` / `role`
  records inside them are kept as ordered `typeResolutions` / `retResolutions`
  / `retTypeResolutions` lists (canonical name, written form, role, start line).
  Inferred type shapes are still ignored. The default path (`contentHash`) is
  byte-for-byte unchanged. Parity comparisons are therefore stricter: signature
  and field types resolved through a vocabulary are now compared across engines
  (minor bump for the next release).

## 1.1.0

### Breaking

- `normalizeIr(node, options)` now takes an options object
  `{ originMode?, includeResolution? }` instead of positional arguments.
  `includeResolution` defaults to `false`, so `contentHash` inputs are
  unchanged; parity comparisons pass `includeResolution: true` to also compare
  `origin.written` / `origin.role` (ADR 0051).

### Added

- Tier-1 parity corpus with corpus-carried vocabularies (`<case>.vocab.json`)
  and shared envelope vectors (`corpus/shared-vectors/envelope-vectors.json`)
  for ADR 0051.
