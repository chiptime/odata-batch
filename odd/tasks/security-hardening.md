# Security Hardening

## Objective
Harden `odata-batch` against boundary collision/injection, header injection (CRLF), HTTP method spoofing, and unparseable batch parts, following locked decisions D1–D10 and strict TDD.

## Target and baseline status
- Repo: `/home/bruno/Code/personal/odata-batch`
- Branch: `feat/security-hardening`
- Base commit: `main` + baseline coverage fix on `tests/operations.test.ts` (`856b063`)
- Untracked PRD SHA-256 after T-01: `eefaa98d4cc1ec5436505742cf343eae2c28f0ae56a65c1ca14cafcf14213c7d`

### T-00 Baseline observations (Confirmed 100% baseline)
- **G-01 (`npm test -- --runInBand`)**: PASS (16 suites, 405 tests passed)
- **G-02 (`npx jest --runInBand --coverage --coverageThreshold='{"global":{"lines":100,"branches":100}}'`)**: PASS
  - Statements: 100%
  - Branches: 100%
  - Functions: 100%
  - Lines: 100%
  - Uncovered lines: None across all files
- **G-06 (`npm run mutation`)**: PASS (Baseline Stryker score established)
  - Total Mutation score: 96.17%
  - Covered Mutation score: 96.17%
  - Killed: 845 | Timeout: 9 | Survived: 34 | No coverage: 0 | Errors: 0

## Tasks
- [x] T-00: Baseline and tracking
- [x] T-01: Apply D1-D10 to the PRD
- [x] T-02: CSPRNG boundaries and outer collision check (FR-01, FR-08)
- [x] T-03: CRLF validation for auth and root headers (FR-02, FR-03)
- [ ] T-04: HTTP method token validation (FR-07)
- [ ] T-05: Anchored delimiters and quoted changeset boundaries in parseBatch (FR-04, FR-06)
- [ ] T-06: Resilient malformed parts in parseResponse (FR-05)
- [ ] T-07: CHANGELOG and README
- [ ] T-08: Final verification

## T-00 Execution evidence
- Commit: `856b063`
- Baseline coverage gap in `src/request.ts:106-115, 126-130` closed per user instruction in `tests/operations.test.ts`.
- G-01: PASS (405 tests)
- G-02: PASS (100% line, 100% branch)
- G-06: PASS (96.17% mutation score)

## T-01 Execution evidence
- Commit: `a89d4f9`
- Readback manual: Aprobado.
- Reflejadas todas las decisiones D1–D10 en `docs/prds/security-hardening-prd.md`:
  - D1: Runtime `randomUUID` de `crypto`, sin requisito Node >= 18 ni `engines`.
  - D2: 10 intentos de colisión uniformes (batch y changeset).
  - D3: FR-02/FR-03 como defensa en profundidad; mensaje `Call auth must not contain line breaks` sin eco de valor; cabeceras con `ensureHeadersAreSafe`.
  - D4: Costura de test en `src/boundary.ts` (`generateBoundaryId()`).
  - D5: Serializadores generan boundary exterior y retornan `{ body, boundary }`; `retrieveToBatch` excluido de colisiones.
  - D6: FR-05 retorna `{ code: '', status: '', headers: [], data: <raw>, success: false }` sin TypeError.
  - D7: Semver 3.1.0 minor; entrada `[Unreleased]` con "Behavior changes" sin editar version en `package.json`.
  - D8: `parseBatch` reutiliza `splitGroupedMultipart` y extractor `getBoundary`.
  - D9: Token RFC 9110 para `call.method` con mensaje `Call method must be a valid HTTP token`.
  - D10: Métricas observables; matriz FR -> V1; V2/V3 como gates globales.
- Referencias `file:line` verificadas contra el código fuente:
  - `src/ODataBatch.ts:55, 76, 78, 134, 145-151`
  - `src/request.ts:27-37, 41, 51, 163, 168-177, 233, 273-282`
  - `src/response.ts:157, 191, 284, 300, 317, 335-349`
- SHA-256 resultante de `docs/prds/security-hardening-prd.md`: `eefaa98d4cc1ec5436505742cf343eae2c28f0ae56a65c1ca14cafcf14213c7d`

## T-02 Execution evidence
- Commit: `92a41f5`
- RED observado en `tests/boundary.test.ts`: 6 fallos de comportamiento en ejecución (falta de retorno `{ body, boundary }`, ausencia de detección de colisión exterior y mensaje `Unable to generate a batch boundary that does not collide with the payload`, persistencia de timestamp en `ODataBatch` y uso de `Math.random` en changesets).
- Implementación GREEN:
  - Creación de `src/boundary.ts` exportando `generateBoundaryId()` sobre `randomUUID()`.
  - Actualización de `requestsToBatch` y `operationsToBatch` retornando `{ body, boundary }` con bucle de 10 reintentos ante colisión de boundary exterior y de changeset con el payload.
  - Actualización de `ODataBatch` almacenando el boundary retornado para `Content-Type` y eliminando `new Date().getTime()`.
  - Actualización de `tests/helpers.ts` para espiar `generateBoundaryId()` en `makeRandomMock` y `makeRandomSequenceMock`.
- Gates observados:
  - G-01: PASS (17 suites, 412 tests)
  - G-03: PASS (`npm run lint`, 0 errores/warnings)
  - G-04: PASS (`npm run format:check`, Prettier clean)
  - G-05: PASS (`npm run build`, tsc exit 0)
  - G-07: PASS (`git diff --exit-code main -- src/index.ts`, API pública intacta)
  - G-09: PASS (`sh -c '! grep -rnE "Math\.random|new Date\(\)\.getTime" src/'`, exit 0, cero generadores débiles en `src/`)

## T-03 Execution evidence
- Commit: pending
- RED observado en `tests/crlf.test.ts`: 7 fallos (Received function did not throw para saltos de línea `\r`, `\n`, `\r\n` en `auth` y cabeceras raíz).
- Implementación GREEN:
  - Validación de `auth` con `LINE_BREAK = /[\r\n]/` en `src/ODataBatch.ts`, lanzando `Call auth must not contain line breaks` sin incluir nunca el valor de la credencial en el mensaje.
  - Validación de cabeceras raíz con `ensureHeadersAreSafe` en `src/ODataBatch.ts` contra claves y valores con saltos de línea (`Call header '<key>' must not contain line breaks`).
  - Test documental de comportamiento nativo de Node.js `http.OutgoingMessage` rechazando CRLF en cabeceras.
- Gates observados:
  - G-01: PASS (18 suites, 425 tests)
  - G-03: PASS (`npm run lint`, exit 0)
  - G-04: PASS (`npm run format:check`, exit 0)
  - G-05: PASS (`npm run build`, exit 0)
  - G-07: PASS (`git diff --exit-code main -- src/index.ts`, exit 0)

## Resume bookmark
- Pack identity: LAUNCH — odata-batch security hardening loop (launch text + PRD SHA-256: eefaa98d4cc1ec5436505742cf343eae2c28f0ae56a65c1ca14cafcf14213c7d)
- Completed: T-00 (`856b063`), T-01 (`a89d4f9`), T-02 (`92a41f5`)
- Active task: T-03 — remediation rounds left: 2
- Next action: commit T-03
