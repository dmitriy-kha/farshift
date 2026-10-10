// Ephemeral streaming downloads only: no caching or whole-file buffering.
const CHUNK_LIMIT = 16 * 1024;
const sessions = new Map();
let timer;
function onlyFields(data, keys) {
  return data !== null && typeof data === 'object' && Object.keys(data).length === keys.length &&
    Object.keys(data).every(key => keys.includes(key));
}
function post(session, type, message) {
  try { session.port.postMessage(message ? { type, message } : { type }); } catch { /* Closed port. */ }
}
function terminate(session, type, message = 'Download cancelled') {
  if (session.terminal) return;
  session.terminal = true;
  session.pending = null;
  session.ended = true;
  if (session.controller) {
    try {
      if (type === 'done') session.controller.close();
      else session.controller.error(new Error(message));
    } catch { /* The browser may have already cancelled its stream. */ }
  }
  if (session.pull) {
    if (type === 'done') session.pull.resolve();
    else session.pull.reject(new Error(message));
    session.pull = null;
  }
  post(session, type, type === 'done' ? undefined : message);
  session.port.onmessage = null;
  session.port.onmessageerror = null;
  session.port.close();
  if (sessions.get(session.token) === session) sessions.delete(session.token);
  if (!sessions.size) { clearInterval(timer); timer = undefined; }
}
function drain(session) {
  if (session.terminal || !session.pending || !session.pull || !session.controller) return;
  try {
    const bytes = new Uint8Array(session.pending);
    session.controller.enqueue(bytes);
    session.delivered += bytes.length;
    session.pending = null;
    session.lastProgress = Date.now();
    session.pull.resolve();
    session.pull = null;
    post(session, 'ack');
  } catch { terminate(session, 'error', 'Download consumer unavailable'); }
}
function portMessage(session, data) {
  if (session.terminal) return;
  session.lastSeen = Date.now();
  if (data?.type === 'chunk' && onlyFields(data, ['type', 'bytes'])) {
    const buffer = data.bytes;
    if (!(buffer instanceof ArrayBuffer) || session.ended || session.pending || !buffer.byteLength ||
        buffer.byteLength > CHUNK_LIMIT || session.delivered + buffer.byteLength > session.size) throw new Error('Invalid chunk');
    session.pending = buffer;
    drain(session);
  } else if (data?.type === 'end' && onlyFields(data, ['type'])) {
    if (session.ended || session.pending || session.delivered !== session.size) throw new Error('Incomplete download');
    session.ended = true;
    if (session.started) terminate(session, 'done');
  } else if (data?.type === 'abort' && onlyFields(data, ['type'])) {
    terminate(session, 'cancel', 'Download aborted');
  } else if (data?.type === 'ping' && onlyFields(data, ['type'])) {
    post(session, 'pong');
  } else { throw new Error('Invalid port message'); }
}
function ensureTimer() {
  if (timer !== undefined) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if ((!session.started && now - session.created > 30000) || now - session.lastSeen > 30000 ||
          (session.started && now - session.lastProgress > 60000)) terminate(session, 'error', 'Download timed out');
    }
  }, 5000);
}
async function handleMessage(event) {
  const data = event.data;
  if (!data || typeof data.token !== 'string' || !/^[0-9a-f]{32}$/.test(data.token)) throw new Error('Invalid token');
  const clientId = event.source?.id;
  if (!clientId) throw new Error('Client required');
  const client = await self.clients.get(clientId);
  if (!client || new URL(client.url).origin !== self.location.origin) throw new Error('Wrong origin');
  if (data.type === 'ping' && onlyFields(data, ['type', 'token'])) {
    const session = sessions.get(data.token);
    if (event.ports.length || !session || session.client !== clientId || session.terminal) throw new Error('Wrong client');
    session.lastSeen = Date.now();
    post(session, 'pong');
    return;
  }
  if (data.type !== 'open' || !onlyFields(data, ['type', 'token', 'name', 'size']) || event.ports.length !== 1) {
    throw new Error('Invalid open request');
  }
  if (typeof data.name !== 'string' || !data.name || new TextEncoder().encode(data.name).length > 1024 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(data.name) || !Number.isSafeInteger(data.size) ||
      data.size < 0 || data.size > 2 ** 50) throw new Error('Invalid file metadata');
  if (sessions.size >= 8 || sessions.has(data.token) || [...sessions.values()].some(session => session.client === clientId)) {
    throw new Error('Download already active');
  }
  const now = Date.now();
  const session = {
    token: data.token, client: clientId, name: data.name, size: data.size, delivered: 0,
    port: event.ports[0], controller: null, pending: null, pull: null,
    started: false, terminal: false, ended: false, created: now, lastSeen: now, lastProgress: now,
  };
  session.port.onmessage = message => {
    try { portMessage(session, message.data); } catch { terminate(session, 'error', 'Invalid download message'); }
  };
  session.port.onmessageerror = () => terminate(session, 'error', 'Download port failed');
  sessions.set(session.token, session);
  ensureTimer();
  session.port.start();
  post(session, 'ready');
}
function disposition(name) {
  const safe = name.replace(/[/\\]/g, '_');
  const encoded = Array.from(new TextEncoder().encode(safe), byte => {
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9!#$&+\-.^_`|~]$/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}
function statusResponse(status) {
  return new Response('Download unavailable', { status, headers: { 'Cache-Control': 'no-store' } });
}
function handleFetch(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return statusResponse(400);
  const session = sessions.get(url.pathname.slice('/download/'.length));
  if (!session) return statusResponse(404);
  if (session.started || session.terminal) return statusResponse(409);
  session.started = true;
  session.lastProgress = Date.now();
  try {
    const stream = new ReadableStream({
      start(controller) {
        session.controller = controller;
        if (session.ended) terminate(session, 'done');
      },
      pull() {
        const promise = new Promise((resolve, reject) => {
          if (session.terminal || session.pull) reject(new Error('Download unavailable'));
          else session.pull = { resolve, reject };
        });
        drain(session);
        return promise;
      },
      cancel() { terminate(session, 'cancel', 'Browser download cancelled'); },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: {
      'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition(session.name),
      'Content-Length': String(session.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
    if (!session.terminal) post(session, 'started');
    return response;
  } catch {
    terminate(session, 'error', 'Stream response unavailable');
    return statusResponse(500);
  }
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => event.waitUntil(handleMessage(event).catch(() => {
  const port = event.ports[0];
  if (port) {
    try { port.postMessage({ type: 'error', message: 'Download worker rejected request' }); } finally { port.close(); }
  }
})));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && /^\/download\/[0-9a-f]{32}$/.test(url.pathname)) {
    event.respondWith(handleFetch(event.request));
  }
});
