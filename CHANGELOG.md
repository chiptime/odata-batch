# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-10-22

### Security

- **CSPRNG boundaries (FR-01, FR-08):** outer batch boundary and inner changeset boundaries are now generated using cryptographically secure random identifiers (`crypto.randomUUID`), replacing pseudo-random and timestamp sources (`Math.random` and `new Date().getTime()`).
- **Outer boundary collision detection (FR-01):** `requestsToBatch` and `operationsToBatch` now check payloads for collisions with the outer `--batch_${boundary}` delimiter in addition to inner changeset boundaries, with up to 10 retry attempts before throwing `Unable to generate a batch boundary that does not collide with the payload`.
- **CRLF injection defense-in-depth (FR-02, FR-03):** `ODataBatch` constructor validates `auth` against line breaks (`\r`/`\n`), throwing `Call auth must not contain line breaks` without echoing credential values. Batch-level root `headers` keys and values are similarly validated, throwing `Call header '<key>' must not contain line breaks`.
- **RFC 9110 HTTP method token validation (FR-07):** `Call.method` is strictly validated against the RFC 9110 token specification, rejecting whitespace, control characters, and separators with `Call method must be a valid HTTP token`.
- **Anchored multipart delimiters (FR-04):** `parseBatch` now anchors boundary matching to line starts (`^--...` with multiline mode), preventing JSON and text payloads containing delimiter substrings from being fragmented.
- **Robust changeset boundary extraction (FR-06):** `parseBatch` supports quoted boundaries (RFC 2046) and parameters (e.g. `charset=utf-8`), avoiding silent drops of changeset operations.
- **Resilient response parsing (FR-05):** `parseResponse` safely handles truncated or malformed parts missing blank-line header separation without throwing an uncaught `TypeError`.

### Behavior changes

- Boundaries on generated batches and changesets now follow UUID formatting instead of millisecond timestamps or `Math.random` floats.
- Inner response parts with truncated or malformed HTTP headers now return `{ code: '', status: '', headers: [], data: <raw>, success: false }` instead of throwing an unhandled `TypeError`.
- HTTP methods in `Call` objects must be valid RFC 9110 tokens (e.g., methods with spaces or control characters throw `Call method must be a valid HTTP token`).
- Passing line breaks in `auth` or batch-level root `headers` throws immediately at construction time.

## [3.0.0] - 2026-10-12

This is a major release. Two observable behaviors of the `string`-typed
response-type options changed, so code that compiled before can now throw or
parse differently. See the **BREAKING** items in Changed.

### Added

- **JSON/XML media types with parameters.** `batchResponseType` and
  `individualResponseType` now accept `json`/`xml`, `application/json`,
  `application/xml`, `text/xml` and `application/atom+xml`, case-insensitively,
  and preserve MIME parameters such as `application/json;odata=verbose` or
  `application/xml;charset=utf-8` on the wire and in the inner `Content-Type`
  and `Accept` headers.
- **MIME `Content-ID` for dependent operations.** Set optional `Call.contentId`
  (a nonempty HTTP token, unique per changeset) to emit a MIME `Content-ID`
  header, so a later operation in the same changeset can reference a newly
  created entity (e.g. `$1/Lines`). Parsed responses expose the server ID as
  `BatchResponseParsed.contentId` (MIME headers only, matched case-insensitively
  and in any order).
- **Changeset-aware grouped responses.** `sendGrouped(): Promise<BatchResponseGroup[]>`
  returns one group per top-level request part (`changeset`, `changeset-error`,
  `retrieve`, `unclassified`) with a stable `partIndex`, so a changeset that
  collapses to a single error keeps its identity instead of shifting later
  results. The exported `BatchResponse` parser adds `parseGrouped(layout?)` and
  `groupedResponse`; custom repositories may implement the optional
  `sendGrouped(...)` method (unsupported repositories reject before transport).
- **Ordered mixed batches.** Pass `operations: (RetrieveCall | Call[])[]` to
  interleave direct GET parts and atomic changesets in one `$batch`, preserving
  input order and reusing the existing injection, `Content-ID` and
  boundary-collision guards.
- New exports: `BatchResponse`, `BatchRequestPart`, `BatchRequestLayout`,
  `BatchResponseGroup`, `BatchOperation`.

### Changed

- **BREAKING** an unsupported or malformed response-type value now throws
  `<option> must be a supported JSON or XML media type` at construction instead
  of silently falling back to XML. Valid `json`/`xml` aliases and legacy
  defaults are unchanged.
- **BREAKING** the flat response parser now keeps parts whose MIME headers start
  with `Content-ID`, previously dropped because the filter required
  `Content-Type` first.
- `send()` is documented precisely: it resolves to one entry per actual inner
  HTTP response, in wire order; a failed changeset can collapse to a single
  error, so one-to-one positional mapping to the calls is not guaranteed.
  `calls`, `retrieve` and `operations` are mutually exclusive.
- **Behavior:** the payload parsing mode is selected by the accept media type
  before `;` (trimmed, case-insensitive), so `application/json;odata=verbose`
  now parses as JSON. Other accepts (e.g. `application/xml`) stay raw text.
- **Behavior:** non-JSON payloads are no longer truncated at the first line or
  the first blank line: `data` is everything after the status/headers block
  with only the trailing framing CRLFs trimmed.
- **Behavior:** header lines split at the FIRST colon with optional whitespace
  trimmed from name and value (RFC 7230); lines without a colon still yield
  `{key:'',value:''}`.
- **Behavior:** the status-line regex allows an empty reason phrase
  (RFC 7230), and an unparseable status line now yields `success: false`
  (with `code: ''`) instead of `success: true`.
- **Behavior:** LF-only (or mixed LF/CRLF) response bodies are normalized to
  CRLF before parsing, so they parse instead of silently returning `[]`.

### Fixed

- A MIME preamble containing a header-looking line before the first boundary no
  longer crashes the parser: the preamble is excluded structurally before the
  parts are filtered.
- Response parser tolerates empty or whitespace-only payloads with JSON accept
  (e.g. `204 No Content`): `data` is `null` instead of a thrown `SyntaxError`.
  Non-JSON accept keeps the previous `''`.
- Batch and changeset boundaries are matched literally even when they contain
  regex metacharacters (legal per RFC 2046): previously they were interpolated
  unescaped into the split `RegExp`, silently yielding zero or corrupted parts.
- The `content-type` response header is now found case-insensitively
  (RFC 9110); previously only the exact lowercase key worked, and any other
  casing threw `Missing content-type header`.
- One part with an unparseable JSON body no longer throws and loses its
  siblings: `data` becomes the raw payload string for that part only.

### Engineering

- TypeScript: explicit `rootDir: "src"` so `tsc` emits `dist` with the current
  toolchain.
- 396 tests across unit, golden-wire, protocol, seeded-property and
  mocked-transport E2E layers; 91.86% mutation score.

## [2.1.0] - 2026-10-02

### Added

- **Read-only batches (retrieve mode).** Pass `retrieve: RetrieveCall[]` to
  `ODataBatch` — mutually exclusive with `calls` (`Pass either calls or
  retrieve, not both`) — to emit each GET as a direct `application/http` batch
  part, the OData V2 retrieve wire format, instead of wrapping operations in a
  changeset. Retrieve entries are GET-only by construction: a `method` or
  `data` property throws `retrieve calls are GET-only: method and data are
  not allowed`. Per-part `Accept` derives from `individualResponseType` (a
  custom `accept` header is replaced by it; a custom `content-type` header is
  dropped), and urls/headers keep the line-break injection guard. New exported
  type `RetrieveCall`. The existing `calls` modes and their wire output are
  unchanged.

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
