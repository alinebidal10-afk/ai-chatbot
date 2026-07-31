"use client";

import { useRef, useState } from "react";
import { Plus, SendHorizontal, Square } from "lucide-react";
import type { Attachment } from "@/lib/chat-types";
import { getModelInfo } from "@/lib/models";
import { ACCEPTED_IMAGE_TYPES, prepareImage } from "@/lib/image";
import ModelPicker from "./ModelPicker";

interface ComposerProps {
  modelId: string;
  onModelChange: (id: string) => void;
  busy: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onFocusInput: () => void;
}

/**
 * The pill-shaped input bar: 56px tall, fully rounded, white, thin outline.
 * Attach button inside on the left; model picker and send inside on the
 * right. Attachment previews and warnings float above the bar.
 */
export default function Composer({
  modelId,
  onModelChange,
  busy,
  onSend,
  onStop,
  onFocusInput,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const model = getModelInfo(modelId);
  const visionBlocked = attachments.length > 0 && !model.supportsVision;
  const canSend =
    !busy && !visionBlocked && (text.trim().length > 0 || attachments.length > 0);

  const addFiles = async (files: FileList | File[]) => {
    setAttachError(null);
    for (const file of Array.from(files)) {
      try {
        const prepared = await prepareImage(file);
        setAttachments((prev) => [...prev, prepared]);
      } catch (err) {
        setAttachError(
          err instanceof Error ? err.message : "Could not read that file.",
        );
      }
    }
  };

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText("");
    setAttachments([]);
    textareaRef.current?.focus();
  };

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {/* Floating layer above the bar: previews + warnings (right side, so
          they never collide with the cat on the left) */}
      {(attachments.length > 0 || visionBlocked || attachError) && (
        <div className="absolute bottom-[calc(100%+10px)] right-0 flex max-w-full flex-col items-end gap-2">
          {attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {attachments.map((a, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    className="h-14 w-14 rounded-xl border border-cat-outline/40 bg-white object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() =>
                      setAttachments((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-white hover:bg-red-800"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {visionBlocked && (
            <p className="rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
              {model.label} cannot see images. Switch model or remove the
              image — it will not be dropped silently.
            </p>
          )}
          {attachError && (
            <p className="rounded-lg bg-white/90 px-3 py-1.5 text-xs text-red-800">
              {attachError}
            </p>
          )}
        </div>
      )}

      <div
        className={`flex h-14 items-center gap-1.5 rounded-[28px] border border-cat-outline bg-white pl-2 pr-2 shadow-lg shadow-cat-outline/10 ${
          dragOver ? "ring-2 ring-cat-outline/50" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="Attach an image"
          title="Attach an image"
          className="touch-target flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-cat-highlight/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cat-outline disabled:opacity-50"
        >
          <Plus size={20} strokeWidth={1.75} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={onFocusInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Message the assistant…"
          aria-label="Message"
          // 16px, not 15px: anything smaller makes iOS Safari zoom the whole
          // page when the input is focused, which breaks the layout.
          className="h-6 flex-1 resize-none self-center bg-transparent text-[16px] leading-6 text-ink outline-none placeholder:text-ink/40"
        />

        <ModelPicker value={modelId} onChange={onModelChange} disabled={busy} />

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="touch-target flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cat-highlight text-ink hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cat-outline"
          >
            <Square size={16} strokeWidth={1.75} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
            className="touch-target flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cat-highlight text-ink hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:bg-transparent disabled:opacity-40"
          >
            <SendHorizontal size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
}
