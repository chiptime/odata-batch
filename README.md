# odata-batch

Build and parse **OData `$batch`** requests in TypeScript/JavaScript: turn an
array of calls into a `multipart/mixed` (v2/v4) or JSON (v4.01) payload, send it over HTTP, and
get each inner response back as a structured object — including per-changeset
grouping, embedded error detection, and automatic authentication.

Works in Node.js (TypeScript ≥ 4.8 or JavaScript). HTTP transport is
[axios](https://axios-http.com/) by default and is replaceable.

## Install

```bash
npm install odata-batch
```

## Quick start

Every entry in `calls` becomes one request inside the batch. Successful
changesets return their child responses in order, but a failed changeset can
collapse to one error for the whole transaction. Use `sendGrouped()` when you
need to retain transaction identity rather than assuming one response per call.

```ts
import { ODataBatch, Call, BatchResponseParsed } from 'odata-batch';

const calls: Call[] = [
    {
        method: 'PUT',
        url: "https://my.server.sap/sap/opu/odata/sap/API/Candidates('200')",
        headers: { 'If-Match': '*' },
        data: { name: 'Sebastian' },
    },
    {
        method: 'POST',
        url: 'https://my.server.sap/sap/opu/odata/sap/API/Candidates',
        data: { name: 'Bruno' },
    },
];

const batch = new ODataBatch({
    url: 'https://my.server.sap/sap/opu/odata/sap/API/$batch',
    auth: 'user:password',
    calls,
});

batch.send().then(console.log).catch(console.error);
```

JavaScript works the same way: `const { ODataBatch } = require('odata-batch');`

## The response you get back

`send()` resolves to `BatchResponseParsed[]` — one entry per actual inner HTTP
response, in wire order. It does not fabricate per-operation results when a
changeset collapses to a single error:

```ts
[
    {
        code: '200',              // HTTP status of the inner response
        status: 'OK',             // reason phrase
        headers: [                // inner response headers
            { key: 'Content-Type', value: 'application/json' },
        ],
        data: { name: 'Sebastian' }, // parsed payload (see below)
        success: true,            // false when code is 4xx or 5xx, or the status line is unrecognizable
        changesetIndex: 0,        // which changeset this response belongs to
    },
]
```

A batch can transport HTTP 200 while individual operations failed — check
`success` (or `code`) per entry instead of only catching the promise.

Payload handling: with `individualResponseType: 'json'`, `data` is the
`JSON.parse` result — an empty body (204) yields `null`, and a body that is
not valid JSON yields the raw string instead of throwing (one odd part never
destroys the batch). The accept media type is matched before `;`,
case-insensitively, so `application/json;odata=verbose` parses as JSON. Any
other accept returns the raw payload string, preserved in full (no truncation
at blank lines). Response bodies may use CRLF or LF line endings.

## Multiple changesets (atomic groups)

Pass `Call[][]` to wrap each group in its **own changeset**. In OData V2 every
changeset is atomic: the server applies all operations in a group or none of
them. Use one changeset per business transaction.

```ts
const calls: Call[][] = [
    // Changeset 0: create the order and its first line — all or nothing
    [
        { method: 'POST', url: '.../Orders', data: { id: 1 } },
        { method: 'POST', url: '.../OrderLines', data: { order: 1, sku: 'A' } },
    ],
    // Changeset 1: independently update a different order
    [{ method: 'PATCH', url: '.../Orders(2)', data: { status: 'confirmed' } }],
];

const batch = new ODataBatch({ url: '.../$batch', auth: 'user:password', calls });

const responses = await batch.send();
responses.map((r) => [r.code, r.success, r.changesetIndex]);
// [['201', true, 0], ['201', true, 0], ['204', true, 1]]
```

`changesetIndex` tells you which group each response came from, so you can map
failures back to the transaction that produced them.

A flat `Call[]` still produces a single changeset, with the exact same wire
format as previous versions.

### Grouped responses

`sendGrouped(): Promise<BatchResponseGroup[]>` preserves one result per top-level
request part. The default axios adapter uses the request layout captured when
the batch was constructed, so a failed three-operation changeset followed by a
successful two-operation changeset remains **two groups**, not five fake results
or three ambiguously flattened results.

| `kind` | Payload | Meaning |
|---|---|---|
| `changeset` | `responses: BatchResponseParsed[]` | A multipart changeset with its actual child responses, including Content-ID when returned. |
| `changeset-error` | `error: BatchResponseParsed` | One top-level HTTP 4xx/5xx response for a whole changeset identified by request layout. |
| `retrieve` | `response: BatchResponseParsed` | A contextual GET response, including a GET error; it is not a failed changeset. |
| `unclassified` | `response: BatchResponseParsed` | A raw top-level HTTP response without request context; its changeset identity is unknown. |

Every group has `partIndex`, the zero-based top-level part index. This index
continues to identify later changesets after an earlier failure collapses.
Nested HTTP errors remain child responses; their status alone does not imply
a whole-changeset failure.

```ts
const groups = await batch.sendGrouped();
for (const group of groups) {
    if (group.kind === 'changeset-error') {
        console.error('Transaction failed', group.partIndex, group.error);
    } else if (group.kind === 'changeset') {
        console.log('Transaction responses', group.partIndex, group.responses);
    }
}
```

For raw responses, the exported `BatchResponse` parser exposes
`groupedResponse` (no request context) and
`parseGrouped(layout?: BatchRequestLayout)`. Layout entries are
`{ kind: 'retrieve' }` or `{ kind: 'changeset', operationCount: number }`.
Without layout, multipart identity is retained but individual HTTP parts are
`unclassified`; HTTP errors alone never establish changeset identity. Explicit
mixed layouts are supported by the parser and repository, not by the batch
request constructor yet.

Grouped parsing rejects missing/unmatched closing boundaries, unsupported part
types, invalid HTTP status lines, and layout count/type mismatches. Multipart
changesets must have the declared number of children; a collapsed failure is
represented by a top-level HTTP error, not invented child responses. The legacy
flat parser and `send()` behavior are unchanged.

Custom repositories may implement optional
`sendGrouped(url, batchRequest, config, accept, layout)` returning
`Promise<BatchResponseGroup[]>`. The existing required `send()` contract remains
unchanged. If grouped support is missing, `ODataBatch.sendGrouped()` rejects
with `Repository does not support grouped responses` **before transport**;
there is no flat-result inference, retry, or second request. Choose either send
method for one operation; calling both sends twice.

### Content-ID and dependent operations

Set optional `Call.contentId` to emit a **MIME** `Content-ID` header before the
inner HTTP request. It is not an HTTP header in `Call.headers`.

```ts
const calls: Call[] = [
    { method: 'POST', url: '/Items', data: { name: 'one' }, contentId: '1' },
    { method: 'POST', url: '$1/Lines', data: { quantity: 2 }, contentId: '2' },
];
```

Identifiers must be nonempty strings containing only HTTP token characters:
letters, digits, and `` ! # $ % & ' * + - . ^ _ ` | ~ ``. Whitespace, CR/LF,
control characters, and other characters are rejected before serialization.
Values are case-sensitive and must be unique **within each changeset**; reuse
across independent changesets is allowed. Omit the field (or pass `undefined`)
to preserve the exact previous wire format. No identifiers are generated from
URLs, and `$1/Lines` passes through unchanged; dependency semantics belong to
the OData service.

`BatchResponseParsed.contentId?: string` contains the server's nonempty MIME
`Content-ID` value when present. Header names are matched case-insensitively
regardless of MIME header order. Missing or empty IDs leave the property absent;
the parser never infers an ID from inner HTTP headers or payloads. The existing
`headers` array continues to contain only inner HTTP headers.

## Read-only batches (retrieve)

OData V2 draws a hard line between the two batch flavors: retrieve
operations (GETs) are sent as **direct batch parts**, while write operations
live inside changesets. Passing `calls` always wraps every operation in a
changeset — correct for writes, wrong for reads. For a read-only batch, pass
`retrieve` instead:

```ts
import { ODataBatch, RetrieveCall } from 'odata-batch';

const retrieve: RetrieveCall[] = [
    { url: "https://my.server.sap/sap/opu/odata/sap/API/Candidates('200')" },
    { url: 'https://my.server.sap/sap/opu/odata/sap/API/Candidates/$count' },
];

const batch = new ODataBatch({
    url: 'https://my.server.sap/sap/opu/odata/sap/API/$batch',
    auth: 'user:password',
    retrieve,
});

const responses = await batch.send();
responses.map((r) => [r.code, r.success]);
// [['200', true], ['200', true]] - same order as `retrieve`
```

Rules:

- **`calls` XOR `retrieve`.** Passing both throws
  `Pass either calls or retrieve, not both`; passing neither (or an empty
  `retrieve`) throws the usual `No calls have been passed`.
- **GET-only.** A retrieve entry is just `url` and optional `headers`. There is
  deliberately no way to express a method or a body: an entry carrying a
  `method` or `data` property throws
  `retrieve calls are GET-only: method and data are not allowed`.
- **Wire format.** Each entry becomes a direct `application/http` part under
  the batch boundary — no changeset delimiters anywhere. The per-part
  `Accept` comes from `individualResponseType`; a custom `accept` header is
  replaced by it, and a custom `content-type` header is dropped (a GET has no
  body). Line breaks in urls and header keys/values are rejected, exactly as
  for `calls`.

Responses come back as `BatchResponseParsed[]`, one entry per retrieve call,
in order; `changesetIndex` is simply the part index here. Authentication,
`headers`, the custom-adapter mechanism and the batch-level
`Content-Type: multipart/mixed; boundary=batch_<boundary>` are identical to
changeset mode.

## Mixed batches (retrieve + changesets)

OData V2 lets a single `$batch` interleave direct retrieve parts and atomic
changesets. Pass `operations` — an array whose entries are either a
`RetrieveCall` (a direct GET part) or a `Call[]` (one atomic changeset) — to
control the exact order on the wire:

```ts
import { ODataBatch, Call } from 'odata-batch';

const write: Call[] = [
    { method: 'POST', url: 'https://my.server.sap/.../Candidates', data: { name: 'Ada' }, contentId: '1' },
    { method: 'POST', url: 'https://my.server.sap/.../Candidates/$1/Notes', data: { text: 'hi' } },
];

const batch = new ODataBatch({
    url: 'https://my.server.sap/sap/opu/odata/sap/API/$batch',
    auth: 'user:password',
    operations: [
        { url: 'https://my.server.sap/.../Candidates/$count' }, // direct GET
        write,                                                   // atomic changeset
        { url: 'https://my.server.sap/.../Candidates' },         // direct GET
    ],
});

const responses = await batch.send(); // flat, wire order
const groups = await batch.sendGrouped(); // changeset-aware (see below)
```

Rules:

- **`operations` XOR `calls` XOR `retrieve`.** Combining them throws
  `Pass either operations or calls/retrieve, not both`; an empty `operations`
  array throws `No calls have been passed`.
- **Order is preserved.** Each entry keeps its position; a `RetrieveCall`
  never gains changeset delimiters, a `Call[]` is always wrapped in one
  changeset. Line breaks, `contentId` uniqueness per changeset, and the
  boundary-collision reroll behave exactly as for `calls`.
- **Empty changesets are rejected.** A `Call[]` entry with zero calls throws
  `No calls have been passed`.

`send()` returns the flat `BatchResponseParsed[]`; `sendGrouped()` (default
Axios adapter) returns `BatchResponseGroup[]` aligned to the mixed layout, so
a collapsed changeset failure keeps its identity instead of shifting later
parts.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | The `$batch` endpoint. **Required.** |
| `auth` | `string` | — | Basic-auth credential. See [Authentication](#authentication). Must not contain line breaks. **Required.** |
| `calls` | `Call[] \| Call[][]` | — | Operations to send. Empty arrays are rejected. Mutually exclusive with `retrieve` and `operations`. |
| `retrieve` | `RetrieveCall[]` | — | Read-only mode: GETs sent as direct batch parts (no changeset). Mutually exclusive with `calls` and `operations`. |
| `operations` | `(RetrieveCall \| Call[])[]` | — | Ordered mixed mode: direct GET entries and atomic changesets interleaved in order. Mutually exclusive with `calls` and `retrieve`. |
| `headers` | `Record<string, string>` | — | Extra headers for the batch request itself. Keys and values must not contain line breaks. `Authorization` from here overrides `auth`; `Accept` and `Content-Type` are always derived from the response-type options. |
| `batchResponseType` | `string` | `'json'` | JSON/XML alias or supported MIME type (see below). Controls call body serialization and inner `Content-Type`: JSON uses `JSON.stringify`; XML writes the payload verbatim. |
| `individualResponseType` | `string` | `'json'` | JSON/XML alias or supported MIME type (see below). Controls inner response parsing and `Accept`: JSON runs `JSON.parse` (empty body → `null`, unparseable body → raw string); XML returns the raw string. |
| `timeout` | `number` | unset | Request timeout in milliseconds for the default axios transport. `0` disables the timeout. |
| `maxContentLength` | `number` | unset | Maximum response size in bytes for the default axios transport. `0` allows only an empty response. This does not limit the outgoing batch size. |
| `protocolVersion` | `'2.0' \| '4.0' \| '4.01'` | unset | Opt-in version headers; v4 modes also assign missing changeset Content-IDs. Omission preserves the legacy v2 wire format. |
| `batchFormat` | `'multipart' \| 'json'` | `'multipart'` | JSON batch requires `protocolVersion: '4.01'` and JSON media types. |
| `asyncPolling` | `{ maxPolls?, defaultRetryAfterMs?, maxRetryAfterMs? }` | unset | Opt-in asynchronous batches. See [Asynchronous batches](#asynchronous-batches). |
| `continueOnError` | `boolean` | unset | JSON batch only: sends `Prefer: odata.continue-on-error`. |
| `binaryResponses` | `boolean` | `false` | Multipart only: return non-textual response parts as `Buffer`. |
| `allowInsecureHttp` | `boolean` | `false` | Allow credentials over plain `http://` to non-loopback hosts. See [Authentication](#authentication). |
| *(2nd constructor arg)* | `ODataBatchRepository` | axios adapter | Custom HTTP transport. See [Custom HTTP adapter](#custom-http-adapter). |

### JSON/XML media types

Both options accept `json` and `xml`, or `application/json`, `application/xml`,
`text/xml`, and `application/atom+xml`. Recognition is case-insensitive; aliases
expand to `application/json` or `application/xml`, and MIME type names are
lowercased. Defaults and legacy body serialization remain unchanged.

MIME values can include parameters such as `application/json;odata=verbose`
or `application/xml;charset=utf-8`. Parameter spelling, values, and internal
spacing are preserved on the wire; surrounding spaces are trimmed. Parameter
names and unquoted values must be HTTP tokens. Quoted values allow printable
ASCII, including escaped quotes and semicolons. XML remains raw even with
parameters, in both single and multiple changesets.

```ts
const batch = new ODataBatch({
    url: '.../$batch',
    auth: 'user:password',
    calls: [{ method: 'POST', url: '.../Items', data: { id: 1 } }],
    batchResponseType: 'application/json;odata=verbose',
    individualResponseType: 'application/json;odata=verbose',
});
```

Unsupported types, wildcards, media-type lists, malformed parameters, control
characters (including tabs and CR/LF), and non-ASCII values throw at construction
instead of silently selecting XML. Parameters require a MIME type, not an alias
(`json;odata=verbose` is invalid). The outer request remains
`multipart/mixed` unless `batchFormat: 'json'` is selected; retrieve mode uses only the normalized `Accept` on its GET
parts, but validates both options.

Each `Call` accepts:

| Field | Type | Description |
|---|---|---|
| `method` | `string` | HTTP method (any casing; uppercase in multipart, lowercase in JSON batch). Must be a valid RFC 9110 HTTP token. `GET` is rejected inside a changeset: use `retrieve` or a direct `operations` entry. |
| `url` | `string` | Request URL. Must not contain line breaks. |
| `data` | `any` | Payload: serialized per `batchResponseType`. A `Buffer` or `Uint8Array` is binary (see below). |
| `headers` | `Record<string, string \| number>` | Optional. `Content-Type`/`Accept` here are overridden by the response-type options, except a binary body's own `Content-Type` is preserved. JSON batch uses lowercase header names. |
| `contentId` | `string` | Optional MIME Content-ID / JSON request id; a nonempty HTTP token. Unique within a v2 changeset, or across the entire v4 batch. |
| `dependsOn` | `string[]` | JSON batch only. Earlier request ids in the same group or earlier standalone requests; dependencies on other changesets must name their atomicity group. No forward, self, or own-group references. |

Each `RetrieveCall` accepts:

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Request URL. Must not contain line breaks. |
| `headers` | `Record<string, string \| number>` | Optional. A custom `accept` is replaced by `individualResponseType`; a custom `content-type` is dropped (a GET has no body). Every other header passes through verbatim. |

### Timeouts and response limits

Both limits must be finite, non-negative numbers. Without them, axios's existing
defaults apply: this library imposes no timeout or response-size limit. Choose
values appropriate for your service, for example `timeout: 30_000` and
`maxContentLength: 10 * 1024 * 1024`. Custom repositories receive these values
in `BatchRequestConfig` and must enforce them themselves.

### Binary request bodies

```ts
const batch = new ODataBatch({
    url: 'https://example.com/service/$batch',
    auth: 'user:password',
    calls: [{
        method: 'POST', url: '/Photos',
        data: Buffer.from([0xff, 0x00, 0x01]),
        headers: { 'Content-Type': 'image/jpeg' },
    }],
});
```

In multipart batches, bytes are written verbatim and the overall request body
becomes a `Buffer`. Batches with no binary payload remain strings. Binary data
requires its own `Content-Type` header; boundary collision guards also scan
binary bytes. In JSON batch, binary bodies are unpadded base64url strings.
To receive binary responses, see [Binary responses](#binary-responses).

### Protocol versions and JSON batch

| Mode | Options | Outer version headers |
|---|---|---|
| Legacy v2 multipart | no new options | none added |
| Explicit v2 multipart | `protocolVersion: '2.0'` | `DataServiceVersion: 2.0`, `MaxDataServiceVersion: 2.0` |
| v4 multipart | `protocolVersion: '4.0'` | `OData-Version: 4.0`, `OData-MaxVersion: 4.0` |
| v4.01 multipart | `protocolVersion: '4.01'` | `OData-Version: 4.01`, `OData-MaxVersion: 4.01` |
| v4.01 JSON batch | `protocolVersion: '4.01', batchFormat: 'json'` | `OData-Version: 4.01`, `OData-MaxVersion: 4.01` |

An explicit caller version header wins case-insensitively. Keep overrides
consistent with the selected format: a 4.0-only server does not support JSON
batch. The library does not negotiate or discover server capabilities.
In v4 modes, omitted Content-IDs are assigned the lowest free positive decimal
ids across the batch, without mutating caller objects.

```ts
const batch = new ODataBatch({
    url: 'https://example.com/service/$batch',
    auth: 'user:password',
    protocolVersion: '4.01',
    batchFormat: 'json',
    operations: [
        { url: '/Items' },
        [
            { method: 'POST', url: '/Items', contentId: 'create', data: { name: 'new' } },
            { method: 'POST', url: '$create/Details', dependsOn: ['create'], data: { label: 'detail' } },
        ],
    ],
});
const groups = await batch.sendGrouped();
```

The JSON body contains `requests[]`; each changeset becomes an `atomicityGroup`
named `group1`, `group2`, etc., skipping names that collide with request ids.
GET entries also receive ids. `dependsOn` is explicit: JSON requests outside
the same atomicity group are **not** implicitly ordered by their array position.
`send()` correlates responses by id and returns them in request order;
`sendGrouped()` uses request layout, including single-member changesets.
If a group fails, every returned member has `success: false`, even if its
original HTTP code was 2xx. Grouped output carries the actual failing response.
After any failed response, a request the service did not answer (a rolled-back
group member, or an unprocessed request under `continueOnError: false`) is
returned as an explicit entry, never a fabricated result:
`{ code: '', status: '', headers: [], data: null, success: false, omitted: true, contentId }`.
In grouped output an entirely omitted changeset is a `changeset-error` carrying
that entry. Unknown or duplicate ids, or missing responses when nothing failed,
reject parsing.

`continueOnError` (JSON batch only) sends
`Prefer: odata.continue-on-error=true|false`; a caller `Prefer` header wins.

### Asynchronous batches

```ts
const batch = new ODataBatch({
    url: 'https://example.com/service/$batch',
    auth: 'user:password',
    calls,
    asyncPolling: { maxPolls: 30, defaultRetryAfterMs: 1000, maxRetryAfterMs: 30000 },
});
```

`asyncPolling` (defaults shown; `{}` uses them) adds `Prefer: respond-async`.
When the service answers `202 Accepted` with a `Location`, the default axios
transport polls that status monitor with `GET`, reusing the batch headers and
waiting `Retry-After` (delay-seconds or HTTP-date, capped at `maxRetryAfterMs`,
`defaultRetryAfterMs` when absent). A later `202` may move the monitor. The
final answer is parsed like any batch response; an `application/http` monitor
answer is unwrapped first, and a wrapped non-2xx status rejects.

Credentials are only ever sent to the batch origin: a `Location` on another
origin rejects **before any poll**, and redirects stay disabled.

Interim results are resumed (OData 4.01 §11.7.7.6): when a monitor answer is a
multipart batch whose **last** part is an `application/http` `202 Accepted`
with a `Location`, the earlier parts are kept and polling continues at that
Location (same origin check, `Retry-After`, shared `maxPolls` budget). The
result is one batch holding every part in order. Custom repositories receive
`config.asyncPolling` and must implement polling themselves.

### Binary responses

`binaryResponses: true` (multipart only) asks the transport for raw bytes
(`responseType: 'arraybuffer'`). Parts whose `Content-Type` is not textual
(`text/*`, `multipart/*`, JSON, `+json`, XML, `+xml`, `application/http`)
return `data` as a `Buffer` with the exact bytes; textual parts are decoded as
UTF-8 and parsed as usual. Payload line breaks are never rewritten in this mode.

### Per-part Content-Type

An inner response that declares a non-JSON `Content-Type` (for example
`text/plain` or `application/xml`) is returned raw even when
`individualResponseType` is JSON. JSON and `+json` parts are parsed; parts
without a `Content-Type` keep following `individualResponseType`.

The low-level `operationsToJsonBatch`, `JsonBatchResponse`, and
`createJsonBatchResponseParser` are also exported. See
[OData JSON Format 4.01, section 19](https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html#sec_BatchRequestsandResponses).
This is a batch transport/serialization library, not an implementation of the
entire OData query, metadata, authentication, or authorization specification.

## Authentication

`auth` builds the `Authorization: Basic ...` header using a simple,
deterministic rule:

- Contains `:` → it is a raw `user:password` pair → **base64-encoded
  automatically** (UTF-8), per RFC 7617.
- No `:` → assumed pre-encoded or an opaque token → **sent untouched**.

```ts
auth: 'user:password'    // sent as: Basic dXNlcjpwYXNzd29yZA==  (encoded for you)
auth: 'dXNlcjpwYXNz'     // sent as: Basic dXNlcjpwYXNz        (already encoded)
auth: 'my-token'         // sent as: Basic my-token            (colon-less: untouched)
```

The rule is safe because the base64 alphabet never contains `:`, while decoded
Basic credentials always do. Caveat: a colon-less **raw** password (rare but
legal) cannot be distinguished from a token — encode such passwords yourself
before passing them. To bypass the heuristic entirely, set
`headers: { Authorization: 'Bearer ...' }` — it overrides `auth`. The key is
matched case-insensitively (`authorization`, `AUTHORIZATION`, ...) and is sent
as a single canonical `Authorization` header.

Credentials never travel in clear text by default: a plain `http://` url throws
`Refusing to send credentials over http://; use https:// or set allowInsecureHttp: true`,
except for loopback hosts (`localhost`, `127.0.0.0/8`, `[::1]`). For an internal
service without TLS, set `allowInsecureHttp: true` explicitly. Relative urls
(used with a custom transport) are not checked.

The default axios transport **never follows redirects** (`maxRedirects: 0`):
following one would replay the `Authorization` header to the redirect target.
A 3xx answer rejects the promise like any other non-2xx response. If your
gateway really redirects `$batch`, point `url` at the final endpoint, or
supply your own transport (see [Custom HTTP adapter](#custom-http-adapter)).

## Errors and validation

| Situation | Behavior |
|---|---|
| `calls` missing, empty, or containing an empty changeset | `throw` at construction: `No calls have been passed` |
| `calls` and `retrieve` both passed | `throw` at construction: `Pass either calls or retrieve, not both` |
| Retrieve entry carrying `method` or `data` | `throw` at construction: `retrieve calls are GET-only: method and data are not allowed` |
| Unsupported or malformed response-type option | `throw` at construction: `<option> must be a supported JSON or XML media type` |
| Invalid explicit `contentId` | `throw` before sending: `Call contentId must be a nonempty HTTP token` |
| Duplicate explicit `contentId` within a changeset | `throw` before sending: `Duplicate contentId within a changeset: <id>` |
| Line breaks (`\r`/`\n`) in `auth` or batch root `headers` | `throw` at construction: `Call auth must not contain line breaks` or `Call header '<key>' must not contain line breaks` |
| Line breaks (`\r`/`\n`) in a call or retrieve `url` or `headers` | `throw` before sending — blocks header injection into the MIME part |
| Invalid HTTP method in `Call` | `throw` before sending: `Call method must be a valid HTTP token` |
| Payload contains the generated batch or changeset boundary | Boundary is regenerated (up to 10 attempts), then `throw` |
| Batch endpoint answers non-2xx | Promise **rejects** (transport error; nothing is parsed) |
| Batch endpoint answers a redirect (3xx) | Promise **rejects**; the redirect is never followed, so credentials are not replayed |
| Inner response is 4xx/5xx | Parsed normally with `success: false` — the promise still resolves |
| Truncated or malformed inner response part (missing header separation) | Parsed with `success: false` and raw unparsed part text in `data` — no throw, siblings are preserved |
| Inner response body is not valid JSON while using `individualResponseType: 'json'` | `data` is the raw payload string for that part — no throw, siblings are preserved |
| Inner response body is empty (204) while using `individualResponseType: 'json'` | `data` is `null` — no throw |
| Response body uses LF-only (or mixed) line endings | Normalized to CRLF; parsed normally |
| Response has no/invalid `content-type` boundary | `throw` with a descriptive message |
| GET inside any changeset | `throw`: `GET is not allowed inside a changeset; use retrieve or operations` |
| Invalid `timeout` / `maxContentLength` | `throw`: `<option> must be a non-negative finite number` |
| Unsupported `protocolVersion` | `throw`: `protocolVersion must be '2.0', '4.0' or '4.01'` |
| Unsupported `batchFormat` | `throw`: `batchFormat must be 'multipart' or 'json'` |
| JSON batch with incompatible version/media types | `throw`: `batchFormat 'json' requires protocolVersion '4.01' and JSON media types` |
| Binary body without its own Content-Type | `throw`: `Binary call data requires its own Content-Type header` |
| Duplicate explicit v4 Content-ID across groups | `throw`: `Duplicate contentId within the batch: <id>` |
| Multipart call with `dependsOn` | `throw`: `dependsOn requires batchFormat 'json'` |
| Invalid JSON dependency (unknown, forward, self, own-group, cross-group member) | `throw`: `dependsOn must reference an earlier request id or atomicity group: <ref>` |
| Invalid JSON response envelope | `throw`: `Invalid JSON batch response` |
| Unknown/duplicate JSON response id, or a missing one when nothing failed | `throw`: `JSON batch response does not match request ids: <id>` |
| `continueOnError` on a multipart batch | `throw`: `continueOnError requires batchFormat 'json'` |
| `binaryResponses` on a JSON batch | `throw`: `binaryResponses requires batchFormat 'multipart'` |
| Invalid `asyncPolling` field | `throw`: `asyncPolling.<field> must be a non-negative finite number` |
| Plain `http://` url to a non-loopback host | `throw` at construction: `Refusing to send credentials over http://; use https:// or set allowInsecureHttp: true` |
| Non-boolean `allowInsecureHttp` | `throw`: `allowInsecureHttp must be a boolean` |
| Async `202` without `Location` | Promise **rejects**: `Async batch response is missing Location` |
| Async monitor on another origin | Promise **rejects** before polling: `Async monitor must be on the batch origin` |
| Async batch still running after `maxPolls` | Promise **rejects**: `Async batch did not finish after <n> polls` |
| Wrapped async result with non-2xx status | Promise **rejects**: `Async batch failed with status <code>` |

## Custom HTTP adapter

The transport is one interface. Implement `ODataBatchRepository` and pass it as
the second constructor argument — anything from `fetch` to a company proxy
client works:

```ts
import {
    ODataBatch,
    ODataBatchRepository,
    BatchRequestConfig,
    BatchResponseParsed,
    createBatchResponse,
    BatchResponseConstructor,
} from 'odata-batch';

export class ODataBatchFetchRepository implements ODataBatchRepository {
    async send(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]> {
        // This minimal adapter does not implement the optional transport limits.
        if (config.timeout !== undefined || config.maxContentLength !== undefined) {
            throw new Error('This adapter does not implement transport limits');
        }
        const response = await fetch(url, {
            method: 'POST',
            headers: config.headers,
            body: typeof batchRequest === 'string' ? batchRequest : Uint8Array.from(batchRequest),
            redirect: 'error',
        });
        if (!response.ok) throw new Error(`Batch endpoint returned ${response.status}`);

        // Reuse the bundled parser: give it the response body and headers
        return createBatchResponse(BatchParser, {
            data: await response.text(),
            headers: Object.fromEntries(response.headers),
        }, accept).response;
    }
}

const batch = new ODataBatch({ url: '.../$batch', auth: 'user:pass', calls }, new ODataBatchFetchRepository());
```

The default adapter (`ODataBatchAxiosRepository`) additionally enforces the
optional limits using axios. To implement `sendGrouped`, accept the optional
sixth argument `BatchParser` (default `BatchResponse`), construct it with
`createBatchResponse`, and call its `parseGrouped(layout)` method. JSON batch
requires the supplied bound parser; do not hardcode `BatchResponse` there.

## Migrating from 3.x (unreleased)

- Use an `https://` batch url. Plain `http://` to a non-loopback host now
  throws; set `allowInsecureHttp: true` only for internal services without TLS.
- Move GET entries out of `calls` into `retrieve`, or into direct `operations`
  entries. GET inside a changeset now throws rather than sending invalid OData.
- Custom repository request bodies now have type `string | Buffer`. Preserve
  binary bytes; do not unconditionally convert them to UTF-8 strings.
- The default transport no longer follows redirects. Set `url` to the final
  endpoint rather than relying on a redirect.
- All new format/version/limit options are opt-in; ordinary v2 write batches
  retain their existing string wire format when the new options are omitted.

## Migrating from 1.x

| Change | 1.x behavior | 2.0.0 behavior | Action needed |
|---|---|---|---|
| `axios` | `0.21.x` bundled | `^1.20.0` | Usually none; retest if you intercept axios |
| Raw `auth` credentials | Sent unencoded | Auto base64-encoded when they contain `:` | None if you already sent encoded values (README contract); otherwise auth now works correctly |
| Line breaks in urls/headers | Sent, corrupting the MIME part | `throw` | Fix the caller producing them |
| `BatchResponseParsed.data` type | `any[]` (wrong) | `any` | Only affects TS consumers reading `.data.length` — payload shape was never an array |
| HTTP/1.0 / quoted boundaries | Parsed as empty | Parsed correctly | None |

Full details in [CHANGELOG.md](CHANGELOG.md).

## Credits

Built on the ideas of
[batchcall](https://www.npmjs.com/package/batchcall) and
[batch-odata](https://www.npmjs.com/package/batch-odata).

---

<sub>Local tests cover v2/v4 multipart and v4.01 JSON batching. This is not a
conformance certification or a claim that every server supports every mode;
validate interoperability against your target service before deployment.</sub>
