# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-15

Everything since `1.2.0`. This is a major release: the runtime dependency jumped
a major version and three wire-format behaviors changed. See
**Migrating from 1.x** in the README before upgrading.

### Added

- **Multiple changesets per batch.** Pass `Call[][]` instead of `Call[]` to group
  operations into atomic changesets; each group gets a unique boundary and every
  parsed response carries a `changesetIndex`. The legacy `Call[]` wire format is
  byte-identical to 1.2.0.
- Constructor validation: empty `calls`, empty changeset sub-arrays, and inputs
  missing calls are rejected with a clear error.
- Line-break injection guard: `Call` urls, methods and header keys/values
  containing `\r` or `\n` throw instead of producing a corrupted MIME part.
- Changeset boundary-collision guard: if a serialized payload already contains
  the generated boundary delimiter, the boundary is regenerated (up to 10
  attempts, then throws).
- Response parser accepts `HTTP/1.0` status lines (previously parsed as an
  empty code with `success: true`).
- Response parser unwraps RFC 2046 quoted boundary parameters
  (`boundary="abc"`), previously treated as an unmatched boundary.
- Descriptive error when the response has no `content-type` header (was a raw
  `TypeError`).
- New type exports: `Call`, `BatchRequestConfig`, `BatchResponseParsed`.

### Changed

- **BREAKING** `axios` runtime dependency upgraded from `0.21.1` to `^1.20.0`.
- **BREAKING** `auth` values containing `:` are now base64-encoded (utf-8)
  before being sent as `Authorization: Basic ...`, per RFC 7617. Colon-less
  values (pre-encoded credentials or opaque tokens) pass through untouched.
  Pre-1.x behavior sent every value raw.
- **BREAKING** `BatchResponseParsed.data` type changed from `any[]` to `any`
  (the old type was wrong — parsed payloads were never arrays).
- The `ODataBatchRepository` interface is fully typed
  (`send(...): Promise<BatchResponseParsed[]>`, `config: BatchRequestConfig`);
  custom adapters using `any` keep compiling.

### Fixed

- Parser returned an empty array for conforming responses behind HTTP/1.0
  proxies and for servers that quote the boundary parameter.
- Internal: build output structure, strict TypeScript (`noImplicitAny`),
  zero `npm audit` vulnerabilities in the dependency tree.

### Engineering

- Toolchain: TypeScript 5.9, Jest 30, ESLint 10 (flat config), Prettier 3.
- 145 tests, 100% line and branch coverage, 99.32% mutation score (Stryker;
  the 2 remaining survivors are provably equivalent mutants).

## [1.2.0]

- Per-call custom headers, with `Content-Type`/`Accept` override.

## [1.1.0]

- Documentation and module import example.

## [1.0.1]

- Initial public API refinements.

## [1.0.0]

- Initial release: OData V2 `$batch` request building and response parsing
  over axios.
