import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { PDFDocument } from "pdf-lib"
import { preparePdfChunks, visitPdfChunks } from "../dist/pdf-chunks.js"

async function makePdf(pageCount) {
  const document = await PDFDocument.create()
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([200 + index, 300])
  }
  return Buffer.from(await document.save())
}

function makeInvalidPageTreePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids 3 /Count 1 >>",
  ]
  let contents = "%PDF-1.7\n"
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents, "ascii"))
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(contents, "ascii")
  contents += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) contents += `${String(offset).padStart(10, "0")} 00000 n \n`
  contents += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(contents, "ascii")
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

for (const pageCount of [101, 201]) {
  test(`splits ${pageCount} pages into ordered chunks`, async () => {
    const source = await makePdf(pageCount)
    const chunks = await preparePdfChunks(source)
    assert.deepEqual(chunks.map((chunk) => [chunk.firstPage, chunk.lastPage]),
      pageCount === 101 ? [[1, 100], [101, 101]] : [[1, 100], [101, 200], [201, 201]])
    assert.deepEqual(chunks.map((chunk) => chunk.lastPage - chunk.firstPage + 1),
      pageCount === 101 ? [100, 1] : [100, 100, 1])
    const widths = []
    for (const chunk of chunks) {
      const document = await PDFDocument.load(chunk.bytes)
      for (const page of document.getPages()) widths.push(page.getWidth())
    }
    assert.deepEqual(widths, Array.from({ length: pageCount }, (_, index) => 200 + index))
  })
}

test("waits for each chunk visitor before serializing the next chunk", async () => {
  const source = await makePdf(201)
  const originalCreate = PDFDocument.create
  let createdChunks = 0
  let releaseFirstVisit
  const firstVisitReleased = new Promise((resolve) => {
    releaseFirstVisit = resolve
  })
  let markFirstVisit
  const firstVisit = new Promise((resolve) => {
    markFirstVisit = resolve
  })
  const visited = []
  PDFDocument.create = async (...args) => {
    createdChunks += 1
    return originalCreate.apply(PDFDocument, args)
  }

  try {
    const preparation = visitPdfChunks(source, async (chunk) => {
      visited.push([chunk.firstPage, chunk.lastPage])
      if (visited.length === 1) {
        markFirstVisit()
        await firstVisitReleased
      }
    })

    await firstVisit
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(createdChunks, 1)
    assert.deepEqual(visited, [[1, 100]])

    releaseFirstVisit()
    await preparation
    assert.equal(createdChunks, 3)
    assert.deepEqual(visited, [[1, 100], [101, 200], [201, 201]])
  } finally {
    PDFDocument.create = originalCreate
  }
})

test("serializes repeated oversized-source chunks identically across a timestamp boundary", async () => {
  const source = await makePdf(101)
  const first = await preparePdfChunks(source)
  const completedSecond = Math.floor(Date.now() / 1000)
  const nextSecondMs = (completedSecond + 1) * 1000
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextSecondMs - Date.now() + 50)))
  assert.ok(Date.now() >= nextSecondMs)

  const second = await preparePdfChunks(source)
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

  assert.deepEqual(
    second.map((chunk) => Buffer.from(chunk.bytes)),
    first.map((chunk) => Buffer.from(chunk.bytes)),
  )
  assert.deepEqual(
    second.map((chunk) => digest(chunk.bytes)),
    first.map((chunk) => digest(chunk.bytes)),
  )
})

test("rejects malformed PDF with a fixed error", async () => {
  await assert.rejects(preparePdfChunks(Buffer.from("%PDF-")), {
    message: "[aiand] PDF split failed: document could not be processed",
  })
})

test("redacts a page-tree traversal failure after the PDF has loaded", async () => {
  const source = makeInvalidPageTreePdf()
  const loaded = await PDFDocument.load(source)
  assert.throws(() => loaded.getPageCount())

  await assert.rejects(preparePdfChunks(source), {
    message: "[aiand] PDF split failed: document could not be processed",
  })
})

test("rejects a zero-page PDF with a fixed error", async () => {
  const header = "%PDF-1.7\n"
  const object1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
  const object2 = "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n"
  const offset1 = header.length
  const offset2 = offset1 + object1.length
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(offset1).padStart(10, "0")} 00000 n \n${String(offset2).padStart(10, "0")} 00000 n \n`
  const trailer = "trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n" + (offset2 + object2.length) + "\n%%EOF\n"
  await assert.rejects(preparePdfChunks(Buffer.from(header + object1 + object2 + xref + trailer)), {
    message: "[aiand] PDF split failed: document has no pages",
  })
})

test("keeps a 100-page source unchanged when a smaller page option is supplied", async () => {
  const source = await makePdf(100)
  const chunks = await preparePdfChunks(source, { maxPagesPerChunk: 1 })
  assert.equal(chunks.length, 1)
  assert.deepEqual(Buffer.from(chunks[0].bytes), source)
  assert.deepEqual([chunks[0].firstPage, chunks[0].lastPage], [1, 100])
})

test("caps an oversized page option at 100 pages", async () => {
  const chunks = await preparePdfChunks(await makePdf(101), { maxPagesPerChunk: 101 })
  assert.deepEqual(chunks.map((chunk) => chunk.lastPage - chunk.firstPage + 1), [100, 1])
})

for (const options of [{ maxPagesPerChunk: 0 }, { maxPagesPerChunk: NaN }, { maxChunkBytes: 0 }, { maxChunkBytes: NaN }]) {
  test(`rejects invalid options: ${JSON.stringify(options)}`, async () => {
    await assert.rejects(preparePdfChunks(await makePdf(1), options), {
      message: "[aiand] PDF split failed: invalid chunk options",
    })
  })
}

test("rejects chunks over the configured byte limit", async () => {
  const source = await makePdf(1)
  await assert.rejects(preparePdfChunks(source, { maxChunkBytes: 1 }), {
    message: "[aiand] PDF split failed: chunk exceeds 104857600 bytes",
  })
})
