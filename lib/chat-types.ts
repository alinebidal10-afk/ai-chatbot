/** Client-side content and message shapes (mirror of the stored JSON). */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | { type: string; [key: string]: unknown };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  updatedAt: string;
}

export interface Attachment {
  mediaType: string;
  /** base64 without the data: prefix */
  data: string;
  /** object URL for the thumbnail preview */
  previewUrl: string;
  name: string;
}
