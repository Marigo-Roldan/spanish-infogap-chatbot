# ¿Qué pasó? — Spanish info-gap voice chatbot

Students talk by voice (no typing) with two characters who tell the **same incident from different perspectives**. Each student gets **3 spoken questions per character** (with suggested questions on screen; "Repite, por favor" does not count), takes notes, writes a conclusion, then unlocks "what really happened." Language is kept at **novice high**. Uses OpenAI's **gpt-realtime-2.1** over WebRTC.

## Deploy on Netlify
1. In Netlify: **Add new project → Import an existing project → GitHub**, and pick this repository. The build settings come from `netlify.toml` automatically (publish folder `public`, functions in `netlify/functions`); leave the build command empty.
2. Go to **Site configuration → Environment variables** and add these. In the **Value** box, type only what is in the "Value" column — nothing else.
   | Key | Value | Needed? |
   |---|---|---|
   | `OPENAI_API_KEY` | your key, starts with `sk-` | **Required** |
   | `CLASS_CODE` | a word students type once, e.g. `tacos5` | Strongly recommended (so strangers can't use your key) |
   | `MAX_QUESTIONS` | `3` | Optional — skip it to use 3 |
   | `REALTIME_MODEL` | `gpt-realtime-2.1` | Optional — skip it to use gpt-realtime-2.1 |
3. **Deploys → Trigger deploy**. Share the site URL (and the class code) with students.

Your API key stays on Netlify; each browser only gets a short-lived key per conversation.

## Run it locally (Windows, no installs)
1. Double-click **start.bat**. The first time, it creates a `.env` file.
2. Open `.env` in Notepad, paste your key: `OPENAI_API_KEY=sk-...`, save.
3. Run **start.bat** again. The browser opens to http://localhost:8080.

## Customize
| What | Where |
|---|---|
| Stories, characters, voices, vocab, answer key | `public/stories.json` (add a block to add a story — the 🔄 button cycles through all of them) |
| How characters speak (level, rules) | `public/persona-prompt.txt` |
| Number of questions, model | Netlify environment variables, or `.env` locally |

Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar. Edit files on GitHub and Netlify redeploys automatically.

## Notes
- Allow the microphone; headphones help.
- Only questions the system actually hears/transcribes count. After the 3rd question, the mic turns off, the character answers, and the call ends.
- "Colgar" (hang up) does not reset the count.
- `stories.json` is public, so a curious student could find the answer key there.
