const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const VIDEO_DURATION_MS = 15_000;
const PAUSE_BETWEEN_MS  =  0;

// ── State ─────────────────────────────────────────────────────────────────────
// Il video è scelto localmente da ogni client — il server non ne sa nulla
let clients        = new Map(); // id → { ws, name, ready }
let clientCounter  = 0;
let turnQueue      = [];
let activeClientId = null;
let sequenceTimer  = null;
let phase          = 'idle';
let phaseEndsAt    = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function getClientList() {
  return Array.from(clients.entries()).map(([id, c]) => ({
    id, name: c.name, isActive: id === activeClientId, ready: c.ready
  }));
}

function broadcastState(extra = {}) {
  broadcast({ type: 'state', clients: getClientList(), count: clients.size,
    activeClientId, turnQueue, phase, phaseEndsAt, ...extra });
}

function readyCount() { return [...clients.values()].filter(c => c.ready).length; }
function clearTimer()  { if (sequenceTimer) { clearTimeout(sequenceTimer); sequenceTimer = null; } }

// ── Sequence ──────────────────────────────────────────────────────────────────
function startSequence() {
  if (clients.size === 0 || turnQueue.length === 0) { phase = 'idle'; phaseEndsAt = null; return; }
  activeClientId = turnQueue[0];
  phase          = 'playing';
  phaseEndsAt    = Date.now() + VIDEO_DURATION_MS;

  broadcast({
    type: 'play_video',
    clientId:   activeClientId,
    clientName: clients.get(activeClientId)?.name,
    durationMs: VIDEO_DURATION_MS,
    phaseEndsAt
    // Nessun video info — ogni client usa il proprio file locale
  });
  broadcastState();
  clearTimer();
  sequenceTimer = setTimeout(endVideoStartPause, VIDEO_DURATION_MS);
}

function endVideoStartPause() {
  turnQueue = turnQueue.filter(id => id !== activeClientId);
  turnQueue.push(activeClientId);
  phase       = 'pausing';
  phaseEndsAt = Date.now() + PAUSE_BETWEEN_MS;
  broadcast({ type: 'pause_between', durationMs: PAUSE_BETWEEN_MS, phaseEndsAt });
  broadcastState();
  clearTimer();
  sequenceTimer = setTimeout(startSequence, PAUSE_BETWEEN_MS);
}

function maybeStart() {
  if (phase === 'idle' && clients.size > 0 && readyCount() > 0) startSequence();
}

/** Solo id di client ancora connessi (evita voci fantasma in coda) */
function sanitizeTurnQueue() {
  turnQueue = turnQueue.filter(qid => clients.has(qid));
}

/**
 * Il client che stava riproducendo si è disconnesso: non ruotare la coda come a fine video
 * (endVideoStartPause rimanderebbe in coda l'id già rimosso).
 */
function skipToNextAfterActiveDisconnected() {
  clearTimer();
  activeClientId = null;
  phase = 'pausing';
  phaseEndsAt = Date.now() + PAUSE_BETWEEN_MS;
  broadcast({ type: 'pause_between', durationMs: PAUSE_BETWEEN_MS, phaseEndsAt });
  broadcastState();
  sequenceTimer = setTimeout(startSequence, PAUSE_BETWEEN_MS);
}

function onClientGone(id) {
  const wasActive = activeClientId === id;
  clients.delete(id);
  turnQueue = turnQueue.filter(qid => qid !== id);
  sanitizeTurnQueue();

  if (clients.size === 0) {
    clearTimer();
    phase = 'idle';
    phaseEndsAt = null;
    activeClientId = null;
    return;
  }

  if (wasActive && phase === 'playing') {
    skipToNextAfterActiveDisconnected();
    return;
  }

  if (wasActive && phase === 'pausing') {
    clearTimer();
    activeClientId = null;
    phase = 'idle';
    phaseEndsAt = null;
    broadcastState();
    if (turnQueue.length > 0 && readyCount() > 0) startSequence();
    return;
  }

  broadcastState();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const id   = `client_${++clientCounter}`;
  const name = `Client ${clientCounter}`;
  clients.set(id, { ws, name, ready: false });
  turnQueue.push(id);

  ws.send(JSON.stringify({ type: 'welcome', id, name }));
  ws.send(JSON.stringify({ type: 'state', clients: getClientList(), count: clients.size,
    activeClientId, turnQueue, phase, phaseEndsAt }));
  broadcastState();

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ready') {
      const c = clients.get(msg.clientId);
      if (c) { c.ready = true; broadcastState(); maybeStart(); }
    }
    if (msg.type === 'rename') {
      const c = clients.get(msg.clientId);
      if (c) { c.name = msg.name.slice(0, 20); broadcastState(); }
    }
  });

  ws.on('close', () => onClientGone(id));
  ws.on('error', () => onClientGone(id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Uno alla volta → http://localhost:${PORT}`));
