# Pendientes — odata-batch

Registro de issues, deuda técnica y mejoras pendientes tras `add-test-infrastructure`.

---

## 🔴 Seguridad

| # | Issue | Detalle |
|---|---|---|
| 1 | axios 0.21.1 — CVEs conocidos | CVE-2023-45857 y otros. Actualizar a ≥1.6.0 requiere verificar compatibilidad con TS 4.3.4 y la API de batch. |
| 2 | 38 vulnerabilidades npm | Provienen de versiones pineadas para compatibilidad con TS 4.3.4. Revisar al migrar TypeScript. |

## 🟡 Tipado

| # | Issue | Detalle |
|---|---|---|
| 3 | `noImplicitAny: false` | `any` implícito erosiona type safety en `src/`. Activar la flag rompe compilación actual — requiere refactor previo. |
| 4 | 33 warnings ESLint en `src/` | `no-explicit-any`, tipos faltantes. No se tocaron por spec del cambio actual. |

## 🟢 Mejoras técnicas

| # | Issue | Detalle |
|---|---|---|
| 5 | `skipLibCheck: true` en Jest | Workaround para `@types/babel__traverse` que usa sintaxis TS 5.0. Se elimina al migrar TypeScript. |
| 6 | `parseData` accedido vía `['parseData']` en tests | El método es privado. Si se expone como parte de la API pública, testear directamente. |
| 7 | ~~BatchResponse parser devuelve arrays vacíos~~ | **RESUELTO (2026-09)**: los fixtures de test usaban LF; el parser exige CRLF (`\r\n\r\n`, filtro `^content-type` post-split). Cubierto en `tests/response.wire.test.ts`. Queda como deuda el branch muerto `|| ['']` en `response.ts:95`. |

## 🔵 Pendientes de infraestructura

| # | Issue | Detalle |
|---|---|---|
| 8 | CI (GitHub Actions) | Excluido del primer slice. Agregar workflow mínimo: `npm ci` + `npm test` + `npm run lint`. |
| 9 | Migrar TypeScript ≥5.0 | Desbloquea versiones modernas de Jest, ts-jest, ESLint. Implica verificar breaking changes de TS 4.3 → 5.x. |

---

_Actualizado: session `add-test-infrastructure` — 28 tests, 0 fallos, lint/formatter operativos._
