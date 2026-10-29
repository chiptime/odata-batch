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
| T1 | S1 | inline | pending | |
| T2 | S2 | inline | pending | |
| T3 | S3 | per-action worker (long run) | pending | |
| T4 | S4 | inline | pending | |
| T5 | all | independent verifier (Risk item 2 credentials, item 3 breaking http guard) | pending | |

## Log

- **L1 (2026-10-29):** "el limite duro es la gestion del batch, se llama odata-batch. cerremos lo que quede"
- **L2:** Answer to the http question: "Rechazar salvo opt-out (Recommended)".
- **L3:** Out of scope by the user's boundary: everything that is not $batch (queries, $metadata, entity modelling). Real-server interop still needs an authorized endpoint; timeout/size defaults stay unset (earlier user choice).
