# batch-gaps

Objective: close the functional gaps left after odata-compliance-v4 (async batches, omitted JSON responses, binary responses, per-part Content-Type).
Branch: `fix/redirect-credential-leak` (pushed). Delivery: ask-on-risk; commits only outside working hours (commit-hours-audit). Test runner: `npx jest` (+ lint, format:check, tsc).

## Specs

All new behavior is opt-in; omitting the new options keeps today's wire and parsing byte-identical. Option names and defaults are agent assumptions (the user asked to "cerremos los puntos pendientes" without choosing a design).

- **S1 Async batch (OData 4.01 Protocol §11.6, §11.7.7.6).** Option `asyncPolling?: { maxPolls?: number; defaultRetryAfterMs?: number; maxRetryAfterMs?: number }` (defaults 30, 1000, 30000; each a non-negative finite number else `asyncPolling.<field> must be a non-negative finite number`). When set, the outer request carries `Prefer: respond-async` (a caller `Prefer` header, any casing, wins). The default axios repository: on `202` with `Location`, polls the monitor with `GET` reusing the request headers, waiting `Retry-After` seconds (capped at `maxRetryAfterMs`, else `defaultRetryAfterMs`); repeats while the monitor answers `202`; stops after `maxPolls` with `Async batch did not finish after <n> polls`. A `Location` on a different origin than the batch url throws `Async monitor must be on the batch origin` before any request (credentials are never sent elsewhere); a `202` without `Location` throws `Async batch response is missing Location`. The final monitor body is parsed like a normal batch response; when the monitor answers `Content-Type: application/http`, the wrapped HTTP response (status line, headers, body) is unwrapped first. Redirects stay disabled for polls.
- **S2 Omitted JSON responses (JSON Format 4.01 §19.4).** Option `continueOnError?: boolean` (JSON batch only; multipart throws `continueOnError requires batchFormat 'json'`). `false` sends `Prefer: odata.continue-on-error=false` (`true` sends `odata.continue-on-error=true`; caller `Prefer` wins). With request ids, a missing response is accepted only when at least one returned response failed (status >= 400): it is returned as `{ code: '', status: '', headers: [], data: null, success: false, omitted: true, contentId, changesetIndex }`. Missing ids with no failure still throw the existing error. `BatchResponseParsed` gains optional `omitted?: true`. Grouped: a unit whose members are all omitted becomes `{ kind: 'changeset-error' | 'retrieve', ... }` carrying the omitted entry.
- **S3 Binary responses.** Option `binaryResponses?: boolean`. When true, `BatchRequestConfig.responseType` is `'arraybuffer'`, and the multipart parser accepts a `Buffer`/`ArrayBuffer` body: framing is done on a byte-preserving latin1 view; a part whose Content-Type is not textual (`text/*`, `application/json`, `*+json`, `application/xml`, `*+xml`, `application/http`, `multipart/*`) yields `data` as a `Buffer` with the exact bytes; textual parts are decoded as UTF-8 and parsed as today. Without the option nothing changes.
- **S4 Per-part Content-Type.** When an inner response declares a Content-Type that is not JSON (`application/json` or `*+json`), its payload is returned raw even if `individualResponseType` is JSON (no `JSON.parse`). Parts without a Content-Type keep today's accept-based behavior.
- **S5 Docs.** README and CHANGELOG describe each option, error message and limitation.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T0 | S1-S3 wiring | inline | done | RED 10/11 tests/options-gaps.test.ts → GREEN; + binaryResponses/json guard RED→GREEN |
| T1 | S1 | delegated writer (interrupted, code saved) + inline fixes | done | Writer left 20 passing tests; parent RED 3/3 (moved Location, cross-origin interim Location, bare CR/LF in wrapped Buffer) → GREEN; 26 tests, 100% lines |
| T3 | S3, S4 | inline (writer interrupted before writing) | done | RED 6/8 tests/response.binary.test.ts → GREEN; string path untouched |
| T2 | S2 | inline | done | RED 3 (incl. changed rolled-back-sibling test) → GREEN; jsonBatch.ts 100% |
| T4 | S5 + seam check | inline | done | README/CHANGELOG; full suite 655/655, lint/format/tsc/diff-check pass |
| T5 | all | independent verifier | done | S1-S3, S5 met (real 127.0.0.1 origin/userinfo/port/scheme probes, 256-byte values); 1 blocker S4 fixed with regression test |

## Log

- **L1 (2026-10-29):** "usa la skill de horas en jornada laboral, mira los commits y crealos para fuera, subamoslo, luego, cerremos los puntos pendientes"
- **L2:** Commits b4cc9a2, 4e87d85, e9a073d created at 00:36-00:40 Thu (outside rule Mon-Thu 09-19, Fri 08-16); audit dec3bdf..HEAD = 0 violations; branch pushed. 12 older commits on origin/main fall inside working hours; not rewritten (published main + npm releases, needs explicit force-push decision).
- **L3:** Release checks: runtime audit 0; dev fast-uri patched (e9a073d); deepmerge dev advisory has no fix; `npm pack` installs and type-checks in a clean consumer. Real-service interoperability still requires an authorized endpoint.
- **L4 (2026-10-29, user):** "continue" after both writers were interrupted. T1 code+tests were on disk (kept, reviewed); T3 had written nothing (done inline).
- **L5:** Parent decisions beyond the written spec: (a) interim 202 without Location keeps the validated monitor (OData 4.01 §11.6: later Location may change; verifier judged compliant); (b) S2 omitted entries apply to every unanswered id once any response failed, so rolled-back siblings are now explicit `omitted: true` entries instead of silently dropped (existing test updated deliberately); (c) `binaryResponses` + JSON batch throws `binaryResponses requires batchFormat 'multipart'`.
- **L6:** Verifier blocker: declared application/json part was JSON-parsed under an XML accept (baseline kept it raw). Fixed: only the accept enables JSON parsing. Advisory: a payload line equal to the multipart delimiter is an inherent MIME ambiguity. Final 655/655, coverage 100% lines / 98.57% branches.

