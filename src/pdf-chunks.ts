import { PDFDocument } from "pdf-lib"

export type PdfChunk = {
  bytes: Uint8Array
  firstPage: number
  lastPage: number
}

export type PreparePdfChunksOptions = {
  maxPagesPerChunk?: number
  maxChunkBytes?: number
}

const DEFAULT_MAX_PAGES = 100
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const PROCESSING_ERROR = "[aiand] PDF split failed: document could not be processed"

export async function preparePdfChunks(
  bytes: Uint8Array,
  options: PreparePdfChunksOptions = {},
): Promise<PdfChunk[]> {
  const requestedPages = options.maxPagesPerChunk ?? DEFAULT_MAX_PAGES
  const requestedBytes = options.maxChunkBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isInteger(requestedPages) || requestedPages <= 0 || !Number.isFinite(requestedBytes) || requestedBytes <= 0) {
    throw new Error("[aiand] PDF split failed: invalid chunk options")
  }
  const maxPagesPerChunk = Math.min(requestedPages, DEFAULT_MAX_PAGES)
  const maxChunkBytes = Math.min(requestedBytes, DEFAULT_MAX_BYTES)

  let source: PDFDocument
  try {
    source = await PDFDocument.load(bytes)
  } catch {
    throw new Error(PROCESSING_ERROR)
  }

  const pageCount = source.getPageCount()
  if (pageCount === 0) {
    throw new Error("[aiand] PDF split failed: document has no pages")
  }

  if (pageCount <= DEFAULT_MAX_PAGES) {
    if (bytes.byteLength > maxChunkBytes) {
      throw new Error("[aiand] PDF split failed: chunk exceeds 104857600 bytes")
    }
    return [{ bytes, firstPage: 1, lastPage: pageCount }]
  }

  const chunks: PdfChunk[] = []
  for (let start = 0; start < pageCount; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk, pageCount)
    let chunkBytes: Uint8Array
    try {
      const chunk = await PDFDocument.create({ updateMetadata: false })
      const pages = await chunk.copyPages(source, Array.from({ length: end - start }, (_, index) => start + index))
      for (const page of pages) chunk.addPage(page)
      chunkBytes = await chunk.save()
    } catch {
      throw new Error(PROCESSING_ERROR)
    }
    if (chunkBytes.byteLength > maxChunkBytes) {
      throw new Error("[aiand] PDF split failed: chunk exceeds 104857600 bytes")
    }
    chunks.push({ bytes: chunkBytes, firstPage: start + 1, lastPage: end })
  }
  return chunks
}
