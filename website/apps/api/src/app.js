import { validateRewriteRequest } from "./policy.js";
import { answerWithOpenAI, rewriteWithOpenAI, synthesizeSpeechWithOpenAI } from "./openai.js";
import { answerWithAnthropic, rewriteWithAnthropic, rewriteWithAnthropicStream } from "./anthropic.js";
import { answerWithClaudeCode, rewriteWithClaudeCode } from "./claude-code.js";
import { searchExa, ExaProviderError } from "./exa.js";
import { createVoice, registerTwilioCall as registerTwilioCallWithElevenLabs, startTwilioCall as startTwilioCallWithElevenLabs, synthesizeSpeech as synthesizeSpeechWithElevenLabs, ElevenLabsProviderError } from "./elevenlabs.js";
import { twilioFormParams, verifyBearerToken, verifyTwilioSignature } from "./twilio.js";
import { PERSONAS, personaOptions, resolvePersona } from "./personas.js";
import {
  DurableConfigError,
  executeRewrite
} from "./executor.js";
import { InvariantError } from "./invariants.js";
import { parseEncryptionKey } from "./crypto.js";
import { AccountAuthError, verifyAccountToken } from "./account-auth.js";
import { validateDeviceBinding } from "./account-devices.js";
import {
  captureInstallEvent as captureInstallEventWithPostHog,
  enqueueInstallEvent,
  validateInstallEvent
} from "./install-telemetry.js";
import {
  captureProductEvent as captureProductEventWithPostHog,
  CONVERSATION_CONTEXT_FLAG_KEY,
  enqueueProductEvent,
  evaluateEmpathyAccess,
  evaluateFeatureFlag,
  isValidDistinctId,
  validateProductEvent
} from "./product-telemetry.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function xml(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8", ...extraHeaders }
  });
}

// Every origin the extension actually runs on must stay allowed no matter how
// a deployment configures ALLOWED_ORIGINS: that variable adds extra origins,
// it never removes a supported product surface.
const PRODUCT_ORIGINS = ["https://app.slack.com", "https://chat.google.com"];
const DEVELOPMENT_ORIGIN = "http://localhost:3000";

function allowedOrigins(env) {
  const configured = (env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const origins = new Set([...PRODUCT_ORIGINS, ...configured]);
  if (env.NODE_ENV !== "production") origins.add(DEVELOPMENT_ORIGIN);
  return origins;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = allowedOrigins(env);
  const developmentExtension = env.NODE_ENV !== "production" && origin.startsWith("chrome-extension://");
  if (!allowed.has(origin) && !developmentExtension) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin"
  };
}

export function selectProvider(env) {
  return env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "claude-code");
}

export function providerModel(provider, env) {
  if (provider === "anthropic") return env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  if (provider === "openai") return env.OPENAI_MODEL ?? "gpt-5-nano";
  return env.CLAUDE_CODE_MODEL ?? "sonnet";
}

export function defaultRewrite(provider) {
  if (provider === "anthropic") return rewriteWithAnthropic;
  if (provider === "openai") return rewriteWithOpenAI;
  return rewriteWithClaudeCode;
}

export function defaultSearchAnswer(provider) {
  if (provider === "anthropic") return answerWithAnthropic;
  if (provider === "openai") return answerWithOpenAI;
  return answerWithClaudeCode;
}

export function streamingRewrite(provider) {
  if (provider === "anthropic") return rewriteWithAnthropicStream;
  return defaultRewrite(provider);
}

function streamRewriteResponse({ runRewrite, args, cors, onSucceeded }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const result = await runRewrite({
          ...args,
          onPartial: (replacement) => send("partial", { replacement }),
          revokeUnvalidatedPreview: () => send("revoke", {})
        });
        send("done", result);
        if (onSucceeded) {
          try {
            await onSucceeded();
          } catch (error) {
            console.error("[rewrite-stream] telemetry failed after successful rewrite", { message: error.message });
          }
        }
      } catch (error) {
        console.error("[rewrite-stream] rewrite failed", { name: error.name, code: error.code, message: error.message });
        send("error", { error: error.code ?? "rewrite_failed", message: "Rewrite failed." });
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" }
  });
}

function resolveEncryptionKey(env, dependencies) {
  if (dependencies.encryptionKey) return dependencies.encryptionKey;
  if (!env.EMPATHY_RUN_ENCRYPTION_KEY) return null;
  return parseEncryptionKey(env.EMPATHY_RUN_ENCRYPTION_KEY);
}

export function createHandler(env = process.env, dependencies = {}) {
  const rewrite = dependencies.rewrite;
  const runRewrite = dependencies.executeRewrite ?? executeRewrite;
  const store = dependencies.store ?? null;
  const socialStore = dependencies.socialStore ?? null;
  const accountDeviceStore = dependencies.accountDeviceStore ?? null;
  const accountFor = dependencies.verifyAccountToken ?? ((request) => verifyAccountToken(request, env, dependencies.accountAuthFetch ?? fetch));
  const captureInstallEvent = dependencies.captureInstallEvent ?? ((event) => captureInstallEventWithPostHog({
    ...event,
    projectToken: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST
  }));
  const captureProductEvent = dependencies.captureProductEvent ?? ((event) => captureProductEventWithPostHog({
    ...event,
    projectToken: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST
  }));
  const exaSearch = dependencies.exaSearch ?? searchExa;
  const synthesizeOpenAI = dependencies.synthesizeSpeech ?? synthesizeSpeechWithOpenAI;
  const synthesizeElevenLabs = dependencies.synthesizeElevenLabsSpeech ?? synthesizeSpeechWithElevenLabs;
  const registerTwilioCall = dependencies.registerTwilioCall ?? registerTwilioCallWithElevenLabs;
  const startTwilioCall = dependencies.startTwilioCall ?? startTwilioCallWithElevenLabs;
  const legacyEmpathyEvaluator = !accountDeviceStore && env.NODE_ENV === "test";
  const empathyAccessFor = dependencies.evaluateEmpathyAccess ?? ((accountDistinctId) => evaluateEmpathyAccess({
    distinctId: accountDistinctId,
    projectToken: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST,
    ...(dependencies.flagFetch ? { fetchImpl: dependencies.flagFetch } : {})
  }));
  const conversationContextAccessFor = dependencies.evaluateConversationContextAccess ?? ((distinctId) => evaluateFeatureFlag({
    flagKey: CONVERSATION_CONTEXT_FLAG_KEY,
    projectToken: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST,
    ...(dependencies.flagFetch ? { fetchImpl: dependencies.flagFetch } : {})
  }));
  // Persona availability has one server-owned decision path. The same
  // evaluator drives both the persona menu and rewrite authorization; clients
  // never get to unlock a persona locally.
  async function accountIdentityFor(request, distinctId) {
    const account = await accountFor(request);
    if (legacyEmpathyEvaluator) return distinctId;
    if (!account?.accountId || !accountDeviceStore) return null;
    try {
      const bound = await accountDeviceStore.accountDistinctIdForDevice(distinctId);
      return bound === account.accountId ? bound : null;
    } catch {
      return null;
    }
  }
  async function personaConfigFor(request, distinctId) {
    const accountDistinctId = await accountIdentityFor(request, distinctId);
    const access = accountDistinctId ? await empathyAccessFor(accountDistinctId) : "locked";
    const variant = (access === "available" || access === true) ? "empathy_available" : "empathy_locked";
    return { access, variant, personas: personaOptions(variant) };
  }

  async function authorizePersona(request, distinctId, persona) {
    if (persona === undefined || persona === "corporate") return null;
    if (!isValidDistinctId(distinctId)) return { status: 400, error: "invalid_request", message: "distinctId is required for gated persona requests." };
    const config = await personaConfigFor(request, distinctId);
    const selected = config.personas.find((option) => option.id === persona);
    if (!selected || !selected.available) return { status: 403, error: "persona_locked", message: "This persona is not available yet." };
    return null;
  }
  // Product telemetry is durable-first like install telemetry, and always
  // best-effort: a delivery failure is logged, never surfaced to the client.
  async function recordProductEvent(event) {
    if (socialStore) {
      try {
        await enqueueProductEvent(socialStore, event);
        return;
      } catch (error) {
        console.error("[product-telemetry] outbox enqueue failed", {
          name: event.name,
          message: error.message
        });
      }
    }
    try {
      await captureProductEvent(event);
    } catch (error) {
      console.error("[product-telemetry] capture failed", {
        name: event.name,
        message: error.message
      });
    }
  }
  let encryptionKey = null;
  try {
    encryptionKey = resolveEncryptionKey(env, dependencies);
  } catch {
    encryptionKey = null;
  }


  return async function handle(request) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const isTelephonyOutbound = request.method === "POST" && url.pathname === "/v1/telephony/twilio/outbound";
    const hasBearer = request.headers.has("authorization") && !isTelephonyOutbound;
    let accountAuthError = null;
    if (hasBearer) {
      try { await accountFor(request); }
      catch (error) { if (error instanceof AccountAuthError) accountAuthError = error; else throw error; }
    }
    const unauthorized = () => json(401, { error: "account_auth_required", message: "A valid account session is required." }, { ...cors, "cache-control": "no-store" });
    if (accountAuthError && url.pathname !== "/health") return unauthorized();

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, policyVersion: PERSONAS.corporate.version }, cors);
    }
    if (request.method === "POST" && url.pathname === "/v1/install-events") {
      let installEvent;
      try {
        installEvent = await request.json();
      } catch {
        return json(400, { error: "invalid_json" }, cors);
      }
      if (!validateInstallEvent(installEvent)) {
        return json(400, { error: "invalid_install_event" }, cors);
      }
      // Durable-first: with a database, the event lands in the social outbox
      // and the cron delivers it with retries. The direct capture is only a
      // fallback for deployments without a database.
      if (socialStore) {
        try {
          await enqueueInstallEvent(socialStore, installEvent);
        } catch (error) {
          console.error("[install-telemetry] outbox enqueue failed", {
            stage: installEvent.stage,
            message: error.message
          });
          try {
            await captureInstallEvent(installEvent);
          } catch (captureError) {
            console.error("[install-telemetry] capture failed", {
              stage: installEvent.stage,
              message: captureError.message
            });
          }
        }
      } else {
        try {
          await captureInstallEvent(installEvent);
        } catch (error) {
          console.error("[install-telemetry] capture failed", {
            stage: installEvent.stage,
            message: error.message
          });
        }
      }
      return json(202, { ok: true }, { ...cors, "cache-control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/v1/events") {
      let productEvent;
      try {
        productEvent = await request.json();
      } catch {
        return json(400, { error: "invalid_json" }, cors);
      }
      // Invalid events must never reach PostHog: validation runs before any
      // enqueue/capture attempt.
      if (!validateProductEvent(productEvent)) {
        return json(400, { error: "invalid_event" }, cors);
      }
      await recordProductEvent(productEvent);
      return json(202, { ok: true }, { ...cors, "cache-control": "no-store" });
    }
    if (request.method === "POST" && url.pathname === "/v1/account/devices") {
      let binding;
      try { binding = await request.json(); } catch { return json(400, { error: "invalid_json" }, cors); }
      if (!validateDeviceBinding(binding)) return json(400, { error: "invalid_request", message: "distinctId is required." }, cors);
      let account;
      try { account = await accountFor(request); } catch { return unauthorized(); }
      if (!account?.accountId) return unauthorized();
      if (!accountDeviceStore) return json(503, { error: "durable_not_configured", message: "Account device storage is not configured." }, cors);
      try {
        const bound = await accountDeviceStore.bindDevice(binding.distinctId, account.accountId);
        if (!bound) return json(409, { error: "device_already_bound", message: "This device is already bound to another account." }, cors);
      } catch {
        return json(503, { error: "durable_not_configured", message: "Account device storage is unavailable." }, cors);
      }
      return json(200, { ok: true }, { ...cors, "cache-control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/v1/personas") {
      let personaRequest;
      try {
        personaRequest = await request.json();
      } catch {
        return json(400, { error: "invalid_json" }, cors);
      }
      if (!personaRequest || typeof personaRequest !== "object" || Array.isArray(personaRequest)
        || !isValidDistinctId(personaRequest.distinctId)) {
        return json(400, { error: "invalid_request", message: "distinctId is required." }, cors);
      }
      const config = await personaConfigFor(request, personaRequest.distinctId);
      return json(200, { personas: config.personas, variant: config.variant }, { ...cors, "cache-control": "no-store" });
    }
    if (request.method === "POST" && url.pathname === "/v1/capabilities") {
      let capabilityRequest;
      try {
        capabilityRequest = await request.json();
      } catch {
        return json(400, { error: "invalid_json" }, cors);
      }
      if (!capabilityRequest || typeof capabilityRequest !== "object" || Array.isArray(capabilityRequest)
        || !isValidDistinctId(capabilityRequest.distinctId)) {
        return json(400, { error: "invalid_request", message: "distinctId is required." }, cors);
      }
      const access = await conversationContextAccessFor(capabilityRequest.distinctId);
      return json(200, {
        conversationContext: access === "available" ? "available" : "locked"
      }, { ...cors, "cache-control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/v1/telephony/twilio/incoming") {
      let form;
      try { form = await request.formData(); } catch { return xml(400, "<Response><Say>Invalid request.</Say></Response>"); }
      const params = twilioFormParams(form);
      if (!env.TWILIO_AUTH_TOKEN) return json(503, { error: "telephony_not_configured", message: "TWILIO_AUTH_TOKEN is not configured." }, cors);
      if (!verifyTwilioSignature({ url: env.TWILIO_WEBHOOK_URL ?? request.url, params, signature: request.headers.get("x-twilio-signature"), authToken: env.TWILIO_AUTH_TOKEN })) {
        return json(403, { error: "invalid_twilio_signature", message: "Twilio signature verification failed." }, cors);
      }
      const fromNumber = params.get("From");
      const toNumber = params.get("To");
      const callSid = params.get("CallSid");
      if (!fromNumber || !toNumber) return xml(400, "<Response><Say>Missing phone number.</Say></Response>");
      if (!env.ELEVENLABS_AGENT_ID) return json(503, { error: "telephony_not_configured", message: "ELEVENLABS_AGENT_ID is not configured." }, cors);
      try {
        const twiml = await registerTwilioCall({
          agentId: env.ELEVENLABS_AGENT_ID,
          fromNumber,
          toNumber,
          direction: "inbound",
          apiKey: env.ELEVENLABS_API_KEY,
          clientData: callSid ? { dynamic_variables: { call_sid: callSid } } : undefined,
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
        });
        return xml(200, twiml);
      } catch (error) {
        if (error instanceof TypeError) return xml(400, "<Response><Say>Invalid call.</Say></Response>");
        if (error instanceof ElevenLabsProviderError && error.status === 503) return json(503, { error: "telephony_not_configured", message: "Configure ElevenLabs telephony on the server." }, cors);
        return json(502, { error: "telephony_provider_failed", message: "Telephony provider failed." }, cors);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/telephony/twilio/outbound") {
      if (!env.TELEPHONY_OUTBOUND_TOKEN) return json(503, { error: "telephony_not_configured", message: "TELEPHONY_OUTBOUND_TOKEN is not configured." }, cors);
      if (!verifyBearerToken(request, env.TELEPHONY_OUTBOUND_TOKEN)) return json(401, { error: "telephony_auth_required", message: "A valid telephony token is required." }, cors);
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }, cors); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.toNumber !== "string") return json(400, { error: "invalid_request", message: "toNumber is required." }, cors);
      if (body.callRecordingEnabled !== undefined && typeof body.callRecordingEnabled !== "boolean") return json(400, { error: "invalid_request", message: "callRecordingEnabled must be boolean." }, cors);
      if (body.clientData !== undefined && (!body.clientData || typeof body.clientData !== "object" || Array.isArray(body.clientData))) return json(400, { error: "invalid_request", message: "clientData must be an object." }, cors);
      if (!env.ELEVENLABS_AGENT_ID || !env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) return json(503, { error: "telephony_not_configured", message: "ElevenLabs agent phone configuration is missing." }, cors);
      try {
        const call = await startTwilioCall({
          agentId: env.ELEVENLABS_AGENT_ID,
          agentPhoneNumberId: env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
          toNumber: body.toNumber,
          callRecordingEnabled: body.callRecordingEnabled,
          clientData: body.clientData,
          apiKey: env.ELEVENLABS_API_KEY,
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
        });
        return json(200, call, { ...cors, "cache-control": "no-store" });
      } catch (error) {
        if (error instanceof TypeError) return json(400, { error: "invalid_request", message: error.message }, cors);
        if (error instanceof ElevenLabsProviderError && error.status === 503) return json(503, { error: "telephony_not_configured", message: "Configure ElevenLabs telephony on the server." }, cors);
        return json(502, { error: "telephony_provider_failed", message: "Telephony provider failed." }, cors);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/voice/sample") {
      let form;
      try { form = await request.formData(); } catch { return json(400, { error: "invalid_multipart" }, cors); }
      const distinctId = form.get("distinctId"); const name = form.get("name"); const audio = form.get("audio");
      if (!isValidDistinctId(distinctId) || typeof name !== "string" || !name.trim() || !(audio instanceof File)) return json(400, { error: "invalid_request", message: "distinctId, name, and audio are required." }, cors);
      try {
        const voiceId = await (dependencies.createVoice ?? createVoice)({ name, audio, mimeType: audio.type, apiKey: env.ELEVENLABS_API_KEY, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) });
        return json(200, { voiceId }, { ...cors, "cache-control": "no-store" });
      } catch (error) {
        if (error instanceof TypeError) return json(400, { error: "invalid_request", message: error.message }, cors);
        if (error instanceof ElevenLabsProviderError && error.status === 503) return json(503, { error: "voice_not_configured", message: "Configure ElevenLabs on the server." }, cors);
        if (error instanceof ElevenLabsProviderError && (error.status === 401 || error.status === 403)) return json(502, { error: "voice_not_available", message: "Voice cloning unavailable for this account." }, cors);
        return json(502, { error: "voice_provider_failed", message: "Voice provider failed." }, cors);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/voice/relay") {
      let form;
      try { form = await request.formData(); } catch { return json(400, { error: "invalid_multipart" }, cors); }
      const persona = form.get("persona");
      const distinctId = form.get("distinctId");
      const audio = form.get("audio");
      if (persona !== "corporate" || !isValidDistinctId(distinctId) || !(audio instanceof File)) {
        return json(400, { error: "invalid_request", message: "distinctId, corporate persona, and audio are required." }, cors);
      }
      const audioBytes = await audio.arrayBuffer();
      if (audioBytes.byteLength === 0 || audioBytes.byteLength > 15 * 1024 * 1024) {
        return json(400, { error: "invalid_request", message: "audio is empty or too large." }, cors);
      }
      return json(200, {
        persona,
        audio: Buffer.from(audioBytes).toString("base64"),
        audioContentType: audio.type || "application/octet-stream"
      }, { ...cors, "cache-control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/v1/search") {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }, cors); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.query !== "string" || !body.query.trim() || body.query.length > 4000) {
        return json(400, { error: "invalid_request", message: "query is required and must be 4,000 characters or fewer." }, cors);
      }
      if (!env.EXA_API_KEY) return json(503, { error: "search_not_configured", message: "Configure EXA_API_KEY on the server." }, cors);
      const provider = selectProvider(env);
      const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (provider !== "claude-code" && !apiKey) return json(503, { error: "llm_not_configured", message: "Configure the selected provider key on the server." }, cors);
      try {
        const search = await exaSearch({
          query: body.query,
          apiKey: env.EXA_API_KEY,
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
        });
        const answer = await (dependencies.answerSearch ?? defaultSearchAnswer(provider))({
          query: body.query,
          sources: search.citations,
          apiKey,
          model: providerModel(provider, env),
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {})
        });
        return json(200, { query: body.query, answer, citations: search.citations, provider }, { ...cors, "cache-control": "no-store" });
      } catch (error) {
        if (error instanceof ExaProviderError && error.status === 503) return json(503, { error: "search_not_configured", message: error.message }, cors);
        return json(502, { error: "search_failed", message: "Web search failed." }, cors);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/translate") {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }, cors); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 || !["incoming", "outgoing"].includes(body.direction)) return json(400, { error: "invalid_request", message: "text and direction are required." }, cors);
      if (body.tone !== undefined && (typeof body.tone !== "string" || !body.tone.trim() || body.tone.length > 1000)) return json(400, { error: "invalid_request", message: "tone must be a non-empty string." }, cors);
      if (body.voice !== undefined && (typeof body.voice !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.voice))) return json(400, { error: "invalid_request", message: "voice is invalid." }, cors);
      if (body.ttsProvider !== undefined && !["openai", "elevenlabs"].includes(body.ttsProvider)) return json(400, { error: "invalid_request", message: "ttsProvider must be openai or elevenlabs." }, cors);
      if (body.direction === "outgoing" && body.persona !== undefined) {
        const authorizationError = await authorizePersona(request, body.distinctId, body.persona);
        if (authorizationError) return json(authorizationError.status, { error: authorizationError.error, message: authorizationError.message }, cors);
      }
      const direction = body.direction;
      try {
        let translation; let citations = [];
        if (direction === "outgoing") {
          const provider = selectProvider(env); const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
          if (provider !== "claude-code" && !apiKey) return json(503, { error: "llm_not_configured", message: "Configure the selected provider key on the server." }, cors);
          const result = await (dependencies.translateRewrite ?? runRewrite)({ body: { text: body.text, persona: body.persona, customization: body.customization }, resolvedPersona: resolvePersona({ persona: body.persona, customization: body.customization }), rewrite: rewrite ?? defaultRewrite(provider), apiKey, model: providerModel(provider, env), store, encryptionKey });
          translation = result.replacement;
        } else {
          if (dependencies.translateIncoming) translation = (await dependencies.translateIncoming({ text: body.text })).translation;
          else translation = body.text;
          if (env.EXA_API_KEY) citations = await exaSearch({ query: `${body.text} ${translation}`, apiKey: env.EXA_API_KEY, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) });
        }
        const output = { direction, original: body.text, translation, citations };
        if (body.tone) {
          const sharedOptions = { text: translation, ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) };
          const spoken = body.ttsProvider === "elevenlabs"
            ? await synthesizeElevenLabs({ ...sharedOptions, voiceId: body.voice ?? env.ELEVENLABS_VOICE_ID, apiKey: env.ELEVENLABS_API_KEY, model: env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2" })
            : await synthesizeOpenAI({ ...sharedOptions, tone: body.tone, voice: body.voice ?? env.OPENAI_TTS_VOICE ?? "coral", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts" });
          output.audio = Buffer.from(spoken.audio).toString("base64");
          output.audioContentType = spoken.contentType;
        }
        return json(200, output, { ...cors, "cache-control": "no-store" });
      } catch (error) {
        if (error.status === 503) return json(503, { error: "provider_not_configured", message: error.message }, cors);
        return json(502, { error: "translation_failed", message: "Translation failed." }, cors);
      }
    }

    const wantsStream = url.pathname === "/v1/rewrite/stream";
    if (request.method !== "POST" || !(url.pathname === "/v1/rewrite" || wantsStream)) {
      return json(404, { error: "not_found" }, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid_json" }, cors);
    }

    const validationError = validateRewriteRequest(body);
    if (validationError) return json(400, { error: "invalid_request", message: validationError }, cors);

    const iosRequest = body.context?.surface === "ios_keyboard";
    let iosVariant = null;

    // The persona menu and rewrite authorization consume the same
    // server-generated configuration. Local UI state can never unlock one.
    const gatedPersonaRequest = body.persona !== undefined && body.persona !== "corporate";
    if (iosRequest) {
      if (!isValidDistinctId(body.distinctId)) {
        return json(400, { error: "invalid_request", message: "distinctId is required for gated persona requests." }, cors);
      }
      iosVariant = (await personaConfigFor(request, body.distinctId)).variant;
    }
    if (gatedPersonaRequest) {
      const authorizationError = await authorizePersona(request, body.distinctId, body.persona);
      if (authorizationError) return json(authorizationError.status, { error: authorizationError.error, message: authorizationError.message }, cors);
    }
    if (body.context?.conversation !== undefined) {
      if (!isValidDistinctId(body.distinctId)) {
        return json(400, { error: "invalid_request", message: "distinctId is required for conversation context." }, cors);
      }
      const access = await conversationContextAccessFor(body.distinctId);
      if (access !== "available") {
        return json(403, { error: "capability_locked", message: "Conversation context is not available yet." }, cors);
      }
    }

    if (!store || !encryptionKey) {
      return json(503, {
        error: "durable_not_configured",
        message: "Configure DATABASE_URL and EMPATHY_RUN_ENCRYPTION_KEY on the server."
      }, cors);
    }

    // Redaction gate rejects "@", so persona versions ("corporate@v1")
    // travel as "corporate-v1" in telemetry.
    let resolvedPersona = null;
    const iosRewriteProperties = () => ({
      persona: resolvedPersona?.id ?? body.persona ?? "corporate",
      variant: iosVariant,
      ...(resolvedPersona ? { policy_version: resolvedPersona.version.replaceAll("@", "-") } : {})
    });
    try {
      const provider = selectProvider(env);
      const apiKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (provider !== "claude-code" && !apiKey) {
        return json(503, { error: "llm_not_configured", message: "Configure the selected provider key on the server." }, cors);
      }
      resolvedPersona = resolvePersona({
        persona: body.persona,
        customization: body.customization
      });
      if (iosRequest) {
        await recordProductEvent({
          distinctId: body.distinctId,
          name: "rewrite_requested",
          properties: iosRewriteProperties()
        });
      }
      if (wantsStream) {
        return streamRewriteResponse({
          runRewrite,
          args: {
            body,
            resolvedPersona,
            rewrite: rewrite ?? streamingRewrite(provider),
            apiKey,
            model: providerModel(provider, env),
            store,
            encryptionKey,
            ...(dependencies.audit ? { audit: dependencies.audit } : {})
          },
          cors,
          onSucceeded: iosRequest
            ? () => recordProductEvent({ distinctId: body.distinctId, name: "rewrite_succeeded", properties: iosRewriteProperties() })
            : null
        });
      }
      const result = await runRewrite({
        body,
        resolvedPersona,
        rewrite: rewrite ?? defaultRewrite(provider),
        apiKey,
        model: providerModel(provider, env),
        store,
        encryptionKey,
        ...(dependencies.audit ? { audit: dependencies.audit } : {})
      });
      if (iosRequest) {
        await recordProductEvent({
          distinctId: body.distinctId,
          name: "rewrite_succeeded",
          properties: iosRewriteProperties()
        });
      }
      return json(200, result, { ...cors, "cache-control": "no-store" });
    } catch (error) {
      let status = 502;
      let payload = { error: "rewrite_failed", message: "Rewrite failed." };
      if (error instanceof InvariantError && error.code === "inbound_invalid") {
        status = 400;
        payload = { error: "invalid_request", message: error.message };
      } else if (error instanceof DurableConfigError) {
        status = 503;
        payload = { error: "durable_not_configured", message: error.message };
      }
      if (iosRequest) {
        // Bounded error code + HTTP status only; never the message or text.
        await recordProductEvent({
          distinctId: body.distinctId,
          name: "rewrite_failed",
          properties: { ...iosRewriteProperties(), error_code: payload.error, status }
        });
      }
      return json(status, payload, cors);
    }
  };
}
