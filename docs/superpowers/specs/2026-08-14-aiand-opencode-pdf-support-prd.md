# PRD: Transparent PDF Support for ai& in OpenCode

**Status:** Proposed for implementation

**Date:** 2026-08-14

**Repository:** `jethac/aiand-opencode-plugin`

**Target:** The `aiand` provider registered by `@aiand/opencode-plugin`

## Summary

The ai& OpenCode plugin must make PDF attachments work transparently with ai& models that advertise PDF input. OpenCode and `@ai-sdk/openai-compatible` currently serialize an attached PDF inline inside a chat-completions request. The ai& gateway instead requires the PDF to be uploaded through its Files API and referenced in chat by the returned `file_id`.

The plugin will bridge those two wire formats at the provider transport boundary. It will upload each distinct PDF once per OpenCode process, replace inline PDF content with an ai& file reference, reuse that reference while it remains valid, and retain only metadata after the upload finishes.

No new user configuration will be required.

## Problem

OpenCode 1.18.18 passes a PDF attachment to `@ai-sdk/openai-compatible` as a model file part. Version 2.0.41 of that adapter emits the following chat-completions content part:

```json
{
  "type": "file",
  "file": {
    "filename": "document.pdf",
    "file_data": "data:application/pdf;base64,..."
  }
}
```

When sent to ai&, the request fails with:

```text
Unsupported chat content part type: 'file'.
```

The message is misleading at first glance: ai& supports PDF documents, but not this inline representation. Its supported flow is:

1. Upload the PDF to `POST /v1/files` as multipart form data with `purpose=document`.
2. Receive a `file_id` and expiry metadata.
3. Reference that file in chat as:

   ```json
   {
     "type": "file",
     "file": {
       "file_id": "file-..."
     }
   }
   ```

The full ai& contract is documented in the [Files API](https://docs.aiand.com/api/files/) and [file lifecycle documentation](https://docs.aiand.com/api/file-lifecycle/).

Installing the current ai& OpenCode plugin does not solve the problem because the plugin supplies authentication and live catalog data but does not transform requests or upload attachments.

## Goals

1. Make PDF attachments work with ai& from both normal OpenCode message attachments and PDFs returned by OpenCode's `Read` tool.
2. Require no change to the user's prompt or workflow.
3. Upload byte-identical PDFs at most once per OpenCode plugin process while their ai& file lease remains valid.
4. Ensure chat-completions requests never contain inline PDF bytes after the plugin recognizes a PDF part.
5. Preserve all non-PDF messages, content parts, request options, headers, and streaming behavior.
6. Bound retries and fail with a clear, safe error when transformation or upload cannot be completed.
7. Avoid retaining PDF bytes, data URLs, filenames, API keys, or response bodies in the settled cache or logs.
8. Cover the behavior with deterministic automated tests that do not call the live ai& service.

## Non-goals

1. Supporting images, audio, video, office documents, or arbitrary file types through the Files API.
2. Adding a user-facing retention, expiry, cache-size, or cleanup setting.
3. Persisting file IDs across OpenCode process restarts.
4. Building a general-purpose upload manager for every OpenCode provider.
5. Changing OpenCode core, Models.dev, the Vercel AI SDK, or the ai& gateway.
6. Extracting PDF text locally or introducing a PDF parser.
7. Managing long-term document storage or guaranteeing reuse beyond ai&'s file lifetime.
8. Logging document content, complete digests, filenames, authorization headers, or API response bodies.

## Users and use cases

### Primary user

An OpenCode user who selects an ai& model with PDF input support and asks the model to inspect a local PDF.

### Required use cases

- Attach a PDF with `opencode run --file manual.pdf` and receive a model response based on its contents.
- Ask the agent to use `Read` on a PDF and continue the conversation using the resulting attachment.
- Continue a session containing the same PDF without re-uploading it on every inference request.
- Reference the same PDF concurrently from title generation and the primary agent without duplicate uploads.
- Recover automatically if ai& reports that a cached file reference is missing or expired before its expected deadline.
- Receive a direct adapter error when the PDF is malformed, too large, or cannot be uploaded.

## Product behavior

### Transparent operation

The feature has no UI and no configuration switch. For an eligible ai& chat-completions request, the plugin performs the upload and rewrite automatically. Users continue attaching and reading PDFs through standard OpenCode workflows.

### Eligibility

The plugin transforms a content part only when all of the following are true:

- The request targets the configured ai& `/chat/completions` endpoint.
- The HTTP body is JSON in the expected chat-completions shape.
- The content part has `type=file`.
- `file.file_data` is a canonical `data:application/pdf;base64,...` URL.
- The base64 payload decodes successfully.
- The decoded bytes begin with the PDF signature `%PDF-`.
- The decoded size does not exceed ai&'s 100 MB single-file document limit.

Non-PDF parts pass through unchanged. A PDF-shaped part that fails validation causes the request to fail closed; it must not be forwarded inline.

Ai& enforces its 100-page document limit during upload. The plugin surfaces that upload error rather than adding a PDF parser solely to count pages.

### Upload and rewrite

For each eligible PDF, the plugin:

1. Computes SHA-256 over decoded PDF bytes.
2. Resolves a process-local file lease for that digest.
3. On a cache miss, uploads multipart form data to `/v1/files` with:
   - `purpose=document`
   - the decoded PDF bytes
   - a safe generated filename such as `document-<digest-prefix>.pdf`
4. Validates the successful response, including a non-empty `file_id`.
5. Replaces the inline content part immutably with the corresponding `file_id` reference.
6. Removes a stale `content-length` header before dispatching the rebuilt request.

The original input object must not be mutated.

### Reuse and concurrency

The cache is content-addressed by SHA-256 of the PDF bytes. It stores a promise while an upload is in flight so concurrent requests for the same PDF share one upload.

After a successful upload, the settled entry retains only:

- the digest used as the map key;
- `file_id`;
- the conservative expiry deadline.

It does not retain decoded bytes, the base64 data URL, the original filename, multipart data, request bodies, or authentication data.

Rejected upload promises are removed immediately so a later request may retry. Expired entries are removed lazily during lookup; no background timer is required.

### Expiry

The lease uses `expires_at` returned by ai& when it is present and valid. If the response omits a usable expiry, the plugin uses 30 days from successful upload, matching ai&'s documented default.

The effective deadline includes a small internal safety margin so the plugin does not reuse an ID at the expiry boundary. The safety margin is an implementation constant, not user configuration.

### Stale-reference recovery

If the chat endpoint definitively reports `file_expired` or `file_not_found` for a transformed request, the plugin:

1. Invalidates the file leases used by that request.
2. Uploads those PDFs again.
3. Rebuilds the request with the new file IDs.
4. Retries chat dispatch exactly once.

No other status or error triggers an automatic chat retry. The retry guard prevents recursion and duplicate inference attempts. This recovery relies on ai& rejecting invalid file references before invoking the model.

## Error handling

The plugin fails before chat dispatch when:

- a recognized PDF data URL is malformed;
- base64 decoding fails;
- the decoded content lacks the PDF signature;
- the decoded document exceeds 100 MB;
- `/v1/files` returns a non-success status;
- the upload response is not valid JSON;
- the upload response does not contain a valid file ID;
- request rewriting cannot produce a complete inline-free chat payload.

Errors must identify the failed stage—validation, upload, upload response, rewrite, or recovery—without including PDF data, filenames, complete digests, authorization values, or unredacted remote response bodies.

Upload errors remain retryable on the next user request because failed entries are not cached.

## Security and privacy requirements

1. Inline PDF bytes must never reach `/chat/completions` after the plugin recognizes the part as a PDF.
2. Upload requests must use the same authorization context as the chat request.
3. Uploads must target the configured ai& base URL; redirects to a different origin must not receive authorization headers or document bytes.
4. Generated multipart filenames must not contain user-controlled path or header characters.
5. Settled cache records may contain the full digest only as the content-addressed map key; they must not contain API keys, authorization headers, filenames, PDF bytes, data URLs, or response bodies. Logs must not contain complete digests or any of those sensitive values.
6. Request rewriting must use newly constructed objects rather than mutating caller-owned data.
7. The plugin must not silently fall back to inline transmission when upload or validation fails.

## Compatibility requirements

- Preserve the current plugin's live catalog and authentication behavior.
- Continue using `@ai-sdk/openai-compatible` for ai& models.
- Work through OpenCode's existing provider `options.fetch` extension point.
- Preserve streaming responses and abort behavior for the final chat request.
- Preserve all messages and parts that are not eligible inline PDFs.
- Avoid new runtime dependencies unless the implementation plan demonstrates that platform APIs are insufficient.
- Support the Node.js 22 CI environment and OpenCode's Bun-based runtime.

## Observability

Normal operation should be silent.

Errors may expose:

- the processing stage;
- HTTP status;
- ai& request ID when supplied in response headers;
- PDF count;
- whether an upload was a cache hit, miss, or stale-reference recovery.

Errors and logs must not expose document content or identifying metadata. Persistent audit storage and verbose lifecycle logging are out of scope.

## Testing requirements

Automated tests must exercise the real request bridge with the network boundary replaced by a deterministic local test double. Assertions target emitted HTTP requests and observable results, not internal implementation details.

Required cases:

1. A request without an inline PDF passes through unchanged and performs no upload.
2. A valid inline PDF is uploaded as multipart `purpose=document` and rewritten to the returned `file_id`.
3. The outbound chat body contains no original data URL or PDF base64.
4. Text, tools, model options, headers, and unrelated content parts are preserved.
5. Repeated PDFs reuse one valid lease.
6. Concurrent references to identical bytes share one upload.
7. Multiple distinct PDFs receive distinct uploads and references.
8. Failed uploads are not cached and can be retried later.
9. Expired leases trigger a new upload.
10. Exact `file_expired` and `file_not_found` failures cause one re-upload and one chat retry.
11. Other chat failures are not retried.
12. Malformed data URLs, invalid base64, non-PDF signatures, and oversized PDFs fail before chat dispatch.
13. Non-PDF file parts retain existing behavior.
14. Upload response validation rejects missing or malformed file IDs.
15. Settled cache entries contain metadata only.
16. Existing TypeScript build and distribution-shape checks remain green.

CI must run the new test suite alongside `npm run build` and `npm run check:dist`. A live ai& API key must not be required in CI.

## Documentation requirements

The README must explain that the plugin transparently uploads PDFs through ai&'s Files API, that uploaded files follow ai&'s retention policy, and that the process-local cache does not persist document data or file IDs across restarts.

The release notes must identify PDF support as the behavioral change and state that no configuration changes are required.

## Success criteria

The feature is complete when all of the following are true:

1. The 589-byte smoke-test PDF that currently reproduces the Aiand `type=file` rejection succeeds through OpenCode using the locally installed fork.
2. `manual.pdf` can be read through OpenCode with an ai& model without the unsupported-content-part error.
3. Reusing the same PDF within one OpenCode process causes one upload while the lease is valid.
4. No transformed chat request contains inline PDF bytes.
5. Invalid and failed uploads produce safe, actionable errors.
6. Automated tests, TypeScript compilation, and distribution checks pass in Node.js 22 CI.
7. Existing authentication, catalog loading, text prompts, images, tools, and streaming remain unaffected.

## Rollout

1. Implement and validate the behavior in the `jethac/aiand-opencode-plugin` fork loaded from the local source checkout.
2. Verify against the minimal smoke-test PDF, then the original `manual.pdf` reproduction.
3. Open an upstream pull request with tests, documentation, and the reproduction details.
4. Retain the local fork installation until the upstream fix is merged and published.

## Open questions

None. PDF-only scope, automatic 30-day-compatible reuse, no user-facing retention setting, and one-shot stale-reference recovery are explicit product decisions for this release.
