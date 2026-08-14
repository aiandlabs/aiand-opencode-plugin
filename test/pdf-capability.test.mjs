import assert from "node:assert/strict"
import test from "node:test"
import { decidePdfCapability } from "../dist/pdf-capability.js"

const availableSnapshot = (entry) => ({
  available: true,
  fetchedAtMs: 1,
  models: { "claude-3": entry },
})

const decisionCases = [
  [true, ["text", "pdf"], "supported"],
  [true, ["text", "image", "pdf"], "supported"],
  [false, ["text", "pdf"], "unsupported"],
  [true, ["text"], "unsupported"],
  [undefined, ["text", "pdf"], "unknown"],
  [true, undefined, "unknown"],
  ["yes", ["text", "pdf"], "unknown"],
  [true, "pdf", "unknown"],
]

for (const [attachment, input, state] of decisionCases) {
  test(`resolves attachment ${String(attachment)} and modalities ${String(input)} as ${state}`, () => {
    assert.deepEqual(
      decidePdfCapability("claude-3", availableSnapshot({ attachment, modalities: { input } })),
      { state },
    )
  })
}

test("returns unknown for unavailable snapshots", () => {
  assert.deepEqual(
    decidePdfCapability("claude-3", { available: false, fetchedAtMs: 1, models: {} }),
    { state: "unknown" },
  )
})

test("returns unknown for missing or non-string model IDs", () => {
  const snapshot = availableSnapshot({ attachment: true, modalities: { input: ["pdf"] } })
  for (const modelID of [undefined, null, 42, ""]) {
    assert.deepEqual(decidePdfCapability(modelID, snapshot), { state: "unknown" })
  }
})

test("returns unknown for absent exact entries and alias-like IDs", () => {
  const snapshot = availableSnapshot({ attachment: true, modalities: { input: ["pdf"] } })
  for (const modelID of ["missing", "claude-3-latest", "provider/claude-3"]) {
    assert.deepEqual(decidePdfCapability(modelID, snapshot), { state: "unknown" })
  }
})

test("returns unsupported when the exact model is runtime-rejected", () => {
  const snapshot = { available: false, fetchedAtMs: 1, models: {} }
  assert.deepEqual(decidePdfCapability("claude-3", snapshot, new Set(["claude-3"])), { state: "unsupported" })
})

test("catalog explicit negatives take precedence over malformed evidence", () => {
  assert.deepEqual(
    decidePdfCapability("claude-3", availableSnapshot({ attachment: false, modalities: { input: "pdf" } })),
    { state: "unsupported" },
  )
  assert.deepEqual(
    decidePdfCapability("claude-3", availableSnapshot({ attachment: true, modalities: { input: ["text"] } })),
    { state: "unsupported" },
  )
})
