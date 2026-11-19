# Local setup

Run the commands from the repository root. Node.js 22 or newer is required.

```sh
npm ci
cp .env.example .env
npm test
npm run typecheck
```

In PowerShell, use `Copy-Item .env.example .env` and `npm.cmd` if execution policy blocks `npm.ps1`. Tests use local fixtures and provider fakes.

## Choose an input mode

- **Typed.** Set the Anthropic and Typesafe keys, run `npm start` and open [localhost:3000](http://localhost:3000/). Choose **Type instead**. `npm run dev` runs the same server with file watching. With no Anthropic key the UI loads and a typed turn uses the server’s error reply. With no Typesafe key the router continues the current thread.
- **Voice.** Set the Vapi keys and custom LLM secret in addition to the typed-mode keys. Install `cloudflared` on your PATH, then run `npm run live`. Open the localhost URL printed by the launcher, choose **Start talking** and grant microphone access. Hold Space or press and hold the mobile glow to keep the floor. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- **Voice with your own HTTPS endpoint.** Set `PUBLIC_URL` to an HTTPS origin that reaches your Branch Voice server. Run `npm run vapi:sync` and then `npm start`. Vapi sends custom LLM requests to `/vapi/chat/completions` and voice events to `/vapi/events`.

## Environment

Keep filled values in the ignored `.env` file. The browser receives only the Vapi public key, assistant ID and endpoint timing from `/api/config`.

| Variable | Role |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude replies, branch naming, digests and session notes. |
| `TYPESAFE_API_KEY` | Jev routing. Missing key or `JEV_ENABLED=0` makes the router continue the current thread. |
| `VAPI_PUBLIC_KEY` | Starts a browser voice session. |
| `VAPI_PRIVATE_KEY` | Creates or updates the assistant during sync. |
| `VAPI_CUSTOM_LLM_SECRET` | Authenticates callbacks to this server. Generate a random value, for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. |
| `PUBLIC_URL` | HTTPS origin for callbacks and share links. The live launcher writes this value. |
| `VAPI_ASSISTANT_ID` | Leave blank to create a dedicated assistant and save its ID. Setting an ID updates that assistant on sync. |
| `PORT` | Local HTTP port, defaults to `3000`. |
| `REPLY_MODEL`, `BACKGROUND_MODEL` | Optional Claude model overrides. The code defaults both to `claude-opus-5-5`. Set models available to your account if needed. |
| `DEEPGRAM_API_KEY` | Optional bring-your-own credential. Sync reuses an existing Deepgram credential in the Vapi account if present. |

## Voice troubleshooting

- If the greeting plays and the first response says the call is unlinked, check the assistant’s callback origin and `model.metadataSendMode`. The sync script sets `variable` so Vapi forwards the call ID required for session binding. Re-sync and start a new call.
- Run one live launcher per checkout and use a dedicated Vapi assistant per concurrent launcher. The launcher holds `.branch-voice-live.lock`. Stop it with Ctrl+C. After a crash, verify the old launcher, server and tunnel have stopped before clearing a stale lock.
- Ended sessions have a link which anyone with the URL can open while the server and session are available. Keep the `?debug=1` footer and its session bearer token out of shared screenshots or recordings.

Try the [demo prompts](demo-script.md#try-it-locally) to exercise a fork, correction, switch, comparison and merge.
