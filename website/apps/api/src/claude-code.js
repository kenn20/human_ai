import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CORPORATE_SYSTEM_PROMPT, formatRewriteInput, formatWebSearchInput, logLlmRequestIfEnabled, normalizeModelResult, WEB_SEARCH_SYSTEM_PROMPT } from "./llm.js";
import { PERSONAS } from "./personas.js";

const execFileAsync = promisify(execFile);
const JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    acceptable: { type: "boolean" },
    categories: { type: "array", items: { type: "string" } },
    replacement: { type: "string" }
  },
  required: ["acceptable", "categories", "replacement"],
  additionalProperties: false
});

export async function rewriteWithClaudeCode({
  text,
  context,
  model = "sonnet",
  systemPrompt = CORPORATE_SYSTEM_PROMPT,
  policyVersion = PERSONAS.corporate.version,
  exec = execFileAsync
}) {
  logLlmRequestIfEnabled({ provider: "claude-code", model, text });
  const inputText = formatRewriteInput(text, context?.conversation);
  const { stdout } = await exec("claude", [
    "-p",
    "--no-session-persistence",
    "--setting-sources", "",
    "--tools", "",
    "--model", model,
    "--output-format", "json",
    "--json-schema", JSON_SCHEMA,
    "--system-prompt", systemPrompt,
    inputText
  ], { timeout: 35_000, maxBuffer: 1_000_000 });

  const envelope = JSON.parse(stdout);
  if (envelope.is_error) throw new Error(envelope.result || "Claude Code rewrite failed.");
  const parsed = envelope.structured_output ?? JSON.parse(envelope.result);
  return normalizeModelResult(parsed, text, "claude-code", policyVersion);
}

export async function answerWithClaudeCode({
  query,
  sources = [],
  model = "sonnet",
  systemPrompt = WEB_SEARCH_SYSTEM_PROMPT,
  exec = execFileAsync
} = {}) {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("query is required.");
  const { stdout } = await exec("claude", [
    "-p",
    "--no-session-persistence",
    "--setting-sources", "",
    "--tools", "",
    "--model", model,
    "--system-prompt", systemPrompt,
    formatWebSearchInput(query.trim(), sources)
  ], { timeout: 35_000, maxBuffer: 1_000_000 });
  const answer = stdout.trim();
  if (!answer) throw new Error("Claude Code search response was empty.");
  return answer;
}
