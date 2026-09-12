import { createHmac, timingSafeEqual } from "node:crypto";

function signatureFor(url, params, authToken) {
  const values = [...params.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const payload = `${url}${values.map(([key, value]) => `${key}${value}`).join("")}`;
  return createHmac("sha1", authToken).update(payload).digest("base64");
}

export function verifyTwilioSignature({ url, params, signature, authToken } = {}) {
  if (typeof url !== "string" || !(params instanceof URLSearchParams) || typeof signature !== "string" || !authToken) return false;
  const expected = Buffer.from(signatureFor(url, params, authToken));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function twilioFormParams(form) {
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) if (typeof value === "string") params.append(key, value);
  return params;
}

export function verifyBearerToken(request, expectedToken) {
  if (!expectedToken) return false;
  const provided = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
