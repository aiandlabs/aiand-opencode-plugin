# ai& OpenCode PDF Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transparently upload OpenCode inline PDFs to ai& and replace them with valid `file_id` references before chat dispatch.

**Architecture:** Add a narrowly scoped custom fetch bridge to the ai& provider. The bridge recognizes only the PDF shape emitted by `@ai-sdk/openai-compatible`, resolves a content-addressed process-local upload lease, rewrites the chat request immutably, and performs one guarded recovery when ai& reports a stale file reference.

**Tech Stack:** TypeScript, Node.js 22/Bun Web APIs (`fetch`, `Request`, `Response`, `FormData`, `Blob`), `node:crypto`, Node's built-in test runner, OpenCode plugin hooks.

## Global Constraints

- Transform PDFs only; preserve all other content and provider behavior.
- Use `POST /v1/files` with `purpose=document`; consume upload response field `id` as the later chat `file_id`.
- Cache one upload per decoded-byte SHA-256 digest per plugin process until conservative expiry.
- Store no PDF bytes, data URLs, filenames, API keys, or response bodies in settled cache entries.
- Never forward recognized inline PDF bytes to `/chat/completions` after validation or upload failure.
- Expose no new user-facing configuration.
- Retry chat exactly once and only for definitive `file_expired` or `file_not_found` errors.
- Preserve streaming and abort behavior for the final chat request.
- Add no runtime dependency; support Node.js 22 CI and OpenCode's Bun runtime.

---

### Task 1: Establish the executable HTTP-boundary test harness

**Files:**
- Create: `test/pdf-upload-fetch.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: compiled `dist/pdf-upload-fetch.js`
- Produces: `npm test`, which builds TypeScript and runs `node --test`

- [ ] **Step 1: Add the first failing transport test**

Add a test that imports `createPdfUploadFetch` from `../dist/pdf-upload-fetch.js`, sends a chat request containing a minimal `%PDF-` data URL through an injected recording fetch, and asserts:

```js
assert.equal(calls[0].url, "https://api.aiand.com/v1/files")
assert.equal(calls[0].init.method, "POST")
assert.equal(await calls[0].init.body.get("purpose"), "document")

const chat = JSON.parse(calls[1].init.body)
assert.deepEqual(chat.messages[0].content[1], {
  type: "file",
  file: { file_id: "file-test-1" },
})
assert.equal(calls[1].init.body.includes("data:application/pdf;base64"), false)
```

The recording fetch returns `{ id: "file-test-1", expires_at: 1786665600 }` for `/files` and an SSE-compatible `200 Response` for chat.

- [ ] **Step 2: Add the test command and CI invocation**

Set:

```json
"test": "npm run build && node --test"
```

Add `npm test` to `.github/workflows/ci.yml` after `npm install`. Retain the existing build and distribution checks.

- [ ] **Step 3: Run the test and verify RED**

Run: `npm test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/pdf-upload-fetch.js`.

- [ ] **Step 4: Commit the verified failing test**

```bash
git add package.json package-lock.json .github/workflows/ci.yml test/pdf-upload-fetch.test.mjs
git commit -m "test: specify Aiand PDF request translation"
```

### Task 2: Implement strict PDF recognition, upload, and request rewriting

**Files:**
- Create: `src/pdf-upload-fetch.ts`
- Modify: `test/pdf-upload-fetch.test.mjs`

**Interfaces:**
- Produces: `createPdfUploadFetch(options: PdfUploadFetchOptions): typeof globalThis.fetch`
- `PdfUploadFetchOptions` contains `baseURL`, optional `fetchImpl`, optional `now`, optional `maxPdfBytes`, and optional `expirySafetyMs`
- Internal `FileLease` contains only `fileID` and `expiresAtMs`

- [ ] **Step 1: Implement the minimum passing request bridge**

Create the provider fetch wrapper with this public shape:

```ts
export type PdfUploadFetchOptions = {
  baseURL: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
  maxPdfBytes?: number
  expirySafetyMs?: number
}

export function createPdfUploadFetch(options: PdfUploadFetchOptions): typeof globalThis.fetch
```

The wrapper must:

```ts
// 1. Pass through requests that are not POST <baseURL>/chat/completions.
// 2. Parse a string JSON body and map messages/content immutably.
// 3. Match only type=file with canonical application/pdf file_data.
// 4. Strictly validate base64, decoded size, and leading %PDF- bytes.
// 5. Upload FormData(file=<Blob>, purpose=document) to <baseURL>/files.
// 6. Require response JSON { id: non-empty string }.
// 7. Replace the part with { ...part, file: { file_id: id } }.
// 8. Delete content-length from rebuilt chat headers.
```

Use a digest-derived filename `document-${digest.slice(0, 12)}.pdf`, `redirect: "error"` for uploads, and the original request's headers except multipart `content-type` and `content-length`.

- [ ] **Step 2: Run the first test and verify GREEN**

Run: `npm test`

Expected: the first translation test passes.

- [ ] **Step 3: Add failing strict-boundary tests**

Add table-driven cases for malformed PDF data URLs, invalid base64, wrong `%PDF-` signature, and decoded size over the injected limit. Each must assert a stable `[aiand] PDF <stage> failed` error and zero chat requests.

Also add passthrough/preservation tests asserting:

```js
// No PDF: exactly one original fetch call, no upload.
// Existing file_id: unchanged.
// image_url, input_audio, text, tool fields, model options, and custom headers: unchanged.
// Non-PDF file_data: unchanged.
```

- [ ] **Step 4: Run strict-boundary tests and verify RED**

Run: `npm test`

Expected: new malformed/preservation cases fail against the minimal implementation.

- [ ] **Step 5: Implement fail-closed validation and lossless passthrough**

Add narrow type guards and errors. Do not log request bodies, filenames, authorization, or complete digests. If a part starts as a PDF data URL but fails canonical validation, throw before invoking chat.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npm test`

Expected: all boundary tests pass with zero warnings other than Node/Bun platform notices.

- [ ] **Step 7: Commit the strict request bridge**

```bash
git add src/pdf-upload-fetch.ts test/pdf-upload-fetch.test.mjs
git commit -m "feat: translate inline PDFs to Aiand file references"
```

### Task 3: Add content-addressed leases, concurrency control, and stale-reference recovery

**Files:**
- Modify: `src/pdf-upload-fetch.ts`
- Modify: `test/pdf-upload-fetch.test.mjs`

**Interfaces:**
- Internal settled cache: `Map<string, FileLease>`
- Internal in-flight cache: `Map<string, Promise<FileLease>>`
- A lease uses returned `expires_at` seconds or a 30-day fallback, minus a fixed safety margin

- [ ] **Step 1: Add failing lease and concurrency tests**

Add tests proving:

```js
// Sequential identical PDFs upload once.
// Concurrent identical PDFs await one upload promise.
// Distinct PDF bytes upload separately.
// A rejected upload is removed and a later call retries.
// A lease at/before the injected clock plus safety margin is re-uploaded.
// Settled cache behavior does not require retaining the original bytes.
```

- [ ] **Step 2: Run lease tests and verify RED**

Run: `npm test`

Expected: duplicate upload counts and expiry expectations fail.

- [ ] **Step 3: Implement two-map single-flight leases**

Compute the digest before lookup. Check the settled lease, then join an existing upload promise, otherwise register the new promise before awaiting network I/O. On success, move metadata to the settled map; in `finally`, remove the in-flight promise. On rejection, do not create a settled entry.

- [ ] **Step 4: Run lease tests and verify GREEN**

Run: `npm test`

Expected: all deduplication, retryability, and expiry cases pass.

- [ ] **Step 5: Add failing guarded-recovery tests**

For transformed chat calls, return exact JSON errors:

```json
{"error":{"code":"file_expired"}}
```

and:

```json
{"error":{"code":"file_not_found"}}
```

Assert one invalidation, one re-upload, and one chat retry. Add controls proving status `500`, unrelated `404`, malformed error JSON, and a second stale-file response are not retried again.

- [ ] **Step 6: Run recovery tests and verify RED**

Run: `npm test`

Expected: stale-file cases return the first failure without re-upload.

- [ ] **Step 7: Implement exact one-shot recovery**

Inspect only a clone of a non-success chat response. Retry only when `error.code` is `file_expired` or `file_not_found`; invalidate digests used by that request, resolve fresh leases from its still-local decoded parts, and dispatch once more with an internal retry guard.

- [ ] **Step 8: Run recovery tests and verify GREEN**

Run: `npm test`

Expected: the full transport suite passes.

- [ ] **Step 9: Commit lease and recovery behavior**

```bash
git add src/pdf-upload-fetch.ts test/pdf-upload-fetch.test.mjs
git commit -m "feat: reuse and refresh Aiand PDF uploads"
```

### Task 4: Wire the bridge into the plugin

**Files:**
- Modify: `src/index.ts`
- Create: `test/plugin-config.test.mjs`
- Modify: `scripts/check-dist.mjs` only if the existing export check cannot load the additional module

**Interfaces:**
- `src/index.ts` imports `createPdfUploadFetch`
- The Aiand provider receives `options.fetch` alongside `baseURL` and `apiKey`

- [ ] **Step 1: Add a failing plugin configuration test**

Stub only the catalog network boundary, invoke `AiandPlugin`, run its `config` hook against an empty config, and assert:

```js
assert.equal(typeof cfg.provider.aiand.options.fetch, "function")
assert.equal(cfg.provider.aiand.options.baseURL, "https://api.aiand.com/v1")
assert.equal(cfg.provider.aiand.npm, "@ai-sdk/openai-compatible")
```

- [ ] **Step 2: Run the plugin test and verify RED**

Run: `npm test`

Expected: `options.fetch` is undefined.

- [ ] **Step 3: Wire the custom fetch into provider options**

Create one bridge per plugin instance and assign it to the injected provider:

```ts
const pdfUploadFetch = createPdfUploadFetch({ baseURL })

options: {
  baseURL,
  apiKey: process.env.AIAND_API_KEY,
  fetch: pdfUploadFetch,
}
```

- [ ] **Step 4: Run unit, build, and distribution checks**

Run:

```bash
npm test
npm run check
npm run check:dist
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit plugin wiring**

```bash
git add src/index.ts test/plugin-config.test.mjs scripts/check-dist.mjs
git commit -m "feat: enable PDF uploads for Aiand models"
```

### Task 5: Document and verify the user-visible behavior

**Files:**
- Modify: `README.md`
- Use for verification: `B:/dvr/.opencode-pdf-smoke.pdf`
- Use for verification: `B:/dvr/manual.pdf`

**Interfaces:**
- The global OpenCode configuration already references `B:/dvr/aiand-opencode-plugin/src/index.ts`
- Smoke command uses `aiand/moonshotai/kimi-k3` with `--variant high` and an explicit title

- [ ] **Step 1: Update README documentation**

Document transparent PDF upload, ai&'s 100 MB/100-page limits, default 30-day server retention, process-local metadata-only reuse, and no required configuration.

- [ ] **Step 2: Run the complete local verification suite**

Run:

```bash
npm test
npm run check
npm run check:dist
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 3: Run the minimal live regression test**

Run from `B:/dvr`:

```bash
opencode run "Read the attached PDF and reply with only the text it contains." --title "Aiand PDF smoke" --print-logs --log-level ERROR -m aiand/moonshotai/kimi-k3 --variant high -f ".opencode-pdf-smoke.pdf"
```

Expected: exit zero and response `PDF smoke test`, with no unsupported `file` or `input_file` error.

- [ ] **Step 4: Run the original manual.pdf regression**

Run a bounded prompt against `manual.pdf` with the same model and explicit title.

Expected: exit zero and a content-based response, with no unsupported content-part error.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: document transparent PDF support"
```

- [ ] **Step 6: Inspect final history and worktree**

Run:

```bash
git log --oneline --decorate -8
git status --short
```

Expected: implementation commits are present and the worktree is clean.
