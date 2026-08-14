import { createHash } from "node:crypto"
import { decidePdfCapability, type CatalogSnapshot } from "./pdf-capability.js"
import { preparePdfChunks } from "./pdf-chunks.js"

type Fetch = typeof globalThis.fetch

type PdfUploadFetchDependencies = {
  preparePdfChunks: typeof preparePdfChunks
}

export type PdfUploadFetchOptions = {
  baseURL: string
  catalogSnapshot: CatalogSnapshot
  rejectedModels?: ReadonlySet<string>
  fetchImpl?: Fetch
  now?: () => number
  maxPdfBytes?: number
  expirySafetyMs?: number
}

type InlinePdfPart = {
  type: "file"
  file: {
    filename?: string
    file_data: string
  }
  [key: string]: unknown
}

type FileLease = {
  fileID: string
  expiresAtMs: number
}

const PDF_PREFIX = "data:application/pdf;base64,"
const PDF_MIME_PREFIX = "data:application/pdf"
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii")
const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024
const DEFAULT_EXPIRY_SAFETY_MS = 60_000
const DEFAULT_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function isBase64Character(code: number) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  )
}

function inlinePdfPart(value: unknown): InlinePdfPart | undefined {
  if (!value || typeof value !== "object") return undefined
  const part = value as Record<string, unknown>
  if (part.type !== "file" || !part.file || typeof part.file !== "object") return undefined
  const file = part.file as Record<string, unknown>
  if (typeof file.file_data !== "string") return undefined
  if (!file.file_data.toLowerCase().startsWith(PDF_MIME_PREFIX)) return undefined
  if (!file.file_data.startsWith(PDF_PREFIX)) {
    throw new Error("[aiand] PDF validation failed: expected a canonical base64 data URL")
  }
  return value as InlinePdfPart
}

function containsRecognizedPdf(messages: unknown[]) {
  return messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.some((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return false
      const file = (part as { file?: unknown }).file
      if (!file || typeof file !== "object" || Array.isArray(file)) return false
      const fileData = (file as { file_data?: unknown }).file_data
      return typeof fileData === "string" && fileData.toLowerCase().startsWith(PDF_MIME_PREFIX)
    })
  })
}

function decodePdf(dataURL: string, maxPdfBytes: number) {
  const encoded = dataURL.slice(PDF_PREFIX.length)
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new Error("[aiand] PDF validation failed: invalid base64 data")
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const decodedSize = (encoded.length / 4) * 3 - padding
  if (decodedSize > maxPdfBytes) {
    throw new Error(`[aiand] PDF validation failed: decoded file exceeds ${maxPdfBytes} bytes`)
  }

  const contentLength = encoded.length - padding
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Character(encoded.charCodeAt(index))) {
      throw new Error("[aiand] PDF validation failed: invalid base64 data")
    }
  }
  for (let index = contentLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) {
      throw new Error("[aiand] PDF validation failed: invalid base64 data")
    }
  }

  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length < PDF_SIGNATURE.length || !bytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new Error("[aiand] PDF validation failed: missing %PDF- signature")
  }

  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  }
}

function safeErrorCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined
}

function safePageLimitMessage(value: unknown) {
  if (typeof value !== "string") return undefined
  let message = value
  try {
    const nested = JSON.parse(value) as unknown
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const detail = (nested as { detail?: unknown }).detail
      if (typeof detail === "string") message = detail
    }
  } catch {
    // Plain provider messages are handled by the same strict allowlist below.
  }
  return /^PDF has [1-9][0-9]{0,5} pages; limit is [1-9][0-9]{0,5}$/.test(message) ? message : undefined
}

async function uploadError(response: Response) {
  let detail: string | undefined
  try {
    const payload = (await response.json()) as unknown
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const error = (payload as { error?: unknown }).error
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const fields = error as { code?: unknown; message?: unknown }
        const code = safeErrorCode(fields.code)
        const pageLimit = safePageLimitMessage(fields.message)
        detail = code && pageLimit ? `${code}: ${pageLimit}` : code
      }
    }
  } catch {
    // Keep non-JSON provider responses out of user-facing errors.
  }

  const suffix = detail ? ` (${detail})` : ""
  return new Error(`[aiand] PDF upload failed: HTTP ${response.status}${suffix}`)
}

export function createPdfUploadFetch(
  options: PdfUploadFetchOptions,
  dependencies: PdfUploadFetchDependencies = { preparePdfChunks },
): Fetch {
  const baseURL = options.baseURL.replace(/\/+$/, "")
  const chatURL = `${baseURL}/chat/completions`
  const filesURL = `${baseURL}/files`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES
  const now = options.now ?? Date.now
  const expirySafetyMs = options.expirySafetyMs ?? DEFAULT_EXPIRY_SAFETY_MS
  const { catalogSnapshot } = options
  const rejectedModels = new Set(options.rejectedModels)
  const leases = new Map<string, FileLease>()
  const uploads = new Map<string, Promise<FileLease>>()
  const manifests = new Map<string, FileLease[]>()
  const preparations = new Map<string, Promise<FileLease[]>>()

  async function uploadPdf(bytes: Buffer, digest: string, headers: Headers): Promise<FileLease> {
    const form = new FormData()
    form.append(
      "file",
      new Blob([bytes], { type: "application/pdf" }),
      `document-${digest.slice(0, 12)}.pdf`,
    )
    form.append("purpose", "document")

    let response: Response
    try {
      response = await fetchImpl(filesURL, {
        method: "POST",
        headers,
        body: form,
        redirect: "error",
      })
    } catch {
      throw new Error("[aiand] PDF upload failed: network request failed")
    }
    if (!response.ok) throw await uploadError(response)

    let uploaded: unknown
    try {
      uploaded = await response.json()
    } catch {
      throw new Error("[aiand] PDF upload response failed: expected JSON")
    }
    if (!uploaded || typeof uploaded !== "object" || Array.isArray(uploaded)) {
      throw new Error("[aiand] PDF upload response failed: expected an object")
    }
    const fields = uploaded as { id?: unknown; expires_at?: unknown }
    if (typeof fields.id !== "string" || fields.id.trim().length === 0) {
      throw new Error("[aiand] PDF upload response failed: missing file id")
    }

    const returnedExpiryMs = typeof fields.expires_at === "number" ? fields.expires_at * 1000 : Number.NaN
    const expiresAtMs =
      Number.isSafeInteger(returnedExpiryMs) && returnedExpiryMs > 0
        ? returnedExpiryMs
        : now() + DEFAULT_FILE_TTL_MS
    return { fileID: fields.id, expiresAtMs }
  }

  async function resolveLease(bytes: Buffer, digest: string, headers: Headers): Promise<FileLease> {
    const lease = leases.get(digest)
    if (lease && now() < lease.expiresAtMs - expirySafetyMs) return lease
    if (lease) leases.delete(digest)

    const pending = uploads.get(digest)
    if (pending) return pending

    const upload = uploadPdf(bytes, digest, headers)
    uploads.set(digest, upload)
    try {
      const next = await upload
      leases.set(digest, next)
      return next
    } finally {
      if (uploads.get(digest) === upload) uploads.delete(digest)
    }
  }

  async function resolveDocument(
    bytes: Buffer,
    sourceDigest: string,
    headers: Headers,
  ): Promise<FileLease[]> {
    const manifest = manifests.get(sourceDigest)
    if (manifest && manifest.every((lease) => now() < lease.expiresAtMs - expirySafetyMs)) {
      return manifest
    }
    if (manifest) manifests.delete(sourceDigest)

    const pending = preparations.get(sourceDigest)
    if (pending) return pending

    const preparation = (async () => {
      const chunks = await dependencies.preparePdfChunks(bytes)
      const next: FileLease[] = []
      for (const chunk of chunks) {
        const chunkBytes = Buffer.from(chunk.bytes)
        const chunkDigest = createHash("sha256").update(chunkBytes).digest("hex")
        next.push(await resolveLease(chunkBytes, chunkDigest, headers))
      }
      manifests.set(sourceDigest, next)
      return next
    })()
    preparations.set(sourceDigest, preparation)
    try {
      return await preparation
    } finally {
      if (preparations.get(sourceDigest) === preparation) preparations.delete(sourceDigest)
    }
  }

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== chatURL) {
      return fetchImpl(input, init)
    }

    const effectiveRequest = new Request(input instanceof Request ? input.clone() : input, init)
    if (effectiveRequest.method.toUpperCase() !== "POST") return fetchImpl(input, init)

    let serializedBody: string
    if (typeof init?.body === "string") {
      serializedBody = init.body
    } else if (init?.body !== undefined) {
      return fetchImpl(input, init)
    } else if (input instanceof Request) {
      serializedBody = await effectiveRequest.clone().text()
    } else {
      return fetchImpl(input, init)
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(serializedBody)
    } catch {
      return fetchImpl(input, init)
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return fetchImpl(input, init)
    }
    const body = parsedBody as { model?: unknown; messages?: unknown }
    if (!Array.isArray(body.messages)) return fetchImpl(input, init)
    const bodyMessages = body.messages
    if (!containsRecognizedPdf(bodyMessages)) return fetchImpl(input, init)

    const capability = decidePdfCapability(body.model, catalogSnapshot, rejectedModels)
    if (capability.state === "unsupported") {
      throw new Error("[aiand] PDF capability failed: selected model does not support PDF input")
    }
    if (capability.state === "unknown") {
      throw new Error("[aiand] PDF capability failed: selected model capability is unavailable")
    }
    const modelID = body.model as string

    const requestHeaders = new Headers(effectiveRequest.headers)

    async function transformedBody() {
      const usedFileIDs = new Set<string>()
      let transformed = false
      const messages = await Promise.all(
        bodyMessages.map(async (message) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return message
          const chatMessage = message as { content?: unknown }
          if (!Array.isArray(chatMessage.content)) return message
          const contentParts = await Promise.all(
            chatMessage.content.map(async (part) => {
              const pdf = inlinePdfPart(part)
              if (!pdf) return [part]

              const { bytes, digest } = decodePdf(pdf.file.file_data, maxPdfBytes)
              const uploadHeaders = new Headers(requestHeaders)
              uploadHeaders.delete("content-type")
              uploadHeaders.delete("content-length")
              const documentLeases = await resolveDocument(bytes, digest, uploadHeaders)

              for (const lease of documentLeases) usedFileIDs.add(lease.fileID)
              transformed = true
              return documentLeases.map((lease) => ({
                ...pdf,
                file: { file_id: lease.fileID },
              }))
            }),
          )
          const content = contentParts.flat()
          return { ...chatMessage, content }
        }),
      )
      return {
        modelID,
        transformed,
        usedFileIDs,
        serialized: JSON.stringify({ ...body, messages }),
      }
    }

    async function isStaleFileResponse(response: Response) {
      if (response.ok) return false
      try {
        const payload = (await response.clone().json()) as { error?: { code?: unknown } }
        return (
          (response.status === 410 && payload.error?.code === "file_expired") ||
          (response.status === 404 && payload.error?.code === "file_not_found")
        )
      } catch {
        return false
      }
    }

    async function isModelCapabilityMismatchResponse(response: Response) {
      if (response.status !== 400) return false
      try {
        const payload = (await response.clone().json()) as { error?: { code?: unknown } }
        return payload.error?.code === "model_capability_mismatch"
      } catch {
        return false
      }
    }

    async function dispatch(retried: boolean): Promise<Response> {
      const transformed = await transformedBody()
      if (!transformed.transformed) return fetchImpl(input, init)

      const headers = new Headers(requestHeaders)
      headers.delete("content-length")
      const response = await fetchImpl(effectiveRequest, {
        headers,
        body: transformed.serialized,
      })

      if (!retried && (await isStaleFileResponse(response))) {
        for (const [digest, lease] of leases) {
          if (transformed.usedFileIDs.has(lease.fileID)) leases.delete(digest)
        }
        for (const [sourceDigest, manifest] of manifests) {
          if (manifest.some((lease) => transformed.usedFileIDs.has(lease.fileID))) {
            manifests.delete(sourceDigest)
          }
        }
        return dispatch(true)
      }
      if (await isModelCapabilityMismatchResponse(response)) {
        rejectedModels.add(transformed.modelID)
      }
      return response
    }

    return dispatch(false)
  }
}
