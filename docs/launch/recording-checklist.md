# Record and replay a session

Use a fresh local voice session to capture the screen and the app’s state log together. The final 78-second V3 release edit has its own local production inputs. The default `Launch` composition is the earlier repository replay.

1. Start the app in [voice mode](../setup.md#choose-an-input-mode). Open `/?film=1` on localhost. Leave debug mode off so the session bearer token stays out of the capture.
2. Start a screen recording with microphone and desktop audio on one track. Use headphones to keep the assistant’s voice out of the mic.
3. Follow the [demo prompts](../demo-script.md#try-it-locally), or use the dinner/barbecue prompts in the [router fixtures](../../eval/router/items.jsonl). End the session and wait for the film log download.
4. Keep source recordings, raw film logs and request captures local. With `ffmpeg` and `ffprobe` on PATH, run `npm run film:sync -- <film-log.json> <recording.mp4>` to align the recording and log. This writes the synchronized log to `film/.capture/session.json` and media to ignored paths in `film/public/`. Optionally run `npm --prefix film run transcribe` to write subtitle timings to `film/.capture/captions.json`.

## Repository replay

The `Launch` composition uses the Japan demo’s text and UI events. The replay fixture replaces the original session ID, uses relative timestamps and omits raw router scores. The render uses bundled fonts and can run from a clean checkout without a microphone or provider keys.

```sh
npm ci --prefix film
npm run film:studio
npm run film:render -- draft
```

The last command writes the picture replay to the ignored `film/renders/` directory. To generate cue, audio and render QA files, use `node film/scripts/launch-render.mjs draft` with Python, NumPy, SciPy and FFmpeg installed. `npm run film:standin` regenerates the separate synthetic dinner/barbecue fixtures under `film/data/`.
