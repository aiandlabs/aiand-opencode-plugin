# Aiand PDF Chunking and Capability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transparently split PDFs over 100 pages into ordered Aiand file references while refusing PDF side effects for models that do not have positive PDF capability evidence.

**Architecture:** Add a pure `pdf-lib`-based page chunker and a pure catalog capability resolver, then compose them inside the existing custom fetch bridge. The bridge gates all PDF decoding and upload work on the exact `body.model`, resolves one metadata-only ordered manifest per source digest, expands one inline PDF part into adjacent `file_id` parts, and retains exact one-shot stale recovery plus a passive runtime capability breaker.

**Tech Stack:** TypeScript 7, Node.js/Bun Fetch APIs, `pdf-lib` 1.17.1, `node:crypto`, Node's built-in test runner, OpenCode plugin hooks.

## Global Constraints

- Aiand document uploads remain limited to 100 MiB per returned chunk and 100 pages per uploaded PDF.
- PDFs of 100 pages or fewer must be uploaded byte-for-byte without rewriting.
- Oversized PDFs must use consecutive page ranges of at most 100 pages and preserve page order.
- All chunks must appear as adjacent `file_id` parts in one chat-completions request; never create hidden model calls or answer aggregation.
- Only an exact catalog entry with `attachment === true` and `modalities.input` containing `pdf` authorizes PDF decoding or network side effects.
- Known unsupported and unknown capability states must fail before decode, split, upload, or chat dispatch.
- Never hardcode model IDs, guess aliases, or silently extract text, run OCR, switch models, or expose a capability override.
- Settled caches retain metadata only: digests as map keys, file IDs, expiry timestamps, and ordered leases; never PDF bytes, data URLs, filenames, parser objects, credentials, or response bodies.
- Stale-reference recovery remains limited to exact `410/file_expired` and `404/file_not_found` pairs and one chat retry.
- Runtime capability drift is recorded only after exact `400/model_capability_mismatch`; it causes no retry and is cleared on process restart.
- Generated filenames remain digest-derived and contain no user-controlled text.
- Implement every behavior with a failing test first and commit after each independently green task.

---

### Task 1: Add the portable PDF page chunker

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/pdf-chunks.ts`
- Create: `test/pdf-chunks.test.mjs`

**Interfaces:**
- Consumes: decoded PDF bytes as `Uint8Array`
- Produces:

```ts
export type PdfChunk = {
  bytes: Uint8Array
  firstPage: number
  lastPage: number
}

export type PreparePdfChunksOptions = {
  maxPagesPerChunk?: number
  maxChunkBytes?: number
}

export function preparePdfChunks(
  bytes: Uint8Array,
  options?: PreparePdfChunksOptions,
): Promise<PdfChunk[]>
```

- [ ] **Step 1: Install the production dependency**

Run:

```powershell
npm install pdf-lib@^1.17.1
```

Expected: `pdf-lib` appears under `dependencies`, not `devDependencies`, and `package-lock.json` records version 1.17.1.

- [ ] **Step 2: Write failing unchanged-byte boundary tests**

Create a deterministic helper in `test/pdf-chunks.test.mjs`:

```js
import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument } from "pdf-lib"
import { preparePdfChunks } from "../dist/pdf-chunks.js"

async function makePdf(pageCount) {
  const document = await PDFDocument.create()
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([200 + index, 300])
  }
  return Buffer.from(await document.save())
}

for (const pageCount of [1, 100]) {
  test(`returns a ${pageCount}-page PDF unchanged`, async () => {
    const source = await makePdf(pageCount)
    const chunks = await preparePdfChunks(source)
    assert.equal(chunks.length, 1)
    assert.deepEqual(Buffer.from(chunks[0].bytes), source)
    assert.deepEqual([chunks[0].firstPage, chunks[0].lastPage], [1, pageCount])
  })
}
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `npm test -- test/pdf-chunks.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/pdf-chunks.js`.

- [ ] **Step 4: Implement the minimal unchanged path**

Create `src/pdf-chunks.ts`, load with `PDFDocument.load(bytes)`, reject zero pages, validate returned byte length, and return the original `Uint8Array` when `pageCount <= maxPagesPerChunk`. Catch parser exceptions and replace them with `[aiand] PDF split failed: document could not be processed`; do not catch the module's own fixed errors.

- [ ] **Step 5: Run the boundary tests and verify GREEN**

Run: `npm test -- test/pdf-chunks.test.mjs`

Expected: 1-page and 100-page cases pass.

- [ ] **Step 6: Write failing split and order tests**

Add cases for 101 and 201 pages. Load each emitted chunk with `PDFDocument.load`, assert page counts `[100, 1]` and `[100, 100, 1]`, flatten all page widths, and assert they equal the source sequence `200..(199 + pageCount)`.

- [ ] **Step 7: Run the split tests and verify RED**

Run: `npm test -- test/pdf-chunks.test.mjs`

Expected: FAIL because the implementation returns one unchanged oversized chunk.

- [ ] **Step 8: Implement sequential ordered splitting**

For `start = 0; start < pageCount; start += maxPagesPerChunk`, create one `PDFDocument`, call `copyPages(source, indices)`, add copied pages in order, save it, enforce `maxChunkBytes`, push `{ bytes, firstPage: start + 1, lastPage: end }`, and release local chunk references before the next loop iteration.

- [ ] **Step 9: Add failing fixed-error tests**

Cover invalid `%PDF-` bytes, a zero-page PDF created by `PDFDocument.create().save()`, and `maxChunkBytes: 1`. Assert only:

```js
await assert.rejects(preparePdfChunks(bytes), {
  message: "[aiand] PDF split failed: document could not be processed",
})
```

or the exact zero-page and byte-limit messages from the design. Assert parser messages are absent.

- [ ] **Step 10: Implement fixed errors and verify the component**

Run:

```powershell
npm test -- test/pdf-chunks.test.mjs
npm run check
```

Expected: all chunker tests and TypeScript checks pass.

- [ ] **Step 11: Commit**

```powershell
git add package.json package-lock.json src/pdf-chunks.ts test/pdf-chunks.test.mjs
git commit -m "feat: split oversized Aiand PDFs"
```

---

### Task 2: Add the pure model capability resolver

**Files:**
- Create: `src/pdf-capability.ts`
- Create: `test/pdf-capability.test.mjs`

**Interfaces:**
- Produces:

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
  rejectedModels?: ReadonlySet<string>,
): PdfCapabilityDecision
```

- [ ] **Step 1: Write the failing decision-table test**

Create table cases covering:

```js
[
  [true, ["text", "pdf"], "supported"],
  [true, ["text", "image", "pdf"], "supported"],
  [false, ["text", "pdf"], "unsupported"],
  [true, ["text"], "unsupported"],
  [undefined, ["text", "pdf"], "unknown"],
  [true, undefined, "unknown"],
  ["yes", ["text", "pdf"], "unknown"],
  [true, "pdf", "unknown"],
]
```

Also assert unknown for unavailable snapshots, missing/non-string model IDs, absent exact entries, and alias-like IDs; assert unsupported when the exact model is present in `rejectedModels`.

- [ ] **Step 2: Run the resolver test and verify RED**

Run: `npm test -- test/pdf-capability.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure resolver**

Use exact `Record` lookup only. Reject missing or non-string model IDs first. For a string model ID, let membership in the runtime-rejection set return `unsupported` before checking snapshot availability. Then check snapshot availability and exact entry presence before fields, return `supported` only for the strict conjunction, and apply explicit catalog negatives before malformed-field unknowns.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
npm test -- test/pdf-capability.test.mjs
npm run check
```

Expected: all resolver cases pass.

```powershell
git add src/pdf-capability.ts test/pdf-capability.test.mjs
git commit -m "feat: resolve Aiand PDF capabilities"
```

---

### Task 3: Wire the immutable catalog snapshot and pre-upload gate

**Files:**
- Modify: `src/index.ts`
- Modify: `src/pdf-upload-fetch.ts`
- Modify: `test/plugin-config.test.mjs`
- Modify: `test/pdf-upload-fetch.test.mjs`

**Interfaces:**
- `createPdfUploadFetch` gains required option `catalogSnapshot: CatalogSnapshot`.
- `fetchCatalogModels()` becomes `fetchCatalogSnapshot(): Promise<CatalogSnapshot>`.
- The config hook injects `snapshot.models`; the transport receives the exact same `snapshot` object.

- [ ] **Step 1: Add shared supported-catalog fixtures to transport tests**

Define:

```js
const SUPPORTED_CATALOG = {
  available: true,
  fetchedAtMs: 1_786_660_000_000,
  models: {
    "moonshotai/kimi-k3": {
      attachment: true,
      modalities: { input: ["text", "image", "pdf"] },
    },
  },
}
```

Pass it to every existing `createPdfUploadFetch` call so all current PDF tests retain their intended supported-model premise.

- [ ] **Step 2: Write failing early-gate tests**

Add three exact cases:

1. Known text-only model with malformed base64 PDF data throws `[aiand] PDF capability failed: selected model does not support PDF input` and records zero network calls.
2. Missing catalog entry with malformed base64 throws `[aiand] PDF capability failed: selected model capability is unavailable` and records zero network calls.
3. The same malformed PDF under a supported model reaches the existing validation error, proving ordering.

Also add a non-PDF request under an unavailable catalog and assert exact passthrough.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- test/pdf-upload-fetch.test.mjs`

Expected: known unsupported and unknown cases proceed to PDF validation or upload instead of returning capability errors.

- [ ] **Step 4: Implement recognized-PDF detection and authorization**

After safe JSON/schema parsing, scan message content for `file.file_data` strings whose lowercased prefix begins `data:application/pdf`. If none exist, retain existing passthrough. If any exist, call `decidePdfCapability(body.model, catalogSnapshot, rejectedModels)` before `inlinePdfPart`, `decodePdf`, hashing, or network operations. Throw the fixed unsupported or unknown error for non-supported states.

- [ ] **Step 5: Write failing plugin snapshot tests**

Extend the successful mocked catalog assertion so the configured model map still contains Kimi K3 and its PDF metadata. Add a failed-catalog fetch case verifying text-only config construction still completes with `{}` models and a defined fetch function.

- [ ] **Step 6: Implement one immutable startup snapshot**

Return `{ available: true, fetchedAtMs: Date.now(), models }` only after a successful catalog response and valid provider entry. All HTTP, timeout, JSON, or shape failures return `{ available: false, fetchedAtMs: Date.now(), models: {} }`. Create the custom fetch with that snapshot and inject the same `snapshot.models` into provider config.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npm test
npm run check
```

Expected: existing tests plus capability gate and plugin snapshot tests pass.

```powershell
git add src/index.ts src/pdf-upload-fetch.ts test/plugin-config.test.mjs test/pdf-upload-fetch.test.mjs
git commit -m "feat: gate PDF uploads by model capability"
```

---

### Task 4: Expand one PDF into an ordered cached upload manifest

**Files:**
- Modify: `src/pdf-upload-fetch.ts`
- Modify: `test/pdf-upload-fetch.test.mjs`

**Interfaces:**
- Consumes: `preparePdfChunks(bytes)` from Task 1.
- Adds internal structures:

```ts
const manifests = new Map<string, FileLease[]>()
const preparations = new Map<string, Promise<FileLease[]>>()

async function resolveDocument(
  bytes: Buffer,
  sourceDigest: string,
  headers: Headers,
): Promise<FileLease[]>
```

- [ ] **Step 1: Write the failing 101-page transport test**

Generate one 101-page PDF with `pdf-lib`, attach it between surrounding text parts, and assert:

- exactly two `/files` calls occur;
- loaded multipart blobs contain 100 and 1 pages in that order;
- upload calls are sequential;
- the one source part becomes two adjacent `{ type: "file", file: { file_id } }` parts;
- surrounding parts remain in their original positions;
- chat contains no `data:application/pdf;base64`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- test/pdf-upload-fetch.test.mjs`

Expected: only one original upload and one chat file part occur.

- [ ] **Step 3: Implement document resolution and flat expansion**

Check a settled manifest only when every lease passes the existing expiry safety rule. Check the preparation map next. Otherwise create one promise that calls `preparePdfChunks`, hashes each chunk, awaits `resolveLease` sequentially, and publishes the ordered manifest only after all resolve. Delete the preparation promise in `finally`.

Change content transformation from `map(part -> part)` to `map(part -> part[])` plus flattening. Non-PDF parts return `[part]`; one PDF returns one file-reference part per lease.

- [ ] **Step 4: Write failing manifest reuse tests**

Add tests proving two sequential source references produce two uploads total, two concurrent references share one preparation/upload set, and distinct 101-page sources produce independent manifests.

- [ ] **Step 5: Implement settled and in-flight manifest reuse**

Store only ordered lease objects in settled manifests. Do not retain chunk bytes or chunk digests as manifest values. Preserve leaf digest caching so re-preparation can reuse a prior successful chunk.

- [ ] **Step 6: Write failing partial-upload recovery test**

Make chunk 1 succeed, chunk 2 return HTTP 500, and assert no chat call. Retry the same source with chunk 2 succeeding; assert chunk 1 is not uploaded again, chunk 2 is retried, and one chat request contains both IDs.

- [ ] **Step 7: Implement incomplete-manifest behavior and verify**

Publish no manifest until every chunk succeeds. Leave successful leaf leases in the existing leaf cache. Let the preparation promise reject and remove itself.

Run:

```powershell
npm test
npm run check
```

Expected: all manifest, concurrency, partial failure, and existing transport tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/pdf-upload-fetch.ts test/pdf-upload-fetch.test.mjs
git commit -m "feat: upload ordered PDF chunk manifests"
```

---

### Task 5: Make manifest invalidation and capability drift race-safe

**Files:**
- Modify: `src/pdf-upload-fetch.ts`
- Modify: `test/pdf-upload-fetch.test.mjs`

**Interfaces:**
- Transformed requests retain `modelID: string` and `usedFileIDs: Set<string>` as local metadata only.
- Adds exact response predicate for HTTP 400 plus `error.code=model_capability_mismatch`.

- [ ] **Step 1: Write failing multi-chunk stale tests**

For a 101-page source, return `410/file_expired` on the first chat and success on the second. Assert all current chunk IDs are invalidated, exactly two refreshed uploads occur, the retry contains the two new ordered IDs, and chat retries once.

Add two concurrent stale responses delayed as in the existing single-file race test. Assert a delayed response that used old IDs does not delete the newer manifest or trigger a third upload generation.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- test/pdf-upload-fetch.test.mjs`

Expected: the current digest-key invalidation cannot correctly preserve/refresh an ordered manifest.

- [ ] **Step 3: Implement file-ID compare-and-delete invalidation**

Collect every file ID used by a transformed attempt. On exact stale response, scan leaf leases and remove only entries whose current `fileID` belongs to that set. Remove a manifest only when its current lease array still contains a used file ID. Rebuild and retry once.

- [ ] **Step 4: Write failing runtime drift tests**

Return exact `400/model_capability_mismatch` after successful uploads. Assert the response is returned unchanged, there is no chat retry, and the next PDF request for that model fails with the unsupported fixed error before upload. Add controls for HTTP 500 with that code and HTTP 400 with another code; neither may alter the next request.

- [ ] **Step 5: Implement the passive negative capability set**

After chat dispatch, inspect a clone without consuming the original response. For the exact drift pair only, add the authorized exact model ID to `rejectedModels`; do not evict uploads or retry. The next request is rejected by the Task 3 gate.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npm test
npm run check
git diff --check
```

Expected: stale manifest, concurrent race, drift breaker, and all regression tests pass.

```powershell
git add src/pdf-upload-fetch.ts test/pdf-upload-fetch.test.mjs
git commit -m "fix: handle PDF capability drift safely"
```

---

### Task 6: Document, review, and publish the complete fix

**Files:**
- Modify: `README.md`
- Modify: PR body on GitHub after validation

**Interfaces:**
- User-facing behavior only; no new configuration.

- [ ] **Step 1: Update README behavior and limits**

Document:

- automatic ordered splitting above 100 pages;
- the unchanged byte path through 100 pages;
- the 100 MiB source/chunk ceiling;
- strict positive model capability authorization from Aiand's live catalog;
- fail-before-upload behavior for text-only and unknown models;
- one request with multiple references;
- aggregate page/context responsibility remains with the selected model;
- process-local metadata-only reuse and default Aiand retention remain unchanged.

- [ ] **Step 2: Run fresh full verification**

Run:

```powershell
npm test
npm run check
npm run check:dist
git diff --check
git status --short
```

Expected: zero failures, `check-dist ok: AiandPlugin`, no whitespace errors, and only the intended README change before its commit.

- [ ] **Step 3: Commit documentation**

```powershell
git add README.md
git commit -m "docs: explain automatic PDF chunking"
```

- [ ] **Step 4: Request independent code review**

Review the complete range from `de9f106` through the new head against:

- `docs/superpowers/specs/2026-08-14-aiand-pdf-chunking-design.md`
- this implementation plan

Fix every Critical or Important finding test-first, rerun the reviewer, and require `Ready to merge: Yes`.

- [ ] **Step 5: Run live supported-model smoke tests**

Verify OpenCode resolves the feature worktree, then run:

```powershell
opencode run 'Read the attached PDF and reply with only the text it contains.' --title 'Aiand PDF chunk smoke' --print-logs --log-level ERROR -m aiand/moonshotai/kimi-k3 --variant high -f 'B:\dvr\.opencode-pdf-smoke.pdf'

opencode run 'Read the attached PDF. Reply with its title and one concise sentence describing it.' --title 'Aiand PDF 120-page acceptance' --print-logs --log-level ERROR -m aiand/moonshotai/kimi-k3 --variant high -f 'B:\dvr\manual.pdf'
```

Expected: the fixture returns `PDF smoke test`; the unchanged manual produces two successful uploads rather than Aiand's per-file page-limit error and reaches chat. A distinct aggregate model context/image-limit error is reported as such and is not retried.

- [ ] **Step 6: Verify unsupported-model behavior without retaining the manual**

Use an existing text-only catalog model with the small fixture and confirm the fixed capability error occurs before any `/files` request. Prefer automated transport evidence for the zero-upload assertion; do not send the 120-page manual to a text-only model.

- [ ] **Step 7: Push and open the draft cross-fork PR**

Run:

```powershell
git push origin feat/pdf-support
```

Open a draft PR from `jethac:feat/pdf-support` to `aiandlabs:main`. The body must cover root cause, Files API translation, automatic chunking, capability gating, cache/retry/privacy behavior, 40+ automated tests, live acceptance evidence, and the remaining aggregate model-context responsibility.
