import { validRoom, validSecret, normalizeCode, randomSecret, Pairing } from './protocol.js';
import { prepare, available, Download } from './download.js';

const animationSettings = {
  code_min_delay_ms: 100, code_random_range_ms: 220, code_tick_ms: 50,
  indicator_ready_ms: 180, indicator_waiting_ms: 120,
};
try {
  const response = await fetch('/ui-config.yaml', { cache: 'no-store' });
  if (!response.ok) throw Error('Animation settings unavailable');
  const settings = { ...animationSettings };
  // This configuration supports flat YAML numeric settings and comments only.
  for (const line of (await response.text()).split(/\r?\n/)) {
    const value = line.split('#')[0].trim();
    if (!value) continue;
    const match = /^([a-z_]+):\s*(\d+)$/.exec(value);
    if (!match || !Object.hasOwn(settings, match[1])) throw Error('Invalid animation setting');
    const number = Number(match[2]);
    const minimum = match[1] === 'code_random_range_ms' ? 0 : 16;
    if (!Number.isSafeInteger(number) || number < minimum || number > 60000) throw Error('Invalid animation timing');
    settings[match[1]] = number;
  }
  Object.assign(animationSettings, settings);
} catch (error) {
  console.warn('Using default animation settings:', error);
}

const CHUNK = 16 * 1024;
const FALLBACK_LIMIT = 32 * 1024 * 1024;
const MAX_LOCAL_ENTRIES = 10000;
const MAX_FILES = MAX_LOCAL_ENTRIES * 2;
const MAX_DEPTH = 32;
const MAX_CONTROL = 48 * 1024;
const MAX_CONTROL_QUEUE = 64 * 1024 * 1024;
const MAX_SIGNAL = 48 * 1024;
const MAX_WS = 64 * 1024;
const TRANSFER_IDLE_TIMEOUT = 30000;
const CHANNEL_OPEN_TIMEOUT = 45000;
const DEFAULT_TTL = 60 * 60;
const MAX_TTL = 999 * 60;
let lifetimeEdited = false;
let filesRenderFrame = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const app = {
  generation: 0, ws: null, pc: null, channel: null, role: '', room: '', secret: '',
  peer: '', peerSecret: '', attempts: [], pairing: null, pakeMessage: null, session: null,
  paired: false, peerReady: false, expiresAt: 0, pairingDeadline: 0,
  localExpiresAt: 0, localPairingDeadline: 0, configuration: null,
  lifetime: null, lifetimeConfirmed: false,
  connectingAt: 0, remoteCandidates: [],
  clock: 0, files: new Map(), local: new Map(), created: new Set(), expanded: new Set(), replace: null, outgoing: null,
  incoming: null, folderDownload: null, directoryImport: null,
  preparingDownload: false, receivingDone: false, disconnectedAt: 0,
  controlQueue: [], controlQueueBytes: 0, sendingControl: false,
};
const element = id => document.getElementById(id);
const text = (id, value) => { element(id).textContent = value; };
const disableButton = (button, value) => button.setAttribute('aria-disabled', String(Boolean(value)));
document.addEventListener('click', event => {
  if (event.target.closest('button[aria-disabled="true"], .button[aria-disabled="true"]')) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);
const clearJoinCode = () => { element('join-code').value = '    -'; };
const decorativeAlphabet = '!@#$%^&*()_+=[]{};:,.<>?/|~';
let codeAnimation = null;
function animateCode() {
  const symbols = Array(8).fill('');
  const nextChange = Array(8).fill(0);
  const frame = () => {
    if (document.hidden || element('waiting').hidden) return;
    const now = performance.now();
    symbols.forEach((symbol, index) => {
      if (now < nextChange[index]) return;
      let next;
      do { next = decorativeAlphabet[Math.floor(Math.random() * decorativeAlphabet.length)]; } while (next === symbol);
      symbols[index] = next;
      nextChange[index] = now + animationSettings.code_min_delay_ms + Math.random() * animationSettings.code_random_range_ms;
    });
    text('code-left', symbols.slice(0, 4).join(''));
    text('code-right', symbols.slice(4).join(''));
  };
  frame();
  codeAnimation = setInterval(frame, animationSettings.code_tick_ms);
}
const showCode = value => {
  clearInterval(codeAnimation);
  codeAnimation = null;
  text('code-left', value.slice(0, 4)); text('code-right', value.slice(4));
  element('code').dataset.ready = String(Boolean(value));
  element('code').tabIndex = value ? 0 : -1;
  if (!value) animateCode();
};
const hidden = (id, value) => { element(id).hidden = value; };
const notice = value => { text('notice', value); hidden('notice', !value); };
const clockwiseDots = [0, 3, 4, 5, 7, 6, 2, 1];
let indicatorMode = null;
let indicatorTimer = null;
let indicatorFrame = 0;
let previousDot = -1;
function indicator(mode) {
  if (mode === indicatorMode && (indicatorTimer !== null || mode === 'connected')) return;
  if (indicatorTimer !== null) clearInterval(indicatorTimer);
  indicatorTimer = null;
  indicatorMode = mode;
  indicatorFrame = 0;
  element('led').dataset.state = mode;
  if (mode === 'connected') { text('led', '\u28ff'); return; }
  const frame = () => {
    let dot;
    if (mode === 'ready') {
      // Exclude the previous dot so every frame visibly changes.
      dot = previousDot < 0 ? Math.floor(Math.random() * 8)
        : (previousDot + 1 + Math.floor(Math.random() * 7)) % 8;
      previousDot = dot;
    } else {
      dot = clockwiseDots[indicatorFrame++ % clockwiseDots.length];
    }
    text('led', String.fromCodePoint(0x2800 + (1 << dot)));
  };
  frame();
  if (!document.hidden) indicatorTimer = setInterval(frame, mode === 'ready' ? animationSettings.indicator_ready_ms : animationSettings.indicator_waiting_ms);
}
const status = (value, mode = 'waiting') => { text('status', value); indicator(mode); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (indicatorTimer !== null) clearInterval(indicatorTimer);
    indicatorTimer = null;
  } else if (indicatorMode !== null) indicator(indicatorMode);
});
const errorText = error => error?.message || String(error || 'Browser error');
const byteLength = value => encoder.encode(value).length;
const validHex = value => typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value);
const unsigned = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => unsigned(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const current = generation => app.generation === generation && app.ws !== null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const busy = value => { disableButton(element('create'), value); disableButton(element('join'), value || !app.room || Boolean(app.peer)); };
function wsSend(value) {
  const payload = JSON.stringify(value);
  if (byteLength(payload) > MAX_WS) throw Error('Pairing message too large');
  if (app.ws?.readyState !== WebSocket.OPEN) throw Error('Session closed');
  app.ws.send(payload);
}
function controlSend(value) {
  const payload = JSON.stringify(value);
  const size = byteLength(payload);
  if (size > MAX_CONTROL) throw Error('Too many files');
  if (app.channel?.readyState !== 'open') throw Error('Source unavailable');
  if (app.controlQueueBytes + size > MAX_CONTROL_QUEUE) {
    closeSession('Folder update queue limit exceeded');
    throw Error('Folder update queue limit exceeded');
  }
  app.controlQueue.push({ payload, size }); app.controlQueueBytes += size;
  if (!app.sendingControl) flushControl();
}
async function flushControl() {
  const channel = app.channel;
  const generation = app.generation;
  const queue = app.controlQueue;
  app.sendingControl = true;
  try {
    let index = 0;
    while (index < queue.length) {
      const started = Date.now();
      while (channel.bufferedAmount > 64 * 1024) {
        if (!current(generation) || channel.readyState !== 'open') return;
        if (Date.now() - started > 30000) throw Error('Folder updates stalled');
        await delay(25);
      }
      if (!current(generation) || channel.readyState !== 'open') return;
      const item = queue[index];
      channel.send(item.payload); app.controlQueueBytes -= item.size;
      queue[index++] = null;
      // Release sent payloads immediately and keep the consumed prefix bounded.
      if (index >= 256) { queue.splice(0, index); index = 0; }
    }
    queue.length = 0;
  } catch (error) {
    if (current(generation)) closeSession(errorText(error));
  } finally {
    if (current(generation)) app.sendingControl = false;
  }
}
function tryControl(value) { try { controlSend(value); } catch {} }
function tryWs(value) { try { wsSend(value); } catch {} }
async function signalSend(value, generation) {
  if (!app.session) throw Error('Missing key');
  const payload = await app.session.seal(JSON.stringify(value));
  if (!current(generation)) return;
  if (byteLength(payload) > MAX_SIGNAL) throw Error('SDP too large');
  wsSend({ type: 'relay', payload });
}
function abortReceiver(receiver) {
  receiver?.reject?.(Error('Transfer cancelled or could not be saved'));
  try { if (receiver?.writer) Promise.resolve(receiver.writer.abort()).catch(() => {}); } catch {}
  try { receiver?.download?.abort('Transfer cancelled'); } catch {}
}
function cancelFolderDownload() {
  const job = app.folderDownload;
  if (!job) return;
  job.cancelled = true;
  abortReceiver({ writer: job.writer });
}
function clearTransfer(message = '') {
  cancelFolderDownload(); app.folderDownload = null;
  const incoming = app.incoming;
  app.outgoing = null; app.incoming = null; app.receivingDone = false;
  abortReceiver(incoming);
  hidden('transfer', true);
  if (message) notice(message);
}
function closeSession(message = '') {
  clearTransfer();
  if (filesRenderFrame !== null) cancelAnimationFrame(filesRenderFrame);
  filesRenderFrame = null;
  app.controlQueue = []; app.controlQueueBytes = 0; app.sendingControl = false;
  app.generation++;
  for (const object of [app.ws, app.channel, app.pc]) {
    if (!object) continue;
    for (const name of ['onmessage', 'onopen', 'onclose', 'onerror', 'ondatachannel', 'onconnectionstatechange', 'onicecandidate']) object[name] = null;
    try { object.close(); } catch {}
  }
  app.session?.destroy?.(); app.pairing?.destroy?.();
  app.ws = app.channel = app.pc = app.session = app.pairing = null;
  app.pakeMessage?.fill(0); app.pakeMessage = null;
  app.secret = app.peerSecret = app.peer = app.room = app.role = '';
  app.configuration = null; app.files.clear(); app.local.clear(); app.created.clear(); app.expanded.clear(); app.replace = null; app.directoryImport = null;
  app.clock = 0; app.paired = app.peerReady = false;
  app.expiresAt = app.pairingDeadline = app.localExpiresAt = app.localPairingDeadline = 0;
  app.lifetime = null; app.lifetimeConfirmed = false;
  app.connectingAt = 0; app.remoteCandidates = [];
  app.preparingDownload = app.receivingDone = false; app.disconnectedAt = 0;
  showCode(''); text('files', ''); text('timer', 'TTL --:--');
  clearJoinCode();
  hidden('entry', false); hidden('waiting', false); hidden('code', false);
  disableButton(element('copy'), true);
  hidden('folder', true);
  status('Ready to connect', 'ready'); notice(message); busy(false);
}
function securityFailure() {
  tryWs({ type: 'invalidate' });
  closeSession('Code or confirmation incorrect. Folder closed. Get a new code.');
}
function connect(secret, ttl, explicit) {
  const now = Date.now();
  app.attempts = app.attempts.filter(started => now - started < 120000);
  if (app.attempts.length >= 5) throw Error('Pairing attempt limit reached. Wait two minutes.');
  if (!validSecret(secret) || (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_TTL)
    || typeof explicit !== 'boolean' || (!explicit && ttl !== DEFAULT_TTL)) throw Error('Invalid lifetime');
  app.attempts.push(now);
  const pendingPeerCode = element('join-code').value;
  closeSession();
  element('join-code').value = pendingPeerCode;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  const generation = app.generation;
  app.ws = ws; app.secret = secret;
  app.lifetime = { ttl, explicit, expires_at: now + ttl * 1000 };
  // An untouched default permits the peer's choice, even if its code is issued later.
  app.localExpiresAt = now + (explicit ? ttl : MAX_TTL + 120) * 1000;
  app.localPairingDeadline = now + Math.min(120000, ttl * 1000);
  text('timer', `TTL ${timeLeft((app.localPairingDeadline - Date.now()) / 1000)}`);
  busy(true); status('Connecting');
  hidden('entry', false); hidden('waiting', false); hidden('code', false); disableButton(element('copy'), true);
  ws.onopen = () => { if (current(generation)) { try { wsSend({ type: 'create', ttl, ttl_explicit: explicit }); } catch { closeSession('Could not open session'); } } };
  // Crypto and SDP operations must preserve the server's ordered message stream.
  let queue = Promise.resolve();
  ws.onmessage = event => {
    if (!current(generation)) return;
    if (typeof event.data !== 'string' || byteLength(event.data) > MAX_WS) { securityFailure(); return; }
    queue = queue.then(async () => {
      if (current(generation)) await handleServer(JSON.parse(event.data), generation);
    }).catch(error => {
      if (!current(generation)) return;
      if (error instanceof WebRTCError) closeSession(error.message);
      else securityFailure();
    });
  };
  ws.onclose = () => { if (current(generation)) closeSession('Session closed. Get a new code.'); };
  ws.onerror = () => { if (current(generation)) closeSession('Server unavailable. Check your connection.'); };
}
async function handleServer(value, generation) {
  switch (value?.type) {
    case 'ready': {
      const now = Date.now();
      if (!validRoom(value.room) || app.room || !Number.isFinite(value.expires_at)
        || !Number.isFinite(value.pairing_deadline) || value.pairing_deadline <= now
        || value.expires_at < value.pairing_deadline || value.pairing_deadline - now > 120000) throw Error('Invalid session context');
      app.room = value.room; app.expiresAt = value.expires_at; app.pairingDeadline = value.pairing_deadline;
      app.configuration = { iceServers: value.ice_servers || [], iceTransportPolicy: value.relay_only === true ? 'relay' : 'all' };
      const code = app.room + app.secret;
      showCode(code); hidden('code', false);
      disableButton(element('copy'), false); disableButton(element('join'), false);
      status('Exchange codes'); tick(); break;
    }
    case 'peer_ready': {
      const role = app.room < app.peer ? 'a' : 'b';
      if (app.peerReady || !app.peer || value.peer !== app.peer || value.role !== role
        || !Number.isFinite(value.expires_at) || !Number.isFinite(value.pairing_deadline)
        || value.expires_at > (app.lifetime.explicit ? app.expiresAt : app.localExpiresAt)
        || value.pairing_deadline > app.pairingDeadline
        || Math.min(value.pairing_deadline, app.localPairingDeadline) <= Date.now()
        || value.expires_at < value.pairing_deadline) throw Error('Invalid pairing context');
      app.peerReady = true;
      const args = role === 'a' ? [app.room, app.peer, app.secret, app.peerSecret] : [app.peer, app.room, app.peerSecret, app.secret];
      const result = await Pairing.create(role, args[0], args[1], value.attempt, args[2], args[3]);
      if (!current(generation)) { result.message.fill(0); result.pairing.destroy?.(); return; }
      app.role = role; app.pairing = result.pairing; app.pakeMessage = result.message;
      app.expiresAt = value.expires_at; app.pairingDeadline = value.pairing_deadline;
      status('Verifying codes');
      wsSend({ type: 'relay', payload: JSON.stringify({ type: 'pake', bytes: Array.from(result.message) }) }); break;
    }
    case 'relay': {
      if (typeof value.payload !== 'string' || byteLength(value.payload) > MAX_SIGNAL) throw Error('Invalid relay');
      if (!app.paired) await handlePairing(value.payload, generation);
      else {
        if (!app.session) throw Error('Missing key');
        const clear = await app.session.open(value.payload);
        if (current(generation)) await handleSignal(JSON.parse(clear), generation);
      }
      break;
    }
    case 'error': {
      const messages = { 'room unavailable': 'Session not found, code expired or already used.',
        'server full': 'No codes available. Try again in two minutes.',
        'admission rate limit': 'Too many requests. Try again later.', 'rate limit': 'Too many requests. Try again later.' };
      closeSession(messages[value.message] || 'Could not connect. Code may have expired or been used.'); break;
    }
    case 'closed': closeSession('Session expired or other device disconnected. Folder closed.'); break;
    case 'paired': break;
    default: throw Error('Invalid server message');
  }
}
async function handlePairing(payload, generation) {
  if (Date.now() >= Math.min(app.pairingDeadline, app.localPairingDeadline)
    || Date.now() >= Math.min(app.expiresAt, app.localExpiresAt)) {
    tryWs({ type: 'invalidate' }); closeSession('Pairing expired. Get a new code.'); return;
  }
  const value = JSON.parse(payload);
  if (!Array.isArray(value.bytes) || !value.bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw Error('Invalid confirmation');
  const bytes = new Uint8Array(value.bytes);
  if (value.type === 'pake') {
    if (bytes.length > 1024 || !app.pairing) throw Error('Invalid key');
    const pairing = app.pairing; app.pairing = null;
    const session = await pairing.finish(bytes);
    if (!current(generation)) { session.destroy?.(); return; }
    app.session = session;
    const proof = await session.confirmation();
    if (current(generation)) wsSend({ type: 'relay', payload: JSON.stringify({ type: 'proof', bytes: Array.from(proof) }) });
  } else if (value.type === 'proof') {
    if (bytes.length !== 32 || !app.session) throw Error('Invalid code');
    await app.session.verifyConfirmation(bytes);
    if (!current(generation)) return;
    app.paired = true; app.secret = app.peerSecret = ''; app.pakeMessage?.fill(0);
    showCode(''); hidden('waiting', true); hidden('entry', true);
    await signalSend({ type: 'lifetime', ...app.lifetime }, generation);
  } else throw Error('Invalid pairing message');
}
class WebRTCError extends Error {}
async function rtc(operation) {
  try { return await operation(); }
  catch { throw new WebRTCError('WebRTC setup failed. Check network or TURN.'); }
}
function setupPeer() {
  if (app.pc || !app.configuration) throw Error('Invalid connection');
  let pc;
  try { pc = new RTCPeerConnection(app.configuration); }
  catch { throw new WebRTCError('WebRTC is unavailable in this browser.'); }
  const generation = app.generation;
  app.pc = pc;
  pc.onicecandidate = event => {
    if (!current(generation)) return;
    signalSend({ type: 'candidate', candidate: event.candidate?.toJSON() ?? null }, generation)
      .catch(() => { if (current(generation)) closeSession('Could not send WebRTC connection details.'); });
  };
  pc.ondatachannel = event => {
    if (!current(generation)) return;
    try { attachChannel(event.channel); } catch { securityFailure(); }
  };
  pc.onconnectionstatechange = () => {
    if (!current(generation)) return;
    switch (pc.connectionState) {
      case 'failed': case 'closed': closeSession('Connection lost. Get a new code.'); break;
      case 'disconnected':
        app.disconnectedAt = Date.now(); status('Connection interrupted'); text('route', 'reconnecting'); renderFiles(); break;
      case 'connected':
        app.disconnectedAt = 0; status('Both devices online', 'connected'); renderFiles(); updateRoute(pc, generation).catch(() => {}); break;
    }
  };
  return pc;
}
function localSdp(pc) {
  const sdp = pc.localDescription?.sdp;
  if (typeof sdp !== 'string' || byteLength(sdp) > 128 * 1024 || !sdp.includes('a=fingerprint:')) throw Error('Missing DTLS fingerprint');
  return sdp;
}
function validCandidate(candidate) {
  return candidate === null || (candidate && Object.getPrototypeOf(candidate) === Object.prototype
    && Object.keys(candidate).every(key => ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))
    && typeof candidate.candidate === 'string' && byteLength(candidate.candidate) <= 8192
    && (candidate.sdpMid === null || (typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 256))
    && (candidate.sdpMLineIndex === null || (unsigned(candidate.sdpMLineIndex) && candidate.sdpMLineIndex <= 65535))
    && (candidate.usernameFragment == null || (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 256)));
}
async function applyCandidates(pc, generation) {
  // Candidates can arrive before the authenticated offer or answer.
  while (app.remoteCandidates.length && current(generation)) {
    const candidate = app.remoteCandidates.shift();
    await rtc(() => pc.addIceCandidate(candidate));
  }
}
async function createOffer(generation) {
  if (!current(generation)) return;
  const pc = setupPeer();
  const channel = await rtc(() => pc.createDataChannel('folder', { ordered: true }));
  if (!current(generation)) return;
  attachChannel(channel);
  const offer = await rtc(() => pc.createOffer());
  if (!current(generation)) return;
  await rtc(() => pc.setLocalDescription(offer));
  if (current(generation)) await signalSend({ type: 'offer', sdp: localSdp(pc) }, generation);
}
async function handleSignal(value, generation) {
  if (!current(generation)) return;
  if (value?.type === 'lifetime') {
    if (app.lifetimeConfirmed || !Number.isSafeInteger(value.ttl) || value.ttl < 60 || value.ttl > MAX_TTL
      || typeof value.explicit !== 'boolean' || (!value.explicit && value.ttl !== DEFAULT_TTL)
      || !positive(value.expires_at)) throw Error('Invalid lifetime preference');
    const own = app.lifetime;
    const expiry = own.explicit && !value.explicit ? own.expires_at
      : !own.explicit && value.explicit ? value.expires_at
      : Math.min(own.expires_at, value.expires_at);
    // Both browsers apply the same authenticated preferences; the server cannot extend them.
    app.expiresAt = app.localExpiresAt = Math.min(app.expiresAt, app.localExpiresAt, expiry);
    if (app.expiresAt <= Date.now()) throw Error('Folder expired. Temporary state cleared.');
    app.lifetimeConfirmed = true;
    app.connectingAt = Date.now();
    status('Opening auth channel'); tick(); wsSend({ type: 'paired' });
    if (app.role === 'a') await createOffer(generation);
    return;
  }
  if (!app.lifetimeConfirmed) throw Error('Lifetime not confirmed');
  if (value?.type === 'candidate') {
    if (!validCandidate(value.candidate) || app.remoteCandidates.length >= 256) throw Error('Invalid ICE candidate');
    app.remoteCandidates.push(value.candidate);
    if (app.pc?.remoteDescription) await applyCandidates(app.pc, generation);
    return;
  }
  const sdp = value?.sdp;
  if (typeof sdp !== 'string' || byteLength(sdp) > 128 * 1024 || !sdp.includes('a=fingerprint:')) throw Error('Missing DTLS fingerprint');
  if (value.type === 'offer' && app.role === 'b') {
    const pc = setupPeer(); await rtc(() => pc.setRemoteDescription({ type: 'offer', sdp }));
    if (!current(generation)) return;
    await applyCandidates(pc, generation);
    const answer = await rtc(() => pc.createAnswer());
    if (!current(generation)) return;
    await rtc(() => pc.setLocalDescription(answer));
    if (current(generation)) await signalSend({ type: 'answer', sdp: localSdp(pc) }, generation);
  } else if (value.type === 'answer' && app.role === 'a') {
    if (!app.pc || app.pc.remoteDescription) throw Error('Invalid answer');
    await rtc(() => app.pc.setRemoteDescription({ type: 'answer', sdp }));
    if (current(generation)) await applyCandidates(app.pc, generation);
  } else throw Error('Invalid SDP');
}
async function updateRoute(pc, generation) {
  const stats = await pc.getStats();
  if (!current(generation)) return;
  let selected;
  for (const value of stats.values()) if (value.type === 'transport') selected = value.selectedCandidatePairId;
  for (const value of stats.values()) {
    if (value.type !== 'candidate-pair' || value.state !== 'succeeded'
      || !(value.nominated || value.selected || selected === value.id)) continue;
    const relay = [stats.get(value.localCandidateId), stats.get(value.remoteCandidateId)].some(v => v?.candidateType === 'relay');
    text('route', relay ? 'via TURN' : 'direct connection'); return;
  }
  text('route', 'authenticated connection');
}
function attachChannel(channel) {
  if (app.channel || channel.label !== 'folder' || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) throw Error('Invalid channel');
  app.channel = channel; channel.binaryType = 'arraybuffer';
  const generation = app.generation;
  channel.onopen = () => { if (current(generation)) channelReady(); };
  channel.onmessage = event => {
    if (!current(generation)) return;
    try {
      if (typeof event.data === 'string') {
        if (byteLength(event.data) > MAX_CONTROL) throw Error('Message size limit exceeded');
        handleControl(parseControl(event.data), generation);
      } else if (event.data instanceof ArrayBuffer && event.data.byteLength <= CHUNK + 40) {
        receiveChunk(event.data, generation).catch(() => { if (current(generation)) closeSession('Invalid file chunk'); });
      } else throw Error('Invalid file chunk');
    } catch (error) { closeSession(errorText(error)); }
  };
  channel.onclose = () => { if (current(generation)) closeSession('Other device disconnected. Folder closed.'); };
  channel.onerror = () => { if (current(generation)) closeSession('Channel error. Folder closed.'); };
  if (channel.readyState === 'open') channelReady();
}
function channelReady() {
  if (!app.paired || !app.lifetimeConfirmed || Date.now() >= Math.min(app.expiresAt, app.localExpiresAt) || !app.pc?.remoteDescription) { securityFailure(); return; }
  app.connectingAt = 0;
  status('Both devices online', 'connected'); tick(); hidden('folder', false); notice('');
  renderFiles(); sendInventory();
}
const entryKind = entry => entry.kind === undefined ? 'file' : entry.kind;
const entryParent = entry => entry.parent ?? null;
const directoryRevision = entry => entry.revision ?? entry.id;
const parentRevision = entry => entry.parentRevision ?? entryParent(entry);
const entryFields = ['id', 'name', 'size', 'version', 'clock', 'actor', 'owner', 'deleted', 'kind', 'parent', 'parentRevision', 'revision'];
function validEntry(file) {
  return file && Object.getPrototypeOf(file) === Object.prototype && Object.keys(file).every(key => entryFields.includes(key))
    && validHex(file.id) && typeof file.name === 'string' && byteLength(file.name) > 0
    && byteLength(file.name) <= 1024 && unsigned(file.size) && file.size <= 2 ** 50
    && positive(file.version) && positive(file.clock) && ['a', 'b'].includes(file.actor)
    && ['a', 'b'].includes(file.owner) && typeof file.deleted === 'boolean'
    && ['file', 'directory'].includes(entryKind(file))
    && (entryParent(file) === null || validHex(entryParent(file)))
    && (file.revision === undefined || (entryKind(file) === 'directory' && validHex(file.revision)))
    && (entryParent(file) === null ? parentRevision(file) === null : validHex(parentRevision(file)))
    && (entryKind(file) !== 'directory' || file.size === 0);
}
function ancestors(entry, entries = app.files) {
  const parents = [];
  const seen = new Set([entry.id]);
  let parent = entryParent(entry);
  while (parent !== null) {
    const directory = entries.get(parent);
    if (!directory || entryKind(directory) !== 'directory' || seen.has(parent) || parents.length >= MAX_DEPTH) throw Error('Invalid folder hierarchy');
    parents.push(directory); seen.add(parent); parent = entryParent(directory);
  }
  return parents;
}
function entryUnavailable(entry, entries = app.files) {
  if (entry.deleted) return true;
  let child = entry;
  for (const parent of ancestors(entry, entries)) {
    if (parent.deleted || parentRevision(child) !== directoryRevision(parent)) return true;
    child = parent;
  }
  return false;
}
function sendInventory() {
  const entries = Array.from(app.files.values()).sort((a, b) => ancestors(a).length - ancestors(b).length);
  let batch = [];
  for (const entry of entries) {
    if (byteLength(JSON.stringify({ type: 'inventory', files: [...batch, entry] })) > MAX_CONTROL) {
      tryControl({ type: 'inventory', files: batch }); batch = [];
    }
    batch.push(entry);
  }
  if (batch.length) tryControl({ type: 'inventory', files: batch });
}
function parseControl(payload) {
  const value = JSON.parse(payload);
  const fields = { inventory: ['files'], put: ['file'], get: ['transfer', 'id', 'version'],
    start: ['transfer', 'id', 'version', 'size'], ack: ['transfer'], done: ['transfer'],
    cancel: ['transfer'], error: ['transfer', 'message'] };
  const required = fields[value?.type];
  if (!required || Object.keys(value).length !== required.length + 1 || !required.every(key => Object.hasOwn(value, key))) throw Error('Invalid folder message');
  if (required.includes('transfer') && typeof value.transfer !== 'string') throw Error('Invalid transfer');
  if (required.includes('id') && typeof value.id !== 'string') throw Error('Invalid file ID');
  if (required.includes('version') && !unsigned(value.version)) throw Error('Invalid version');
  if (required.includes('size') && !unsigned(value.size)) throw Error('Invalid size');
  if (value.type === 'inventory' && !Array.isArray(value.files)) throw Error('Invalid inventory');
  if (value.type === 'error' && typeof value.message !== 'string') throw Error('Invalid transfer message');
  return value;
}
function mergeEntry(file, inventory) {
  if (!validEntry(file)) throw Error('Invalid file entry');
  if (!inventory && file.actor !== (app.role === 'a' ? 'b' : 'a')) throw Error('Invalid change author');
  app.clock = Math.max(app.clock, file.clock);
  const old = app.files.get(file.id);
  if (old && (file.clock < old.clock || (file.clock === old.clock && file.actor <= old.actor))) return;
  if (!old && app.files.size >= MAX_FILES) throw Error('File count limit exceeded');
  if (old && (entryKind(old) !== entryKind(file) || entryParent(old) !== entryParent(file)
    || parentRevision(old) !== parentRevision(file))) throw Error('File hierarchy changed');
  ancestors(file);
  if (file.deleted || file.owner !== app.role || old?.version !== file.version) app.local.delete(file.id);
  app.files.set(file.id, { ...file });
}
function handleControl(value, generation) {
  switch (value.type) {
    case 'inventory':
      if (value.files.length > MAX_FILES) throw Error('File count limit exceeded');
      for (const file of value.files) mergeEntry(file, true);
      renderFiles(); break;
    case 'put': mergeEntry(value.file, false); renderFiles(); break;
    case 'get': {
      if (!validHex(value.transfer) || !validHex(value.id)) throw Error('Invalid file request');
      try {
        if (app.outgoing) throw Error('Source is already sending a file');
        const entry = app.files.get(value.id);
        if (!entry || entryKind(entry) !== 'file' || entryUnavailable(entry)) throw Error('File unavailable');
        if (entry.version !== value.version || entry.owner !== app.role) throw Error('File version changed. Retry the request.');
        const file = app.local.get(value.id);
        if (!file) throw Error('Source unavailable');
        app.outgoing = { transfer: value.transfer, file, offset: 0, size: entry.size, busy: false,
          started: Date.now(), activity: Date.now() };
        controlSend({ type: 'start', transfer: value.transfer, id: value.id, version: value.version, size: entry.size });
        transferProgress(false);
      } catch (error) {
        if (app.outgoing?.transfer === value.transfer) cancelOne(value.transfer, 'Could not start transfer');
        tryControl({ type: 'error', transfer: value.transfer, message: errorText(error) });
      }
      break;
    }
    case 'start': {
      const receiver = app.incoming;
      if (receiver?.transfer !== value.transfer) return;
      if (receiver.id !== value.id || receiver.version !== value.version || receiver.size !== value.size
        || receiver.offset !== 0 || receiver.startedAck) throw Error('Invalid transfer start');
      receiver.startedAck = true;
      receiver.activity = Date.now();
      try { controlSend({ type: 'ack', transfer: value.transfer }); } catch { clearTransfer('Transfer failed'); }
      break;
    }
    case 'ack':
      if (app.outgoing?.transfer !== value.transfer || app.outgoing.busy) return;
      app.outgoing.activity = Date.now();
      sendChunk(value.transfer, generation).catch(error => {
        if (current(generation) && app.outgoing?.transfer === value.transfer) {
          tryControl({ type: 'cancel', transfer: value.transfer }); cancelOne(value.transfer, errorText(error));
        }
      }); break;
    case 'done':
      finishDownload(value.transfer, generation).catch(error => { if (current(generation)) closeSession(errorText(error)); }); break;
    case 'cancel': cancelOne(value.transfer, 'Transfer cancelled'); break;
    case 'error':
      if (byteLength(value.message) > 1024) throw Error('Invalid transfer message');
      cancelOne(value.transfer, value.message); break;
  }
}
function cancelOne(transfer, message) {
  if (app.outgoing?.transfer === transfer) app.outgoing = null;
  if (app.incoming?.transfer === transfer) {
    const receiver = app.incoming;
    app.incoming = null; app.receivingDone = false; abortReceiver(receiver);
  }
  hidden('transfer', !app.incoming && !app.outgoing && !app.folderDownload); notice(message);
}
function cancelAll() {
  cancelFolderDownload();
  for (const transfer of [app.outgoing?.transfer, app.incoming?.transfer].filter(Boolean)) {
    tryControl({ type: 'cancel', transfer }); cancelOne(transfer, 'Transfer cancelled');
  }
}
async function sendChunk(transfer, generation) {
  if (!current(generation)) return;
  const sender = app.outgoing;
  if (!sender || sender.transfer !== transfer || sender.busy) return;
  sender.busy = true;
  const { file, offset, size } = sender;
  if (offset === size) {
    controlSend({ type: 'done', transfer }); app.outgoing = null;
    hidden('transfer', !app.incoming && !app.folderDownload); notice('File sent'); return;
  }
  const end = Math.min(offset + CHUNK, size);
  const bytes = await file.slice(offset, end).arrayBuffer();
  if (bytes.byteLength !== end - offset) throw Error('File changed or unavailable');
  if (!current(generation) || app.outgoing !== sender) return;
  const channel = app.channel;
  if (!channel) throw Error('Channel closed');
  const started = Date.now();
  while (channel.bufferedAmount > 64 * 1024) {
    if (!current(generation) || app.outgoing !== sender) return;
    if (Date.now() - started > 30000) throw Error('Transfer is not responding');
    await delay(20);
  }
  if (!current(generation) || app.outgoing !== sender) return;
  // One bounded chunk stays outstanding until its destination write completes.
  const packet = new Uint8Array(40 + bytes.byteLength);
  packet.set(encoder.encode(transfer));
  new DataView(packet.buffer).setBigUint64(32, BigInt(offset), false);
  packet.set(new Uint8Array(bytes), 40); channel.send(packet.buffer);
  sender.offset = end; sender.busy = false; sender.activity = Date.now(); transferProgress(false);
}
async function receiveChunk(buffer, generation) {
  if (!current(generation)) return;
  if (buffer.byteLength < 40) throw Error('Invalid file header');
  const packet = new Uint8Array(buffer);
  const transfer = decoder.decode(packet.subarray(0, 32));
  const offset = new DataView(buffer).getBigUint64(32, false);
  const length = packet.byteLength - 40;
  const receiver = app.incoming;
  // One bounded packet can remain in flight after a cancellation.
  if (!receiver || receiver.transfer !== transfer) return;
  if (!receiver.startedAck || receiver.busy || offset !== BigInt(receiver.offset)
    || length === 0 || length !== Math.min(receiver.size - receiver.offset, CHUNK)) throw Error('Invalid file chunk');
  receiver.busy = true;
  const bytes = packet.subarray(40);
  if (receiver.download || receiver.writer) {
    try {
      if (receiver.folder) checkFolderDownload(receiver.folder, receiver.entry);
      if (receiver.download) await receiver.download.push(bytes);
      else await receiver.writer.write(bytes);
    } catch (error) {
      if (current(generation) && app.incoming === receiver) {
        tryControl({ type: 'cancel', transfer }); cancelOne(transfer, `Could not write file: ${errorText(error)}`);
      }
      return;
    }
    if (!current(generation) || app.incoming !== receiver) return;
  } else {
    if (receiver.offset + length > FALLBACK_LIMIT) {
      tryControl({ type: 'cancel', transfer }); cancelOne(transfer, 'Memory limit: 32 MiB'); return;
    }
    receiver.chunks.push(bytes);
  }
  receiver.offset += length; receiver.busy = false; receiver.activity = Date.now(); transferProgress(true);
  try { controlSend({ type: 'ack', transfer }); } catch { clearTransfer('Connection lost'); }
}
async function finishDownload(transfer, generation) {
  if (!current(generation)) return;
  const receiver = app.incoming;
  if (!receiver || receiver.transfer !== transfer) return;
  if (!receiver.startedAck || receiver.offset !== receiver.size || receiver.busy) throw Error('Invalid transfer completion');
  app.receivingDone = true; receiver.busy = true;
  let message, failure;
  try {
    if (receiver.folder) checkFolderDownload(receiver.folder, receiver.entry);
    if (receiver.download) await receiver.download.finish();
    else if (receiver.writer) await receiver.writer.close();
    else downloadBlob(new Blob(receiver.chunks), receiver.name);
    message = receiver.writer ? 'File saved' : 'Sent to download manager';
  } catch (error) {
    failure = error;
    abortReceiver(receiver); message = 'Could not save file';
  }
  if (!current(generation) || app.incoming !== receiver) return;
  app.receivingDone = false; app.incoming = null;
  hidden('transfer', !app.outgoing && !app.folderDownload);
  if (failure) receiver.reject?.(failure);
  else receiver.resolve?.();
  if (!receiver.resolve) notice(message);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function downloadFile(id) {
  if (app.folderDownload) throw Error('Finish the current folder download first');
  const file = app.files.get(id);
  if (!file || entryKind(file) !== 'file' || entryUnavailable(file)) throw Error('File unavailable');
  const local = app.local.get(id);
  if (local) { downloadBlob(local, file.name); return; }
  if (app.incoming || app.preparingDownload || app.receivingDone) throw Error('Finish the current download first');
  app.preparingDownload = true;
  const generation = app.generation;
  (async () => {
    let downloader;
    try {
      let streaming = available();
      if (!streaming) {
        try { await prepare(); } catch { /* Small files can use a Blob download. */ }
        streaming = available();
      }
      if (!current(generation)) return;
      if (!streaming && file.size > FALLBACK_LIMIT) throw Error('Files larger than 32 MiB need streaming browser downloads.');
      if (streaming) downloader = await Download.create(file.name, file.size);
      const latest = app.files.get(id);
      if (!current(generation) || !latest || entryUnavailable(latest) || latest.version !== file.version || latest.owner !== file.owner) throw Error('File version changed. Retry the request.');
      const transfer = randomId();
      app.incoming = { transfer, name: file.name, id, version: file.version, size: file.size,
        offset: 0, download: downloader, chunks: [], busy: false, startedAck: false,
        started: Date.now(), activity: Date.now() };
      try { controlSend({ type: 'get', transfer, id, version: file.version }); }
      catch (error) { cancelOne(transfer, 'Source unavailable'); throw error; }
      transferProgress(true); notice('');
    } catch (error) {
      abortReceiver({ download: downloader });
      if (current(generation)) notice(errorText(error));
    } finally { if (current(generation)) app.preparingDownload = false; }
  })();
}
function checkFolderDownload(job, entry) {
  if (!current(job.generation) || app.folderDownload !== job || job.cancelled) throw Error('Folder download cancelled');
  if (app.channel?.readyState !== 'open') throw Error('Connection lost');
  const latest = app.files.get(entry.id);
  if (!latest || entryUnavailable(latest) || latest.clock !== entry.clock || latest.actor !== entry.actor) throw Error('Folder changed. Retry the download.');
}
async function newDestinationFolder(destination, name, job, root) {
  for (let index = 1; index <= 1024; index++) {
    checkFolderDownload(job, root);
    const candidate = index === 1 ? name : `${name} (${index})`;
    try {
      await destination.getDirectoryHandle(candidate);
    } catch (error) {
      if (error.name === 'NotFoundError') {
        checkFolderDownload(job, root);
        return destination.getDirectoryHandle(candidate, { create: true });
      }
      if (error.name !== 'TypeMismatchError') throw error;
    }
  }
  throw Error('No unused folder name available');
}
function receiveFolderFile(entry, writer, job) {
  checkFolderDownload(job, entry);
  return new Promise((resolve, reject) => {
    const transfer = randomId();
    app.incoming = { transfer, name: entry.name, id: entry.id, version: entry.version, size: entry.size,
      offset: 0, writer, chunks: [], busy: false, startedAck: false, started: Date.now(),
      activity: Date.now(), folder: job, entry, resolve, reject };
    try { controlSend({ type: 'get', transfer, id: entry.id, version: entry.version }); }
    catch (error) { cancelOne(transfer, errorText(error)); }
    transferProgress(true);
  });
}
async function downloadFolder(id) {
  if (!app.paired || app.channel?.readyState !== 'open') throw Error('No connection');
  if (app.folderDownload || app.incoming || app.preparingDownload || app.receivingDone) throw Error('Finish the current download first');
  const root = app.files.get(id);
  if (!root || entryKind(root) !== 'directory' || entryUnavailable(root)) throw Error('Folder unavailable');
  if (typeof window.showDirectoryPicker !== 'function') throw Error('Saving a folder needs a browser with a directory picker, such as Chrome or Edge.');
  const entries = Array.from(app.files.values()).filter(entry => !entryUnavailable(entry)
    && (entry.id === id || ancestors(entry).some(parent => parent.id === id)))
    .sort((a, b) => ancestors(a).length - ancestors(b).length);
  const names = new Set();
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || /[\x00-\x1f\x7f/\\]/.test(entry.name)) throw Error('Folder contains an unsafe file name');
    const key = `${entryParent(entry)}:${entry.name.normalize('NFC').toLowerCase()}`;
    if (names.has(key)) throw Error('Folder contains conflicting file names');
    names.add(key);
    if (entryKind(entry) === 'file' && entry.owner === app.role && !app.local.has(entry.id)) throw Error('File source unavailable');
  }
  const job = { generation: app.generation, cancelled: false, writer: null,
    progress: { name: root.name, size: 0, offset: 0, started: Date.now() } };
  app.folderDownload = job;
  try {
    // Open the destination picker while the button click still has user activation.
    const destination = await window.showDirectoryPicker({ mode: 'readwrite', id: 'save-folder', startIn: 'downloads' });
    checkFolderDownload(job, root);
    const savedRoot = await newDestinationFolder(destination, root.name, job, root);
    checkFolderDownload(job, root);
    const directories = new Map([[root.id, savedRoot]]);
    transferProgress(true); notice('');
    for (const entry of entries) {
      checkFolderDownload(job, root); checkFolderDownload(job, entry);
      if (entry.id === root.id) continue;
      const parent = directories.get(entryParent(entry));
      if (!parent) throw Error('Invalid folder hierarchy');
      if (entryKind(entry) === 'directory') {
        const directory = await parent.getDirectoryHandle(entry.name, { create: true });
        checkFolderDownload(job, entry);
        directories.set(entry.id, directory);
        continue;
      }
      const handle = await parent.getFileHandle(entry.name, { create: true });
      checkFolderDownload(job, entry);
      const writer = await handle.createWritable();
      job.writer = writer;
      checkFolderDownload(job, entry);
      const local = app.local.get(entry.id);
      if (local) {
        job.progress = { name: entry.name, size: entry.size, offset: 0, started: Date.now() };
        transferProgress(true);
        for (let offset = 0; offset < entry.size; offset += CHUNK) {
          const end = Math.min(offset + CHUNK, entry.size);
          const bytes = await local.slice(offset, end).arrayBuffer();
          checkFolderDownload(job, entry);
          if (bytes.byteLength !== end - offset) throw Error('File changed or unavailable');
          await writer.write(bytes);
          checkFolderDownload(job, entry);
          job.progress.offset = end; transferProgress(true);
        }
        checkFolderDownload(job, entry);
        await writer.close();
      } else await receiveFolderFile(entry, writer, job);
      job.writer = null;
      checkFolderDownload(job, entry);
    }
    for (const entry of entries) checkFolderDownload(job, entry);
    notice('Folder saved');
  } catch (error) {
    abortReceiver({ writer: job.writer });
    if (current(job.generation) && app.folderDownload === job && error.name !== 'AbortError') notice(`${errorText(error)}. Completed files remain in the destination folder.`);
  } finally {
    if (app.folderDownload === job) {
      app.folderDownload = null;
      hidden('transfer', !app.incoming && !app.outgoing);
    }
  }
}
function transferProgress(receiving) {
  const transfer = receiving ? app.incoming || app.folderDownload?.progress : app.outgoing;
  if (!transfer) return;
  const { offset, size, started } = transfer;
  const elapsed = Math.max((Date.now() - started) / 1000, 0.001);
  const speed = offset / elapsed;
  const percentage = size === 0 ? 100 : 100 * offset / size;
  hidden('transfer', false);
  text('transfer-label', `${receiving ? '↓' : '↑'} ${receiving ? transfer.name : transfer.file.name}`);
  element('progress').value = percentage;
  text('progress-text', `${fileSize(offset)} / ${fileSize(size)} · ${percentage.toFixed(0)}%${speed > 0 ? ` · ~${timeLeft((size - offset) / speed)}` : ''}`);
}
function fileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  if (size < 1024 ** 4) return `${(size / 1024 ** 3).toFixed(1)} GiB`;
  if (size < 1024 ** 5) return `${(size / 1024 ** 4).toFixed(1)} TiB`;
  return `${(size / 1024 ** 5).toFixed(1)} PiB`;
}
function timeLeft(seconds) {
  const s = Math.ceil(Math.max(0, seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
    : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function node(tag, className, value = '') {
  const result = document.createElement(tag); result.className = className; result.textContent = value; return result;
}
function renderFiles() {
  if (filesRenderFrame !== null) return;
  filesRenderFrame = requestAnimationFrame(() => {
    filesRenderFrame = null;
    renderFileList();
  });
}
function renderFileList() {
  const focused = document.activeElement?.closest('#files [data-action]');
  const focusId = focused?.dataset.id;
  const focusAction = focused?.dataset.action;
  const container = element('files'); container.replaceChildren();
  const entries = Array.from(app.files.values()).filter(entry => !entryUnavailable(entry));
  if (!entries.length) { container.append(node('p', 'empty', 'Folder empty')); return; }
  const children = new Map();
  const totals = new Map();
  for (const entry of entries) {
    const parent = entryParent(entry);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
    if (entryKind(entry) === 'file') {
      for (const directory of ancestors(entry)) totals.set(directory.id, (totals.get(directory.id) || 0) + entry.size);
    }
  }
  const online = app.pc?.connectionState === 'connected';
  function branch(parent, prefix = '') {
    const siblings = (children.get(parent) || []).sort((a, b) => {
      const kinds = Number(entryKind(b) === 'directory') - Number(entryKind(a) === 'directory');
      return kinds || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id));
    });
    siblings.forEach((entry, index) => {
      const directory = entryKind(entry) === 'directory';
      const last = index === siblings.length - 1;
      const row = node('div', 'file');
      if (parent !== null) row.append(node('span', 'tree-prefix', prefix + (last ? '└─' : '├─')));
      const name = node('button', directory ? 'file-name directory-toggle' : 'file-name');
      name.type = 'button'; name.dataset.action = directory ? 'toggle' : 'select'; name.dataset.id = entry.id;
      name.setAttribute('aria-keyshortcuts', 'd r q');
      name.title = entry.name;
      if (directory) {
        name.dataset.extraCells = '2'; name.setAttribute('aria-expanded', String(app.expanded.has(entry.id)));
        const marker = node('span', 'directory-marker'); marker.setAttribute('aria-hidden', 'true');
        name.append(marker, node('span', 'directory-name', entry.name.replace(/[\r\n\t]/g, ' ')));
      } else name.textContent = entry.name.replace(/[\r\n\t]/g, ' ');
      row.append(name, node('span', 'version', `v${entry.version}`));
      const actions = node('span', 'file-actions');
      for (const action of ['download', 'replace', 'delete']) {
        const button = node('button', 'file-action', { download: 'dow', replace: 'rep', delete: 'del' }[action]);
        button.type = 'button'; button.tabIndex = -1;
        button.dataset.action = action; button.dataset.id = entry.id;
        button.title = action;
        disableButton(button, action === 'download' && entry.owner !== app.role && !online);
        actions.append(button);
      }
      row.append(actions);
      const source = node('span', 'file-source', entry.owner === app.role ? 'l' : online ? 'o' : '-');
      source.title = entry.owner === app.role ? 'Local' : online ? 'Peer online' : 'Peer offline';
      row.append(node('span', 'file-size', fileSize(directory ? totals.get(entry.id) || 0 : entry.size)), source);
      container.append(row);
      if (directory && app.expanded.has(entry.id)) branch(entry.id, parent === null ? '' : prefix + (last ? '  ' : '│ '));
    });
  }
  branch(null);
  if (focusId) {
    Array.from(container.querySelectorAll('[data-action]'))
      .find(button => button.dataset.id === focusId && button.dataset.action === focusAction)?.focus({ preventScroll: true });
  }
}
function nextClock() {
  if (app.clock >= Number.MAX_SAFE_INTEGER - 1) throw Error('Change limit');
  return ++app.clock;
}
function addFile(file, replace = null) {
  if (!app.paired || app.channel?.readyState !== 'open') throw Error('No connection');
  if (!file.name || byteLength(file.name) > 1024 || !unsigned(file.size) || file.size > 2 ** 50) throw Error('Invalid file');
  if (replace && (!app.files.has(replace) || entryKind(app.files.get(replace)) !== 'file'
    || entryUnavailable(app.files.get(replace)))) throw Error('File unavailable');
  if (!replace && (app.created.size >= MAX_LOCAL_ENTRIES || app.files.size >= MAX_FILES)) throw Error(`Local limit: ${MAX_LOCAL_ENTRIES} files and directories, including deleted entries.`);
  const id = replace || randomId(); const old = app.files.get(id);
  const version = old ? old.version + 1 : 1;
  if (!positive(version)) throw Error('Version limit');
  const entry = { id, kind: 'file', parent: old ? entryParent(old) : null, parentRevision: old ? parentRevision(old) : null,
    name: file.name, size: file.size, version, clock: nextClock(), actor: app.role, owner: app.role, deleted: false };
  app.files.set(id, entry); app.local.set(id, file);
  if (!replace) app.created.add(id);
  controlSend({ type: 'put', file: entry }); renderFiles(); notice('');
}
function deleteFile(id) {
  const old = app.files.get(id);
  if (!old || old.deleted) throw Error('File deleted');
  const entries = Array.from(app.files.values()).filter(entry => !entry.deleted && (entry.id === id || ancestors(entry).some(parent => parent.id === id)));
  for (const oldEntry of entries) {
    const entry = { ...oldEntry, clock: nextClock(), actor: app.role, deleted: true };
    app.files.set(entry.id, entry); app.local.delete(entry.id); app.expanded.delete(entry.id);
    controlSend({ type: 'put', file: entry });
  }
  renderFiles(); notice('');
}
function commitFolder(entries, generation, replacement = null) {
  if (!current(generation)) return;
  if (!app.paired || app.channel?.readyState !== 'open') throw Error('No connection');
  if (replacement) {
    const latest = app.files.get(replacement.id);
    if (!latest || entryUnavailable(latest) || latest.clock !== replacement.clock || latest.actor !== replacement.actor) throw Error('Folder changed. Choose its replacement again.');
  }
  const added = entries.length - Number(Boolean(replacement));
  if (app.created.size + added > MAX_LOCAL_ENTRIES || app.files.size + added > MAX_FILES) throw Error(`Local limit: ${MAX_LOCAL_ENTRIES} files and directories, including deleted entries.`);
  const removed = replacement ? Array.from(app.files.values()).filter(entry => !entry.deleted
    && ancestors(entry).some(parent => parent.id === replacement.id)) : [];
  if (app.clock >= Number.MAX_SAFE_INTEGER - entries.length - removed.length - 1) throw Error('Change limit');
  const combined = new Map(app.files);
  for (const item of entries) combined.set(item.entry.id, item.entry);
  for (const { entry } of entries) {
    if (!validEntry(entry)) throw Error('Invalid folder entry');
    ancestors(entry, combined);
  }
  for (const old of removed) {
    const entry = { ...old, deleted: true, clock: nextClock(), actor: app.role };
    app.files.set(entry.id, entry); app.local.delete(entry.id); app.expanded.delete(entry.id);
    controlSend({ type: 'put', file: entry });
  }
  for (const { entry, file } of entries) {
    if (!app.files.has(entry.id)) app.created.add(entry.id);
    entry.clock = nextClock(); app.files.set(entry.id, entry);
    if (file) app.local.set(entry.id, file);
    controlSend({ type: 'put', file: entry });
  }
  renderFiles(); notice('');
}
function folderEntry(entries, name, kind, parent, file = null, replacement = null) {
  const replacingRoot = replacement && entries.length === 0;
  const added = entries.length - Number(Boolean(replacement) && !replacingRoot);
  if (!replacingRoot && (app.created.size + added >= MAX_LOCAL_ENTRIES || app.files.size + added >= MAX_FILES)) throw Error(`Local limit: ${MAX_LOCAL_ENTRIES} files and directories, including deleted entries.`);
  const entry = { id: replacingRoot ? replacement.id : randomId(), kind,
    parent: replacingRoot ? entryParent(replacement) : parent?.id ?? null,
    parentRevision: replacingRoot ? parentRevision(replacement) : parent ? directoryRevision(parent) : null,
    name, size: file?.size || 0, version: replacingRoot ? replacement.version + 1 : 1,
    clock: 1, actor: app.role, owner: app.role, deleted: false };
  if (kind === 'directory') entry.revision = replacingRoot ? randomId() : entry.id;
  if (!validEntry(entry)) throw Error('Invalid folder entry');
  entries.push({ entry, file }); return entry;
}
async function chooseFolder(replace = null) {
  if (!app.paired || app.channel?.readyState !== 'open') throw Error('No connection');
  const replacement = replace ? app.files.get(replace) : null;
  if (replace && (!replacement || entryKind(replacement) !== 'directory' || entryUnavailable(replacement))) throw Error('Folder unavailable');
  const generation = app.generation;
  if (typeof window.showDirectoryPicker !== 'function') {
    app.directoryImport = { generation, replacement }; element('add-directory').click(); return;
  }
  try {
    const root = await window.showDirectoryPicker({ mode: 'read' });
    const entries = [];
    async function collect(handle, parent = null, depth = 0) {
      if (!current(generation)) throw Error('Session closed');
      if (depth >= MAX_DEPTH) throw Error('Folder nesting limit: 32 levels.');
      const directory = folderEntry(entries, handle.name, 'directory', parent, null, replacement);
      for await (const child of handle.values()) {
        if (child.kind === 'directory') await collect(child, directory, depth + 1);
        else {
          const file = await child.getFile();
          if (!current(generation)) throw Error('Session closed');
          folderEntry(entries, child.name, 'file', directory, file, replacement);
        }
      }
    }
    await collect(root); commitFolder(entries, generation, replacement);
  } catch (error) {
    if (error.name !== 'AbortError' && current(generation)) notice(errorText(error));
  }
}
function importDirectory(files, context) {
  if (!context || !current(context.generation)) return;
  const { generation, replacement } = context;
  const entries = [];
  const directories = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath.split('/');
    if (path.length < 2 || path.some(part => !part || part === '.' || part === '..') || path.length - 1 > MAX_DEPTH) throw Error('Invalid folder path');
    let parent = null;
    for (let index = 0; index < path.length - 1; index++) {
      const key = path.slice(0, index + 1).join('/');
      if (!directories.has(key)) directories.set(key, folderEntry(entries, path[index], 'directory', parent, null, replacement));
      parent = directories.get(key);
    }
    folderEntry(entries, file.name, 'file', parent, file, replacement);
  }
  if (entries.length) commitFolder(entries, generation, replacement);
}
function tick() {
  if (app.connectingAt && Date.now() - app.connectingAt > CHANNEL_OPEN_TIMEOUT) {
    closeSession('WebRTC connection timed out. Check network or TURN.'); return;
  }
  if (app.disconnectedAt && Date.now() - app.disconnectedAt > 30000) { closeSession('Connection not restored. Folder closed.'); return; }
  if (app.incoming?.download?.cancelled) {
    const transfer = app.incoming.transfer; tryControl({ type: 'cancel', transfer }); cancelOne(transfer, 'Download cancelled in browser');
  }
  for (const direction of ['incoming', 'outgoing']) {
    const transfer = app[direction];
    if (transfer && !transfer.busy && Date.now() - transfer.activity > TRANSFER_IDLE_TIMEOUT) {
      tryControl({ type: 'cancel', transfer: transfer.transfer });
      cancelOne(transfer.transfer, direction === 'incoming' ? 'File source is not responding' : 'File destination is not responding');
    }
  }
  const expires = Math.min(app.expiresAt, app.localExpiresAt);
  const deadline = Math.min(app.pairingDeadline, app.localPairingDeadline);
  // Apply local bounds even while a server never sends its initial response.
  if (app.ws && Date.now() >= app.localExpiresAt) { closeSession('Folder expired. Temporary state cleared.'); return; }
  if (app.ws && !app.lifetimeConfirmed && Date.now() >= app.localPairingDeadline) {
    tryWs({ type: 'invalidate' }); closeSession('Code expired. Get a new code.'); return;
  }
  if (!expires) return;
  if (Date.now() >= expires) { closeSession('Folder expired. Temporary state cleared.'); return; }
  if (!app.lifetimeConfirmed && Date.now() >= deadline) { tryWs({ type: 'invalidate' }); closeSession('Code expired. Get a new code.'); return; }
  text('timer', app.lifetimeConfirmed
    ? `TTL ${timeLeft((expires - Date.now()) / 1000)}`
    : `TTL ${timeLeft((deadline - Date.now()) / 1000)}`);
}
function listen(id, event, handler) {
  element(id).addEventListener(event, value => {
    try { handler(value); } catch (error) { notice(errorText(error)); }
  });
}
status('Ready to connect', 'ready'); busy(false);
showCode('');
prepare().catch(() => {});
function replaceDefaultLifetime(event, value) {
  if (lifetimeEdited || !event.cancelable || typeof value !== 'string') return;
  const digits = value.replace(/[^0-9]/g, '').slice(0, 3);
  if (!digits) return;
  event.preventDefault();
  const input = element('ttl');
  input.value = digits;
  input.setSelectionRange(digits.length, digits.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
listen('ttl', 'beforeinput', event => {
  if (!event.isComposing && event.inputType.startsWith('insert')) replaceDefaultLifetime(event, event.data);
});
listen('ttl', 'paste', event => replaceDefaultLifetime(event, event.clipboardData?.getData('text')));
listen('ttl', 'input', () => {
  lifetimeEdited = true;
  element('ttl').dataset.edited = 'true';
  element('ttl').value = element('ttl').value.replace(/[^0-9]/g, '').slice(0, 3);
});
listen('ttl', 'keydown', event => { if (event.key === 'Enter') element('create').click(); });
listen('create', 'click', () => {
  const value = element('ttl').value;
  if (!/^[0-9]{1,3}$/.test(value) || Number(value) < 1) throw Error('Enter a lifetime from 1 to 999 minutes.');
  connect(randomSecret(), Number(value) * 60, lifetimeEdited);
});
listen('join', 'click', () => {
  const code = normalizeCode(element('join-code').value);
  if (!code) throw Error('Enter an eight-character code.');
  const peer = code.slice(0, 3), secret = code.slice(3);
  if (!app.room || app.peer || app.room === peer) throw Error("Get your code first, then enter the other device's code once.");
  if (Date.now() >= Math.min(app.pairingDeadline, app.localPairingDeadline)) throw Error('Your code has expired. Get a new code.');
  app.peer = peer; app.peerSecret = secret; clearJoinCode(); disableButton(element('join'), true);
  wsSend({ type: 'select', peer }); status('Waiting other device');
});
const cleanPeerCode = value => value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
function setPeerCode(value, cursor = value.length) {
  const input = element('join-code');
  const code = cleanPeerCode(value).slice(0, 8);
  input.value = code.slice(0, 4).padEnd(4, ' ') + '-' + code.slice(4);
  const offset = Math.min(cursor, code.length);
  const position = offset < 4 ? offset : offset + 1;
  input.setSelectionRange(position, position);
}
listen('join-code', 'beforeinput', event => {
  if (event.isComposing || !event.cancelable) return;
  const input = element('join-code');
  const code = cleanPeerCode(input.value);
  let start = cleanPeerCode(input.value.slice(0, input.selectionStart)).length;
  let end = cleanPeerCode(input.value.slice(0, input.selectionEnd)).length;
  let inserted = '';
  if (event.inputType.startsWith('insert') && typeof event.data === 'string') {
    inserted = cleanPeerCode(event.data);
  } else if (event.inputType.startsWith('delete')) {
    if (start === end && event.inputType.endsWith('Backward')) {
      start = /Word|Line/.test(event.inputType) ? 0 : Math.max(0, start - 1);
    } else if (start === end && event.inputType.endsWith('Forward')) {
      end = /Word|Line/.test(event.inputType) ? code.length : Math.min(code.length, end + 1);
    }
  } else return;
  event.preventDefault();
  const result = code.slice(0, start) + inserted + code.slice(end);
  if (result.length <= 8) setPeerCode(result, start + inserted.length);
});
function normalizePeerInput() {
  const input = element('join-code');
  const cursor = cleanPeerCode(input.value.slice(0, input.selectionStart)).length;
  setPeerCode(input.value, cursor);
}
listen('join-code', 'input', event => { if (!event.isComposing) normalizePeerInput(); });
listen('join-code', 'compositionend', normalizePeerInput);
listen('join-code', 'paste', event => {
  event.preventDefault();
  const pasted = event.clipboardData?.getData('text/plain') || '';
  const code = normalizeCode(pasted.replace(/[\s-]/g, ''));
  if (!code) { notice('Paste a complete eight-character code.'); return; }
  setPeerCode(code);
  notice('');
});
listen('join-code', 'keydown', event => { if (event.key === 'Enter') element('join').click(); });
listen('code', 'dblclick', event => {
  const left = element('code-left').firstChild;
  const right = element('code-right').firstChild;
  if (!left || !right) return;
  event.preventDefault();
  element('code').focus({ preventScroll: true });
  const range = document.createRange();
  range.setStart(left, 0);
  range.setEnd(right, right.length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
});
listen('copy', 'click', () => {
  if (!validRoom(app.room) || !validSecret(app.secret)) throw Error('Code not available yet');
  const generation = app.generation;
  navigator.clipboard.writeText(app.room + app.secret).then(() => {
    if (current(generation)) notice('Code copied');
  }).catch(() => { if (current(generation)) notice('Select the code and copy it manually'); });
});
listen('leave', 'click', () => closeSession('Folder closed. Temporary state cleared.'));
listen('add-files', 'change', () => {
  const input = element('add-files');
  try { for (const file of input.files) addFile(file); } finally { input.value = ''; }
});
listen('add-folder', 'click', () => { chooseFolder().catch(error => notice(errorText(error))); });
listen('add-directory', 'change', () => {
  const input = element('add-directory');
  const context = app.directoryImport; app.directoryImport = null;
  try { importDirectory(input.files, context); } finally { input.value = ''; }
});
listen('add-directory', 'cancel', () => { app.directoryImport = null; });
function performFileAction(id, action) {
  const entry = app.files.get(id);
  if (!entry || entryUnavailable(entry)) return;
  try {
    if (action === 'download') {
      if (entry.owner !== app.role && app.pc?.connectionState !== 'connected') return;
      if (entryKind(entry) === 'directory') downloadFolder(id).catch(error => notice(errorText(error)));
      else downloadFile(id);
    } else if (action === 'delete') deleteFile(id);
    else if (entryKind(entry) === 'directory') chooseFolder(id).catch(error => notice(errorText(error)));
    else { app.replace = id; element('replace-file').click(); }
  } catch (error) { notice(errorText(error)); }
}
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
  const action = { d: 'download', r: 'replace', q: 'delete' }[event.key];
  const selected = document.activeElement?.closest('#files .file-name');
  if (!action || !selected) return;
  event.preventDefault();
  if (!event.repeat) performFileAction(selected.dataset.id, action);
});
listen('files', 'pointerdown', event => {
  const button = event.target.closest('.file-action');
  if (!button) return;
  event.preventDefault();
  button.closest('.file').querySelector('.file-name').focus({ preventScroll: true });
});
listen('files', 'click', event => {
  const target = event.target.closest('[data-action]') || event.target.closest('.file')?.querySelector('.file-name');
  if (!target || target.getAttribute('aria-disabled') === 'true') return;
  if (target.matches('.file-name')) target.focus({ preventScroll: true });
  const id = target.dataset.id;
  if (target.dataset.action === 'toggle') {
    if (app.expanded.has(id)) app.expanded.delete(id); else app.expanded.add(id);
    renderFiles();
  } else if (target.matches('.file-action')) performFileAction(id, target.dataset.action);
});
listen('replace-file', 'change', () => {
  const input = element('replace-file'), id = app.replace; app.replace = null;
  try { if (id && input.files[0]) addFile(input.files[0], id); } finally { input.value = ''; }
});
listen('replace-file', 'cancel', () => { app.replace = null; });
listen('cancel-transfer', 'click', cancelAll);
let countdownTimer = null;
function scheduleCountdown() {
  if (countdownTimer !== null) clearTimeout(countdownTimer);
  tick();
  // Align every update to a wall-clock second instead of the tab's start time.
  countdownTimer = setTimeout(scheduleCountdown, 1000 - Date.now() % 1000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleCountdown();
});
scheduleCountdown();
window.addEventListener('pagehide', () => closeSession());
