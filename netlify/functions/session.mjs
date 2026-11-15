// Netlify Function: POST /api/session
// Builds the character's instructions and returns a short-lived OpenAI Realtime key.
// Set these in Netlify > Site configuration > Environment variables:
//   OPENAI_API_KEY (required), REALTIME_MODEL, TRANSCRIBE_MODEL, MAX_QUESTIONS, CLASS_CODE (optional)

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return json(500, { error: 'Falta OPENAI_API_KEY en Netlify (Environment variables).' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Solicitud no válida.' }); }

  const classCode = process.env.CLASS_CODE;
  if (classCode && String(body.code || '').trim().toLowerCase() !== classCode.trim().toLowerCase()) {
    return json(401, { error: 'Código de la clase incorrecto.', needCode: true });
  }

  // Use only the first word, so a value pasted like "gpt-realtime-2.1 (optional)" still works.
  const firstWord = (v) => String(v || '').trim().split(/\s+/)[0];
  const model = firstWord(process.env.REALTIME_MODEL || process.env.OPENAI_REALTIME_MODEL) || 'gpt-realtime-2.1';
  const transcribe = firstWord(process.env.TRANSCRIBE_MODEL) || 'gpt-4o-mini-transcribe';
  const maxQ = parseInt(process.env.MAX_QUESTIONS || '3', 10);

  // Read the same files the page uses, from this site, so there is one place to edit them.
  const base = new URL(req.url).origin;
  const [data, template] = await Promise.all([
    fetch(`${base}/stories.json`).then(r => r.json()),
    fetch(`${base}/persona-prompt.txt`).then(r => r.text()),
  ]);

  const story = data.historias.find(s => s.id === body.storyId);
  if (!story) return json(400, { error: 'Historia no encontrada.' });
  const persona = story.personas.find(p => p.id === body.personaId);
  if (!persona) return json(400, { error: 'Persona no encontrada.' });

  const instructions = template
    .replaceAll('{{NOMBRE}}', persona.nombre)
    .replaceAll('{{TITULO}}', story.titulo)
    .replaceAll('{{ROL}}', persona.rol)
    .replaceAll('{{HISTORIA}}', persona.historia)
    .replaceAll('{{NO_SABE}}', persona.noSabe)
    .replaceAll('{{MAX}}', String(maxQ));

  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model,
        instructions,
        audio: {
          input: {
            transcription: { model: transcribe, language: 'es' },
            turn_detection: { type: 'semantic_vad', eagerness: 'low' },
          },
          output: { voice: persona.voz },
        },
      },
    }),
  });

  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json(502, { error: 'OpenAI: ' + (out.error?.message || r.statusText) });
  return json(200, { value: out.value, maxQuestions: maxQ });
};

export const config = { path: '/api/session' };
