# Batch Interoperability

## Objective
Complete focused OData v2 batch capabilities with observed strict TDD while preserving existing consumers.

## Problem and scope
Mixed reads and writes are currently mutually exclusive, MIME Content-ID is not exposed, flat results lose changeset boundaries, and response media type strings silently fall back to XML. Implement these four capabilities only; exclude v4 JSON batching, SDK generation, automatic write retries, remote service execution, and publishing.

## Constraints and decisions
- Strict TDD requested explicitly by the user: observe RED, implement GREEN, refactor with tests green.
- Preserve existing calls/retrieve and send() APIs, custom repositories, and existing flat parser results.
- Content-ID is explicit opt-in, validated against injection and duplicate identifiers within a changeset.
- Grouped results must preserve semantic changeset identity even for a single error response; use request context when the wire alone is ambiguous.
- Preserve untracked .agy-diagnostics/ and all unrelated work.
- No commits or remote operations are authorized. Commit evidence remains pending until explicitly requested.
- RDD: on, source default; candidate consent remains required by native transitions.

## Tasks
- [x] T1: Normalize and validate JSON/XML media type aliases and parameters; verify wire output and invalid-input behavior.
- [x] T2: Generate and parse MIME Content-ID; verify dependent resource references, invalid identifiers, and existing wire compatibility.
- [x] T3: Expose grouped changeset-aware results without breaking flat results or custom repository contracts; verify collapsed changeset failures followed by successful groups.
- [x] T4: Add ordered mixed retrieve/changeset operations without breaking legacy modes; verify ordering, invalid combinations, and end-to-end transport/parser behavior.

## Routing
All four tasks: delegated direct to one bounded writer. Preparation requires unfamiliar flow inspection, and each task involves multiple non-trivial source/test files. No parallel writers.

## Acceptance criteria and verification
Use existing Jest unit/component, golden-wire/edge, protocol, deterministic property, and axios-mock-adapter E2E layers where relevant. Observe meaningful failing assertions before production edits for each task; compilation-only RED is insufficient.

Commands: npm test -- --runInBand; npm run lint; npm run format:check; npm run build; npm run mutation. Mutating normalization precedes final checks and native review freeze. Mutation testing is a separate expensive check with an explicit forecast before launch. No live-server testing or new dependencies.

## Delivery and progress
Initial explorer forecast: approximately 330 authored changed lines; advisory only, never omit tests or compress code to fit. Strategy: ask-on-risk; chain choice remains pending if needed before an authorized commit. No PR planned. Reviewed boundary: current HEAD before implementation.

T1 implementation evidence: baseline 218 tests passed; focused RED had 63 assertion failures; initial GREEN 109 tests; refactor GREEN 115 tests; full suite 291 tests; lint and diff check passed. Parent repeated the 115-test focused command successfully. T1 closure checks now pass alongside T2: full suite 334 tests, lint, format check, and build.

Known environmental failures (resolved): npm run format:check previously reported existing formatting in src/response.ts and tests/response.property.test.ts, tests/response.protocol.test.ts, tests/response.test.ts, tests/response.wire.test.ts. These authorized files were normalized during T2. npm run build previously failed TS5011 because tsconfig.json lacked explicit rootDir for src with the current TypeScript version. Adding rootDir: src fixed the build; include and output settings are unchanged. These non-runtime tooling prerequisites use the previously observed check failures as evidence, not a fabricated behavior-test RED. No checks were relaxed.

Build output: user explicitly approved the 21 existing dist JS/declaration/map output files. Work-unit commits: not authorized, pending. Engram mirror: observation 10265, topic odd/batch-interoperability/tasks; synchronization/readback status is reported in the writer handoff. Earlier worker writes failed because multiple active sessions matched; no identity was invented.

### T2 implementation and verification

Optional Call.contentId emits a MIME header before the inner HTTP request in both request shapes. Identifiers are nonempty HTTP tokens, case-sensitive, and unique within each changeset; independent changesets may reuse identifiers. Missing/undefined identifiers preserve legacy bytes. Dependent URLs such as $1/Lines pass through without identifier inference. Optional BatchResponseParsed.contentId comes only from nonempty MIME Content-ID headers, recognized case-insensitively even before Content-Type; inner HTTP headers and payloads are not used to infer IDs. Missing IDs preserve existing result shape.

Focused command: `npm test -- --runInBand tests/request.test.ts tests/request.edge.test.ts tests/request.property.test.ts tests/response.wire.test.ts tests/response.protocol.test.ts tests/response.property.test.ts tests/e2e.batch.test.ts`.

- Baseline: 7 suites, 147 tests passed before T2 edits.
- First RED attempt: 36 assertion failures, 136 passes, plus an E2E test-only TS2352 cast error. This compilation error is not claimed as behavior RED.
- Meaningful RED after correcting the test cast, still before source edits: 7 suites failed, 38 assertion failures and 152 passes (190 tests). Failures covered missing wire/parser IDs, invalid/duplicate identifier acceptance, and MIME header order.
- Intermediate implementation: 189 passes and one existing mismatched-boundary regression. Corrected MIME-part filtering preserved that behavior before GREEN.
- Initial GREEN: 7 suites, 190 tests passed.
- REFACTOR GREEN after sharing optional MIME-header emission and scoped normalization: 7 suites, 190 tests passed. Golden wire, edge/security, seeded properties, response protocol, and mocked axios coverage remain green.
- `npm test -- --runInBand`: 13 suites, 334 tests passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm run build`: passed; generated request/response declarations expose optional contentId fields.
- `git diff --check`: passed.

Normalization command: `./node_modules/.bin/prettier --write src/request.ts src/response.ts tests/request.test.ts tests/request.edge.test.ts tests/request.property.test.ts tests/response.test.ts tests/response.wire.test.ts tests/response.protocol.test.ts tests/response.property.test.ts tests/e2e.batch.test.ts`.

Mutation remains explicitly deferred. No remote service tests, commits, dependency changes, or native review were performed; the parent owns review and delivery. The cumulative tracked diff includes T1 and authorized formatting and exceeds the advisory 400-line heuristic; no tests or documentation were compressed to fit it. Diagnostics and unrelated work were preserved.

### T3 implementation and verification

Additive API: ODataBatch.sendGrouped() returns BatchResponseGroup[]. ODataBatchRepository may implement optional sendGrouped(url, batchRequest, config, accept, layout); existing send() and custom flat parser contracts remain unchanged. The default Axios grouped path posts once and parses the raw response with a request-layout snapshot, without calling flat send or inferring groups from flattened results. Unsupported custom repositories reject before transport.

Exported BatchResponse exposes groupedResponse without context and parseGrouped(layout?: BatchRequestLayout). Exported BatchRequestPart/BatchRequestLayout describe retrieve parts or changesets with operationCount. BatchResponseGroup discriminates changeset child responses, a whole changeset-error, contextual retrieve responses, and unclassified raw HTTP responses. partIndex preserves top-level identity. A three-operation changeset collapsed to one HTTP error followed by a successful two-operation changeset produces two groups and only three actual HTTP results, not five invented operation results. Nested child errors do not alone imply whole-changeset failure, and raw HTTP errors remain unclassified without layout.

Grouped validation is opt-in: MIME type/status shape, literal complete-line closing boundaries, top-level layout count/type, and multipart child counts are checked. Flat parser behavior is retained. README positional claims now distinguish actual wire responses from per-operation correspondence, which is not guaranteed after a changeset collapses. Explicit mixed layouts are supported by the parser/repository only; T4 mixed constructor input is not implemented.

Focused command: `npm test -- --runInBand tests/grouped.test.ts tests/response.wire.test.ts tests/response.protocol.test.ts tests/response.property.test.ts tests/ODataBatch.test.ts tests/ODataBatchAxiosRepository.test.ts tests/e2e.batch.test.ts`.

- Baseline: 6 suites, 194 tests passed before T3 edits; grouped.test.ts did not yet exist.
- Meaningful RED before source edits: 23 runtime failures and 194 passes (217 tests), covering absent grouped API/results, whole-changeset identity, layout validation, custom repository capability, and single-POST transport. No compilation-only RED.
- Initial GREEN: 7 suites, 217 tests passed.
- Additional public-entrypoint RED: 1 export assertion failure and 221 passes (222 tests); added negative MIME/status/boundary cases already passed.
- REFACTOR GREEN: shared unchanged request config creation and optional grouped parser export; after normalization, 7 suites and 222 tests passed. Seeded grouped properties cover 100 deterministic mixed-layout scenarios without fake results or shifted group identity.
- `npm test -- --runInBand`: 14 suites, 362 tests passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Normalization command: `./node_modules/.bin/prettier --write src/ODataBatch.ts src/response.ts src/BatchRepository.ts src/ODataBatchAxiosRepository.ts src/index.ts tests/grouped.test.ts tests/response.property.test.ts tests/ODataBatchAxiosRepository.test.ts tests/e2e.batch.test.ts`.

T1/T2 edits and diagnostics were preserved. Mutation remains deferred; no commits, dependency changes, network/remote service operations, or native review were performed. The advisory line heuristic remains exceeded, without test or documentation compression.

Next step: parent reviews the T3 handoff. T4 requires separate delegation and was not started; independent review and delivery remain parent-owned.

### T4 implementation and verification

Delegation note: the three delegated workers (gentle-ai-worker, -fallback) failed with provider "usage limit reached", so the delegation mechanism was unavailable. The parent completed T4 inline under the documented degradation path, keeping the strict RED→GREEN cycle; this is an observed process exception, not a design choice.

Additive API: ODataBatch accepts operations?: BatchOperation[] where BatchOperation = RetrieveCall | Call[]. Entries serialize in input order: a RetrieveCall becomes a direct application/http part (no changeset wrapper), a Call[] becomes one atomic changeset. Ordering, injection guards, per-changeset contentId rules, and boundary-collision reroll are shared with the existing serializers via operationsToBatch in src/request.ts. Legacy calls/retrieve modes are byte-for-byte unchanged. The constructor rejects operations combined with calls or retrieve (preserving the legacy 'Pass either calls or retrieve, not both' message for that pair) and rejects empty operations. requestLayout now includes retrieve/changeset entries so sendGrouped consumes a mixed request end to end. Mixed support remains additive to T3's parser/repository contracts.

Focused command: `npm test -- --runInBand tests/operations.test.ts`.

- Baseline (T1-T3 final): 15 suites, 362 tests passed.
- Meaningful RED before source edits: 9 failures / 5 passes (14 tests), demonstrating the missing operationsToBatch export, missing operations constructor option/layout, and absent mutual-exclusion. An earlier compile-only error was corrected so the suite ran and failed on behavior, not types.
- GREEN: 14 tests passed after wiring operationsToBatch and the operations branch.
- `npm test -- --runInBand`: 15 suites, 376 tests passed.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Normalization command: `./node_modules/.bin/prettier --write src/request.ts src/ODataBatch.ts tests/operations.test.ts`.

T1-T3 edits and diagnostics were preserved. Mutation remains deferred to the parent's final gate. No commits, dependency changes, network/remote service operations, or native review were performed. The cumulative tracked diff remains above the advisory 400-line heuristic; no tests or documentation were compressed to fit it.

Next step: parent runs the deferred mutation gate and, when the user authorizes it, the native review candidate consent; commits and delivery remain parent- and user-owned.

### Mutation gate

Stryker (jest runner, coverageAnalysis perTest, 4 workers) mutating src/**/*.ts.

Baseline after T1-T4, before hardening (376 tests):

- All files 84.52% total / 90.01% covered; 744 killed, 4 timeout, 83 survived, 54 no coverage.
- request.ts 73.68% (52 survived, 48 no coverage); response.ts 91.51% (25 survived); ODataBatch.ts 95.62% (6 survived).
- Survivors concentrated in new code: isXmlMediaType branches, operationsToBatch byte literals/boundary reroll, and parseGrouped branch conditions asserted only through loose toThrow(/Grouped response/) regexes.

Hardening (test-only, +15 tests, no production change): byte-exact substrings for the mixed direct part and changeset block, boundary-collision reroll and give-up, exact guard messages, isXmlMediaType branch coverage (text/xml, application/atom+xml, parameterized, case-insensitive), and exact per-branch messages plus MIME/status/boundary branch cases for the grouped parser. The unreachable-in-practice readGroupedMime missing-separation branch is exercised by calling the helper directly.

After hardening (391 tests):

- All files 91.86% total / 95.87% covered; 805 killed, 8 timeout, 35 survived, 37 no coverage.
- request.ts 87.63% (10 survived); response.ts 94.79% (19 survived); ODataBatch.ts 95.62% (6 survived).
- Remaining survivors are mostly equivalent mutants (trim on already-trimmed input, post-increment) or pre-existing legacy parser branches, not the new capabilities. No further high-value test-only target identified.

Commands: `npm run mutation`. No production source changed for the hardening; no commits authorized.

Next step: parent presents the native review candidate consent when the user authorizes it; commits and delivery remain parent- and user-owned.

### Native review (RDD)

Candidate: lineage review-465abc9ac254bce9, target sha256:24188a7c..., 22 paths, 2384 changed lines, risk medium. Intended untracked selected: this document, tests/grouped.test.ts, tests/operations.test.ts (excluding .agy-diagnostics/). Consent granted by the user; plan was one consolidated reassurance lens (review-reliability).

Outcome: approved on the last admitted event; acknowledgement burned authority (gentle-ai.review-acknowledged/v1, authority: burned). No correction transition was offered.

One non-blocking advisory finding (R3-preamble-filter-regression, WARNING, deterministic, introduced): the multiline Content-Type filter added in T2 (src/response.ts:289) admits a MIME preamble whose first header block contains a content-type-looking line, before the first real delimiter. The preamble then reaches parseResponse without a MIME/HTTP separator, so responseParts[1] is undefined and it throws. The base's string-start filter skipped such a preamble. The finding is confirmed independently against the compiled dist:

- plain preamble, no header-like line: parses 1 response (OK).
- preamble with a content-id line: parses 1 response (OK).
- preamble with a Content-Type line: throws "Cannot read properties of undefined (reading 'split')".

This is separate later work; it must not re-run review on this approved candidate. A fix would be a new candidate needing its own review. Suggested direction: exclude the preamble structurally (drop the segment before the first delimiter) while still admitting Content-ID-first real parts, plus a public-parser regression assertion.

No commits were made; delivery remains parent- and user-owned.

### Post-review fix (separate work)

User-authorized fix for the advisory finding, as a new candidate with its own TDD cycle (the approved candidate above is not re-reviewed).

Fix: src/response.ts parseBatch now drops the RFC 2046 preamble structurally. The body is split on the batch delimiter and, when the normalized body does not start with the delimiter, the first segment (the preamble) is sliced off before filtering. A preamble that happens to contain a header-looking line can no longer be parsed as a response. Content-ID-first real parts are preserved.

- RED: tests/response.wire.test.ts "MIME preamble before the first boundary" — the Content-Type-looking preamble case failed with "Cannot read properties of undefined (reading 'split')" (1 failed / 46 passed), the same failure independently confirmed against dist.
- GREEN: after the change, 47 tests in that suite pass.
- Full verification: 15 suites, 396 tests passed; lint, format:check, build, and git diff --check passed.
- Independent dist confirmation: plain preamble, Content-Type-looking preamble, Content-ID-looking preamble, and no-preamble all parse one response with code 200 (previously the Content-Type-looking case threw).

New regression tests: four preamble shapes (plain, Content-Type-looking, Content-ID-looking, and a header-looking line after a blank line) plus a Content-ID-first part with no preamble.

Native review of the fix (new candidate): lineage review-0d6918df0864c2d9, target sha256:27b8a0df..., 22 paths, 2471 changed lines, risk medium, one consolidated review-reliability lens. Outcome: approved with zero findings; acknowledgement burned authority (gentle-ai.review-acknowledged/v1, authority: burned). No correction transition.

No commits were made; both candidates are approved and delivery remains parent- and user-owned.
