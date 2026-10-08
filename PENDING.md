# Pendientes — odata-batch

Registro de issues, deuda técnica y mejoras pendientes.

---

## 🔴 Seguridad

| # | Issue | Detalle |
|---|---|---|
| 1 | ~~axios 0.21.1 — CVEs conocidos~~ | **RESUELTO (2026-09)**: migrado a axios 1.20.0. Única dependencia runtime, árbol limpio de CVEs. Ajuste necesario: cast de `AxiosHeaders` en la frontera del parser. |
| 2 | ~~Vulnerabilidades en devDeps~~ | **RESUELTO (2026-09)**: `npm audit` → **0 vulnerabilidades** tras la migración TS 5.9 + jest 30 + eslint 10 (#9). |

## 🟡 Tipado — RESUELTO (2026-09)

| # | Issue | Detalle |
|---|---|---|
| 3 | ~~`noImplicitAny: false`~~ | Activado. 9 anys implícitos tipados; tipos reales en la superficie pública (`BatchRequestConfig`, `BatchResponseParsed.data: any` documentado). |
| 4 | ~~Warnings ESLint~~ | 0 warnings. Tests: `no-explicit-any` off por convención (fixtures hostiles); src 100% tipado. |

## 🟢 Mejoras técnicas

| # | Issue | Detalle |
|---|---|---|
| 5 | ~~`skipLibCheck: true` en Jest~~ | **RESUELTO (2026-09)**: migrado a TS 5.9.3; `skipLibCheck: false` en tsconfig y sin override en jest. |
| 6 | ~~`parseData` accedido vía `['parseData']`~~ | **DECIDIDO (2026-09)**: queda privado; los tests acceden por bracket. No forma parte de la API pública. |
| 7 | ~~BatchResponse parser devuelve arrays vacíos~~ | **RESUELTO (2026-09)**: fixtures LF vs parser CRLF. Cubierto en `tests/response.wire.test.ts`. |
| 10 | ~~Branch muerto `response.ts:95`~~ | **RESUELTO (2026-09)**: fallback inalcanzable eliminado; cobertura 100% branches. |
| 11 | ~~Parser: HTTP/1.0 y boundaries con comillas~~ | **RESUELTO (2026-09)**: regex `HTTP/1\.[01]`, unquote RFC 2046, error descriptivo si falta `content-type`. |
| 12 | ~~Mutación~~ | **RESUELTO (2026-09)**: stryker 10 + stack migrado. Score **99.32%**; 2 sobrevivientes restantes son mutantes equivalentes demostrables: `Buffer.from(x, '')` (Node trata encoding vacío como utf8 default) y flag `'m'` en regex sin anclas `^`/`$` (inerte). |

## 🔵 Pendientes de infraestructura

| # | Issue | Detalle |
|---|---|---|
| 9 | ~~Migrar TypeScript ≥5.0~~ | **RESUELTO (2026-09)**: TS 5.9.3 + jest 30 + ts-jest 29 + eslint 10 (flat config) + prettier 3 + @types/node 26 + nodemon 3. Diagnósticos de tipo en tests ACTIVADOS (destapó un import roto). |

## 🟢 Hardening del wire format — RESUELTO (2026-09)

Los tres propuestos, aprobados e implementados con su batería de tests:

| # | Propuesta | Implementación |
|---|---|---|
| H1 | ~~Sanitizar/rechazar CRLF~~ | `requestsToBatch` rechaza (`throw`) `\r`/`\n` en url, method y keys/valores de headers, en ambas rutas (legacy y multi). Mensajes de error por campo. |
| H2 | ~~Regenerar boundary en colisión~~ | Si algún payload serializado (JSON o XML) contiene `--changeset_{num}`, se re-sortea el boundary (máx. 10 intentos → throw). Check conservador por prefijo. Wire idéntico para payloads limpios. |
| H3 | ~~Base64 en Basic auth~~ | Heurística del colon (RFC 7617): valor con `:` ⇒ credenciales crudas ⇒ se codifica base64 (utf8); sin `:` ⇒ pre-codificado o token ⇒ pasa byte-idéntico. README actualizado. |

## 🛡️ Robustez del parser — RESUELTO (2026-10)

Sondeo con batches sintéticos (2026-10-08) destapó 9 defectos en `BatchResponse` (`src/response.ts`); los 9 resueltos en la rama `fix/parser-robustness`:

| # | Defecto | Resolución |
|---|---|---|
| A1 | Payload vacío/204 con accept JSON lanzaba `SyntaxError` | `data: null` para payload vacío o solo espacios (accept no-JSON mantiene `''`). |
| A2 | Boundary interpolada sin escapar en el `RegExp` del split | Escape de metacaracteres regex para boundaries de batch Y changeset (RFC 2046). |
| A3 | Un part con JSON inparsing lanzaba y perdía los hermanos | Nunca lanza por part: `data` = payload crudo (string). |
| A4 | Lookup de `content-type` case-sensitive (RFC 9110) | Búsqueda case-insensitive de la clave. |
| B5 | `application/json;odata=verbose` no parseaba como JSON | Modo JSON por media type antes de `;` (trim, case-insensitive); el resto raw. |
| B6 | Payload no-JSON truncado en la primera línea/línea en blanco | Payload íntegro tras el bloque status/headers; solo se recortan los CRLFs finales del framing. |
| B7 | Split de headers en el ÚLTIMO `": "`; `Key:value` sin espacio daba clave vacía | Split en el PRIMER colon con OWS recortado (RFC 7230); sin colon → `{key:'',value:''}`. |
| B8 | Reason phrase vacío → code `''`; status line desconocida → `success: true` | Regex tolera reason vacío; status line no reconocible → `success: false`; 1xx/2xx/3xx siguen siendo success. |
| B9 | Body solo-LF → `[]` silencioso | Normalización `\r?\n` → `\r\n` al inicio de `parseBatch`. |

Cubierto además con property tests deterministas (LCG con semilla, sin dependencias): boundaries RFC 2046 arbitrarias (1-70 chars, espacio nunca al final), round-trip con `requestsToBatch`, mezclas JSON/204/error que nunca lanzan, equivalencia LF/CRLF y casing arbitrario de `content-type`.

## 📦 Release — 2.0.0 (2026-09-15)

- **145 tests** (11 suites), 100% líneas/branches, mutation **99.32%** (2 mutantes equivalentes demostrables).
- Toolchain: TS 5.9.3, jest 30, ts-jest 29, eslint 10 (flat config), prettier 3, stryker 10.
- `npm audit`: **0 vulnerabilidades**.
- Breaking changes documentados en `CHANGELOG.md` y `README.md` (axios 1.20.0, base64 Basic auth, `BatchResponseParsed.data: any`, múltiples changesets).

## Sigue pendiente

| # | Issue | Detalle |
|---|---|---|
| 8 | CI (GitHub Actions) | Excluido por decisión del usuario. Workflow mínimo cuando se decida: `npm ci` + `npm test` + `npm run lint` + `npm run mutation`. |
| 13 | TS 7 (port nativo) | Follow-up. Bloqueado hasta que ts-jest / typescript-eslint declaren soporte oficial. |
| 14 | Mutante sobreviviente en retrieve mode (preexistente de 2.1.0) | Observado 2026-10 (mutation 99.02%): `retrieveToBatch(retrieve, boundary, {accept})` → `{}` sobrevive porque ningún test fija el `Accept:` por part del wire retrieve. Fuera de las superficies de parser-robustness; matarlo exige test de `ODataBatch` retrieve. Los otros 3 sobrevivientes sí son equivalentes demostrables. |

---

_Actualizado: 2026-10-08 — 218 tests (13 suites), 100% líneas/branches, mutation 99.02% (3 equivalentes demostrables + 1 pendiente #14), robustez del parser A1-A4+B5-B9 resuelta, v2.1.0._
