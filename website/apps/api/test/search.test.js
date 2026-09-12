import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/app.js";
import { searchExa } from "../src/exa.js";
import { answerWithOpenAI } from "../src/openai.js";

test("web search answers with the configured EmapthyAi voice and keeps citations", async () => {
  let searchRequest;
  let answerRequest;
  const handler = createHandler(
    {
      NODE_ENV: "test",
      EXA_API_KEY: "exa-key",
      OPENAI_API_KEY: "openai-key",
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5-nano"
    },
    {
      exaSearch: async (options) => {
        searchRequest = options;
        return {
          answer: "raw Exa snippets",
          citations: [{ title: "Exa", url: "https://exa.ai", snippet: "A relevant result." }]
        };
      },
      answerSearch: async (options) => {
        answerRequest = options;
        return "Here is the short answer.";
      }
    }
  );

  const response = await handler(new Request("https://example.test/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "What is Exa?" })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    query: "What is Exa?",
    answer: "Here is the short answer.",
    citations: [{ title: "Exa", url: "https://exa.ai", snippet: "A relevant result." }],
    provider: "openai"
  });
  assert.equal(searchRequest.query, "What is Exa?");
  assert.equal(searchRequest.apiKey, "exa-key");
  assert.equal(answerRequest.query, "What is Exa?");
  assert.deepEqual(answerRequest.sources, [{ title: "Exa", url: "https://exa.ai", snippet: "A relevant result." }]);
});

test("web search reports missing Exa configuration", async () => {
  let answerCalled = false;
  const handler = createHandler(
    { NODE_ENV: "test", OPENAI_API_KEY: "openai-key", LLM_PROVIDER: "openai" },
    { answerSearch: async () => { answerCalled = true; return "should not run"; } }
  );

  const response = await handler(new Request("https://example.test/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "What is Exa?" })
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "search_not_configured",
    message: "Configure EXA_API_KEY on the server."
  });
  assert.equal(answerCalled, false);
});

test("web search rejects an empty query", async () => {
  const handler = createHandler({ NODE_ENV: "test", EXA_API_KEY: "exa-key" });
  const response = await handler(new Request("https://example.test/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "  " })
  }));

  assert.equal(response.status, 400);
});

test("OpenAI search answering sends the query and source context", async () => {
  let request;
  const result = await answerWithOpenAI({
    query: "What is Exa?",
    sources: [{ title: "Exa", url: "https://exa.ai", snippet: "An AI search engine." }],
    apiKey: "openai-key",
    model: "gpt-5-nano",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ output_text: "Exa is an AI search engine." });
    }
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "gpt-5-nano");
  assert.equal(body.store, false);
  assert.equal(body.input[1].role, "user");
  assert.match(body.input[1].content, /What is Exa\?/);
  assert.match(body.input[1].content, /https:\/\/exa\.ai/);
  assert.equal(result, "Exa is an AI search engine.");
});

test("Exa search requests page text and normalizes safe citations", async () => {
  let request;
  const result = await searchExa({
    query: "What is Exa?",
    apiKey: "exa-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ results: [
        { title: "Exa", url: "https://exa.ai", text: "An AI search engine." },
        { title: "Ignored", url: "http://unsafe.example", text: "Not returned." }
      ] });
    }
  });

  assert.equal(request.url, "https://api.exa.ai/search");
  assert.deepEqual(JSON.parse(request.options.body), {
    query: "What is Exa?",
    contents: { text: true }
  });
  assert.deepEqual(result.citations, [{ title: "Exa", url: "https://exa.ai", snippet: "An AI search engine." }]);
});

test("incoming translation preserves the existing Exa result envelope", async () => {
  const citation = { title: "Exa", url: "https://exa.ai", snippet: "A relevant result." };
  const handler = createHandler(
    { NODE_ENV: "test", EXA_API_KEY: "exa-key" },
    {
      translateIncoming: async () => ({ translation: "Translated text." }),
      exaSearch: async () => ({ answer: "ignored", citations: [citation] })
    }
  );
  const response = await handler(new Request("https://example.test/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Incoming text", direction: "incoming" })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.citations, { answer: "ignored", citations: [citation] });
});
