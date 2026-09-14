# Pendientes — odata-batch

Registro de issues, deuda técnica y mejoras pendientes.

---

## 🔴 Seguridad

| # | Issue | Detalle |
|---|---|---|
| 1 | ~~axios 0.21.1 — CVEs conocidos~~ | **RESUELTO (2026-09)**: migrado a axios 1.20.0. Única dependencia runtime, árbol limpio de CVEs. Ajuste necesario: cast de `AxiosHeaders` en la frontera del parser. |
| 2 | Vulnerabilidades en devDeps | 23 restantes (low/moderate/high/critical), TODAS en el toolchain de test (jest 27, nodemon, jsdom). Sin fix disponible sin bumps mayores → bloqueadas por la migración TS/jest (#9). No afectan a consumidores del paquete. |

## 🟡 Tipado — RESUELTO (2026-09)

| # | Issue | Detalle |
|---|---|---|
| 3 | ~~`noImplicitAny: false`~~ | Activado. 9 anys implícitos tipados; tipos reales en la superficie pública (`BatchRequestConfig`, `BatchResponseParsed.data: any` documentado). |
| 4 | ~~Warnings ESLint~~ | 0 warnings. Tests: `no-explicit-any` off por convención (fixtures hostiles); src 100% tipado. |

## 🟢 Mejoras técnicas

| # | Issue | Detalle |
|---|---|---|
| 5 | `skipLibCheck: true` en Jest | Workaround para `@types/babel__traverse` (sintaxis TS 5.0). Se elimina al migrar TypeScript. |
| 6 | ~~`parseData` accedido vía `['parseData']`~~ | **DECIDIDO (2026-09)**: queda privado; los tests acceden por bracket. No forma parte de la API pública. |
| 7 | ~~BatchResponse parser devuelve arrays vacíos~~ | **RESUELTO (2026-09)**: fixtures LF vs parser CRLF. Cubierto en `tests/response.wire.test.ts`. |
| 10 | ~~Branch muerto `response.ts:95`~~ | **RESUELTO (2026-09)**: fallback inalcanzable eliminado; cobertura 100% branches. |
| 11 | ~~Parser: HTTP/1.0 y boundaries con comillas~~ | **RESUELTO (2026-09)**: regex `HTTP/1\.[01]`, unquote RFC 2046, error descriptivo si falta `content-type`. |
| 12 | ~~Mutación~~ | **RESUELTO (2026-09)**: stryker 10 operativo (`npm run mutation`). Score 95.42% (229 killed / 11 survived). Sobrevivientes: anclas del regex unquote y ternarios de response types — menores. |

## 🔵 Pendientes de infraestructura

| # | Issue | Detalle |
|---|---|---|
| 8 | CI (GitHub Actions) | Excluido por decisión del usuario (2026-09). Workflow mínimo cuando se decida: `npm ci` + `npm test` + `npm run lint` (+ `npm run mutation`). |
| 9 | Migrar TypeScript ≥5.0 | Declinado por ahora (2026-09). Desbloquearía jest moderno, eliminaría las 23 vulns de devDeps y el workaround #5. |

## 🟠 Hardening del wire format — ESPERA DECISIÓN

Propuestos y explicados (2026-09), sin implementar. Todos con tests de caracterización listos como red de seguridad:

| # | Propuesta | Riesgo del cambio |
|---|---|---|
| H1 | Sanitizar/rechazar CRLF en url y headers de `Call` | Podría rechazar inputs que hoy "funcionan" (rotos en el servidor, pero pasan). Semver: minor al menos. |
| H2 | Escapar payloads que contienen el boundary del changeset | Cambia bytes del wire → riesgo de compatibilidad con servidores estrictos. Necesita validación contra servidor real. |
| H3 | Codificar base64 las credenciales en `Basic auth` | **Breaking**: servidores que hoy reciben las credenciales ya codificadas por el caller dejarían de funcionar. Requiere flag opt-in (`authEncoded: true`) o major. |

---

_Actualizado: 2026-09-14 — 124 tests, 100% líneas/branches, mutation 95.42%, axios 1.20.0, tipado estricto._
