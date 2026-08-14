import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument } from "pdf-lib"

import { preparePdfChunks } from "../dist/pdf-chunks.js"
import { createPdfUploadFetch } from "../dist/pdf-upload-fetch.js"

const BASE_URL = "https://api.aiand.com/v1"
const CHAT_URL = `${BASE_URL}/chat/completions`
const PDF_BYTES = await createPdfBytes(1)
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`
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

function createTestPdfUploadFetch(options, dependencies) {
  return createPdfUploadFetch({ catalogSnapshot: SUPPORTED_CATALOG, ...options }, dependencies)
}

function chatBody(parts, model = "moonshotai/kimi-k3") {
  return {
    model,
    stream: true,
    messages: [{ role: "user", content: parts }],
  }
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  })
}

function recordingAiand(options = {}) {
  const calls = []
  let uploadCount = 0
  let chatCount = 0
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url === `${BASE_URL}/files`) {
      uploadCount += 1
      if (options.uploadResponse) return options.uploadResponse(uploadCount)
      return jsonResponse({
        id: "file-test-1",
        object: "file",
        bytes: PDF_BYTES.length,
        purpose: "document",
        filename: "document.pdf",
        created_at: 1786660000,
        expires_at: 1786665600,
        page_count: 1,
      })
    }
    chatCount += 1
    if (options.chatResponse) return options.chatResponse(chatCount)
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  return { calls, fetchImpl }
}

function sendPdf(fetch, dataURL = PDF_DATA_URL, model) {
  return fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(chatBody([{ type: "file", file: { filename: "manual.pdf", file_data: dataURL } }], model)),
  })
}

async function createPdfBytes(pageCount, pageSize = [72, 72]) {
  const document = await PDFDocument.create()
  for (let page = 0; page < pageCount; page += 1) document.addPage(pageSize)
  return Buffer.from(await document.save())
}

async function pdfDataURL(pageCount, pageSize = [72, 72]) {
  const bytes = await createPdfBytes(pageCount, pageSize)
  return `data:application/pdf;base64,${bytes.toString("base64")}`
}

test("uploads an inline PDF and sends only its file_id to chat", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })

  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      "content-length": "9999",
    },
    body: JSON.stringify(
      chatBody([
        { type: "text", text: "Read this PDF." },
        {
          type: "file",
          file: { filename: "manual.pdf", file_data: PDF_DATA_URL },
        },
      ]),
    ),
  })

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.length, 2)

  const upload = aiand.calls[0]
  assert.equal(upload.url, `${BASE_URL}/files`)
  assert.equal(upload.init.method, "POST")
  assert.equal(upload.init.redirect, "error")
  assert.equal(upload.init.headers.get("authorization"), "Bearer test-key")
  assert.equal(upload.init.headers.has("content-type"), false)
  assert.equal(upload.init.headers.has("content-length"), false)
  assert.equal(upload.init.body.get("purpose"), "document")
  const uploadedFile = upload.init.body.get("file")
  assert.equal(await uploadedFile.text(), PDF_BYTES.toString("utf8"))
  assert.match(uploadedFile.name, /^document-[a-f0-9]{12}\.pdf$/)

  const chat = aiand.calls[1]
  const sent = JSON.parse(chat.init.body)
  assert.deepEqual(sent.messages[0].content, [
    { type: "text", text: "Read this PDF." },
    { type: "file", file: { file_id: "file-test-1" } },
  ])
  assert.equal(chat.init.body.includes("data:application/pdf;base64"), false)
  assert.equal(chat.init.headers.has("content-length"), false)
})

test("splits a 101-page PDF into sequential ordered uploads and adjacent chat references", async () => {
  const calls = []
  let activeUploads = 0
  let maximumActiveUploads = 0
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url === `${BASE_URL}/files`) {
      activeUploads += 1
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads)
      await new Promise((resolve) => setImmediate(resolve))
      activeUploads -= 1
      const uploadNumber = calls.filter((call) => call.url === `${BASE_URL}/files`).length
      return jsonResponse({ id: `file-chunk-${uploadNumber}`, expires_at: 1786665600 })
    }
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl,
    now: () => 1786660000 * 1000,
  })
  const dataURL = await pdfDataURL(101)

  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(
      chatBody([
        { type: "text", text: "before" },
        { type: "file", file: { filename: "long.pdf", file_data: dataURL } },
        { type: "text", text: "after" },
      ]),
    ),
  })

  assert.equal(response.status, 200)
  const uploads = calls.filter((call) => call.url === `${BASE_URL}/files`)
  assert.equal(uploads.length, 2)
  const uploadedPageCounts = []
  for (const upload of uploads) {
    const uploadedFile = upload.init.body.get("file")
    const uploadedDocument = await PDFDocument.load(await uploadedFile.arrayBuffer())
    uploadedPageCounts.push(uploadedDocument.getPageCount())
  }
  assert.deepEqual(uploadedPageCounts, [100, 1])
  assert.equal(maximumActiveUploads, 1)

  const chat = calls.find((call) => call.url === CHAT_URL)
  const sent = JSON.parse(chat.init.body)
  assert.deepEqual(sent.messages[0].content, [
    { type: "text", text: "before" },
    { type: "file", file: { file_id: "file-chunk-1" } },
    { type: "file", file: { file_id: "file-chunk-2" } },
    { type: "text", text: "after" },
  ])
  assert.equal(chat.init.body.includes("data:application/pdf;base64"), false)
})

test("accepts a large valid PDF without regex size failures", async () => {
  const largePdf = Buffer.concat([PDF_BYTES, Buffer.alloc(14 * 1024 * 1024, 0x20)])
  const dataURL = `data:application/pdf;base64,${largePdf.toString("base64")}`
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  const response = await sendPdf(fetch, dataURL)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 1)
})

test("translates an inline PDF carried by a Request input", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const request = new Request(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer request-key", "content-type": "application/json" },
    body: JSON.stringify(chatBody([{ type: "file", file: { file_data: PDF_DATA_URL } }])),
  })

  const response = await fetch(request)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.length, 2)
  assert.equal(aiand.calls[0].init.headers.get("authorization"), "Bearer request-key")
  const sent = JSON.parse(aiand.calls[1].init.body)
  assert.deepEqual(sent.messages[0].content, [{ type: "file", file: { file_id: "file-test-1" } }])
})

test("applies init overrides when translating a Request input", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const request = new Request(CHAT_URL, {
    headers: { authorization: "Bearer old-key", "x-original": "discarded" },
  })

  await fetch(request, {
    method: "POST",
    headers: {
      authorization: "Bearer override-key",
      "content-type": "application/json",
      "x-override": "preserved",
    },
    body: JSON.stringify(chatBody([{ type: "file", file: { file_data: PDF_DATA_URL } }])),
  })

  const uploadHeaders = aiand.calls[0].init.headers
  assert.equal(uploadHeaders.get("authorization"), "Bearer override-key")
  assert.equal(uploadHeaders.get("x-override"), "preserved")
  assert.equal(uploadHeaders.has("x-original"), false)
  assert.equal(aiand.calls.length, 2)
})

test("rejects malformed PDF-shaped parts before any network request", async (t) => {
  const invalid = [
    {
      name: "non-canonical data URL",
      data: `data:application/pdf;charset=utf-8;base64,${PDF_BYTES.toString("base64")}`,
      options: {},
    },
    { name: "invalid base64", data: "data:application/pdf;base64,%%%%", options: {} },
    {
      name: "wrong file signature",
      data: `data:application/pdf;base64,${Buffer.from("not a pdf").toString("base64")}`,
      options: {},
    },
    { name: "decoded size over limit", data: PDF_DATA_URL, options: { maxPdfBytes: PDF_BYTES.length - 1 } },
  ]

  for (const item of invalid) {
    await t.test(item.name, async () => {
      const aiand = recordingAiand()
      const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl, ...item.options })
      const body = chatBody([{ type: "file", file: { filename: "unsafe.pdf", file_data: item.data } }])

      await assert.rejects(
        fetch(CHAT_URL, {
          method: "POST",
          headers: { authorization: "Bearer test-key", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        /\[aiand\] PDF validation failed:/,
      )
      assert.equal(aiand.calls.length, 0)
    })
  }
})

test("rejects a malformed PDF before validation when the selected model is known not to support PDF", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    catalogSnapshot: {
      available: true,
      fetchedAtMs: 1_786_660_000_000,
      models: {
        "moonshotai/kimi-k3": {
          attachment: true,
          modalities: { input: ["text"] },
        },
      },
    },
  })

  await assert.rejects(sendPdf(fetch, "data:application/pdf;base64,%%%%"), {
    message: "[aiand] PDF capability failed: selected model does not support PDF input",
  })
  assert.equal(aiand.calls.length, 0)
})

test("rejects a malformed PDF before validation when the selected model is absent from the catalog", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    catalogSnapshot: { available: true, fetchedAtMs: 1_786_660_000_000, models: {} },
  })

  await assert.rejects(sendPdf(fetch, "data:application/pdf;base64,%%%%"), {
    message: "[aiand] PDF capability failed: selected model capability is unavailable",
  })
  assert.equal(aiand.calls.length, 0)
})

test("validates malformed PDFs after authorizing a supported model", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(sendPdf(fetch, "data:application/pdf;base64,%%%%"), {
    message: "[aiand] PDF validation failed: invalid base64 data",
  })
  assert.equal(aiand.calls.length, 0)
})

test("passes through non-PDF chat requests when the catalog is unavailable", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    catalogSnapshot: { available: false, fetchedAtMs: 1_786_660_000_000, models: {} },
  })
  const body = chatBody([{ type: "text", text: "hello" }])
  const init = {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  }

  const response = await fetch(CHAT_URL, init)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.length, 1)
  assert.equal(aiand.calls[0].url, CHAT_URL)
  assert.equal(aiand.calls[0].init, init)
})

test("preserves requests without an eligible inline PDF", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const body = {
    ...chatBody([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      { type: "file", file: { file_id: "file-existing" } },
      { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGk=" } },
    ]),
    tools: [{ type: "function", function: { name: "demo", parameters: { type: "object" } } }],
    reasoning_effort: "high",
  }
  const serialized = JSON.stringify(body)

  await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", "x-test": "preserve" },
    body: serialized,
  })

  assert.equal(aiand.calls.length, 1)
  assert.equal(aiand.calls[0].url, CHAT_URL)
  assert.equal(aiand.calls[0].init.body, serialized)
  assert.equal(aiand.calls[0].init.headers["x-test"], "preserve")
})

test("preserves unrelated fields and headers while rewriting a PDF", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const body = {
    ...chatBody([
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      { type: "file", file: { file_id: "file-existing" } },
      { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGk=" } },
      { type: "file", file: { filename: "manual.pdf", file_data: PDF_DATA_URL } },
    ]),
    tools: [{ type: "function", function: { name: "demo", parameters: { type: "object" } } }],
    reasoning_effort: "high",
  }

  await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", "x-test": "preserve" },
    body: JSON.stringify(body),
  })

  assert.equal(aiand.calls.length, 2)
  const chat = aiand.calls[1]
  const sent = JSON.parse(chat.init.body)
  assert.deepEqual(sent.tools, body.tools)
  assert.equal(sent.reasoning_effort, "high")
  assert.deepEqual(sent.messages[0].content.slice(0, 4), body.messages[0].content.slice(0, 4))
  assert.deepEqual(sent.messages[0].content[4], { type: "file", file: { file_id: "file-test-1" } })
  assert.equal(chat.init.headers.get("x-test"), "preserve")
})

test("passes through malformed or unexpected chat bodies unchanged", async (t) => {
  for (const serialized of ["not-json", "null", "[]", '{"messages":{}}']) {
    await t.test(serialized, async () => {
      const aiand = recordingAiand()
      const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
      const init = {
        method: "POST",
        headers: { authorization: "Bearer test-key", "content-type": "application/json" },
        body: serialized,
      }

      const response = await fetch(CHAT_URL, init)

      assert.equal(response.status, 200)
      assert.equal(aiand.calls.length, 1)
      assert.equal(aiand.calls[0].url, CHAT_URL)
      assert.equal(aiand.calls[0].init, init)
    })
  }
})

test("turns an invalid upload response into a safe adapter error", async () => {
  const aiand = recordingAiand({
    uploadResponse: () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
  })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(
    fetch(CHAT_URL, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify(chatBody([{ type: "file", file: { file_data: PDF_DATA_URL } }])),
    }),
    /\[aiand\] PDF upload response failed:/,
  )

  assert.equal(aiand.calls.length, 1)
  assert.equal(aiand.calls[0].url, `${BASE_URL}/files`)
})

test("wraps upload transport failures without exposing transport details", async () => {
  const aiand = recordingAiand({
    uploadResponse: () => {
      throw new Error("connect to secret.internal.example failed")
    },
  })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(sendPdf(fetch), {
    message: "[aiand] PDF upload failed: network request failed",
  })
})

test("rejects a null upload response with a staged adapter error", async () => {
  const aiand = recordingAiand({ uploadResponse: () => jsonResponse(null) })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(sendPdf(fetch), {
    message: "[aiand] PDF upload response failed: expected an object",
  })
})

test("rejects a blank upload file id", async () => {
  const aiand = recordingAiand({ uploadResponse: () => jsonResponse({ id: "   " }) })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(sendPdf(fetch), {
    message: "[aiand] PDF upload response failed: missing file id",
  })
})

test("redacts arbitrary provider messages from upload errors", async () => {
  const aiand = recordingAiand({
    uploadResponse: () =>
      jsonResponse(
        { error: { code: "invalid_request_error", message: "manual.pdf for jetha was rejected" } },
        { status: 400 },
      ),
  })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(sendPdf(fetch), {
    message: "[aiand] PDF upload failed: HTTP 400 (invalid_request_error)",
  })
})

test("reuses one settled chunk manifest for sequential references to a 101-page source", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-chunk-${count}`, expires_at: 1786665600 }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })
  const dataURL = await pdfDataURL(101)

  await sendPdf(fetch, dataURL)
  await sendPdf(fetch, dataURL)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.equal(chats.length, 2)
  for (const chat of chats) {
    assert.deepEqual(
      chat.messages[0].content.map((part) => part.file.file_id),
      ["file-chunk-1", "file-chunk-2"],
    )
  }
})

test("invalidates a mixed-expiry manifest and reuses its still-safe leaf", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => {
      if (count === 1) return jsonResponse({ id: "file-chunk-1", expires_at: 1786665600 })
      if (count === 2) return jsonResponse({ id: "file-chunk-2", expires_at: 1786660030 })
      return jsonResponse({ id: "file-chunk-2-refreshed", expires_at: 1786665600 })
    },
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })
  const dataURL = await pdfDataURL(101)

  await sendPdf(fetch, dataURL)
  await sendPdf(fetch, dataURL)

  const uploads = aiand.calls.filter((call) => call.url === `${BASE_URL}/files`)
  assert.equal(uploads.length, 3)
  const uploadedPageCounts = []
  for (const upload of uploads) {
    const uploadedFile = upload.init.body.get("file")
    const uploadedDocument = await PDFDocument.load(await uploadedFile.arrayBuffer())
    uploadedPageCounts.push(uploadedDocument.getPageCount())
  }
  assert.deepEqual(uploadedPageCounts, [100, 1, 1])

  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content.map((part) => part.file.file_id)),
    [
      ["file-chunk-1", "file-chunk-2"],
      ["file-chunk-1", "file-chunk-2-refreshed"],
    ],
  )
})

test("shares one in-flight chunk preparation for concurrent references to a 101-page source", async () => {
  let preparationCount = 0
  const aiand = recordingAiand({
    uploadResponse: async (count) => {
      await new Promise((resolve) => setImmediate(resolve))
      return jsonResponse({ id: `file-chunk-${count}`, expires_at: 1786665600 })
    },
  })
  const fetch = createTestPdfUploadFetch(
    {
      baseURL: BASE_URL,
      fetchImpl: aiand.fetchImpl,
      now: () => 1786660000 * 1000,
    },
    {
      preparePdfChunks: async (bytes) => {
        preparationCount += 1
        return preparePdfChunks(bytes)
      },
    },
  )
  const dataURL = await pdfDataURL(101)

  await Promise.all([sendPdf(fetch, dataURL), sendPdf(fetch, dataURL)])

  assert.equal(preparationCount, 1)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.equal(chats.length, 2)
  for (const chat of chats) {
    assert.deepEqual(
      chat.messages[0].content.map((part) => part.file.file_id),
      ["file-chunk-1", "file-chunk-2"],
    )
  }
})

test("keeps manifests for distinct 101-page sources independent", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-chunk-${count}`, expires_at: 1786665600 }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })
  const firstSource = await pdfDataURL(101, [72, 72])
  const secondSource = await pdfDataURL(101, [73, 72])

  await sendPdf(fetch, firstSource)
  await sendPdf(fetch, secondSource)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 4)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content.map((part) => part.file.file_id)),
    [
      ["file-chunk-1", "file-chunk-2"],
      ["file-chunk-3", "file-chunk-4"],
    ],
  )
})

test("retries only the failed leaf after a partial chunk upload failure", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => {
      if (count === 1) return jsonResponse({ id: "file-chunk-1", expires_at: 1786665600 })
      if (count === 2) return jsonResponse({ error: { code: "server_error" } }, { status: 500 })
      return jsonResponse({ id: "file-chunk-2", expires_at: 1786665600 })
    },
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })
  const dataURL = await pdfDataURL(101)

  await assert.rejects(sendPdf(fetch, dataURL), {
    message: "[aiand] PDF upload failed: HTTP 500 (server_error)",
  })
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 0)

  const response = await sendPdf(fetch, dataURL)

  assert.equal(response.status, 200)
  const uploads = aiand.calls.filter((call) => call.url === `${BASE_URL}/files`)
  assert.equal(uploads.length, 3)
  const uploadedPageCounts = []
  for (const upload of uploads) {
    const uploadedFile = upload.init.body.get("file")
    const uploadedDocument = await PDFDocument.load(await uploadedFile.arrayBuffer())
    uploadedPageCounts.push(uploadedDocument.getPageCount())
  }
  assert.deepEqual(uploadedPageCounts, [100, 1, 1])

  const chats = aiand.calls.filter((call) => call.url === CHAT_URL)
  assert.equal(chats.length, 1)
  const sent = JSON.parse(chats[0].init.body)
  assert.deepEqual(
    sent.messages[0].content.map((part) => part.file.file_id),
    ["file-chunk-1", "file-chunk-2"],
  )
})

test("reuses one upload for sequential references to identical PDF bytes", async () => {
  const aiand = recordingAiand()
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })

  await sendPdf(fetch)
  await sendPdf(fetch)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
})

test("shares an in-flight upload between concurrent references to identical PDF bytes", async () => {
  let releaseUpload
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve
  })
  const aiand = recordingAiand({
    uploadResponse: async () => {
      await uploadGate
      return jsonResponse({ id: "file-shared", expires_at: 1786665600 })
    },
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1786660000 * 1000,
  })

  const first = sendPdf(fetch)
  const second = sendPdf(fetch)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)

  releaseUpload()
  await Promise.all([first, second])
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
})

test("uploads distinct PDF bytes separately", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-${count}`, expires_at: 1786665600 }),
  })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const other = (await createPdfBytes(1, [73, 72])).toString("base64")

  await sendPdf(fetch)
  await sendPdf(fetch, `data:application/pdf;base64,${other}`)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
})

test("does not cache failed uploads", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) =>
      count === 1
        ? jsonResponse(
            {
              error: {
                code: "invalid_value",
                message: '{"detail":"PDF has 120 pages; limit is 100"}',
              },
            },
            { status: 400 },
          )
        : jsonResponse({ id: "file-recovered", expires_at: 1786665600 }),
  })
  const fetch = createTestPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(
    sendPdf(fetch),
    /\[aiand\] PDF upload failed: HTTP 400 \(invalid_value: PDF has 120 pages; limit is 100\)/,
  )
  const response = await sendPdf(fetch)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
})

test("re-uploads after the cached file lease expires", async () => {
  let now = 1_786_660_000_000
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-${count}`, expires_at: 1_786_660_100 }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => now,
    expirySafetyMs: 0,
  })

  await sendPdf(fetch)
  await sendPdf(fetch)
  now = 1_786_660_100_000
  await sendPdf(fetch)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  const chatBodies = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.equal(chatBodies[0].messages[0].content[0].file.file_id, "file-1")
  assert.equal(chatBodies[1].messages[0].content[0].file.file_id, "file-1")
  assert.equal(chatBodies[2].messages[0].content[0].file.file_id, "file-2")
})

test("uses the fallback lease for an unsafe returned expiry", async () => {
  let now = 1_786_660_000_000
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-${count}`, expires_at: Number.MAX_VALUE }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => now,
    expirySafetyMs: 0,
  })

  await sendPdf(fetch)
  now += 30 * 24 * 60 * 60 * 1000
  await sendPdf(fetch)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
})

test("refreshes a stale file reference and retries chat once", async (t) => {
  for (const stale of [
    { code: "file_expired", status: 410 },
    { code: "file_not_found", status: 404 },
  ]) {
    await t.test(stale.code, async () => {
      const aiand = recordingAiand({
        uploadResponse: (count) => jsonResponse({ id: `file-${count}`, expires_at: 1_786_665_600 }),
        chatResponse: (count) =>
          count === 1
            ? jsonResponse({ error: { code: stale.code, message: "stale test fixture" } }, { status: stale.status })
            : new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
      })
      const fetch = createTestPdfUploadFetch({
        baseURL: BASE_URL,
        fetchImpl: aiand.fetchImpl,
        now: () => 1_786_660_000_000,
      })

      const response = await sendPdf(fetch)

      assert.equal(response.status, 200)
      assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
      assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
      const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
      assert.equal(chats[0].messages[0].content[0].file.file_id, "file-1")
      assert.equal(chats[1].messages[0].content[0].file.file_id, "file-2")
    })
  }
})

test("invalidates every stale chunk in a manifest and retries with refreshed ordered IDs", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-chunk-${count}`, expires_at: 1_786_665_600 }),
    chatResponse: (count) =>
      count === 1
        ? jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
        : new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })
  const dataURL = await pdfDataURL(101)

  const response = await sendPdf(fetch, dataURL)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 4)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.equal(chats.length, 2)
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content.map((part) => part.file.file_id)),
    [
      ["file-chunk-1", "file-chunk-2"],
      ["file-chunk-3", "file-chunk-4"],
    ],
  )
})

test("keeps a refreshed chunk manifest when a delayed stale response used its old IDs", async () => {
  let markRefreshedChat
  const refreshedChat = new Promise((resolve) => {
    markRefreshedChat = resolve
  })
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-chunk-${count}`, expires_at: 1_786_665_600 }),
    chatResponse: async (count) => {
      if (count === 1) return jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
      if (count === 2) {
        await refreshedChat
        return jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
      }
      if (count === 3) markRefreshedChat()
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })
  const dataURL = await pdfDataURL(101)

  const responses = await Promise.all([sendPdf(fetch, dataURL), sendPdf(fetch, dataURL)])

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  )
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 4)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content.map((part) => part.file.file_id)),
    [
      ["file-chunk-1", "file-chunk-2"],
      ["file-chunk-1", "file-chunk-2"],
      ["file-chunk-3", "file-chunk-4"],
      ["file-chunk-3", "file-chunk-4"],
    ],
  )
})

test("does not publish a captured shared lease after another source invalidates it", async () => {
  const sourceABytes = await createPdfBytes(1, [73, 73])
  const sourceBBytes = await createPdfBytes(1, [74, 74])
  const sharedChunkBytes = await createPdfBytes(1, [75, 75])
  const laterChunkBytes = await createPdfBytes(1, [76, 76])
  const sourceA = `data:application/pdf;base64,${sourceABytes.toString("base64")}`
  const sourceB = `data:application/pdf;base64,${sourceBBytes.toString("base64")}`
  let markLaterUploadStarted
  const laterUploadStarted = new Promise((resolve) => {
    markLaterUploadStarted = resolve
  })
  let releaseLaterUpload
  const laterUploadReleased = new Promise((resolve) => {
    releaseLaterUpload = resolve
  })
  const aiand = recordingAiand({
    uploadResponse: async (count) => {
      if (count === 2) {
        markLaterUploadStarted()
        await laterUploadReleased
      }
      return jsonResponse({ id: `file-${count}`, expires_at: 1_786_665_600 })
    },
    chatResponse: (count) =>
      count === 2
        ? jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
        : new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
  })
  const fetch = createTestPdfUploadFetch(
    {
      baseURL: BASE_URL,
      fetchImpl: aiand.fetchImpl,
      now: () => 1_786_660_000_000,
    },
    {
      preparePdfChunks: async (bytes) => {
        if (Buffer.from(bytes).equals(sourceABytes)) {
          return [
            { bytes: sharedChunkBytes, firstPage: 1, lastPage: 1 },
            { bytes: laterChunkBytes, firstPage: 2, lastPage: 2 },
          ]
        }
        if (Buffer.from(bytes).equals(sourceBBytes)) {
          return [{ bytes: sharedChunkBytes, firstPage: 1, lastPage: 1 }]
        }
        throw new Error("unexpected source fixture")
      },
    },
  )

  const seedResponse = await sendPdf(fetch, sourceB)
  const pendingSourceA = sendPdf(fetch, sourceA)
  await laterUploadStarted
  const refreshedSourceB = await sendPdf(fetch, sourceB)
  releaseLaterUpload()
  const firstSourceA = await pendingSourceA
  const secondSourceA = await sendPdf(fetch, sourceA)

  assert.deepEqual(
    [seedResponse.status, refreshedSourceB.status, firstSourceA.status, secondSourceA.status],
    [200, 200, 200, 200],
  )
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 3)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content.map((part) => part.file.file_id)),
    [
      ["file-1"],
      ["file-1"],
      ["file-3"],
      ["file-3", "file-2"],
      ["file-3", "file-2"],
    ],
  )
})

test("shares one refresh when concurrent requests discover the same stale reference", async () => {
  let markRefreshed
  const refreshed = new Promise((resolve) => {
    markRefreshed = resolve
  })
  const aiand = recordingAiand({
    uploadResponse: (count) => {
      if (count === 2) markRefreshed()
      return jsonResponse({ id: `file-${count}`, expires_at: 1_786_665_600 })
    },
    chatResponse: async (count) => {
      if (count === 1) return jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
      if (count === 2) {
        await refreshed
        return jsonResponse({ error: { code: "file_expired" } }, { status: 410 })
      }
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })

  const responses = await Promise.all([sendPdf(fetch), sendPdf(fetch)])

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  )
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  const chats = aiand.calls.filter((call) => call.url === CHAT_URL).map((call) => JSON.parse(call.init.body))
  assert.deepEqual(
    chats.map((chat) => chat.messages[0].content[0].file.file_id),
    ["file-1", "file-1", "file-2", "file-2"],
  )
})

test("does not retry unrelated chat errors", async (t) => {
  const errors = [
    jsonResponse({ error: { code: "server_error" } }, { status: 500 }),
    jsonResponse({ error: { code: "unrelated_not_found" } }, { status: 404 }),
    jsonResponse({ error: { code: "file_expired" } }, { status: 500 }),
    jsonResponse({ error: { code: "file_not_found" } }, { status: 410 }),
    jsonResponse({ error: { code: "file_expired" } }, { status: 404 }),
    new Response("not-json", { status: 410, headers: { "content-type": "text/plain" } }),
  ]

  for (const [index, error] of errors.entries()) {
    await t.test(`control ${index + 1}`, async () => {
      const aiand = recordingAiand({ chatResponse: () => error.clone() })
      const fetch = createTestPdfUploadFetch({
        baseURL: BASE_URL,
        fetchImpl: aiand.fetchImpl,
        now: () => 1_786_660_000_000,
      })

      const response = await sendPdf(fetch)

      assert.equal(response.status, error.status)
      assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
      assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 1)
    })
  }
})

test("limits stale-reference recovery to one chat retry", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) => jsonResponse({ id: `file-${count}`, expires_at: 1_786_665_600 }),
    chatResponse: () => jsonResponse({ error: { code: "file_expired" } }, { status: 410 }),
  })
  const fetch = createTestPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })

  const response = await sendPdf(fetch)

  assert.equal(response.status, 410)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
})

test("passively rejects only the exact model after a capability mismatch without retrying or evicting", async () => {
  const otherModelID = "provider/other-pdf-model"
  const mismatch = jsonResponse(
    { error: { code: "model_capability_mismatch", message: "runtime catalog drift" } },
    { status: 400 },
  )
  const aiand = recordingAiand({
    chatResponse: (count) =>
      count === 1
        ? mismatch
        : new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
  })
  const fetch = createPdfUploadFetch({
    baseURL: BASE_URL,
    catalogSnapshot: {
      ...SUPPORTED_CATALOG,
      models: {
        ...SUPPORTED_CATALOG.models,
        [otherModelID]: {
          attachment: true,
          modalities: { input: ["text", "image", "pdf"] },
        },
      },
    },
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })

  const response = await sendPdf(fetch)

  assert.strictEqual(response, mismatch)
  assert.deepEqual(await response.json(), {
    error: { code: "model_capability_mismatch", message: "runtime catalog drift" },
  })
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 1)

  await assert.rejects(sendPdf(fetch), {
    message: "[aiand] PDF capability failed: selected model does not support PDF input",
  })
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 1)

  const otherResponse = await sendPdf(fetch, PDF_DATA_URL, otherModelID)
  assert.equal(otherResponse.status, 200)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
})

test("does not reject a model for other capability response status and code pairs", async (t) => {
  for (const control of [
    { code: "model_capability_mismatch", status: 500 },
    { code: "invalid_request_error", status: 400 },
  ]) {
    await t.test(`${control.status}/${control.code}`, async () => {
      const controlResponse = jsonResponse({ error: { code: control.code } }, { status: control.status })
      const aiand = recordingAiand({
        chatResponse: (count) =>
          count === 1
            ? controlResponse
            : new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
      })
      const fetch = createTestPdfUploadFetch({
        baseURL: BASE_URL,
        fetchImpl: aiand.fetchImpl,
        now: () => 1_786_660_000_000,
      })

      const firstResponse = await sendPdf(fetch)
      const secondResponse = await sendPdf(fetch)

      assert.strictEqual(firstResponse, controlResponse)
      assert.equal(secondResponse.status, 200)
      assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
      assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
    })
  }
})
