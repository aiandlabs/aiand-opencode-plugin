import { createHash } from "node:crypto"

type Fetch = typeof globalThis.fetch

export type PdfUploadFetchOptions = {
  baseURL: string
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

function safeErrorField(value: unknown) {
  if (typeof value !== "string") return undefined
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  return sanitized.length > 0 ? sanitized.slice(0, 240) : undefined
}

async function uploadError(response: Response) {
  let detail: string | undefined
  try {
    const payload = (await response.json()) as { error?: { code?: unknown; message?: unknown } | unknown }
    if (payload.error && typeof payload.error === "object") {
      const error = payload.error as { code?: unknown; message?: unknown }
      const code = safeErrorField(error.code)
      const message = safeErrorField(error.message)
      detail = code && message ? `${code}: ${message}` : code ?? message
    } else {
      detail = safeErrorField(payload.error)
    }
  } catch {
    // Keep non-JSON provider responses out of user-facing errors.
  }

  const suffix = detail ? ` (${detail})` : ""
  return new Error(`[aiand] PDF upload failed: HTTP ${response.status}${suffix}`)
}

export function createPdfUploadFetch(options: PdfUploadFetchOptions): Fetch {
  const baseURL = options.baseURL.replace(/\/+$/, "")
  const chatURL = `${baseURL}/chat/completions`
  const filesURL = `${baseURL}/files`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES
  const now = options.now ?? Date.now
  const expirySafetyMs = options.expirySafetyMs ?? DEFAULT_EXPIRY_SAFETY_MS
  const leases = new Map<string, FileLease>()
  const uploads = new Map<string, Promise<FileLease>>()

  async function uploadPdf(bytes: Buffer, digest: string, headers: Headers): Promise<FileLease> {
    const form = new FormData()
    form.append(
      "file",
      new Blob([bytes], { type: "application/pdf" }),
      `document-${digest.slice(0, 12)}.pdf`,
    )
    form.append("purpose", "document")

    const response = await fetchImpl(filesURL, {
      method: "POST",
      headers,
      body: form,
      redirect: "error",
    })
    if (!response.ok) throw await uploadError(response)

    let uploaded: { id?: unknown; expires_at?: unknown }
    try {
      uploaded = (await response.json()) as { id?: unknown; expires_at?: unknown }
    } catch {
      throw new Error("[aiand] PDF upload response failed: expected JSON")
    }
    if (typeof uploaded.id !== "string" || uploaded.id.length === 0) {
      throw new Error("[aiand] PDF upload response failed: missing file id")
    }

    const expiresAtMs =
      typeof uploaded.expires_at === "number" && Number.isFinite(uploaded.expires_at) && uploaded.expires_at > 0
        ? uploaded.expires_at * 1000
        : now() + DEFAULT_FILE_TTL_MS
    return { fileID: uploaded.id, expiresAtMs }
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
    const body = parsedBody as { messages?: unknown }
    if (!Array.isArray(body.messages)) return fetchImpl(input, init)
    const bodyMessages = body.messages

    const requestHeaders = new Headers(effectiveRequest.headers)

    async function transformedBody() {
      const references = new Map<string, string>()
      let transformed = false
      const messages = await Promise.all(
        bodyMessages.map(async (message) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return message
          const chatMessage = message as { content?: unknown }
          if (!Array.isArray(chatMessage.content)) return message
          const content = await Promise.all(
            chatMessage.content.map(async (part) => {
              const pdf = inlinePdfPart(part)
              if (!pdf) return part

              const { bytes, digest } = decodePdf(pdf.file.file_data, maxPdfBytes)
              const uploadHeaders = new Headers(requestHeaders)
              uploadHeaders.delete("content-type")
              uploadHeaders.delete("content-length")
              const lease = await resolveLease(bytes, digest, uploadHeaders)

              references.set(digest, lease.fileID)
              transformed = true
              return {
                ...pdf,
                file: { file_id: lease.fileID },
              }
            }),
          )
          return { ...chatMessage, content }
        }),
      )
      return {
        references,
        transformed,
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
        for (const [digest, staleFileID] of transformed.references) {
          if (leases.get(digest)?.fileID === staleFileID) leases.delete(digest)
        }
        return dispatch(true)
      }
      return response
    }

    return dispatch(false)
  }
}
