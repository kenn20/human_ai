import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/app.js";
import { synthesizeSpeechWithOpenAI } from "../src/openai.js";

const handler = createHandler({ NODE_ENV: "test" });

test("voice relay returns the uploaded audio and corporate persona", async () => {
  const input = new Uint8Array([0, 1, 2, 250, 255]);
  const form = new FormData();
  form.set("distinctId", "0123456789abcdef0123456789abcdef");
  form.set("persona", "corporate");
  form.set("audio", new File([input], "voice.m4a", { type: "audio/mp4" }));

  const response = await handler(new Request("https://example.test/v1/voice/relay", { method: "POST", body: form }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.persona, "corporate");
  assert.equal(body.audioContentType, "audio/mp4");
  assert.deepEqual([...Buffer.from(body.audio, "base64")], [...input]);
});

test("voice relay rejects a non-corporate persona", async () => {
  const form = new FormData();
  form.set("distinctId", "0123456789abcdef0123456789abcdef");
  form.set("persona", "empathetic");
  form.set("audio", new File([new Uint8Array([1])], "voice.m4a", { type: "audio/mp4" }));

  const response = await handler(new Request("https://example.test/v1/voice/relay", { method: "POST", body: form }));
  assert.equal(response.status, 400);
});

test("translation defaults to OpenAI when ttsProvider is omitted", async () => {
  const input = new Uint8Array([73, 68, 51, 4]);
  let rewriteRequest;
  let synthesisRequest;
  const voiceHandler = createHandler(
    { OPENAI_API_KEY: "test-key", TTS_PROVIDER: "elevenlabs", OPENAI_TTS_MODEL: "gpt-4o-mini-tts", OPENAI_TTS_VOICE: "coral", NODE_ENV: "test" },
    {
      translateRewrite: async (options) => {
        rewriteRequest = options;
        return { replacement: "Please read this aloud." };
      },
      synthesizeSpeech: async (options) => {
        synthesisRequest = options;
        return { audio: input.buffer, contentType: "audio/mpeg" };
      }
    }
  );

  const response = await voiceHandler(new Request("https://example.test/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Read this", direction: "outgoing", persona: "corporate", tone: "Warm and reassuring" })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.translation, "Please read this aloud.");
  assert.equal(body.audio, Buffer.from(input).toString("base64"));
  assert.equal(body.audioContentType, "audio/mpeg");
  assert.equal(rewriteRequest.resolvedPersona.id, "corporate");
  assert.equal(synthesisRequest.text, "Please read this aloud.");
  assert.equal(synthesisRequest.tone, "Warm and reassuring");
  assert.equal(synthesisRequest.voice, "coral");
  assert.equal(synthesisRequest.model, "gpt-4o-mini-tts");
});

test("translation returns ElevenLabs audio when selected at runtime", async () => {
  const input = new Uint8Array([73, 68, 51, 5]);
  let synthesisRequest;
  const voiceHandler = createHandler(
    {
      OPENAI_API_KEY: "test-key",
      TTS_PROVIDER: "openai",
      ELEVENLABS_API_KEY: "eleven-key",
      ELEVENLABS_VOICE_ID: "voice_123",
      ELEVENLABS_MODEL: "eleven_multilingual_v2",
      NODE_ENV: "test"
    },
    {
      translateRewrite: async () => ({ replacement: "Please read this aloud." }),
      synthesizeElevenLabsSpeech: async (options) => {
        synthesisRequest = options;
        return { audio: input.buffer, contentType: "audio/mpeg" };
      }
    }
  );

  const response = await voiceHandler(new Request("https://example.test/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Read this", direction: "outgoing", persona: "corporate", tone: "Warm", ttsProvider: "elevenlabs" })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.audio, Buffer.from(input).toString("base64"));
  assert.equal(body.audioContentType, "audio/mpeg");
  assert.equal(synthesisRequest.text, "Please read this aloud.");
  assert.equal(synthesisRequest.voiceId, "voice_123");
  assert.equal(synthesisRequest.apiKey, "eleven-key");
  assert.equal(synthesisRequest.model, "eleven_multilingual_v2");
});

test("translation rejects an invalid runtime TTS provider", async () => {
  const response = await handler(new Request("https://example.test/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Read this", direction: "incoming", tone: "Warm", ttsProvider: "unknown" })
  }));

  assert.equal(response.status, 400);
});

test("OpenAI speech sends tone instructions and returns audio", async () => {
  const input = new Uint8Array([73, 68, 51, 4]);
  let request;

  const speech = await synthesizeSpeechWithOpenAI({
    text: "Read this aloud",
    tone: "Calm and concise",
    voice: "coral",
    model: "gpt-4o-mini-tts",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(input, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
  });

  assert.equal(request.url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(JSON.parse(request.options.body), {
    model: "gpt-4o-mini-tts",
    input: "Read this aloud",
    voice: "coral",
    instructions: "Calm and concise"
  });
  assert.equal(speech.contentType, "audio/mpeg");
  assert.deepEqual([...new Uint8Array(speech.audio)], [...input]);
});

test("translation rejects an empty tone", async () => {
  const response = await handler(new Request("https://example.test/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Read this", direction: "outgoing", tone: "" })
  }));

  assert.equal(response.status, 400);
});
