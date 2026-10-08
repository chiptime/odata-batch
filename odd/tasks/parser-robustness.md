# Feature: parser-robustness

Branch: `fix/parser-robustness` (from `chore/typescript-6`). Target version: 2.2.0 (release itself is a separate user decision).

## Objective
Make `BatchResponse` (`src/response.ts`) robust against valid-but-unusual `$batch` responses so one odd part never destroys the whole result or silently yields wrong data.

## Why
Probing with synthetic CRLF batches (2026-10-08) confirmed 9 defects. Tests only used well-formed inputs. Evidence: Engram `parser/robustness-gaps`.

## Scope / authorized
User authorized fixing group A (bugs) AND group B (behavior pinned by current tests; those tests get updated). Only `src/response.ts`, response tests, CHANGELOG/README/PENDING. No public API signature changes. No version bump, no publish, no push.

## Decisions (parent-owned)
| # | Defect | Decided behavior |
|---|---|---|
| A1 | 204 / empty body + JSON accept throws | Empty or whitespace-only payload with JSON accept => `data: null`. Non-JSON accept keeps `''`. |
| A2 | Boundary used unescaped in RegExp | Escape regex metacharacters for batch AND changeset boundaries. |
| A3 | One unparseable JSON part throws, losing siblings | Never throw per part: on JSON.parse failure `data` = raw payload string. Replaces the old "throws SyntaxError" test. |
| A4 | `headers['content-type']` case-sensitive | Case-insensitive lookup of the content-type key. |
| B5 | `application/json;odata=verbose` not parsed | JSON mode when the media type (before `;`, trimmed, case-insensitive) is `application/json`. Other accepts stay raw text. |
| B6 | Non-JSON payload truncated at first line / first blank line | Payload = everything after the status/headers block, with trailing CRLFs trimmed; no truncation. |
| B7 | `Key:value` (no space) => empty key; split at LAST ": " | Split at FIRST colon, trim optional whitespace (RFC 7230). Lines with no colon still yield `{key:'',value:''}`. |
| B8 | Empty reason phrase => code '' ; unknown code => success true | Status regex allows empty reason. Unparseable status line => `success: false`. 1xx/2xx/3xx stay success. |
| B9 | LF-only body => `[]` silently | Normalize `\r?\n` to `\r\n` at the start of `parseBatch`. |

## Tasks
- [x] T1 (A1-A4): done. Route: delegated writer (trigger: 2+ non-trivial files). 196 tests, 100% cov, tsc+lint clean. RED 23 failed -> GREEN 85/85.
- [x] T2 (B5-B9): done. Route: delegated writer. 214 tests, 100% cov. RED 25 failed -> GREEN. Also fixed latent case-sensitive changeset split (i flag).
- [ ] T3: extend property/fuzz tests (arbitrary RFC 2046 boundaries, round-trip with `requestsToBatch`), CHANGELOG `Unreleased`, README note, PENDING.md refresh. Route: delegated writer.

## Checks
`npx tsc --noEmit`, `npm run lint`, `npm test` (170 tests at start; 100% line/branch coverage must hold), `npm run mutation` at the end.

## Delivery
Strategy `ask-on-risk`. Forecast ~500 authored lines (mostly tests) > 400. One work-unit commit per task (T1, T2, T3). No PR created now; chain strategy (`stacked-to-main` or `feature-branch-chain`) is asked when the user decides to open PRs.

## Progress
(none yet)
