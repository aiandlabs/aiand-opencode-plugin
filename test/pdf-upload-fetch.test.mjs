import assert from "node:assert/strict"
import test from "node:test"

import { createPdfUploadFetch } from "../dist/pdf-upload-fetch.js"

const BASE_URL = "https://api.aiand.com/v1"
const CHAT_URL = `${BASE_URL}/chat/completions`
const PDF_BYTES = Buffer.from("%PDF-1.4\nPDF smoke test\n%%EOF\n", "utf8")
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`

function chatBody(parts) {
  return {
    model: "moonshotai/kimi-k3",
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

function sendPdf(fetch, dataURL = PDF_DATA_URL) {
  return fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(chatBody([{ type: "file", file: { filename: "manual.pdf", file_data: dataURL } }])),
  })
}

test("uploads an inline PDF and sends only its file_id to chat", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({
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

test("accepts a large valid PDF without regex size failures", async () => {
  const largePdf = Buffer.alloc(14 * 1024 * 1024)
  PDF_BYTES.subarray(0, 5).copy(largePdf)
  const dataURL = `data:application/pdf;base64,${largePdf.toString("base64")}`
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  const response = await sendPdf(fetch, dataURL)

  assert.equal(response.status, 200)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 1)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 1)
})

test("translates an inline PDF carried by a Request input", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
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
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
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
      const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl, ...item.options })
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

test("preserves requests without an eligible inline PDF", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
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

test("turns an invalid upload response into a safe adapter error", async () => {
  const aiand = recordingAiand({
    uploadResponse: () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }),
  })
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

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

test("reuses one upload for sequential references to identical PDF bytes", async () => {
  const aiand = recordingAiand()
  const fetch = createPdfUploadFetch({
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
  const fetch = createPdfUploadFetch({
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
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })
  const other = Buffer.from("%PDF-1.4\na different document\n%%EOF\n").toString("base64")

  await sendPdf(fetch)
  await sendPdf(fetch, `data:application/pdf;base64,${other}`)

  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
})

test("does not cache failed uploads", async () => {
  const aiand = recordingAiand({
    uploadResponse: (count) =>
      count === 1
        ? jsonResponse(
            { error: { code: "invalid_request_error", message: "PDFs are capped at 100 pages" } },
            { status: 400 },
          )
        : jsonResponse({ id: "file-recovered", expires_at: 1786665600 }),
  })
  const fetch = createPdfUploadFetch({ baseURL: BASE_URL, fetchImpl: aiand.fetchImpl })

  await assert.rejects(
    sendPdf(fetch),
    /\[aiand\] PDF upload failed: HTTP 400 \(invalid_request_error: PDFs are capped at 100 pages\)/,
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
  const fetch = createPdfUploadFetch({
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
      const fetch = createPdfUploadFetch({
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
  const fetch = createPdfUploadFetch({
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
      const fetch = createPdfUploadFetch({
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
  const fetch = createPdfUploadFetch({
    baseURL: BASE_URL,
    fetchImpl: aiand.fetchImpl,
    now: () => 1_786_660_000_000,
  })

  const response = await sendPdf(fetch)

  assert.equal(response.status, 410)
  assert.equal(aiand.calls.filter((call) => call.url === `${BASE_URL}/files`).length, 2)
  assert.equal(aiand.calls.filter((call) => call.url === CHAT_URL).length, 2)
})
