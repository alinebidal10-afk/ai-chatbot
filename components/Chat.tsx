"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import type {
  Attachment,
  ChatMessage,
  ContentBlock,
  ConversationSummary,
} from "@/lib/chat-types";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import Sidebar from "./Sidebar";
import MessageList from "./MessageList";
import Composer from "./Composer";
import Mascot from "./Mascot";

const SIDEBAR_KEY = "sidebar-open";

export default function Chat() {
  // Default closed for first-time visitors; localStorage keeps the last
  // choice across reloads. Read after mount so SSR and client agree.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(SIDEBAR_KEY) === "1") {
      setSidebarOpen(true);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      window.localStorage.setItem(SIDEBAR_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awakeSignal, setAwakeSignal] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const wake = useCallback(() => setAwakeSignal((n) => n + 1), []);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
    } catch {
      /* sidebar refresh is best-effort */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refreshConversations(), 0);
    return () => clearTimeout(t);
  }, [refreshConversations]);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages);
      if (data.modelId) setModelId(data.modelId);
    } catch {
      setError("Could not load that conversation.");
    }
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setStreamingText(null);
    setToolStatus(null);
  }, []);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }).catch(() => {});
    },
    [],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeId) newChat();
      await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(
        () => {},
      );
    },
    [activeId, newChat],
  );

  const send = useCallback(
    async (text: string, attachments: Attachment[]) => {
      const content: ContentBlock[] = [
        ...attachments.map((a) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: a.mediaType,
            data: a.data,
          },
        })),
        ...(text ? [{ type: "text" as const, text }] : []),
      ];

      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "user", content },
      ]);
      setBusy(true);
      setError(null);
      setStreamingText("");
      setToolStatus(null);
      wake();

      const abort = new AbortController();
      abortRef.current = abort;
      let acc = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: activeId ?? undefined,
            modelId,
            content,
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const raw of events) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line.slice(5));
            } catch {
              continue;
            }
            switch (event.type) {
              case "conversation": {
                const id = event.id as string;
                if (!activeId) setActiveId(id);
                void refreshConversations();
                break;
              }
              case "text":
                acc += event.text as string;
                setStreamingText(acc);
                setToolStatus(null);
                break;
              case "status":
                setToolStatus(event.text as string);
                break;
              case "status_done":
                setToolStatus(null);
                break;
              case "title":
                void refreshConversations();
                break;
              case "error":
                setError(event.message as string);
                break;
            }
          }
        }
      } catch (err) {
        const aborted =
          abort.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (!aborted) {
          setError(
            err instanceof Error ? err.message : "Something went wrong.",
          );
        }
      } finally {
        if (acc.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              id: `local-a-${Date.now()}`,
              role: "assistant",
              content: [{ type: "text", text: acc }],
            },
          ]);
        }
        setStreamingText(null);
        setToolStatus(null);
        setBusy(false);
        abortRef.current = null;
        void refreshConversations();
      }
    },
    [activeId, modelId, refreshConversations, wake],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const changeModel = useCallback(
    (id: string) => {
      setModelId(id);
      if (activeId) {
        void fetch(`/api/conversations/${activeId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: id }),
        }).catch(() => {});
      }
    },
    [activeId],
  );

  // Two-state layout: with no messages the bar is vertically centred with a
  // greeting above it; after the first message it docks to the bottom with
  // 24px of margin. One smooth move of the bar (animated `top`), no page
  // swap. Messages scroll behind the bar.
  const active =
    messages.length > 0 || streamingText !== null || busy || error !== null;

  return (
    <div className="flex h-screen">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => void openConversation(id)}
        onNewChat={newChat}
        onRename={(id, t) => void renameConversation(id, t)}
        onDelete={(id) => void deleteConversation(id)}
      />

      <main className="relative min-w-0 flex-1">
        {/* Floating controls, no panel */}
        <div className="absolute left-4 top-4 z-20 flex items-center">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-cat-highlight/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cat-outline"
          >
            <Menu size={20} strokeWidth={1.75} />
          </button>
          <h1 className="ml-3 text-sm font-medium text-ink/80">AI chatbot</h1>
        </div>

        {active && (
          <MessageList
            messages={messages}
            streamingText={streamingText}
            toolStatus={toolStatus}
            error={error}
          />
        )}

        {/* The input bar (with the cat on its top edge). Positioned after
            the message list in the DOM so it paints above it — deliberately
            NO z-index anywhere in this subtree, or the mascot's multiply
            blend would be isolated and its white box would come back. */}
        <div
          className="absolute inset-x-0 px-4 transition-[top] duration-500 ease-out"
          style={{
            // Empty state: the greeting (48px) + 200px cat clearance + the
            // 56px bar centre as one group -> bar top sits 96px below centre.
            top: active ? "calc(100% - 80px)" : "calc(50% + 96px)",
          }}
        >
          <div className="relative mx-auto max-w-[720px]">
            <p
              aria-hidden={active}
              className={`pointer-events-none absolute bottom-[calc(100%+200px)] left-0 right-0 whitespace-nowrap text-center text-[40px] font-normal leading-[48px] tracking-[-0.02em] text-ink transition-opacity duration-300 ${
                active ? "opacity-0" : "opacity-100"
              }`}
            >
              What can I help with?
            </p>
            <Composer
              modelId={modelId}
              onModelChange={changeModel}
              busy={busy}
              onSend={(t, a) => void send(t, a)}
              onStop={stop}
              onFocusInput={wake}
            />
            {/* After the Composer in the DOM so the paws paint on top of the
                bar without any z-index (which would isolate the blend). */}
            <Mascot awakeSignal={awakeSignal} busy={busy} />
          </div>
        </div>
      </main>
    </div>
  );
}
