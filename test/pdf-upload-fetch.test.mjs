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

function recordingAiand() {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url === `${BASE_URL}/files`) {
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
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  return { calls, fetchImpl }
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
  assert.equal(await upload.init.body.get("file").text(), PDF_BYTES.toString("utf8"))

  const chat = aiand.calls[1]
  const sent = JSON.parse(chat.init.body)
  assert.deepEqual(sent.messages[0].content, [
    { type: "text", text: "Read this PDF." },
    { type: "file", file: { file_id: "file-test-1" } },
  ])
  assert.equal(chat.init.body.includes("data:application/pdf;base64"), false)
  assert.equal(chat.init.headers.has("content-length"), false)
})
