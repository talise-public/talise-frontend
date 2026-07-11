"use client";

/**
 * conversationsStore — a tiny localStorage-backed store for the Talise Agent's
 * chat history (the ChatGPT-style sidebar).
 *
 * Conversations are DISPLAY-ONLY transcripts: we persist the finished prose +
 * any parsed intent so a thread can be re-opened and re-rendered. They never
 * feed the send/plan paths — execution always re-validates through
 * /api/agent/plan and only moves money against server-resolved values.
 *
 * Storage shape (key `talise.agent.conversations.v1`): an array of
 * `Conversation` ({ id, title, messages[], createdAt, updatedAt }), newest
 * first, capped at MAX. A module-level pub/sub keeps every `useConversations`
 * subscriber in sync across the sidebar + chat without a context provider.
 */

import { useEffect, useState } from "react";
import type { ChatIntent } from "@/lib/chat/intent";

const KEY = "talise.agent.conversations.v1";
const MAX = 60;

export type StoredRole = "user" | "assistant";

export type StoredMessage = {
  id: string;
  role: StoredRole;
  /** Display prose (intent fence already stripped). */
  content: string;
  /** Full raw stream incl. any intent fence (assistant only). */
  raw?: string;
  intent?: ChatIntent | null;
};

export type Conversation = {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
};

type Listener = (list: Conversation[]) => void;
const listeners = new Set<Listener>();

function read(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Conversation[]) : [];
  } catch {
    return [];
  }
}

function write(list: Conversation[]) {
  if (typeof window === "undefined") return;
  const trimmed = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota / private-mode — fail soft, history just won't persist */
  }
  for (const l of listeners) l(trimmed);
}

/** All conversations, newest-updated first. */
export function loadConversations(): Conversation[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A single conversation by id (or null). */
export function loadConversation(id: string): Conversation | null {
  return read().find((c) => c.id === id) ?? null;
}

/** Insert-or-update a conversation, preserving its original createdAt. */
export function saveConversation(conv: Conversation) {
  const rest = read().filter((c) => c.id !== conv.id);
  write([conv, ...rest]);
}

export function deleteConversation(id: string) {
  write(read().filter((c) => c.id !== id));
}

/** Derive a thread title from its first user message. */
export function titleFromMessages(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
}

/** Coarse relative time for sidebar rows. */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "earlier";
  }
}

/** Live, sorted view of the stored conversations. */
export function useConversations(): Conversation[] {
  const [list, setList] = useState<Conversation[]>([]);
  useEffect(() => {
    setList(loadConversations());
    const fn: Listener = (next) =>
      setList([...next].sort((a, b) => b.updatedAt - a.updatedAt));
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setList(loadConversations());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return list;
}
