export type PdfModelCatalogEntry = {
  attachment?: unknown
  modalities?: { input?: unknown }
}

export type CatalogSnapshot = {
  available: boolean
  fetchedAtMs: number
  models: Readonly<Record<string, PdfModelCatalogEntry>>
}

export type PdfCapabilityDecision =
  | { state: "supported" }
  | { state: "unsupported" }
  | { state: "unknown" }

const UNKNOWN: PdfCapabilityDecision = { state: "unknown" }
const UNSUPPORTED: PdfCapabilityDecision = { state: "unsupported" }
const SUPPORTED: PdfCapabilityDecision = { state: "supported" }

export function decidePdfCapability(
  modelID: unknown,
  snapshot: CatalogSnapshot,
  rejectedModels?: ReadonlySet<string>,
): PdfCapabilityDecision {
  if (typeof modelID !== "string") return UNKNOWN
  if (rejectedModels?.has(modelID)) return UNSUPPORTED
  if (snapshot?.available !== true || !snapshot.models || typeof snapshot.models !== "object") return UNKNOWN
  if (!Object.prototype.hasOwnProperty.call(snapshot.models, modelID)) return UNKNOWN

  const entry = snapshot.models[modelID]
  if (!entry || typeof entry !== "object") return UNKNOWN
  const input = entry.modalities?.input

  if (entry.attachment === false) return UNSUPPORTED
  if (Array.isArray(input) && !input.includes("pdf")) return UNSUPPORTED
  if (entry.attachment !== true || !Array.isArray(input)) return UNKNOWN
  return input.includes("pdf") ? SUPPORTED : UNSUPPORTED
}
