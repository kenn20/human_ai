# EmapthyAi MVP

EmapthyAi previews a corporate rewrite before replacing a draft. The MVP contains:

- A policy API backed by the authenticated local Claude Code subscription, Anthropic Claude API, or OpenAI API.
- An Exa-powered web search endpoint that grounds concise answers in live web results while keeping the answer in EmapthyAi's voice.
- A Chrome extension for Slack Web and Google Chat that detects the active composer and extracts conversation IDs from the page URL.
- An Android input method that reviews the active draft and sees the owning app package.

It does **not** send Slack messages, capture audio, embed a model-provider key in a client, or silently rewrite with hard-coded word lists. Drafts are stored briefly in **our Postgres only** as AES-GCM ciphertext and hard-deleted after 10 minutes.

## 1. Run the API

Node 22 or later and a local Postgres database are required.

```sh
cp .env.example .env
# Set DATABASE_URL and EMPATHY_RUN_ENCRYPTION_KEY (32-byte base64 or hex) in the shell.
npm test
npm run start:api
```

The current server reads environment variables from the shell; `.env` is a template, not automatically loaded. Required for every start: `DATABASE_URL`, `EMPATHY_RUN_ENCRYPTION_KEY`. By default, the local server uses the authenticated Claude Code CLI subscription:

```sh
export DATABASE_URL="postgres://localhost:5432/emapthyai"
export EMPATHY_RUN_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
export HOST="127.0.0.1"
export PORT="8787"
export LLM_PROVIDER="claude-code"
export CLAUDE_CODE_MODEL="sonnet"
npm run start:api
```

For a physical iPhone on the same Wi-Fi network, set `HOST=0.0.0.0`, start
the server, and enter the computer's LAN URL (for example
`http://192.168.1.42:8787`) in EmapthyAi's **Debug server settings**. Keep the
phone and computer on the same network and allow the port through the
computer's firewall if prompted.

Anthropic API is also supported with `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`; OpenAI with `LLM_PROVIDER=openai` and `OPENAI_API_KEY`. There is no regex fallback. The rewrite endpoint requires no authentication — the app is free, so `/v1/rewrite` is public.

Check the server:

```sh
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/rewrite \
  -H 'content-type: application/json' \
  -d '{"text":"this makes no sense, this is stupid","context":{"app":"slack"}}'
```

Adding `tone` to `/v1/translate` returns the persona-shaped text as
base64-encoded audio. The optional `ttsProvider` request field selects `openai`
or `elevenlabs` at runtime; omitting it uses OpenAI. `voice` is optional and
defaults to `OPENAI_TTS_VOICE` for OpenAI or `ELEVENLABS_VOICE_ID` for
ElevenLabs. The response adds `audio` and `audioContentType` fields.

```sh
curl -X POST http://127.0.0.1:8787/v1/translate \
  -H 'content-type: application/json' \
  -d '{"text":"Hello from EmapthyAi.","direction":"outgoing","persona":"corporate","tone":"Warm and confident","ttsProvider":"elevenlabs"}'
```

### Live phone calls

The API can hand a Twilio call to an ElevenLabs Conversational AI agent. In
ElevenLabs, create an agent, connect/import a Twilio phone number, and copy the
agent ID and phone-number ID into `.env`. Set `TWILIO_AUTH_TOKEN` and configure
the Twilio number's **A call comes in** webhook as:

```
https://YOUR_DOMAIN/v1/telephony/twilio/incoming
```

Use `POST /v1/telephony/twilio/incoming` only as a Twilio webhook. The endpoint
verifies `X-Twilio-Signature`, calls ElevenLabs' `register-call` API, and returns
the TwiML that keeps the caller connected to the agent. `TWILIO_WEBHOOK_URL`
must exactly match the public URL Twilio signs, including HTTPS and any path.

For a server-initiated call, keep `TELEPHONY_OUTBOUND_TOKEN` private and call:

```sh
curl -X POST https://YOUR_DOMAIN/v1/telephony/twilio/outbound \
  -H 'authorization: Bearer YOUR_TELEPHONY_OUTBOUND_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"toNumber":"+14155550100"}'
```

Phone numbers must use E.164 format (`+` followed by country code and number).
Twilio and ElevenLabs still apply their own account, consent, recording, and
phone-number restrictions.

The web search endpoint keeps both provider keys on the server. It searches with
Exa, sends the returned source extracts to the configured LLM as untrusted
context, and returns the synthesized answer with citations.

```sh
curl -X POST http://127.0.0.1:8787/v1/search \
  -H 'content-type: application/json' \
  -d '{"query":"What changed in the latest OpenAI API release?"}'
```

Set EXA_API_KEY and configure the selected LLM provider before calling it.

## 2. Install the browser extension

The hosted installer always downloads the Chrome developer extension to
`~/.emapthyai/chrome-extension`, reveals that folder in Finder, and opens
`chrome://extensions`. With Developer mode already enabled, the only remaining
user action is one **Load unpacked** click. Chrome does not allow a local
unpacked extension to be enabled with zero confirmation.

Open `https://app.slack.com` or `https://chat.google.com`, type or dictate a draft, then select **Corporate rewrite**.
Review the suggestion and choose **Accept rewrite** or **Keep original**. The red
**Keep original** action leaves the draft unsent.

The extension also intercepts plain `Enter` in the composer on both surfaces. `Shift+Enter` remains Slack's newline shortcut. Slack's green Send button is disabled while the review is pending. Accepting the rewrite sends it. Rewrite failures never send the original draft.

There is also a YOLO mode (auto-send a successful rewrite with no preview) behind a `YOLO_MODE_AVAILABLE` flag in `apps/chrome-extension/ui.js`, hardcoded off. It exists for internal testing only and must never be flipped on in a build users install — see `docs/architecture.md`.

## 3. Build and enable Android

The Android project is under `apps/android` and targets API 35.

```sh
cd apps/android
./gradlew assembleDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk`, open **EmapthyAi Keyboard**, save the API URL, and select **Enable keyboard**. Android emulators use `http://10.0.2.2:8787` to reach the host machine.

In Slack:

1. Type or dictate using the normal keyboard.
2. Leave the cursor at the end of the draft.
3. Switch to **EmapthyAi** and select **Review draft**.
4. Choose **Accept rewrite** or **Keep original**.

Cleartext HTTP is enabled only to support the local development server. A production build must use HTTPS and remove `android:usesCleartextTraffic="true"`.

## 4. X human-reply queue (ships disabled)

A read-only X scanner turns allowlisted creators' posts into EmapthyAi reply
drafts. A person opens a prefilled X composer and presses Post; nothing is
published automatically. The app holds **read-only** X credentials and has no
code path that posts to or deletes from X.

- Operator portal: `/portal` (Google sign-in, restricted to an explicit
  allowlist of `@emapthyai.ai` accounts).
- Scheduled scanning only happens when the campaign is enabled, fully
  configured, and inside the 9am–9pm Pacific window. Outbox delivery, queue
  expiry, abandoned-job recovery, and the 30-day text purge run on each scan.

The campaign defaults to **disabled** and refuses to be enabled until all of
these are set (see `.env.example`):

```
X_READ_BEARER_TOKEN          read-only X app bearer token
X_ACCOUNT_USER_ID            the numeric X user ID replies are posted from
GOOGLE_OAUTH_CLIENT_ID       Google Identity client ID for the portal
SOCIAL_PORTAL_ALLOWED_EMAILS comma-separated @emapthyai.ai operators
```

`SLACK_WEBHOOK_URL` and `POSTHOG_PROJECT_TOKEN` are optional; without them,
notifications and analytics accumulate in the database outbox and are
delivered once configured. If `X_API_SCOPES` is set and names any write scope,
the campaign refuses to run.

Creator handles are never checked in — add them in the portal.

## Verification

```sh
npm test
npm run check
cd apps/android && ./gradlew assembleDebug
```

See [docs/architecture.md](docs/architecture.md) for data boundaries and the planned iOS/desktop adapters.
