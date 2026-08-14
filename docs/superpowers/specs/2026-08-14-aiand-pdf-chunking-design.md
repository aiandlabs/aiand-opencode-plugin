# Transparent Aiand PDF Chunking Design

**Date:** 2026-08-14

**Status:** Approved in conversation; pending written-spec review

## Context

The Aiand Files API accepts PDF uploads with `purpose=document`, but each uploaded PDF is capped at 100 pages and 100 MB. OpenCode supplies an attached PDF to the OpenAI-compatible provider as one inline base64 `file` part. The existing feature branch translates that part into one Aiand Files API upload and one chat `file_id` reference.

The user's acceptance document, `manual.pdf`, is 14,179,600 bytes and 120 pages. The transport bridge successfully processes PDFs within Aiand's limit, but Aiand correctly rejects this unchanged document with `400 invalid_value` because it exceeds 100 pages.

Aiand's live Models.dev-shaped catalog also distinguishes attachment-capable models from text-only models. At design time, four of nine catalog entries advertise `modalities.input` containing `pdf` with `attachment=true`, while five advertise text input only with `attachment=false`. OpenCode consumes those fields for its UI, but the transport must independently enforce them before it creates retained Files API uploads.

## Goal

Make page-limit handling transparent: when an attached PDF contains more than 100 pages, split it into ordered PDFs of at most 100 pages, upload every chunk, and replace the original attachment with multiple ordered `file_id` parts in the same chat request.

Before any PDF decoding, parsing, splitting, or upload, require positive capability evidence for the exact selected model from the same immutable Aiand catalog snapshot that populated OpenCode. The plugin solves the Files API's per-file transport constraint; it does not make additional model calls, summarize chunks, or attempt to manage a model's aggregate image or context limit.

## Non-goals

- Separate inference calls per chunk or answer aggregation.
- Automatic summarization, page selection, retrieval, or context budgeting.
- User-configurable chunk sizes or retention settings.
- External `qpdf`, Poppler, Python, or platform-specific runtime dependencies.
- Support for encrypted, corrupted, or otherwise unsplittable PDFs.
- Splitting non-PDF attachments.
- Silent local text extraction, OCR, model switching, or another representation fallback for models that do not support PDF input.
- User overrides that grant PDF capability to an unknown or custom model outside Aiand's catalog.
- Persisting PDF bytes, derived chunks, or cache metadata across process restarts.

## Approaches Considered

### 1. Parse and split in-process before upload (selected)

Use the pure-JavaScript `pdf-lib` package. Count pages locally, retain the original byte-for-byte upload for PDFs of 100 pages or fewer, and create sequential page-range chunks only when required.

Advantages:

- Portable across OpenCode's Node.js and Bun environments.
- Avoids a guaranteed rejected upload for oversized PDFs.
- Does not depend on provider error-message wording.
- Allows precise page-order and chunk-boundary tests.

Costs:

- Adds one production dependency.
- Parsing and rewriting temporarily increases memory use for oversized documents.
- Some PDFs that Aiand might parse may not be accepted by `pdf-lib`; these fail safely rather than bypassing chunking.

### 2. Upload first and split only after Aiand returns its page-limit error

This avoids parsing normal PDFs but guarantees an unnecessary failed upload for every oversized document and couples behavior to Aiand's error shape. It was rejected.

### 3. Invoke an external PDF utility

Tools such as `qpdf` or Poppler are robust, but requiring a separately installed executable would make the plugin non-portable. It was rejected.

## Architecture

### Capability snapshot and side-effect gate

Catalog loading produces one immutable snapshot containing the model map, whether the fetch succeeded, and the local fetch time. The same model map is injected into OpenCode and passed to the PDF transport. The transport never maintains a hardcoded model allowlist and does not guess aliases.

When a recognized chat body contains a PDF-shaped inline part, a pure resolver checks its exact string-valued `body.model` before decoding the data URL or invoking the PDF parser, splitter, hasher, Files API, or chat endpoint:

```ts
export type PdfModelCatalogEntry = {
  attachment?: unknown
  modalities?: { input?: unknown }
}

export type CatalogSnapshot = {
  available: boolean
  fetchedAtMs: number
  models: Readonly<Record<string, PdfModelCatalogEntry>>
}

export type PdfCapabilityDecision =
  | { state: "supported" }
  | { state: "unsupported" }
  | { state: "unknown" }

export function decidePdfCapability(
  modelID: unknown,
  snapshot: CatalogSnapshot,
  rejectedModels: ReadonlySet<string>,
): PdfCapabilityDecision
```

The states are defined exactly:

- `supported`: an exact catalog entry exists, `attachment === true`, `modalities.input` is an array, and that array contains `pdf`.
- `unsupported`: an exact entry explicitly has `attachment === false`, or it has a present input-modality array that does not contain `pdf`, or the model is in the process-local runtime-rejection set.
- `unknown`: the catalog fetch failed, the model ID is missing or non-string, no exact entry exists, or the entry's relevant fields are missing, malformed, or contradictory without an explicit negative signal.

Only `supported` opens the side-effect gate. `unsupported` and `unknown` fail before document decoding or any network request. Unknown capability never means "upload and let Aiand decide" because that would create retained user data and cost without positive authorization.

Internally, request preparation uses discriminated states: a genuine passthrough request with no recognized PDF, a recognized request with unresolved PDF slots, and an authorized request plan. PDF decoding and upload helpers consume only an authorized plan. This makes an unresolved PDF structurally ineligible for either Files API upload or rewritten chat dispatch.

The original request remains available only for genuine passthrough when no recognized PDF exists or when the overall chat shape is outside the adapter's supported schema. A recognized PDF request with a missing or malformed `body.model` is `unknown` and fails closed rather than passing inline bytes to chat.

### Runtime capability drift

Catalog evidence can be falsely positive or become stale during a long-lived process. If a transformed PDF chat request returns exactly HTTP 400 with `error.code=model_capability_mismatch`, the adapter:

1. returns that response unchanged to the current caller;
2. records the exact model ID in a process-local negative set;
3. performs no retry, fallback, probe, or second model call; and
4. refuses future PDF uploads for that model before side effects.

The negative observation is cleared only by restarting OpenCode, which creates a new catalog snapshot. Other HTTP statuses and error codes do not affect capability state. The set stores model IDs only, never request content, filenames, digests, file IDs, or credentials.

### PDF preparation boundary

Extract document preparation from the HTTP adapter into `src/pdf-chunks.ts`. Its public contract is:

```ts
export type PdfChunk = {
  bytes: Uint8Array
  firstPage: number
  lastPage: number
}

export async function preparePdfChunks(
  bytes: Uint8Array,
  options?: { maxPagesPerChunk?: number; maxChunkBytes?: number },
): Promise<PdfChunk[]>
```

The default page limit is exactly 100. The default byte limit is exactly 100 MiB (`100 * 1024 * 1024`), matching the existing decoded-file limit.

The function loads the PDF once with `pdf-lib` and obtains the page count:

- Zero-page documents fail with `[aiand] PDF split failed: document has no pages`.
- PDFs containing 1 through 100 pages return one chunk whose bytes are the original input bytes. They are not rewritten.
- PDFs containing more than 100 pages are copied into consecutive page ranges of at most 100 pages: `1-100`, `101-200`, and so on.
- Chunks are created and serialized sequentially to bound peak memory.
- Every returned chunk, including an unchanged original, is checked against the byte limit before upload.
- Parse, copy, or serialization failures become a fixed `[aiand] PDF split failed: document could not be processed` error. Parser error text is not exposed.

An oversized emitted chunk fails safely instead of recursively changing the page boundary. The original input is already capped at 100 MiB, so this case is expected only when PDF rewriting duplicates unusually large shared resources.

### Request transformation

The existing adapter identifies PDF-shaped parts from their declared data-URL prefix without decoding them. Once the selected model passes the capability gate, it accepts only canonical `data:application/pdf;base64,...` file parts and validates their decoded size, base64 syntax, and `%PDF-` signature.

For every recognized PDF part it:

1. Resolves the exact selected model against the immutable capability snapshot.
2. Opens the authorized side-effect gate.
3. Decodes and validates the PDF, then computes the SHA-256 digest of the original bytes.
4. Resolves an ordered document manifest for that digest.
5. Replaces the one inline part with one or more adjacent parts:

```json
[
  { "type": "file", "file": { "file_id": "file-pages-1-100" } },
  { "type": "file", "file": { "file_id": "file-pages-101-120" } }
]
```

6. Preserves the position of the original attachment relative to all surrounding text, images, files, and tools.
7. Sends one unchanged chat-completions request after all chunk references are ready.

No inline PDF bytes or locally generated chunks are sent to the chat endpoint.

### Upload and filenames

Each chunk uses the existing Files API upload path:

- `POST <baseURL>/files`
- multipart field `purpose=document`
- `redirect=error`
- the original authorization and safe request headers
- no inherited multipart `content-type` or stale `content-length`

Generated filenames remain content-derived and user-independent. A chunk uses `document-${digest.slice(0, 12)}.pdf`, where the digest is computed from that chunk's bytes. The original filename and page range are not sent or logged.

### Cache and concurrency

The adapter keeps four process-local structures:

1. The existing leaf lease map, keyed by a chunk's SHA-256 digest, containing only `{ fileID, expiresAtMs }`.
2. A settled document-manifest map, keyed by the original PDF digest, containing the ordered `FileLease[]` required by chat.
3. An in-flight document promise map, keyed by the original PDF digest, so concurrent requests share parsing, splitting, and upload work.
4. A negative capability set containing exact model IDs contradicted by a runtime `model_capability_mismatch` response.

Settled manifests contain no PDF bytes, data URLs, filenames, parser objects, multipart bodies, request bodies, response bodies, or credentials. Their lease objects contain only file IDs and expiry timestamps.

Manifest reuse is allowed only while every lease remains outside the existing expiry safety window. When any lease is missing or expired, the manifest is removed and the source PDF is prepared again. Existing valid leaf leases can be reused by digest, including after a partial prior failure.

The document in-flight promise is removed in `finally`. Rejected promises and incomplete manifests are never cached.

### Partial failure

Chunks are uploaded sequentially. The document manifest is published only after every chunk upload succeeds.

If a later chunk fails:

- chat is not dispatched;
- no incomplete manifest is stored;
- the fixed safe upload error is returned;
- successful leaf leases remain eligible for content-addressed reuse during a later retry;
- no PDF bytes are retained after the failed operation settles.

### Stale-reference recovery

The adapter retains the existing exact one-shot recovery conditions:

- HTTP 410 with `error.code=file_expired`; or
- HTTP 404 with `error.code=file_not_found`.

Because the response does not identify which file reference was stale, every file ID used by that transformed chat attempt is considered suspect. Invalidation is compare-and-delete safe:

- remove a leaf lease only when its current `fileID` equals an ID used by the stale request;
- remove a document manifest only when its current ordered leases still contain an ID used by the stale request.

This prevents a delayed concurrent stale response from deleting a newer refresh. The adapter prepares the ordered references again and retries chat exactly once.

### Model context limits

Aiand converts each PDF page to an image for inference. Chunking does not reduce the total page count presented to the model. A 120-page source therefore produces two uploaded files but still presents 120 page-images in one chat request.

Aggregate image limits, model context limits, latency, and billing remain the user's model-selection responsibility. Context, image-count, and input-size errors after successful capability authorization and upload are returned unchanged; they do not trip the capability breaker or cause separate calls or summaries.

## Error handling and privacy

New local failures use fixed messages:

- `[aiand] PDF capability failed: selected model does not support PDF input`
- `[aiand] PDF capability failed: selected model capability is unavailable`
- `[aiand] PDF split failed: document has no pages`
- `[aiand] PDF split failed: document could not be processed`
- `[aiand] PDF split failed: chunk exceeds 104857600 bytes`

The adapter does not expose parser exception text. Existing safe validation, upload, response-validation, and stale-reference errors remain unchanged.

Logs and errors must not contain PDF bytes, data URLs, user filenames, complete digests, authorization headers, arbitrary provider messages, or parser messages.

## Dependency

Add `pdf-lib` version `^1.17.1` as a production dependency. It is MIT-licensed, pure JavaScript, includes TypeScript declarations, and does not require native binaries.

## Testing

### Chunk preparation tests

Generate deterministic PDFs in memory and verify:

- 1-page and 100-page PDFs return the original bytes unchanged;
- 101 pages become chunks with 100 and 1 pages;
- 201 pages become chunks with 100, 100, and 1 pages;
- page order is preserved across chunk boundaries using page dimensions or embedded page labels;
- an injected small byte limit rejects an oversized emitted chunk with the fixed error;
- malformed and zero-page PDFs fail with fixed, content-free errors.

### Transport tests

Verify:

- one 101-page inline part becomes two ordered uploads and two adjacent chat `file_id` parts;
- the outbound chat body contains no inline PDF data;
- surrounding content and request options retain their order and values;
- sequential and concurrent references to the same source reuse one ordered manifest;
- a later-chunk upload failure prevents chat and does not cache an incomplete manifest;
- retrying after partial failure reuses already uploaded chunk leases;
- exact stale responses invalidate the matching current manifest and refresh once;
- concurrent stale responses do not evict a newer manifest;
- non-PDF and unexpected request shapes retain existing passthrough behavior.

### Capability tests

Use table-driven catalog fixtures and side-effect counters to verify:

- only `attachment=true` combined with an input modality containing `pdf` authorizes processing;
- explicit `attachment=false` or a present input-modality list without `pdf` is unsupported;
- a missing catalog entry, catalog outage, missing or malformed fields, missing model ID, and guessed alias are unknown;
- unsupported and unknown requests invoke zero decoders, parsers, splitters, hashers, uploads, and chat dispatches;
- a non-PDF request is unaffected by the capability resolver;
- the exact HTTP 400 `model_capability_mismatch` response is returned unchanged and blocks later PDF attempts for that exact model;
- unrelated status/code combinations do not change future capability decisions;
- no hidden model call, local text extraction, OCR, or model fallback occurs.

### Verification

Before publication:

- `npm test`
- `npm run check`
- `npm run check:dist`
- `git diff --check`
- independent code review with no unresolved Critical or Important findings
- live OpenCode/Kimi K3 smoke test with the small fixture
- live OpenCode/Kimi K3 test with the unchanged 120-page `manual.pdf`

The unchanged manual is accepted when both chunks upload and chat is dispatched. A subsequent model context or capability error is distinct from the Files API page-limit failure and does not invalidate chunking correctness, but a successful model response is the preferred end-to-end result.

## Documentation and release impact

Update the README to state that PDFs over 100 pages are split automatically into ordered Aiand file references, with no configuration required. Document that the exact selected model must positively advertise both PDF input and attachment support, while unknown or text-only models fail before upload. Retain the 100 MB source-file limit and explain that total pages still count toward the selected model's multimodal/context limits.

The pull request description must call out transparent chunking, pre-upload capability enforcement, and the remaining model-level context responsibility.
