import { CORPORATE_SYSTEM_PROMPT, formatRewriteInput, formatWebSearchInput, logLlmRequestIfEnabled, normalizeModelResult, parseJsonText, WEB_SEARCH_SYSTEM_PROMPT } from "./llm.js";
import { PERSONAS } from "./personas.js";

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("The model response did not contain output text.");
}

const REWRITE_SCHEMA = {
  type: "object",
  properties: {
    acceptable: { type: "boolean" },
    categories: { type: "array", items: { type: "string" } },
    replacement: { type: "string" }
  },
  required: ["acceptable", "categories", "replacement"],
  additionalProperties: false
};

export class OpenAISpeechError extends Error {
  constructor(status, message = "OpenAI speech request failed.") {
    super(message);
    this.name = "OpenAISpeechError";
    this.status = Number.isInteger(status) ? status : 502;
  }
}

export async function synthesizeSpeechWithOpenAI({
  text,
  tone,
  voice = "coral",
  model = "gpt-4o-mini-tts",
  apiKey,
  fetchImpl = fetch
} = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new TypeError("text is required and bounded.");
  if (typeof tone !== "string" || !tone.trim() || tone.length > 1000) throw new TypeError("tone is required and bounded.");
  if (typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voice)) throw new TypeError("voice is invalid.");
  if (!apiKey) throw new OpenAISpeechError(503, "OpenAI speech is not configured.");
  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: text.trim(), voice, instructions: tone.trim() })
    });
  } catch {
    throw new OpenAISpeechError(502);
  }
  if (!response.ok) throw new OpenAISpeechError(response.status);
  return { audio: await response.arrayBuffer(), contentType: response.headers.get("content-type") || "audio/mpeg" };
}

export async function rewriteWithOpenAI({
  text,
  context,
  apiKey,
  model,
  systemPrompt = CORPORATE_SYSTEM_PROMPT,
  policyVersion = PERSONAS.corporate.version,
  fetchImpl = fetch
}) {
  logLlmRequestIfEnabled({ provider: "openai", model, text });
  const inputText = formatRewriteInput(text, context?.conversation);
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "rewrite_result",
          strict: true,
          schema: REWRITE_SCHEMA
        }
      },
      store: false,
      input: [
        {
          role: "developer",
          content: systemPrompt
        },
        {
          role: "user",
          content: inputText
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI request failed (${response.status}): ${detail}`);
  }

  return normalizeModelResult(parseJsonText(extractOutputText(await response.json())), text, "openai", policyVersion);
}

export async function answerWithOpenAI({
  query,
  sources = [],
  apiKey,
  model,
  systemPrompt = WEB_SEARCH_SYSTEM_PROMPT,
  fetchImpl = fetch
} = {}) {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("query is required.");
  if (!apiKey) throw new Error("OpenAI search is not configured.");
  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      store: false,
      input: [
        { role: "developer", content: systemPrompt },
        { role: "user", content: formatWebSearchInput(query.trim(), sources) }
      ]
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI search request failed (${response.status}): ${detail}`);
  }
  const answer = extractOutputText(await response.json()).trim();
  if (!answer) throw new Error("The OpenAI search response was empty.");
  return answer;
}
