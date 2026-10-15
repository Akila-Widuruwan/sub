# sub — Sinhala Anime Subtitle Translator (Gemini)

A small web app that translates a complete `.srt` episode into natural,
conversational Sri Lankan Sinhala using the Gemini API. The translation rules
(character voice, humor, sarcasm, pronouns, JJK terminology, etc.) live in
`prompts/system-prompt.txt` and are sent as the Gemini system instruction.

## Features

- Enter your Gemini API key in the app (optionally remembered in this browser only).
- Choose a Gemini model (Flash, Pro, or Flash-Lite).
- Upload an `.srt` file or paste SRT text.
- Live progress while translating in batches (40 subtitles per request, with the
  previous 8 translated lines passed as context for continuity).
- The output SRT is rebuilt by the server from the original numbers and
  timestamps, so the structure is always preserved. Each entry is validated; if
  Gemini skips or duplicates one, that batch is retried.
- Download the result as `<name>.si.srt`, or copy it.

## Run

Requires Node.js 18+ (no npm dependencies).

```bash
npm start            # http://localhost:3000  (PORT env var to change)
npm test             # run the test suite (uses a mock Gemini server)
```

Then open the app, paste your key from https://aistudio.google.com/app/apikey,
pick a model, add the SRT, and click **Translate episode**.

## Layout

```
server.js            HTTP server: static UI + POST /api/translate (NDJSON progress)
src/srt.js           SRT parser / builder
src/gemini.js        Gemini client, batching, context, validation, retries
prompts/system-prompt.txt   Translation rules used as the system prompt
public/              Browser UI (index.html, app.js, style.css)
test/app.test.js     Unit + integration tests
```

## Notes

- The API key is sent from the browser to this server only for the translation
  request and is forwarded to Google. It is not written to disk or logged.
- Long episodes take several minutes on Pro. Keep the tab open while it runs.
- `GEMINI_BASE_URL` can override the Gemini endpoint (used by the tests).
