"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { ChatMessage, ImageBlock, TextBlock } from "@/lib/chat-types";
import Markdown from "./Markdown";

interface MessageListProps {
  messages: ChatMessage[];
  streamingText: string | null;
  toolStatus: string | null;
  error: string | null;
}

function textOf(m: ChatMessage): string {
  return m.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function imagesOf(m: ChatMessage): ImageBlock[] {
  return m.content.filter(
    (b): b is ImageBlock =>
      b.type === "image" && (b as ImageBlock).source?.type === "base64",
  );
}

/**
 * The message thread. Bubbles sit directly on the page gradient — no card
 * or panel wraps the thread. The whole surface scrolls behind the docked
 * input bar; the bottom spacer keeps the last message clear of the bar and
 * the mascot above it.
 */
export default function MessageList({
  messages,
  streamingText,
  toolStatus,
  error,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Pinned to the bottom while streaming — but the moment the user scrolls
  // up, stop following and offer a jump-to-latest affordance instead.
  // Following resumes only when they scroll back down themselves.
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distance < 60);
  }, []);

  useEffect(() => {
    if (following) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamingText, toolStatus, error, following]);

  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setFollowing(true);
  }, []);

  // Hide pure tool-plumbing messages (tool_use-only / tool_result-only)
  const visible = messages.filter(
    (m) => textOf(m).length > 0 || imagesOf(m).length > 0,
  );

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="absolute inset-0 touch-pan-y overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto max-w-3xl space-y-4 px-4 pt-16 md:px-6">
        {visible.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] md:max-w-[80%] ${
                m.role === "user"
                  ? "rounded-br-md border border-cat-outline/30 bg-cat-highlight text-ink"
                  : "rounded-bl-md border border-cat-outline/20 bg-white/85 text-ink"
              }`}
            >
              {imagesOf(m).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {imagesOf(m).map((img, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={`data:${img.source.media_type};base64,${img.source.data}`}
                      alt="Attached image"
                      className="max-h-48 max-w-full rounded-lg border border-cat-outline/30"
                    />
                  ))}
                </div>
              )}
              {m.role === "assistant" ? (
                <Markdown text={textOf(m)} />
              ) : (
                textOf(m) && <p className="whitespace-pre-wrap">{textOf(m)}</p>
              )}
            </div>
          </div>
        ))}

        {streamingText !== null && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-cat-outline/20 bg-white/85 px-4 py-2.5 text-[15px] text-ink md:max-w-[80%]">
              {streamingText.length > 0 ? (
                // Plain text with preserved line breaks while streaming —
                // re-parsing markdown every frame is the jitter people
                // mistake for network lag. Parsed once on completion, when
                // the message joins the list above.
                <p className="whitespace-pre-wrap leading-relaxed">
                  {streamingText}
                </p>
              ) : (
                <span className="text-ink/50">…</span>
              )}
              {toolStatus && (
                <p className="mt-2 flex items-center gap-2 text-sm italic text-ink/60">
                  <span
                    aria-hidden="true"
                    className="tool-spinner inline-block h-3.5 w-3.5 rounded-full border-2 border-cat-outline/40 border-t-cat-outline"
                  />
                  {toolStatus}
                </p>
              )}
              {!toolStatus && (
                <span className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-cat-outline" />
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl border border-red-800/30 bg-red-50 px-4 py-2.5 text-sm text-red-900 md:max-w-[80%]">
              {error}
            </div>
          </div>
        )}

        {/* Clearance for the docked bar (live height via --bar-h, written
            by a ResizeObserver as the composer grows, + 24px margin) plus
            the mascot reservation above it (--mascot-w * 0.6), so the last
            message never slides underneath either. */}
        <div
          ref={bottomRef}
          className="h-[calc(var(--bar-h,56px)+24px+var(--mascot-w)*0.6+env(safe-area-inset-bottom,0px))]"
        />
      </div>

      {/* Shown when the user has scrolled away from the bottom; following
          resumes when they return there (by this button or by hand). */}
      {!following && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className="touch-target absolute bottom-[calc(var(--bar-h,56px)+48px+env(safe-area-inset-bottom,0px))] left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-cat-outline/40 bg-white text-ink shadow-md hover:bg-cat-highlight/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cat-outline"
        >
          <ArrowDown size={18} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
