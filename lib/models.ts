/** Client-safe model registry — no SDK imports here. */
export interface ModelInfo {
  id: string;
  label: string;
  supportsVision: boolean;
  supportsTools: boolean;
}

export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", supportsVision: true, supportsTools: true },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsVision: true, supportsTools: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", supportsVision: true, supportsTools: true },
];

export const DEFAULT_MODEL_ID = "claude-opus-5";

export function getModelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}
