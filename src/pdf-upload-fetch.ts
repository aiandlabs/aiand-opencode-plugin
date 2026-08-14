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
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

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
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error("[aiand] PDF validation failed: invalid base64 data")
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const decodedSize = (encoded.length / 4) * 3 - padding
  if (decodedSize > maxPdfBytes) {
    throw new Error(`[aiand] PDF validation failed: decoded file exceeds ${maxPdfBytes} bytes`)
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
    if (!response.ok) throw new Error(`[aiand] PDF upload failed: HTTP ${response.status}`)

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
    if (url !== chatURL || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") {
      return fetchImpl(input, init)
    }

    const body = JSON.parse(init.body) as {
      messages?: Array<{ content?: unknown }>
    }

    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value))

    async function transformedBody() {
      const digests = new Set<string>()
      let transformed = false
      const messages = await Promise.all(
        (body.messages ?? []).map(async (message) => {
          if (!Array.isArray(message.content)) return message
          const content = await Promise.all(
            message.content.map(async (part) => {
              const pdf = inlinePdfPart(part)
              if (!pdf) return part

              const { bytes, digest } = decodePdf(pdf.file.file_data, maxPdfBytes)
              const uploadHeaders = new Headers(requestHeaders)
              uploadHeaders.delete("content-type")
              uploadHeaders.delete("content-length")
              const lease = await resolveLease(bytes, digest, uploadHeaders)

              digests.add(digest)
              transformed = true
              return {
                ...pdf,
                file: { file_id: lease.fileID },
              }
            }),
          )
          return { ...message, content }
        }),
      )
      return {
        digests,
        transformed,
        serialized: JSON.stringify({ ...body, messages }),
      }
    }

    async function isStaleFileResponse(response: Response) {
      if (response.ok) return false
      try {
        const payload = (await response.clone().json()) as { error?: { code?: unknown } }
        return payload.error?.code === "file_expired" || payload.error?.code === "file_not_found"
      } catch {
        return false
      }
    }

    async function dispatch(retried: boolean): Promise<Response> {
      const transformed = await transformedBody()
      if (!transformed.transformed) return fetchImpl(input, init)

      const headers = new Headers(requestHeaders)
      headers.delete("content-length")
      const response = await fetchImpl(input, {
        ...init,
        headers,
        body: transformed.serialized,
      })

      if (!retried && (await isStaleFileResponse(response))) {
        for (const digest of transformed.digests) leases.delete(digest)
        return dispatch(true)
      }
      return response
    }

    return dispatch(false)
  }
}
