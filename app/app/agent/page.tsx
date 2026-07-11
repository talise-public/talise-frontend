"use client";

/**
 * /app/agent — the Talise Agent (AI assistant) surface.
 *
 * Renders the full-height <AgentChat> panel inside the standard /app shell
 * (so it inherits the nav, providers, and beta gate). The chat streams from
 * /api/chat/stream, proposes a server-validated plan, and executes only the
 * confirmed steps through the same prepare→sign→submit hooks the manual flows
 * use — see components/app/agent/AgentChat.tsx.
 */

import { AgentChat } from "@/components/app/agent/AgentChat";

export default function AgentPage() {
  return <AgentChat />;
}
