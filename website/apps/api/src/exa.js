const MAX_QUERY_LENGTH = 4000;
const MAX_CITATIONS = 3;
export const EXA_SEARCH_URL = "https://api.exa.ai/search";

export class ExaProviderError extends Error {
  constructor(status, message = "Exa request failed.") {
    super(message);
    this.name = "ExaProviderError";
    this.status = Number.isInteger(status) ? status : 502;
  }
}

export async function searchExa({ query, apiKey, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (typeof query !== "string" || query.trim().length === 0) throw new TypeError("query is required.");
  if (query.length > MAX_QUERY_LENGTH) throw new TypeError("query is too long.");
  if (!apiKey) throw new ExaProviderError(503, "Exa is not configured.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1000), 20000));
  try {
    const response = await fetchImpl(EXA_SEARCH_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: query.trim(), contents: { text: true } }),
      signal: controller.signal
    });
    if (!response.ok) throw new ExaProviderError(response.status, "Exa request failed.");
    const payload = await response.json();
    const citations = (Array.isArray(payload.results) ? payload.results : [])
      .filter((item) => item && typeof item.url === "string" && item.url.length <= 2048 && /^https:\/\//i.test(item.url))
      .slice(0, MAX_CITATIONS)
      .map((item) => ({
        title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
        url: item.url,
        snippet: typeof item.text === "string" ? item.text.slice(0, 1000) : typeof item.snippet === "string" ? item.snippet.slice(0, 1000) : ""
      }));
    return { answer: citations.map((item) => item.snippet).filter(Boolean).join("\n\n"), citations };
  } catch (error) {
    if (error instanceof ExaProviderError) throw error;
    throw new ExaProviderError(502);
  } finally {
    clearTimeout(timer);
  }
}

export const EXA_LIMITS = { maxQueryLength: MAX_QUERY_LENGTH, maxCitations: MAX_CITATIONS };

export const searchWithExa = searchExa;
