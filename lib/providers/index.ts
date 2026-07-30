import type Anthropic from "@anthropic-ai/sdk";

export type Delta =
  | { type: "text"; text: string }
  | { type: "final"; message: Anthropic.Message };

export interface Provider {
  id: string;
  label: string;
  supportsVision: boolean;
  supportsTools: boolean;
  stream(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.ToolUnion[],
    signal: AbortSignal,
  ): AsyncIterable<Delta>;
}

export { PROVIDERS, getProvider, DEFAULT_MODEL_ID } from "./anthropic";
