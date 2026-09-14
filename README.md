# odata-batch

Build and parse **OData V2 `$batch`** requests in TypeScript/JavaScript: turn an
array of calls into a correct `multipart/mixed` payload, send it over HTTP, and
get each inner response back as a structured object — including per-changeset
grouping, embedded error detection, and automatic authentication.

Works in Node.js (TypeScript ≥ 4.8 or JavaScript). HTTP transport is
[axios](https://axios-http.com/) by default and is replaceable.

## Install

```bash
npm install odata-batch
```

## Quick start

Every entry in `calls` becomes one request inside the batch. Responses come
back **in the same order as the calls**.

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

`send()` resolves to `BatchResponseParsed[]` — one entry per call, in order:

```ts
[
    {
        code: '200',              // HTTP status of the inner response
        status: 'OK',             // reason phrase
        headers: [                // inner response headers
            { key: 'Content-Type', value: 'application/json' },
        ],
        data: { name: 'Sebastian' }, // parsed payload (see response types)
        success: true,            // false when code is 4xx or 5xx
        changesetIndex: 0,        // which changeset this response belongs to
    },
]
```

A batch can transport HTTP 200 while individual operations failed — check
`success` (or `code`) per entry instead of only catching the promise.

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
    // Changeset 1: an independent operation
    [{ method: 'GET', url: '.../Orders(1)', data: null }],
];

const batch = new ODataBatch({ url: '.../$batch', auth: 'user:password', calls });

const responses = await batch.send();
responses.map((r) => [r.code, r.success, r.changesetIndex]);
// [['201', true, 0], ['201', true, 0], ['200', true, 1]]
```

`changesetIndex` tells you which group each response came from, so you can map
failures back to the transaction that produced them.

A flat `Call[]` still produces a single changeset, with the exact same wire
format as previous versions.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | The `$batch` endpoint. **Required.** |
| `auth` | `string` | — | Basic-auth credential. See [Authentication](#authentication). **Required.** |
| `calls` | `Call[] \| Call[][]` | — | Operations to send. Empty arrays are rejected. |
| `headers` | `Record<string, string>` | — | Extra headers for the batch request itself. `Authorization` from here overrides `auth`; `Accept` and `Content-Type` are always derived from the response-type options. |
| `batchResponseType` | `'json' \| 'xml'` | `'json'` | How `data` of each call is serialized into the batch body. `json` uses `JSON.stringify`; `xml` writes the payload verbatim. |
| `individualResponseType` | `'json' \| 'xml'` | `'json'` | How each inner response body is parsed. `json` runs `JSON.parse`; `xml` returns the raw string. Also sent as the batch `Accept` header. |
| *(2nd constructor arg)* | `ODataBatchRepository` | axios adapter | Custom HTTP transport. See [Custom HTTP adapter](#custom-http-adapter). |

Each `Call` accepts:

| Field | Type | Description |
|---|---|---|
| `method` | `string` | HTTP method (any casing; normalized to uppercase). |
| `url` | `string` | Request URL. Must not contain line breaks. |
| `data` | `any` | Payload: serialized per `batchResponseType`. |
| `headers` | `Record<string, string \| number>` | Optional. `Content-Type`/`Accept` here are overridden by the response-type options; every other header passes through verbatim. |

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
`headers: { Authorization: 'Bearer ...' }` — it overrides `auth`.

## Errors and validation

| Situation | Behavior |
|---|---|
| `calls` missing, empty, or containing an empty changeset | `throw` at construction: `No calls have been passed` |
| Line breaks (`\r`/`\n`) in a call url, method or header | `throw` before sending — blocks header injection into the MIME part |
| Payload contains the generated changeset boundary | Boundary is regenerated (up to 10 attempts), then `throw` |
| Batch endpoint answers non-2xx | Promise **rejects** (transport error; nothing is parsed) |
| Inner response is 4xx/5xx | Parsed normally with `success: false` — the promise still resolves |
| Response body is not JSON while using `individualResponseType: 'json'` | `throw SyntaxError` while parsing |
| Response has no/invalid `content-type` boundary | `throw` with a descriptive message |

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
        batchRequest: string,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]> {
        const response = await fetch(url, {
            method: 'POST',
            headers: config.headers,
            body: batchRequest,
        });

        // Reuse the bundled parser: give it the response body and headers
        return createBatchResponse(BatchParser, {
            data: await response.text(),
            headers: Object.fromEntries(response.headers),
        }, accept).response;
    }
}

const batch = new ODataBatch({ url: '.../$batch', auth: 'user:pass', calls }, new ODataBatchFetchRepository());
```

The default adapter (`ODataBatchAxiosRepository`) does exactly this with axios.

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

<sub>OData V2 is the supported and tested dialect. V3 batches share the MIME
structure and may work, but are not covered by the test suite.</sub>
