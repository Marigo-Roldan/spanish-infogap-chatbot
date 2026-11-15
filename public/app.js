// Info-gap chatbot — browser side.
// Connects to the OpenAI Realtime API over WebRTC using a short-lived key from our local server.

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const START_TEXT = '(El estudiante llega. Saluda, di tu nombre y cuenta tu historia.)';
const RETURN_TEXT = '(El estudiante regresa. Saluda brevemente y espera su pregunta.)';

let MAX_Q = 3;
let stories = [];
let storyIdx = 0;
let personaState = {};   // personaId -> { count, done, card }
let session = null;      // the one live conversation (only one persona at a time)

const $ = (sel, el = document) => el.querySelector(sel);

// ---------- Setup ----------
async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    MAX_Q = cfg.maxQuestions || 3;
  } catch { /* keep default */ }
  const data = await (await fetch('/stories.json')).json();
  stories = data.historias;
  try { storyIdx = Math.min(Number(localStorage.getItem('infogap-story')) || 0, stories.length - 1); } catch { }
  $('#changeStory').addEventListener('click', changeStory);
  $('#revealBtn').addEventListener('click', revealTruth);
  $('#showText').addEventListener('change', applyTextToggle);
  renderStory();
}

function changeStory() {
  endSession();
  storyIdx = (storyIdx + 1) % stories.length;
  try { localStorage.setItem('infogap-story', String(storyIdx)); } catch { }
  renderStory();
}

function renderStory() {
  const story = stories[storyIdx];
  $('#storyTitle').textContent = story.titulo;
  $('#storyScene').textContent = story.escena;
  $('#storyCount').textContent = `Historia ${storyIdx + 1} de ${stories.length}`;
  $('#vocabList').innerHTML = '';
  story.vocabulario.forEach(w => {
    const c = document.createElement('span'); c.className = 'chip'; c.textContent = w;
    $('#vocabList').appendChild(c);
  });
  $('.steps li:nth-child(2) b').textContent = `${MAX_Q} preguntas`;
  $('#conclusion').value = '';
  $('#truth').hidden = true;
  $('#revealBtn').disabled = true;
  $('#revealBtn').textContent = '🔒 Ver lo que pasó (termina con las dos personas)';

  const wrap = $('#personas');
  wrap.innerHTML = '';
  personaState = {};
  story.personas.forEach(p => {
    const card = $('#personaTpl').content.firstElementChild.cloneNode(true);
    $('.avatar', card).textContent = p.emoji;
    $('.name', card).textContent = p.nombre;
    $('.name2', card).textContent = p.nombre;
    $('.rol', card).textContent = p.rol;
    $('.talk', card).addEventListener('click', () => toggleTalk(p));
    const list = $('.suggest-list', card);
    (p.preguntas || []).forEach(q => {
      const li = document.createElement('li'); li.textContent = q; list.appendChild(li);
    });
    if (!list.children.length) $('.suggest', card).hidden = true;
    wrap.appendChild(card);
    personaState[p.id] = { count: 0, done: false, visited: false, card, persona: p };
    updateCard(p.id);
  });
  applyTextToggle();
}

function applyTextToggle() {
  const show = $('#showText').checked;
  document.querySelectorAll('.transcript').forEach(t => t.classList.toggle('hidden-text', !show));
}

// ---------- Card UI ----------
function updateCard(id) {
  const st = personaState[id];
  const card = st.card;
  const dots = $('.dots', card);
  dots.innerHTML = '';
  for (let i = 0; i < MAX_Q; i++) {
    const d = document.createElement('span');
    d.className = 'dot' + (i < st.count ? ' used' : '');
    dots.appendChild(d);
  }
  const live = session && session.personaId === id;
  const talk = $('.talk', card);
  card.classList.toggle('active', !!live);
  card.classList.toggle('done', st.done);
  if (st.done) {
    talk.textContent = '✅ Terminaste';
    talk.disabled = true;
    talk.classList.remove('live');
  } else if (live) {
    talk.textContent = '⏹️ Colgar';
    talk.disabled = false;
    talk.classList.add('live');
  } else {
    talk.textContent = `🎙️ Hablar con ${st.persona.nombre}`;
    talk.disabled = false;
    talk.classList.remove('live');
  }
}

function setStatus(id, text, cls = '') {
  const s = $('.status', personaState[id].card);
  s.textContent = text;
  s.className = 'status ' + cls;
}

function addMsg(id, kind, text, who) {
  const t = $('.transcript', personaState[id].card);
  const m = document.createElement('div');
  m.className = 'msg ' + kind;
  if (who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who; m.appendChild(w); }
  const body = document.createElement('span'); body.className = 'body'; body.textContent = text;
  m.appendChild(body);
  t.appendChild(m);
  t.scrollTop = t.scrollHeight;
  return body;
}

// ---------- Connecting ----------
async function toggleTalk(p) {
  if (session && session.personaId === p.id) { endSession(); return; }
  endSession();
  await startSession(p);
}

async function startSession(p) {
  const id = p.id;
  const st = personaState[id];
  const s = session = {
    personaId: id, pc: null, dc: null, stream: null, audio: null,
    ready: false, storyTold: st.visited, responseActive: false, limitReached: false,
    currentBubble: null, pendingYou: {}, fallbackTimer: null,
  };
  updateCard(id);
  setStatus(id, 'Conectando…');

  try {
    let r, data;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyId: stories[storyIdx].id, personaId: id, code: getClassCode() }),
      });
      data = await r.json().catch(() => ({}));
      if (!data.needCode) break;
      const code = window.prompt(attempt ? 'Código incorrecto. Escribe el código de la clase:' : 'Escribe el código de la clase:');
      if (code === null) throw new Error('Necesitas el código de la clase.');
      setClassCode(code.trim());
    }
    if (!r.ok || !data.value) throw new Error(data.error || `No se pudo conectar (error ${r.status}).`);
    if (session !== s) return; // user clicked away

    s.pc = new RTCPeerConnection();
    s.audio = new Audio(); s.audio.autoplay = true;
    s.pc.ontrack = e => { s.audio.srcObject = e.streams[0]; };

    s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mic = s.stream.getAudioTracks()[0];
    mic.enabled = false; // stay muted while the story is told
    s.pc.addTrack(mic, s.stream);

    s.dc = s.pc.createDataChannel('oai-events');
    s.dc.onopen = () => onChannelOpen(s);
    s.dc.onmessage = e => onEvent(s, JSON.parse(e.data));

    const offer = await s.pc.createOffer();
    await s.pc.setLocalDescription(offer);
    const sdpRes = await fetch(REALTIME_CALLS_URL, {
      method: 'POST', body: offer.sdp,
      headers: { Authorization: `Bearer ${data.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) throw new Error('OpenAI: ' + await sdpRes.text());
    await s.pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
  } catch (err) {
    console.error(err);
    if (session === s) endSession();
    let msg = err.message || String(err);
    if (err.name === 'NotAllowedError') msg = 'Necesitas permitir el micrófono.';
    setStatus(id, '⚠️ ' + msg);
  }
}

let classCode = '';
function getClassCode() {
  if (!classCode) { try { classCode = localStorage.getItem('infogap-code') || ''; } catch { } }
  return classCode;
}
function setClassCode(c) {
  classCode = c;
  try { localStorage.setItem('infogap-code', c); } catch { }
}

function send(s, obj) {
  if (s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify(obj));
}

function onChannelOpen(s) {
  const st = personaState[s.personaId];
  s.ready = true;
  // Kick off the conversation with a hidden "stage direction" message.
  send(s, {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: st.visited ? RETURN_TEXT : START_TEXT }] },
  });
  send(s, { type: 'response.create' });
  st.visited = true;
  setStatus(s.personaId, st.count ? 'Saludando…' : 'Escucha la historia…', 'speaking');
  updateCard(s.personaId);
}

// ---------- Realtime events ----------
function onEvent(s, ev) {
  if (session !== s) return;
  const id = s.personaId;
  const name = personaState[id].persona.nombre;

  switch (ev.type) {
    case 'response.created':
      s.responseActive = true;
      s.currentBubble = null;
      setStatus(id, `${name} habla…`, 'speaking');
      updateCard(id);
      break;

    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      if (!s.currentBubble) s.currentBubble = addMsg(id, 'them', '', name);
      s.currentBubble.textContent += ev.delta;
      $('.transcript', personaState[id].card).scrollTop = 1e9;
      break;

    case 'response.done':
      s.responseActive = false;
      s.currentBubble = null;
      if (s.limitReached) { finishPersona(s); break; }
      if (!s.storyTold) s.storyTold = true;
      setMic(s, true);
      setStatus(id, `¡Tu turno! Haz una pregunta (${MAX_Q - personaState[id].count} restantes).`, 'listening');
      updateCard(id);
      break;

    case 'input_audio_buffer.speech_started':
      if (!s.limitReached) setStatus(id, 'Te escucho…', 'listening');
      break;

    case 'input_audio_buffer.committed':
      // Placeholder bubble; filled in when transcription arrives.
      s.pendingYou[ev.item_id] = addMsg(id, 'you', '…', 'Tú');
      break;

    case 'conversation.item.input_audio_transcription.completed': {
      const text = (ev.transcript || '').trim();
      const bubble = s.pendingYou[ev.item_id];
      delete s.pendingYou[ev.item_id];
      if (!text) { bubble?.parentElement.remove(); break; }
      if (bubble) bubble.textContent = text; else addMsg(id, 'you', text, 'Tú');
      if (!isFreeUtterance(text)) registerQuestion(s);
      break;
    }

    case 'error':
      console.warn('Realtime error', ev.error);
      if (ev.error?.message && !/active response/i.test(ev.error.message)) {
        addMsg(id, 'system', '⚠️ ' + ev.error.message);
      }
      break;
  }
}

function setMic(s, on) {
  const t = s.stream?.getAudioTracks()[0];
  if (t) t.enabled = on;
}

function registerQuestion(s) {
  const st = personaState[s.personaId];
  if (s.limitReached) return;
  st.count = Math.min(st.count + 1, MAX_Q);
  if (st.count >= MAX_Q) {
    s.limitReached = true;
    setMic(s, false);
    setStatus(s.personaId, 'Última pregunta. Escucha la respuesta…', 'speaking');
    // Close after the answer finishes; fallback in case no answer comes.
    const fallback = () => { s.responseActive ? (s.fallbackTimer = setTimeout(fallback, 5000)) : finishPersona(s); };
    s.fallbackTimer = setTimeout(fallback, 15000);
  }
  updateCard(s.personaId);
}

// "Repite, por favor", "No entiendo", "Hola", "Gracias"... do not use up a question.
function isFreeUtterance(text) {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[¿?¡!.,]/g, '').trim();
  if (/\b(repit\w*|repetir|despacio|no entiendo|otra vez|como dices)\b/.test(t)) return true;
  if (/^(como|que)$/.test(t)) return true; // "¿Cómo?" / "¿Qué?"
  return /^(hola|gracias|muchas gracias|ok|okay|vale|si|no|adios|bueno|perdon)( \w+)?$/.test(t);
}

function finishPersona(s) {
  if (session !== s) return;
  const st = personaState[s.personaId];
  st.done = true;
  endSession();
  addMsg(s.personaId, 'system', `Usaste tus ${MAX_Q} preguntas. ¡Buen trabajo!`);
  setStatus(s.personaId, '✅ Terminaste con esta persona.');
  updateCard(s.personaId);
  if (Object.values(personaState).every(p => p.done)) {
    const b = $('#revealBtn');
    b.disabled = false;
    b.textContent = '🔓 Ver lo que pasó de verdad';
  }
}

function endSession() {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(s.fallbackTimer);
  try { s.dc?.close(); } catch { }
  try { s.pc?.close(); } catch { }
  s.stream?.getTracks().forEach(t => t.stop());
  if (s.audio) s.audio.srcObject = null;
  if (personaState[s.personaId]) {
    if (!personaState[s.personaId].done) setStatus(s.personaId, 'Llamada terminada. Puedes hablar otra vez.');
    updateCard(s.personaId);
  }
}

function revealTruth() {
  const t = $('#truth');
  t.innerHTML = '<b>Lo que pasó de verdad:</b> ';
  t.append(stories[storyIdx].verdad);
  t.hidden = false;
}

init().catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    `<p style="background:#ffe3e3;padding:12px;margin:0">⚠️ No se pudo cargar la actividad. (${err.message})</p>`);
});
