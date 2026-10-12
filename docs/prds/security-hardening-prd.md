# PRD — Seguridad y Robustez de Protocolo (Security Hardening)

**Status:** APROBADO (Decisiones D1–D10 integradas formalmente; preparado para ejecución bajo loop ODD).  
**Owner:** Bruno  
**Date:** 2026-10-12  
**Context:** Auditoría de seguridad y robustez del repositorio [`odata-batch`](file:///home/bruno/Code/personal/odata-batch) (versión base 3.0.0).  
**Decision Authority:** Decisiones confirmadas D1–D10 en sesión (2026-10-12, Engram #10496).

---

## 1. Contexto y Problema

La librería `odata-batch` construye y procesa peticiones y respuestas multipart OData V2 `$batch`. En la auditoría de seguridad sobre el código base se identificaron áreas de mejora y debilidades en tres ámbitos fundamentales:

1. **Inyección y Colisión de Delimitadores Multipart (Request Smuggling):** El límite exterior del lote (`boundary`) se genera a partir de la marca de tiempo del sistema (`new Date().getTime().toString()`), la cual tiene muy baja entropía y es predecible por atacantes externos. Asimismo, los changesets emplean `Math.random()`. A diferencia de los changesets, no existe comprobación de colisión entre el límite exterior y el contenido del payload. Si un atacante inyecta `--batch_<boundary>` dentro de los datos de una petición, puede provocar corte prematuro, alteración de la estructura multipart o inyección de sub-peticiones no autorizadas.
2. **Inyección de Cabeceras HTTP (CRLF Injection):** Las cabeceras a nivel de lote en `ODataBatch` y las credenciales pasadas mediante el parámetro `auth` no cuentan con validación defensiva en la librería frente a caracteres de salto de línea (`\r\n`). Aunque el cliente HTTP subyacente de Node.js pueda mitigar ciertos casos, la inyección de repositorios personalizados y los errores tardíos/opacos hacen necesaria una validación previa estricta como defensa en profundidad.
3. **Fragilidad y Corrupción en el Parsing de Respuestas:** El método plano `parseBatch` utiliza expresiones regulares no ancladas al inicio de línea (`^` o `\r\n`), lo que provoca que cualquier payload devuelto que contenga la cadena del límite divida la carga útil en dos. Asimismo, la extracción de límites de changesets no contempla comillas ni parámetros adicionales, descartando en silencio (`silent drop`) operaciones válidas, y partes malformadas provocan excepciones no capturadas (`TypeError`).

---

## 2. Decisiones Bloqueadas (D1–D10)

Las siguientes decisiones forman la autoridad única para el diseño e implementación del hardening:

| ID | Decisión | Detalle y Regla de Implementación |
|---|---|---|
| **D1** | **Runtime y CSPRNG** | Uso de `import { randomUUID } from 'crypto'` (disponible en Node.js >= 14.17). NO se añade requisito Node.js >= 18 ni se añade campo `engines` a `package.json`. |
| **D2** | **Reintentos ante Colisión** | Se mantienen exactamente 10 intentos de reintento ante colisión (comportamiento actual en changesets), aplicados de forma uniforme para límites de batch y de changeset. Si persiste tras 10 intentos, se lanza `Error`. |
| **D3** | **CRLF en Auth y Headers** | Clasificado como MUST bajo enfoque de defensa en profundidad (Node `http` suele rechazar saltos de línea; el riesgo reside en repositorios personalizados inyectados y errores opacos). Se incluye un test que documenta el comportamiento de Node. El mensaje de error para `auth` es exactamente `Call auth must not contain line breaks` y NUNCA incluye el valor confidencial (no reutilizar `ensureNoLineBreak`). Las cabeceras reutilizan `ensureHeadersAreSafe`. |
| **D4** | **Costura de Test (Test Seam)** | Nuevo módulo interno `src/boundary.ts` que exporta `generateBoundaryId(): string` envolviendo `randomUUID()`. Los tests usan `jest.spyOn` sobre esta función; los tests de formato wire/golden se mantienen deterministas con mocks fijos. Sin cambios en la API pública. |
| **D5** | **Embudo de Serialización** | Los serializadores (`requestsToBatch`, `operationsToBatch`) generan el límite exterior y devuelven `{ body: string, boundary: string }`; `ODataBatch` almacena el boundary retornado para componer la cabecera `Content-Type`. Un único punto de control de colisión. `retrieveToBatch` no serializa cuerpos de petición, por lo que queda excluida de comprobación de colisión. |
| **D6** | **Resiliencia ante Partes Malformadas** | En `parseResponse`, una parte malformada devuelve `{ code: '', status: '', headers: [], data: <raw unparsed part text>, success: false }`, nunca un `TypeError` no capturado. Se documenta como cambio de comportamiento en el CHANGELOG (el servidor ya procesó el lote; lanzar error abortaría resultados válidos comprometidos). |
| **D7** | **Semver y CHANGELOG** | Lanzamiento semver menor 3.1.0. Se añade únicamente una entrada `[Unreleased]` en `CHANGELOG.md` con subsección "Behavior changes". NO se modifica el campo `version` en `package.json`. |
| **D8** | **Parser Multipart Unificado** | `parseBatch` reutiliza la lógica del delimitador anclado de `splitGroupedMultipart` y el extractor robusto de límites existente en `src/response.ts` (`getBoundary`, soportando comillas y parámetros). Un único parser multipart, sin regex duplicadas. |
| **D9** | **Token de Método HTTP RFC 9110** | El método de llamada en `ensureCallIsSafe` debe cumplir con el patrón de token RFC 9110 ya utilizado para `contentId` en `src/request.ts` (`/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`). Mensaje exacto de error: `Call method must be a valid HTTP token`. |
| **D10** | **Métricas y Gates** | Cada FR debe observarse en ROJO antes y en VERDE después; suite completa existente verde; 100% cobertura de líneas y ramas (G-02); mutación >= línea base T-00 (96.17%, G-06); dependencias solo `axios` (G-08); lint, format y build con código 0. `npm audit` es chequeo manual humano, no puerta del loop. |

---

## 3. Objetivos y No-Objetivos (Goals & Non-Goals)

### Objetivos (Goals)
- **G-01:** Garantizar la unicidad e impredecibilidad criptográfica de todos los límites multipart (batch y changeset) mediante `src/boundary.ts` (`generateBoundaryId` vía `crypto.randomUUID`).
- **G-02:** Prevenir colisiones de límites en peticiones salientes verificando que ningún cuerpo de datos contenga los delimitadores generados (`batch` y `changeset`), con bucle de 10 reintentos automáticos.
- **G-03:** Neutralizar vectores de inyección CRLF en credenciales `auth` (sin divulgar credenciales en el mensaje de error) y cabeceras raíz `headers` en `ODataBatch`.
- **G-04:** Unificar la delimitación multipart en `src/response.ts` para que los límites solo se reconozcan como líneas completas ancladas, impidiendo fragmentaciones accidentales por payloads de respuesta.
- **G-05:** Prevenir caídas no controladas (`TypeError`) en `parseResponse` ante respuestas incompletas o malformadas, devolviendo un objeto `BatchResponseParsed` con `success: false`.
- **G-06:** Asegurar que `parseBatch` soporte delimitadores de changeset entre comillas y parámetros adicionales, reutilizando el extractor de `src/response.ts`.
- **G-07:** Validar estrictamente los métodos HTTP en peticiones internas con tokens RFC 9110 (`Call method must be a valid HTTP token`).
- **G-08:** Mantener compatibilidad absoluta hacia atrás con la API pública (`src/index.ts`).

### No-Objetivos (Non-Goals)
- **NG-01:** No alterar la firma ni las exportaciones de la API pública expuesta en `src/index.ts`.
- **NG-02:** No introducir dependencias de producción en `package.json` (`dependencies` permanece únicamente con `axios`).
- **NG-03:** No modificar el protocolo OData V2 hacia V4 JSON batching.
- **NG-04:** No incluir la actualización de dependencias de desarrollo (`devDependencies`).
- **NG-05:** No exigir Node.js >= 18 ni modificar el objeto `engines` de `package.json` (compatibilidad con Node.js >= 14.17 vía `import { randomUUID } from 'crypto'`).

---

## 4. Arquitectura y Límites de Confianza

### Flujo de Datos y Embudo de Serialización

```
[Datos: URL, Headers, Auth, Payloads]
                   │
                   ▼
┌────────────────────────────────────────────────────────┐
│              Constructor: ODataBatch                   │
│ - Validación CRLF en headers (ensureHeadersAreSafe)    │
│ - Validación CRLF en auth (sin fuga de valor)          │
│ - Invocación a serializadores (recibe {body, boundary})│
│ - Almacena boundary retornado para Content-Type        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│    Serializadores: requestsToBatch / operationsToBatch │
│ - Generación CSPRNG vía src/boundary.ts                │
│ - Validación RFC 9110 para call.method                 │
│ - Detección de colisiones (batch y changeset)          │
│ - Bucle de hasta 10 reintentos                         │
│ - Retorno { body, boundary } (embudo único)            │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (Wire HTTP Request)
┌────────────────────────────────────────────────────────┐
│                 Transporte: Axios / Red                │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (Wire HTTP Response)
┌────────────────────────────────────────────────────────┐
│             Parsing: BatchResponse / parseBatch        │
│ - Parser multipart anclado unificado                   │
│ - Extracción robusta de boundary (comillas/parámetros) │
│ - parseResponse tolerante a partes malformadas         │
│   (success: false sin TypeError)                       │
└────────────────────────────────────────────────────────┘
```

---

## 5. Requisitos Funcionales (FR)

### FR-01: Generación CSPRNG y Detección de Colisión del Límite Exterior (MUST)
- **Requisito:** Los serializadores `requestsToBatch` y `operationsToBatch` **DEBEN** generar el límite exterior de lote (`boundary`) utilizando `generateBoundaryId()` de `src/boundary.ts`. Asimismo, **DEBEN** verificar que ningún cuerpo de datos serializado contenga la cadena `--batch_${boundary}`. Si se detecta una colisión con el payload, se **DEBEN** ejecutar reintentos automáticos de hasta 10 intentos en total. Si tras 10 intentos persiste la colisión, se **DEBE** lanzar `Error('Unable to generate a batch boundary that does not collide with the payload')`. Ambos serializadores retornan `{ body: string, boundary: string }`, y `ODataBatch` almacena el `boundary` para componer la cabecera `Content-Type`. `retrieveToBatch` no maneja cuerpos de datos y queda excluida de la detección de colisiones.
- **Evidencia Técnica Verificada:**
  - `src/ODataBatch.ts:76`: `this.boundary = new Date().getTime().toString();` es predecible y de baja entropía.
  - `src/request.ts:168-177` y `src/request.ts:273-282`: los bucles de colisión existentes solo comprueban `--changeset_${changeSetNum}`, omitiendo `--batch_${boundary}`.

### FR-02: Validación CRLF en Parámetro `auth` (MUST — Defensa en Profundidad)
- **Requisito:** `ODataBatch` **DEBE** validar el parámetro `auth` para asegurar que no contenga caracteres de salto de línea (`\r` o `\n`). Si `auth` contiene un salto de línea, el constructor **DEBE** lanzar un error con el mensaje exacto: `Call auth must not contain line breaks`. El mensaje **NUNCA** debe incluir ni reflejar el valor de las credenciales pasadas (no reutilizar `ensureNoLineBreak`). Se debe incluir un test que documente el comportamiento del módulo `http` de Node.js frente a cabeceras con CRLF.
- **Evidencia Técnica Verificada:**
  - `src/ODataBatch.ts:145-151`: `encodeBasicAuth(auth)` retorna `auth` intacto si no contiene `:`, permitiendo inyectar valores como `token\r\nX-Injected: evil`.
  - `src/ODataBatch.ts:134`: se interpola en `Authorization: Basic ${this.encodeBasicAuth(this.auth)}`.

### FR-03: Validación CRLF en Cabeceras Globales del Lote (MUST — Defensa en Profundidad)
- **Requisito:** `ODataBatch` **DEBE** verificar todas las claves y valores del objeto `headers` en el constructor principal mediante `ensureHeadersAreSafe(this.headers)` de `src/request.ts`, lanzando un error si se detecta algún salto de línea (`Call header '<key>' must not contain line breaks`).
- **Evidencia Técnica Verificada:**
  - `src/ODataBatch.ts:55, 78`: `headers?: Record<string, string>` se recibe y asigna pero no se valida contra CRLF en el constructor.
  - `src/request.ts:27-37`: `ensureHeadersAreSafe` existe para llamadas internas individuales pero no se invocaba para las cabeceras raíz del lote.

### FR-04: Delimitación Estricta de Líneas en `parseBatch` (MUST)
- **Requisito:** `parseBatch` **DEBE** exigir que los límites de parte (`--batch_...` y `--changeset_...`) coincidan únicamente si ocurren como líneas completas dentro del formato multipart, reutilizando la lógica anclada de `splitGroupedMultipart`, impidiendo que una subcadena contenida dentro de un JSON o texto de respuesta divida artificialmente la parte.
- **Evidencia Técnica Verificada:**
  - `src/response.ts:157`: `splitGroupedMultipart` utiliza la expresión regular anclada `^--${escapeRegExp(boundary)}(--)?[ \t]*(?:\r\n|$)`.
  - `src/response.ts:284`: `normalizedBody.split(RegExp('--' + escapeRegExp(this.boundary) + '(?:\r\n)?(?:--\r\n)?'))` no requiere inicio de línea.
  - `src/response.ts:317`: `changeSetBody[1].split(RegExp('--' + changeSetBoundary + '(?:\r\n)?(?:--\r\n)?', 'i'))` divide en cualquier posición del cuerpo.

### FR-05: Resiliencia ante Respuestas Truncadas o Malformadas en `parseResponse` (MUST)
- **Requisito:** Si una parte no contiene la separación de cabeceras HTTP (`\r\n\r\n`) o carece de línea de estado HTTP parseable, `parseResponse` **DEBE** manejar la anomalía de forma resiliente, retornando un objeto `BatchResponseParsed` con exactamente `{ code: '', status: '', headers: [], data: <raw unparsed part text>, success: false }`, sin arrojar un `TypeError` no capturado.
- **Evidencia Técnica Verificada:**
  - `src/response.ts:191`: `const httpResponseWithHeaders = responseParts[1].split('\r\n');` lanza `TypeError: Cannot read properties of undefined (reading 'split')` si `responseParts.length < 2`.

### FR-06: Extracción Robusta de Límites de Changeset en `parseBatch` (MUST)
- **Requisito:** `parseBatch` **DEBE** reutilizar la lógica robusta de extracción de límites existente en `src/response.ts:335-349` (`getBoundary`), admitiendo valores entre comillas (RFC 2046) y parámetros posteriores (e.g., `boundary="cs_123"; charset=utf-8`), despojando las comillas antes de buscar los delimitadores del cuerpo para evitar el descarte silencioso de operaciones.
- **Evidencia Técnica Verificada:**
  - `src/response.ts:300`: `batchPart.match(RegExp('boundary=(.+)', 'm'))` captura comillas y parámetros sin limpiar.
  - `src/response.ts:342, 348`: `getBoundary` ya maneja `boundary=([^;]+)` y remueve comillas envolventes `replace(/^"(.*)"$/, '$1')`.

### FR-07: Validación Estricta de Método HTTP en Sub-peticiones (MUST)
- **Requisito:** `ensureCallIsSafe` **DEBE** verificar que `call.method` sea un token HTTP válido sin espacios en blanco ni caracteres de control, cumpliendo con el estándar RFC 9110 mediante la misma expresión regular empleada para `contentId` (`/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`). Ante cualquier valor no conforme, **DEBE** lanzar un error con el mensaje exacto: `Call method must be a valid HTTP token`.
- **Evidencia Técnica Verificada:**
  - `src/request.ts:41`: `ensureNoLineBreak('method', call.method)` solo comprueba saltos de línea; cadenas como `"POST /other HTTP/1.1"` pasaban sin detección.
  - `src/request.ts:51`: patrón de token RFC 9110 ya implementado para `contentId`.

### FR-08: Sustitución de `Math.random()` por CSPRNG en Changesets (MUST)
- **Requisito:** La generación de identificadores de boundary de changeset en `requestsToBatch` y `operationsToBatch` **DEBE** utilizar `generateBoundaryId()` de `src/boundary.ts` en lugar de `Math.random() * 100`, aplicando el mismo mecanismo de detección de colisión con 10 reintentos.
- **Evidencia Técnica Verificada:**
  - `src/request.ts:163, 233`: `let changeSetNum = Math.random() * 100;` utiliza un generador pseudo-aleatorio no criptográfico (CWE-338).

---

## 6. Estrategia de Verificación y Aceptación

### 1. Niveles de Verificación y Gates

- **V1 (Tests Jest — Nivel Requisito):** Cada FR se valida mediante al menos un test unitario o de protocolo enfocado, observado en ROJO antes de la modificación y en VERDE tras la implementación (`npm test -- --runInBand`).
- **V2 (Calidad Estática y Build — Gate Global):** Verificación global del árbol de trabajo: `npm run lint`, `npm run format:check` y `npm run build` sin errores ni warnings.
- **V3 (Revisión y Conformidad — Gate Global):** M-01 (`npm audit --omit=dev` sin hallazgos de severidad alta) y M-02 (inspección de `git diff --exit-code main -- src/index.ts` asegurando compatibilidad pública de API).

### 2. Escenarios de Aceptación Gherkin

```gherkin
Scenario: Reintento automático y resolución ante colisión de delimitador de lote en payload (FR-01) [V1]
  Given una petición ODataBatch con un Call cuyo payload contiene deliberadamente un límite generado
  When se ejecuta la serialización de la petición
  Then la librería detecta la colisión del boundary exterior
  And regenera un nuevo boundary seguro hasta 10 intentos
  And si persiste la colisión lanza Error("Unable to generate a batch boundary that does not collide with the payload")

Scenario: Detección y rechazo de inyección CRLF en auth (FR-02) [V1]
  Given una configuración de ODataBatch con auth igual a "token\r\nX-Injected: attack"
  When se inicializa la instancia ODataBatch
  Then el constructor lanza un Error con el mensaje exacto "Call auth must not contain line breaks"
  And el mensaje de error no contiene el valor de las credenciales

Scenario: Detección y rechazo de inyección CRLF en cabeceras superiores (FR-03) [V1]
  Given una configuración de ODataBatch con headers que contienen "X-Custom\r\nInjected: value"
  When se inicializa la instancia ODataBatch
  Then el constructor lanza un Error indicando que la cabecera contiene saltos de línea

Scenario: Preservación de cuerpo JSON que contiene subcadena de boundary (FR-04) [V1]
  Given una respuesta multipart batch válida cuyo payload JSON incluye el texto "--batch_12345"
  When BatchResponse parsea la respuesta con parseBatch
  Then el campo JSON se conserva íntegro sin dividirse en dos partes separadas
  And la respuesta se marca como exitosa

Scenario: Manejo resiliente sin crash de parte HTTP truncada o malformada (FR-05) [V1]
  Given una respuesta batch que contiene una parte sin separación de cabeceras HTTP ("\r\n\r\n")
  When BatchResponse parsea los datos
  Then la ejecución no aborta con TypeError no controlado
  And la parte se reporta como { code: '', status: '', headers: [], data: <raw>, success: false }

Scenario: Parsing exitoso de changeset con boundary entre comillas y parámetros (FR-06) [V1]
  Given una respuesta con Content-Type "multipart/mixed; boundary=\"changeset_custom\"; charset=utf-8"
  When parseBatch procesa el lote
  Then las operaciones dentro del changeset son extraídas correctamente sin ser descartadas silenciosamente

Scenario: Rechazo de método HTTP no conforme con RFC 9110 (FR-07) [V1]
  Given una llamada con method "POST /admin HTTP/1.1"
  When se intenta serializar el lote
  Then la librería lanza Error("Call method must be a valid HTTP token")

Scenario: Generación de identificadores de changeset mediante CSPRNG (FR-08) [V1]
  Given una petición con múltiples changesets
  When se genera el mensaje multipart
  Then los identificadores de changeset contienen formato UUID seguro generado vía CSPRNG
```

### 3. Matriz de Trazabilidad (FR a V1)

| Requisito | Verificación V1 (Tests Jest Observados RED→GREEN) | Escenario Gherkin |
|---|:---:|---|
| **FR-01** (Boundary CSPRNG & Reintentos de Colisión) | ✔ | Reintento automático y resolución ante colisión de delimitador de lote en payload |
| **FR-02** (CRLF en `auth` sin fuga de valor) | ✔ | Detección y rechazo de inyección CRLF en auth |
| **FR-03** (CRLF en `headers` raíz) | ✔ | Detección y rechazo de inyección CRLF en cabeceras superiores |
| **FR-04** (Delimitación Estricta en `parseBatch`) | ✔ | Preservación de cuerpo JSON que contiene subcadena de boundary |
| **FR-05** (Resiliencia en `parseResponse`) | ✔ | Manejo resiliente sin crash de parte HTTP truncada o malformada |
| **FR-06** (Límites de Changeset con Comillas/Parámetros) | ✔ | Parsing exitoso de changeset con boundary entre comillas y parámetros |
| **FR-07** (Validación de Método HTTP RFC 9110) | ✔ | Rechazo de método HTTP no conforme con RFC 9110 |
| **FR-08** (CSPRNG en Changesets) | ✔ | Generación de identificadores de changeset mediante CSPRNG |

*(Nota: V2 y V3 aplican como puertas de verificación globales sobre la totalidad del árbol antes del cierre).*

---

## 7. Métricas de Éxito (D10)

1. **Evidencia RED→GREEN:** Cada FR (FR-01 a FR-08) cuenta con al menos un test unitario enfocado observado en ROJO antes de la modificación de producción y en VERDE tras implementarlo.
2. **Suite Existente Preservada:** La totalidad de los tests existentes se mantiene en estado VERDE sin regresiones (sin asumir conteos estáticos).
3. **Cobertura Completa (100%):** 100% de cobertura global de líneas y 100% de cobertura global de ramas, verificado mediante Jest (G-02).
4. **Puntuación de Mutación:** La puntuación de mutación de Stryker (G-06) es igual o superior a la línea base registrada en T-00 (96.17%).
5. **Cero Dependencias Adicionales:** `package.json` mantiene exclusivamente `axios` en el bloque `dependencies` (G-08).
6. **Calidad y Build:** `npm run lint` (G-03), `npm run format:check` (G-04) y `npm run build` (G-05) terminan con código de salida 0.
7. **Integridad de API Pública:** `src/index.ts` permanece idéntico a la rama `main` (G-07).
8. **Ausencia de Generadores Débiles:** Cero ocurrencias de `Math.random` o `new Date().getTime` en el código fuente de `src/` (G-09).
