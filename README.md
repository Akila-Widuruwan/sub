# sub — Sinhala Anime Subtitle Translator (Gemini)

A small web app that translates a complete `.srt` episode into natural,
conversational Sri Lankan Sinhala using the Gemini API. The translation rules
(character voice, humor, sarcasm, pronouns, JJK terminology, etc.) live in
`prompts/system-prompt.txt` and are sent as the Gemini system instruction.

## Features

- **Multiple API keys with automatic failover.** Paste as many Gemini keys as
  you like (one per line). If a key is rejected, rate limited, out of quota,
  unreachable or the model misbehaves, the app silently switches to the next
  key and carries on with the same episode. Nothing is lost mid-translation.
- **Optional model fallback.** Pick a primary model and tick backup models.
  If every key fails on the primary model (404 model not found, quota for that
  model, …), the run continues on the next model. Quotas are per model, so a
  key that is exhausted on one model is still used on the others.
- **Patient mode.** When Gemini answers "this model is experiencing high
  demand" (503), patient mode backs off (2s → 10s → 30s → 60s → 2m → 5m) and
  keeps retrying for up to ~15 minutes per batch instead of giving up after a
  few seconds.
- **Key health check.** "Check keys" asks Gemini which of your keys are alive
  and which models each one can call, before you burn a translation on them.
- Keys can optionally be remembered in this browser only.
- Choose a Gemini model (Flash, Pro, Flash-Lite) or type a custom model ID.
- Upload an `.srt` file or paste SRT text.
- Live progress while translating in batches (40 subtitles per request, with the
  previous 8 translated lines passed as context for continuity). The progress
  line shows which key and model are currently serving, and any failover is
  logged on screen.
- The output SRT is rebuilt by the server from the original numbers and
  timestamps, so the structure is always preserved. Each entry is validated; if
  Gemini skips or duplicates one, that batch is retried.
- Download the result as `<name>.si.srt`, or copy it.

### How the failover works

Every *(model × key)* pair is an "endpoint", ordered as:

```
primary model  → key 1, key 2, key 3 …
fallback model → key 1, key 2, key 3 …
```

Each batch walks that list until one endpoint answers. What happens to an
endpoint that fails depends on *why* it failed:

| Failure | Consequence |
| --- | --- |
| `401` / `403` (key rejected) | that key is dropped for the whole run |
| `404` (model not found) | that model is dropped for every key |
| `429` — long wait (hours) | a **per-model daily quota**: only that key+model pair is dropped, the key stays available for other models |
| `429` — short wait (seconds) | a **per-minute rate limit**: the whole key is parked for exactly as long as Gemini asked, and another key takes over |
| `5xx` / network error | the endpoint is parked for the `retryDelay` Gemini returned (max 30s) and another key is used meanwhile |
| Bad model output (invalid JSON, skipped/duplicated lines) | the key is *not* penalised — the batch is simply re-asked (fail over to the next key first) |

Gemini says how long to wait (`error.details[].retryDelay`, or "Please retry in
7h22m58s" in the message), and the app uses that number instead of guessing: a
7-hour daily-quota block and a 27-second rate limit are handled completely
differently.

A batch gets 3 rounds over the pool (6 in patient mode) with backoff of
2s → 10s → 30s → 60s → 2m → 5m, capped by a time budget (90s standard,
15min patient), and a healthy endpoint stays "sticky" so an episode keeps a
consistent voice.

### When everything fails

The app no longer hides which option said what. It lists every endpoint it
tried, the error each one returned, how long each one is blocked for, and a
hint built from the actual mix of failures — e.g. *"1 option is quota-blocked
for up to 7h 22m — add a key, or pick a model with more free-tier quota; tick a
fallback model, or turn on patient mode to ride out the overload."* The
`POST /api/translate` stream also carries a `waiting` event, so the UI shows
"Waiting 27s — every key is cooling down" instead of a frozen progress bar.

## Run

Requires Node.js 18+ (no npm dependencies).

```bash
npm start            # http://localhost:3000  (PORT env var to change)
npm test             # run the test suite (uses mock Gemini servers)
```

Then open the app, paste one or more keys from
https://aistudio.google.com/app/apikey, pick a model, add the SRT, and click
**Translate episode**.

## Layout

```
server.js            HTTP server: static UI, POST /api/translate (NDJSON progress),
                     POST /api/keys/check
src/srt.js           SRT parser / builder
src/gemini.js        Gemini client, endpoint pool + failover, batching, context, retries
prompts/system-prompt.txt   Translation rules used as the system prompt
public/              Browser UI (index.html, app.js, style.css)
test/app.test.js     Unit + integration tests
```

## API

- `GET /api/models` → the built-in model list.
- `POST /api/translate` → `{ keys: ["…", "…"] (or "a\nb"), model, fallbackModels?, patient?, srt }`,
  answered as a stream of NDJSON events:
  `start`, `progress` (with the endpoint in use), `failover` (with the
  `retryDelayMs` Gemini asked for), `waiting`, `result`,
  `error` (`{ message, hint, failures: [{ label, status, message, retryDelayMs }] }`).
  `apiKey` (a single key, string) is still accepted for backwards compatibility.
- `POST /api/keys/check` → `{ keys: [...] }`, answered with per-key
  `{ ok, status, message, models }` results.

## Notes

- API keys are sent from the browser to this server only for the translation
  request and are forwarded to Google. They are not written to disk or logged.
- Long episodes take several minutes on Pro. Keep the tab open while it runs.
- `GEMINI_BASE_URL` can override the Gemini endpoint (used by the tests).
