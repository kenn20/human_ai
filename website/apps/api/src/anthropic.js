import { CORPORATE_SYSTEM_PROMPT, formatRewriteInput, formatWebSearchInput, logLlmRequestIfEnabled, normalizeModelResult, parseJsonText, WEB_SEARCH_SYSTEM_PROMPT } from "./llm.js";
import { PERSONAS } from "./personas.js";

function extractOutputText(response) {
  const text = (response.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (!text) throw new Error("The Claude response did not contain output text.");
  return text;
}

function requestBody({ model, systemPrompt, inputText, stream }) {
  return JSON.stringify({
    model,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: inputText }],
    ...(stream ? { stream: true } : {})
  });
}

function requestHeaders(apiKey) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
}

export async function rewriteWithAnthropic({
  text,
  context,
  apiKey,
  model,
  systemPrompt = CORPORATE_SYSTEM_PROMPT,
  policyVersion = PERSONAS.corporate.version,
  fetchImpl = fetch
}) {
  logLlmRequestIfEnabled({ provider: "anthropic", model, text });
  const inputText = formatRewriteInput(text, context?.conversation);
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: requestBody({ model, systemPrompt, inputText, stream: false })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Anthropic request failed (${response.status}): ${detail}`);
  }

  return normalizeModelResult(parseJsonText(extractOutputText(await response.json())), text, "anthropic", policyVersion);
}

export async function answerWithAnthropic({
  query,
  sources = [],
  apiKey,
  model,
  systemPrompt = WEB_SEARCH_SYSTEM_PROMPT,
  fetchImpl = fetch
} = {}) {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("query is required.");
  if (!apiKey) throw new Error("Anthropic search is not configured.");
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: requestBody({
      model,
      systemPrompt,
      inputText: formatWebSearchInput(query.trim(), sources),
      stream: false
    })
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Anthropic search request failed (${response.status}): ${detail}`);
  }
  const answer = extractOutputText(await response.json()).trim();
  if (!answer) throw new Error("The Anthropic search response was empty.");
  return answer;
}

export function partialReplacement(accumulated) {
  const key = accumulated.indexOf('"replacement"');
  if (key === -1) return null;
  const colon = accumulated.indexOf(":", key + '"replacement"'.length);
  if (colon === -1) return null;
  let index = colon + 1;
  while (index < accumulated.length && /\s/.test(accumulated[index])) index += 1;
  if (accumulated[index] !== '"') return null;

  let out = "";
  index += 1;
  while (index < accumulated.length) {
    const character = accumulated[index];
    if (character === "\\") {
      const escape = accumulated[index + 1];
      if (escape === undefined) return out;
      if (escape === "u") {
        const hex = accumulated.slice(index + 2, index + 6);
        if (hex.length < 4) return out;
        out += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
      const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }[escape];
      out += simple ?? escape;
      index += 2;
      continue;
    }
    if (character === '"') return out;
    out += character;
    index += 1;
  }
  return out;
}

export async function rewriteWithAnthropicStream({
  text,
  context,
  apiKey,
  model,
  systemPrompt = CORPORATE_SYSTEM_PROMPT,
  policyVersion = PERSONAS.corporate.version,
  fetchImpl = fetch,
  onPartial
}) {
  logLlmRequestIfEnabled({ provider: "anthropic", model, text });
  const inputText = formatRewriteInput(text, context?.conversation);
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: requestBody({ model, systemPrompt, inputText, stream: true })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Anthropic request failed (${response.status}): ${detail}`);
  }

  let accumulated = "";
  let lastSent = null;
  let buffered = "";
  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch (error) {
        console.error("[anthropic-stream] unparseable SSE data line", { message: error.message, line: line.slice(0, 120) });
        continue;
      }
      const piece = event?.delta?.text;
      if (typeof piece !== "string" || piece.length === 0) continue;
      accumulated += piece;
      if (!onPartial) continue;
      const preview = partialReplacement(accumulated);
      if (preview !== null && preview !== lastSent) {
        lastSent = preview;
        onPartial(preview);
      }
    }
  }

  if (!accumulated) throw new Error("The Claude stream did not contain output text.");
  return normalizeModelResult(parseJsonText(accumulated), text, "anthropic", policyVersion);
}
