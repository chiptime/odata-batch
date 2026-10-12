# Security Hardening

## Objective
Harden `odata-batch` against boundary collision/injection, header injection (CRLF), HTTP method spoofing, and unparseable batch parts, following locked decisions D1–D10 and strict TDD.

## Target and baseline status
- Repo: `/home/bruno/Code/personal/odata-batch`
- Branch: `feat/security-hardening`
- Base commit: `main` + baseline coverage fix on `tests/operations.test.ts`
- Untracked PRD SHA-256 before T-01: `1cbcd736c4ef93b21128290aed70765a984e02e2ad47283bb78043a8b3e2a827`

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
- [ ] T-01: Apply D1-D10 to the PRD
- [ ] T-02: CSPRNG boundaries and outer collision check (FR-01, FR-08)
- [ ] T-03: CRLF validation for auth and root headers (FR-02, FR-03)
- [ ] T-04: HTTP method token validation (FR-07)
- [ ] T-05: Anchored delimiters and quoted changeset boundaries in parseBatch (FR-04, FR-06)
- [ ] T-06: Resilient malformed parts in parseResponse (FR-05)
- [ ] T-07: CHANGELOG and README
- [ ] T-08: Final verification

## T-00 Execution evidence
- Baseline coverage gap in `src/request.ts:106-115, 126-130` closed per user instruction in `tests/operations.test.ts`.
- G-01: PASS (405 tests)
- G-02: PASS (100% line, 100% branch)
- G-06: PASS (96.17% mutation score)

## Resume bookmark
- Pack identity: LAUNCH — odata-batch security hardening loop (launch text + PRD SHA-256 before T-01: 1cbcd736c4ef93b21128290aed70765a984e02e2ad47283bb78043a8b3e2a827)
- Completed: T-00 (commit pending) — G-01 PASS, G-02 PASS, G-06 PASS (96.17%)
- Active task: T-01 — remediation rounds left: 2
- Next action: T-01 manual readback & PRD updates against D1-D10
