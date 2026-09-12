const MAX_NAME_LENGTH = 80;
const MAX_TEXT_LENGTH = 4000;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export class ElevenLabsProviderError extends Error {
  constructor(status, message = "ElevenLabs request failed.") {
    super(message);
    this.name = "ElevenLabsProviderError";
    this.status = Number.isInteger(status) ? status : 502;
  }
}

function checkKey(apiKey) {
  if (!apiKey) throw new ElevenLabsProviderError(503, "ElevenLabs is not configured.");
}

function providerFailure(response) {
  if (response.status === 401 || response.status === 403) {
    return new ElevenLabsProviderError(response.status, "Voice cloning unavailable for this account.");
  }
  return new ElevenLabsProviderError(response.status);
}

export async function createVoice({ name, audio, mimeType = "audio/m4a", apiKey, fetchImpl = fetch } = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME_LENGTH) throw new TypeError("name is required and bounded.");
  if (!(audio instanceof Blob) && !(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) throw new TypeError("audio is required.");
  const bytes = audio instanceof Blob ? audio.size : audio.byteLength;
  if (!bytes || bytes > MAX_AUDIO_BYTES) throw new TypeError("audio is empty or too large.");
  checkKey(apiKey);
  const form = new FormData();
  form.append("name", name.trim());
  const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mimeType });
  form.append("files", blob, `sample.${mimeType.split("/")[1] || "audio"}`);
  let response;
  try { response = await fetchImpl("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": apiKey }, body: form }); }
  catch { throw new ElevenLabsProviderError(502); }
  if (!response.ok) throw providerFailure(response);
  const payload = await response.json();
  if (typeof payload.voice_id !== "string" || !payload.voice_id) throw new ElevenLabsProviderError(502);
  return payload.voice_id;
}

export async function synthesizeSpeech({ voiceId = DEFAULT_VOICE_ID, text, apiKey, modelId, model, fetchImpl = fetch } = {}) {
  if (typeof voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) throw new TypeError("voiceId is invalid.");
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) throw new TypeError("text is required and bounded.");
  checkKey(apiKey);
  let response;
  try { response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, { method: "POST", headers: { "xi-api-key": apiKey, accept: "audio/mpeg", "content-type": "application/json" }, body: JSON.stringify({ text: text.trim(), model_id: model ?? modelId ?? "eleven_multilingual_v2" }) }); }
  catch { throw new ElevenLabsProviderError(502); }
  if (!response.ok) throw providerFailure(response);
  return { audio: await response.arrayBuffer(), contentType: response.headers?.get?.("content-type") || "audio/mpeg" };
}

const PHONE_NUMBER = /^\+[1-9]\d{7,14}$/;

function checkPhoneNumber(value, name) {
  if (typeof value !== "string" || !PHONE_NUMBER.test(value)) throw new TypeError(`${name} must be an E.164 phone number.`);
}

function checkAgentId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("agentId is invalid.");
}

async function postTelephony(path, body, apiKey, fetchImpl) {
  checkKey(apiKey);
  let response;
  try {
    response = await fetchImpl(`https://api.elevenlabs.io/v1/convai/twilio/${path}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch { throw new ElevenLabsProviderError(502); }
  if (!response.ok) throw providerFailure(response);
  return response;
}

export async function registerTwilioCall({ agentId, fromNumber, toNumber, direction = "inbound", clientData, apiKey, fetchImpl = fetch } = {}) {
  checkAgentId(agentId);
  checkPhoneNumber(fromNumber, "fromNumber");
  checkPhoneNumber(toNumber, "toNumber");
  if (direction !== "inbound" && direction !== "outbound") throw new TypeError("direction is invalid.");
  const response = await postTelephony("register-call", {
    agent_id: agentId,
    from_number: fromNumber,
    to_number: toNumber,
    direction,
    ...(clientData === undefined ? {} : { conversation_initiation_client_data: clientData })
  }, apiKey, fetchImpl);
  const twiml = await response.text();
  if (!twiml.trim()) throw new ElevenLabsProviderError(502);
  return twiml;
}

export async function startTwilioCall({ agentId, agentPhoneNumberId, toNumber, callRecordingEnabled, clientData, apiKey, fetchImpl = fetch } = {}) {
  checkAgentId(agentId);
  if (typeof agentPhoneNumberId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(agentPhoneNumberId)) throw new TypeError("agentPhoneNumberId is invalid.");
  checkPhoneNumber(toNumber, "toNumber");
  if (callRecordingEnabled !== undefined && typeof callRecordingEnabled !== "boolean") throw new TypeError("callRecordingEnabled must be boolean.");
  const response = await postTelephony("outbound-call", {
    agent_id: agentId,
    agent_phone_number_id: agentPhoneNumberId,
    to_number: toNumber,
    ...(callRecordingEnabled === undefined ? {} : { call_recording_enabled: callRecordingEnabled }),
    ...(clientData === undefined ? {} : { conversation_initiation_client_data: clientData })
  }, apiKey, fetchImpl);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ElevenLabsProviderError(502);
  return payload;
}

export const synthesizeWithElevenLabs = async (options) => (await synthesizeSpeech({ ...options, modelId: options?.model ?? options?.modelId })).audio;
export const ELEVENLABS_LIMITS = { maxNameLength: MAX_NAME_LENGTH, maxTextLength: MAX_TEXT_LENGTH, maxAudioBytes: MAX_AUDIO_BYTES };
