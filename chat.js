// api/chat.js
// Vercel serverless function — the secure backend that holds the Claude API key.
//
// Designed to work with the persona.html "callClaude" flow:
//   the page sends { persona_id, system, messages }
//   - "system" is the rich persona systemPrompt already defined in persona.html
//   - "messages" is the running conversation (user/assistant turns)
// This backend RETRIEVES relevant playbook chunks for the latest user message
// and APPENDS them to the persona's system prompt, then calls Claude.
//
// The API key lives ONLY here, as a Vercel Environment Variable (ANTHROPIC_API_KEY).
// It is never sent to the browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const knowledge = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "playbook-knowledge.json"), "utf-8")
);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- Small keyword RAG over the playbook chunks ---
function selectContext(question, maxChunks = 4) {
  const q = (question || "").toLowerCase();
  const words = q.split(/[^a-zàâéèêëïîôûùç0-9]+/i).filter((w) => w.length > 3);
  if (words.length === 0) return [];

  const scored = knowledge.chunks.map((chunk) => {
    const text = (chunk.title + " " + chunk.text).toLowerCase();
    let score = 0;
    for (const w of words) if (text.includes(w)) score += 1;
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, maxChunks).map((s) => s.chunk);
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return String(messages[i].content || "");
  }
  return "";
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "Server not configured: ANTHROPIC_API_KEY missing." }); return; }

  try {
    const body = req.body || {};
    const system = body.system;
    const messages = body.messages;

    if (!system || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "Expected { system, messages: [...] }." });
      return;
    }

    // RAG: retrieve playbook context for the latest user message
    const question = lastUserMessage(messages);
    const context = selectContext(question);

    let augmentedSystem = system;
    if (context.length > 0) {
      const ctxText = context
        .map((c) => "### " + c.title + " (source: " + c.source + ")\n" + c.text)
        .join("\n\n");
      augmentedSystem =
        system +
        "\n\n# PLAYBOOK CONTEXT (retrieved for the user's question)\n" +
        "Use the following excerpts from the FlexReady playbook to ground your answer when relevant. " +
        "If they don't cover the question, answer from your own expertise and say so briefly.\n\n" +
        ctxText;
    }

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: augmentedSystem,
        messages: messages.map(function (m) { return { role: m.role, content: String(m.content) }; }),
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      res.status(502).json({ error: "Claude API error", detail: errText.slice(0, 500) });
      return;
    }

    const data = await anthropicResp.json();
    // Return the raw Anthropic shape so the page's existing parser works unchanged:
    //   data.content?.map(b => b.text).join('')
    res.status(200).json({
      content: data.content,
      _sources: context.map(function (c) { return { title: c.title, source: c.source }; }),
    });
  } catch (err) {
    res.status(500).json({ error: "Unexpected server error", detail: String(err).slice(0, 300) });
  }
}
