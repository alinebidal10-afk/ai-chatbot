"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { ConversationSummary } from "@/lib/chat-types";

interface SidebarProps {
  open: boolean;
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export default function Sidebar({
  open,
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const commitRename = (id: string) => {
    if (draft.trim()) onRename(id, draft.trim());
    setEditingId(null);
  };

  return (
    <aside
      className={`${open ? "sidebar-open" : ""} shrink-0 bg-cat-green max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:w-72 max-lg:transition-transform max-lg:duration-[240ms] max-lg:ease-out ${open ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"} lg:overflow-hidden lg:transition-[width] lg:duration-[240ms] lg:ease-out ${open ? "lg:w-72" : "lg:w-0"}`}
      aria-label="Conversations"
      aria-hidden={!open}
    >
      <div className="flex h-full w-72 flex-col p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="mb-3 rounded-xl border border-cat-outline/50 bg-cat-highlight px-3 py-2 text-left text-sm font-medium text-ink hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          + New chat
        </button>
        <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-ink/80">
          Conversations
        </h2>
        <div className="flex-1 space-y-1 overflow-y-auto pr-1">
          {conversations.length === 0 && (
            <p className="sidebar-row px-1 text-sm text-ink/80">
              No conversations yet. Say hello!
            </p>
          )}
          {conversations.map((c, i) => (
            <div
              key={c.id}
              className={`sidebar-row group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink ${
                c.id === activeId ? "bg-cat-highlight" : "hover:bg-cat-highlight/50"
              }`}
              style={{ transitionDelay: open ? `${Math.min(i, 12) * 40}ms` : "0ms" }}
            >
              {editingId === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  aria-label="Conversation title"
                  className="w-full rounded border border-cat-outline/60 bg-white px-1 py-0.5 text-sm text-ink focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className="min-w-0 flex-1 truncate text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                  title={c.title}
                >
                  {c.title}
                </button>
              )}
              <button
                type="button"
                aria-label={`Rename "${c.title}"`}
                title="Rename"
                onClick={() => {
                  setEditingId(c.id);
                  setDraft(c.title);
                }}
                className="hidden shrink-0 rounded p-1 text-ink/70 hover:bg-white/40 hover:text-ink group-hover:block"
              >
                <Pencil size={14} strokeWidth={1.75} />
              </button>
              {confirmDeleteId === c.id ? (
                <button
                  type="button"
                  aria-label="Confirm delete"
                  title="Click again to confirm"
                  onClick={() => {
                    setConfirmDeleteId(null);
                    onDelete(c.id);
                  }}
                  onBlur={() => setConfirmDeleteId(null)}
                  className="shrink-0 rounded border border-red-800/40 bg-red-100 p-1 px-1.5 text-xs font-medium text-red-900"
                >
                  Sure?
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`Delete "${c.title}"`}
                  title="Delete"
                  onClick={() => setConfirmDeleteId(c.id)}
                  className="hidden shrink-0 rounded p-1 text-ink/70 hover:bg-white/40 hover:text-ink group-hover:block"
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
