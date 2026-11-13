# batch-close

Objective: close every remaining gap inside the batch-management boundary and prepare 4.0.0.
Branch: `fix/redirect-credential-leak`. Commits only outside working hours (commit-hours-audit). Test runner: `npx jest` (+ lint, format:check, tsc).

## Specs

- **S1 Credentials over http.** User choice: "Rechazar salvo opt-out" — "Lanza error si hay credenciales y la URL es http://, excepto localhost/127.0.0.1/::1. Opción `allowInsecureHttp: true` para SAP internos sin TLS."
  - Every batch carries `Authorization`, so: an absolute `http:` url whose host is not loopback (`localhost`, `127.0.0.0/8`, `[::1]`) throws at construction `Refusing to send credentials over http://; use https:// or set allowInsecureHttp: true`. `allowInsecureHttp: true` disables the check. `https:` and urls that do not parse as absolute (relative urls for custom transports) are unaffected. Non-boolean `allowInsecureHttp` throws `allowInsecureHttp must be a boolean`.
- **S2 Async interim results (OData 4.01 Protocol §11.7.7.6).** With `asyncPolling`, when a monitor answer is a multipart batch (direct or unwrapped from application/http) whose LAST part is an `application/http` `202 Accepted` with `Location`, its earlier parts are kept and polling continues at that Location (same-origin check, Retry-After); the final result is one multipart body containing all kept parts in order followed by the final parts, under a fresh boundary. Same `maxPolls` budget for the whole run. Multipart only.
- **S3 Mutation testing** re-run over the new code; surviving non-equivalent mutants get tests.
- **S4 Release prep.** package.json 4.0.0 (version, description, keywords), CHANGELOG `[4.0.0]`, README docs for S1/S2, PR. npm publish only on explicit confirmation.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1 | inline | done (5df498d) | RED 7/14 tests/insecure-http.test.ts → GREEN; ~70 placeholder http:// test urls moved to https:// |
| T2 | S2 | inline | done (5df498d) | RED 5/6 interim tests → GREEN; + passthrough/changeset-last/merge-reroll tests |
| T3 | S3 | per-action worker run + bounded writers per file | done (uncommitted) | 91.25% → 98.63% global (2203 killed, 27 timeout, 31 survived, all reasoned equivalent). Per file: axios 98.52, response 99.63, request 98.82, ODataBatch 98.48, jsonBatch 97.42. No real bug found; 3 behavior-preserving simplifications. 777 tests |
| T4 | S4 | inline | done (uncommitted) | package.json 4.0.0 + description/keywords, CHANGELOG `[4.0.0] - Unreleased`, README migration heading, PENDING #14 closed. PR after 19:00; npm publish needs explicit confirmation |
| T5 | all | independent verifier (Risk item 2 credentials, item 3 breaking http guard) | done | S1-S4 met, 0 blockers; http guard bypass probes (case, userinfo, ::ffff, 0.0.0.0, decimal loopback, whitespace, opaque http:) pinned as regressions; 33-case differential vs 5df498d identical; real-socket interim probes incl. 256-byte merge |

## Log

- **L1 (2026-10-29):** "el limite duro es la gestion del batch, se llama odata-batch. cerremos lo que quede"
- **L2:** Answer to the http question: "Rechazar salvo opt-out (Recommended)".
- **L3:** Out of scope by the user's boundary: everything that is not $batch (queries, $metadata, entity modelling). Real-server interop still needs an authorized endpoint; timeout/size defaults stay unset (earlier user choice).
- **L4:** Commit 5df498d (01:33 Thu) pushed. Stryker needs `ignorePatterns: [".codegraph"]` (live daemon socket ENXIO) — added to stryker.conf.json.
- **L5:** 09:59 Thu is inside working hours: no commits/push until 19:00 (user rule). Work continues uncommitted.

- **L6:** Mutation 98.63% (31 equivalent survivors). Verifier advisory: `//evil/$batch` is unchecked as relative, but the default axios transport fails with ERR_INVALID_URL before any socket. Final suite 784 tests. All work since 5df498d is uncommitted until 19:00 (working-hours rule).
\n