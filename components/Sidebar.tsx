"use client";

import { useEffect, useState } from "react";
import {
  MessageSquarePlus,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ConversationSummary } from "@/lib/chat-types";

interface SidebarProps {
  open: boolean;
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}

const actionRowClass =
  "touch-target flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-ink hover:bg-cat-highlight/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink";

export default function Sidebar({
  open,
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
  onDeleteAll,
  onClose,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    ConversationSummary[] | null
  >(null);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  // Live search across titles and message content, debounced server call.
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || !q) {
      setSearchResults(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/conversations?q=${encodeURIComponent(q)}`);
        if (res.ok) setSearchResults(await res.json());
      } catch {
        /* keep the previous results on a failed search */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, searchOpen]);

  const commitRename = (id: string) => {
    if (draft.trim()) onRename(id, draft.trim());
    setEditingId(null);
  };

  const listed = searchResults ?? conversations;

  return (
    <aside
      className={`${open ? "sidebar-open" : ""} shrink-0 bg-cat-green max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:w-[min(85vw,20rem)] max-lg:transition-transform max-lg:duration-[240ms] max-lg:ease-out ${open ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"} lg:overflow-hidden lg:transition-[width] lg:duration-[240ms] lg:ease-out ${open ? "lg:w-72" : "lg:w-0"}`}
      aria-label="Conversations"
      aria-hidden={!open}
    >
      <div className="flex h-full w-full flex-col p-3 lg:w-72">
        {/* The panel carries its own dismissal: on a phone the overlay
            covers the hamburger that opened it, so without this there is
            no way back out. 44x44 hit area unconditionally. */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            title="Close sidebar"
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink hover:bg-cat-highlight/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <button type="button" onClick={onNewChat} className={actionRowClass}>
          <MessageSquarePlus size={16} strokeWidth={1.75} />
          New chat
        </button>

        <button
          type="button"
          onClick={() => {
            setSearchOpen((v) => !v);
            setQuery("");
          }}
          className={actionRowClass}
          aria-expanded={searchOpen}
        >
          <Search size={16} strokeWidth={1.75} />
          Search in chats
        </button>
        {searchOpen && (
          <div className="mb-1 mt-1 flex items-center gap-1 rounded-lg border border-cat-outline/50 bg-white px-2 py-1.5">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink/50" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setQuery("");
                }
              }}
              placeholder="Search titles and messages"
              aria-label="Search in chats"
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink/40"
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={() => {
                setSearchOpen(false);
                setQuery("");
              }}
              className="shrink-0 rounded p-0.5 text-ink/60 hover:bg-cat-highlight/60 hover:text-ink"
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setConfirmingDeleteAll(true)}
          className={actionRowClass}
        >
          <Trash2 size={16} strokeWidth={1.75} />
          Delete all
        </button>
        {confirmingDeleteAll && (
          <div className="mb-1 mt-1 rounded-lg border border-red-800/40 bg-red-100 p-2 text-sm text-red-900">
            <p className="mb-2">Delete all conversations? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDeleteAll(false)}
                className="rounded px-2 py-1 text-xs font-medium text-ink hover:bg-white/50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDeleteAll(false);
                  setSearchResults(null);
                  setQuery("");
                  onDeleteAll();
                }}
                className="rounded border border-red-800/40 bg-white px-2 py-1 text-xs font-medium text-red-900 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        )}

        <h2 className="mb-1 mt-3 px-2 text-xs font-medium tracking-[0.04em] text-ink/60">
          Recents
        </h2>
        <div className="flex-1 space-y-1 overflow-y-auto pr-1">
          {listed.length === 0 && (
            <p className="sidebar-row px-2 text-sm text-ink/80">
              {searchResults ? "No matches." : "No conversations yet. Say hello!"}
            </p>
          )}
          {listed.map((c, i) => (
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
                className="row-action hidden shrink-0 rounded p-1 text-ink/70 hover:bg-white/40 hover:text-ink group-hover:block"
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
                  className="row-action hidden shrink-0 rounded p-1 text-ink/70 hover:bg-white/40 hover:text-ink group-hover:block"
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
