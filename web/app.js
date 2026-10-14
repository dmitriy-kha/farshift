import { validRoom, validSecret, normalizeCode, randomSecret, Pairing } from './protocol.js';
import { prepare, Download } from './download.js';
import { CHUNK, TRANSFER_WINDOW, WRITE_BATCH, WRITE_DELAY, ACK_BYTES, CHANNEL_HIGH_WATER, CHANNEL_LOW_WATER } from './transfer-config.js';

const animationSettings = {
  code_min_delay_ms: 100, code_random_range_ms: 220, code_tick_ms: 50,
  indicator_ready_ms: 180, indicator_waiting_ms: 120,
};
const animationRequest = new AbortController();
const animationTimeout = setTimeout(() => animationRequest.abort(), 3000);
try {
  const response = await fetch('/ui-config.yaml', { cache: 'no-store', signal: animationRequest.signal });
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
} finally { clearTimeout(animationTimeout); }

const SPEED_DURATION = 5000;
const SPEED_MAX_BYTES = 256 * 1024 * 1024;
const SPEED_TIMEOUT = 30000;
const SPEED_COOLDOWN = 30000;
const MAX_LOCAL_ENTRIES = 10000;
const MAX_FILES = MAX_LOCAL_ENTRIES * 2;
const MAX_DEPTH = 32;
const MAX_CONTROL = 48 * 1024;
const MAX_CONTROL_QUEUE = 64 * 1024 * 1024;
const MAX_SIGNAL = 48 * 1024;
const MAX_WS = 64 * 1024;
const TRANSFER_IDLE_TIMEOUT = 30000;
const TRANSFER_WRITE_TIMEOUT = 60000;
const SIGNAL_OPEN_TIMEOUT = 15000;
const CHANNEL_OPEN_TIMEOUT = 45000;
const DATA_CHANNEL_OPEN_TIMEOUT = 15000;
const ICE_RESTART_TIMEOUT = 20000;
const MAX_ICE_RESTARTS = 2;
const DEFAULT_TTL = 60 * 60;
const MAX_TTL = 999 * 60;
// Keep elapsed time independent of device clock corrections during a session.
const sessionNow = () => Math.floor(performance.timeOrigin + performance.now());
let lifetimeEdited = false;
let filesRenderFrame = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const app = {
  generation: 0, ws: null, pc: null, channel: null, dataChannel: null, channelStarted: false, role: '', room: '', secret: '',
  peer: '', peerSecret: '', attempts: [], pairing: null, pakeMessage: null, session: null,
  paired: false, peerReady: false, expiresAt: 0, pairingDeadline: 0,
  localExpiresAt: 0, localPairingDeadline: 0, configuration: null,
  serverOffset: 0, serverExpiresAt: 0, serverPairingDeadline: 0,
  lifetime: null, lifetimeConfirmed: false,
  signalingAt: 0, connectingAt: 0, remoteCandidates: [],
  ice: { local: 0, remote: 0, reflexive: 0, errors: [] },
  clock: 0, files: new Map(), local: new Map(), created: new Set(), expanded: new Set(), replace: null, outgoing: null,
  incoming: null, folderDownload: null, directoryImport: null,
  preparingDownload: false, receivingDone: false, disconnectedAt: 0,
  controlQueue: [], urgentControlQueue: [], controlQueueBytes: 0, sendingControl: false,
  speedTest: null, speedRates: { upload: null, download: null }, lastSpeedTest: 0,
  restartingAt: 0, restartAttempts: 0, restartBusy: false, remoteIceGeneration: 0, iceGeneration: 0, iceUfrag: '',
  routeAt: 0, routeBusy: false,
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
const current = generation => app.generation === generation && (app.ws !== null || app.channel !== null);
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
  const urgent = ['start', 'ack', 'done', 'received', 'cancel', 'error', 'speed_ready', 'speed_end', 'speed_result', 'speed_cancel', 'speed_busy'].includes(value.type);
  (urgent ? app.urgentControlQueue : app.controlQueue).push({ payload, size }); app.controlQueueBytes += size;
  if (!app.sendingControl) flushControl();
}
function waitForBuffer(channel, generation) {
  if (!current(generation) || channel.readyState !== 'open') return Promise.reject(Error('Channel closed'));
  if (channel.bufferedAmount <= CHANNEL_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', drained);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
      if (error) reject(error); else resolve();
    };
    const drained = () => finish(!current(generation) || channel.readyState !== 'open' ? Error('Channel closed') : null);
    const closed = () => finish(Error('Channel closed'));
    const timer = setTimeout(() => finish(Error('Transfer is not responding')), TRANSFER_WRITE_TIMEOUT);
    channel.addEventListener('bufferedamountlow', drained);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
    if (channel.bufferedAmount <= CHANNEL_LOW_WATER) drained();
  });
}
async function flushControl() {
  const channel = app.channel;
  const generation = app.generation;
  const queue = app.controlQueue;
  const urgent = app.urgentControlQueue;
  app.sendingControl = true;
  try {
    let index = 0;
    while (index < queue.length || urgent.length) {
      await waitForBuffer(channel, generation);
      if (!current(generation) || channel.readyState !== 'open') return;
      const item = urgent.length ? urgent.shift() : queue[index];
      channel.send(item.payload); app.controlQueueBytes -= item.size;
      if (item === queue[index]) queue[index++] = null;
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
  if (app.ws?.readyState !== WebSocket.OPEN && preserveDirectConnection(app.ws)) return;
  if (!app.session) throw Error('Missing key');
  const payload = await app.session.seal(JSON.stringify(value));
  if (!current(generation)) return;
  if (app.ws?.readyState !== WebSocket.OPEN && preserveDirectConnection(app.ws)) return;
  if (byteLength(payload) > MAX_SIGNAL) throw Error('SDP too large');
  wsSend({ type: 'signal', payload });
}
function abortReceiver(receiver) {
  clearTimeout(receiver?.batchTimer);
  receiver?.flushBatch?.();
  receiver?.reject?.(Error('Transfer cancelled or could not be saved'));
  if (receiver?.queue) receiver.queue.length = 0;
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
  stopSpeedTest('', false);
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
  app.controlQueue = []; app.urgentControlQueue = []; app.controlQueueBytes = 0; app.sendingControl = false;
  app.generation++;
  for (const object of [app.ws, app.channel, app.dataChannel, app.pc]) {
    if (!object) continue;
    for (const name of ['onmessage', 'onopen', 'onclose', 'onerror', 'ondatachannel', 'onconnectionstatechange', 'onicecandidate', 'onicecandidateerror', 'onicegatheringstatechange', 'oniceconnectionstatechange']) object[name] = null;
    try { object.close(); } catch {}
  }
  app.session?.destroy?.(); app.pairing?.destroy?.();
  app.ws = app.channel = app.dataChannel = app.pc = app.session = app.pairing = null;
  app.channelStarted = false;
  app.pakeMessage?.fill(0); app.pakeMessage = null;
  app.secret = app.peerSecret = app.peer = app.room = app.role = '';
  app.configuration = null; app.files.clear(); app.local.clear(); app.created.clear(); app.expanded.clear(); app.replace = null; app.directoryImport = null;
  app.clock = 0; app.paired = app.peerReady = false;
  app.expiresAt = app.pairingDeadline = app.localExpiresAt = app.localPairingDeadline = 0;
  app.serverOffset = app.serverExpiresAt = app.serverPairingDeadline = 0;
  app.lifetime = null; app.lifetimeConfirmed = false;
  app.signalingAt = app.connectingAt = 0; app.remoteCandidates = [];
  app.ice = { local: 0, remote: 0, reflexive: 0, errors: [] };
  app.preparingDownload = app.receivingDone = false; app.disconnectedAt = 0;
  app.restartingAt = app.restartAttempts = app.remoteIceGeneration = app.iceGeneration = 0;
  app.restartBusy = app.routeBusy = false; app.routeAt = 0;
  app.iceUfrag = '';
  app.speedRates = { upload: null, download: null }; updateSpeedUI(); hidden('speed-row', true);
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
function preserveDirectConnection(ws) {
  if (!app.lifetimeConfirmed || !channelsOpen()) return false;
  if (!ws) return true;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  if (app.ws === ws) app.ws = null;
  try { ws.close(); } catch {}
  notice('The pairing server connection closed. Direct file transfer remains active.');
  return true;
}
function connect(secret, ttl, explicit) {
  if (!window.isSecureContext || !crypto.subtle) throw Error('Secure connection required. Open this page over HTTPS.');
  const now = sessionNow();
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
  app.signalingAt = now;
  app.lifetime = { ttl, explicit, expires_at: now + ttl * 1000 };
  // An untouched default permits the peer's choice, even if its code is issued later.
  app.localExpiresAt = now + (explicit ? ttl : MAX_TTL + 120) * 1000;
  app.localPairingDeadline = now + Math.min(120000, ttl * 1000);
  text('timer', `TTL ${timeLeft((app.localPairingDeadline - sessionNow()) / 1000)}`);
  busy(true); status('Connecting to server'); notice('Requesting a code from the pairing server.');
  hidden('entry', false); hidden('waiting', false); hidden('code', false); disableButton(element('copy'), true);
  ws.onopen = () => { if (current(generation)) { try { wsSend({ type: 'create', ttl, ttl_explicit: explicit }); } catch { closeSession('Could not open session'); } } };
  // Crypto and SDP operations must preserve the server's ordered message stream.
  let queue = Promise.resolve();
  ws.onmessage = event => {
    if (!current(generation)) return;
    if (typeof event.data !== 'string' || byteLength(event.data) > MAX_WS) { securityFailure(); return; }
    queue = queue.then(async () => {
      if (current(generation) && app.ws === ws) await handleServer(JSON.parse(event.data), generation);
    }).catch(error => {
      if (!current(generation)) return;
      console.error('Session message rejected:', error);
      if (error instanceof WebRTCError) closeSession(error.message);
      else securityFailure();
    });
  };
  ws.onclose = () => {
    if (current(generation) && !preserveDirectConnection(ws)) closeSession('Pairing server connection closed. Get new codes on both devices.');
  };
  ws.onerror = () => {
    if (current(generation) && !preserveDirectConnection(ws)) closeSession('Pairing server unavailable. Check your connection.');
  };
}
async function handleServer(value, generation) {
  switch (value?.type) {
    case 'ready': {
      if (!validRoom(value.room) || app.room || !positive(value.expires_at)
        || !positive(value.pairing_deadline)
        || value.expires_at - value.pairing_deadline !== Math.max(0, app.lifetime.ttl - 120) * 1000) throw Error('Invalid session context');
      // Map server timestamps to the local request start, conservatively counting transit time.
      app.serverOffset = value.expires_at - app.lifetime.expires_at;
      app.serverExpiresAt = value.expires_at; app.serverPairingDeadline = value.pairing_deadline;
      app.room = value.room;
      app.signalingAt = 0;
      app.expiresAt = value.expires_at - app.serverOffset;
      app.pairingDeadline = value.pairing_deadline - app.serverOffset;
      app.lifetime.expires_at = value.expires_at;
      // STUN discovers addresses for the direct connection.
      const iceServers = (value.ice_servers || []).flatMap(server => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
          .filter(url => typeof url === 'string' && /^stuns?:/.test(url));
        return urls.length ? [{ urls }] : [];
      });
      app.configuration = { iceServers, iceTransportPolicy: 'all' };
      const code = app.room + app.secret;
      showCode(code); hidden('code', false);
      disableButton(element('copy'), false); disableButton(element('join'), false);
      status('Exchange codes'); notice('Enter the other device\'s code here and this code on the other device.'); tick(); break;
    }
    case 'peer_ready': {
      const role = app.room < app.peer ? 'a' : 'b';
      if (app.peerReady || !app.peer || value.peer !== app.peer || value.role !== role
        || !positive(value.expires_at) || !positive(value.pairing_deadline)
        || value.expires_at > (app.lifetime.explicit ? app.serverExpiresAt : app.localExpiresAt + app.serverOffset)
        || value.pairing_deadline > app.serverPairingDeadline
        || Math.min(value.pairing_deadline - app.serverOffset, app.localPairingDeadline) <= sessionNow()
        || value.expires_at < value.pairing_deadline) throw Error('Invalid pairing context');
      app.peerReady = true;
      const args = role === 'a' ? [app.room, app.peer, app.secret, app.peerSecret] : [app.peer, app.room, app.peerSecret, app.secret];
      const result = await Pairing.create(role, args[0], args[1], value.attempt, args[2], args[3]);
      if (!current(generation)) { result.message.fill(0); result.pairing.destroy?.(); return; }
      app.role = role; app.pairing = result.pairing; app.pakeMessage = result.message;
      app.expiresAt = value.expires_at - app.serverOffset;
      app.pairingDeadline = value.pairing_deadline - app.serverOffset;
      status('Verifying codes'); notice('Both devices selected each other. Verifying the codes.');
      wsSend({ type: 'signal', payload: JSON.stringify({ type: 'pake', bytes: Array.from(result.message) }) }); break;
    }
    case 'signal': {
      if (typeof value.payload !== 'string' || byteLength(value.payload) > MAX_SIGNAL) throw Error('Invalid signaling message');
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
        'peer unavailable': 'Other device code not found, expired or already used. Get new codes on both devices.',
        'peer too slow': 'Other device is not receiving connection details. Check its connection and get new codes.',
        'server full': 'No codes available. Try again in two minutes.',
        'admission rate limit': 'Too many requests. Try again later.', 'rate limit': 'Too many requests. Try again later.' };
      closeSession(messages[value.message] || 'Could not connect. Code may have expired or been used.'); break;
    }
    case 'closed': {
      if (value.reason === 'peer_disconnected' && preserveDirectConnection(app.ws)) break;
      const messages = {
        code_invalidated: 'The other device rejected or expired the codes. Get new codes on both devices.',
        pairing_timeout: 'Code exchange timed out. Get new codes on both devices and enter them within two minutes.',
        expired: 'Folder lifetime expired. Get new codes on both devices.',
        peer_disconnected: 'Other device disconnected. Keep both tabs open and get new codes.',
        'connection unavailable': 'Could not deliver pairing messages. Get new codes on both devices.',
      };
      closeSession(messages[value.reason] || 'Server closed the session. Get new codes on both devices.');
      break;
    }
    case 'paired': break;
    default: throw Error('Invalid server message');
  }
}
async function handlePairing(payload, generation) {
  if (sessionNow() >= Math.min(app.pairingDeadline, app.localPairingDeadline)
    || sessionNow() >= Math.min(app.expiresAt, app.localExpiresAt)) {
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
    if (current(generation)) wsSend({ type: 'signal', payload: JSON.stringify({ type: 'proof', bytes: Array.from(proof) }) });
  } else if (value.type === 'proof') {
    if (bytes.length !== 32 || !app.session) throw Error('Invalid code');
    await app.session.verifyConfirmation(bytes);
    if (!current(generation)) return;
    app.paired = true; app.secret = app.peerSecret = ''; app.pakeMessage?.fill(0);
    app.connectingAt = sessionNow();
    status('Codes verified'); notice('Codes verified. Waiting for the other device\'s connection settings.');
    showCode(''); hidden('waiting', true); hidden('entry', true);
    await signalSend({ type: 'lifetime', ...app.lifetime }, generation);
  } else throw Error('Invalid pairing message');
}
class WebRTCError extends Error {}
async function rtc(operation, action) {
  try { return await operation(); }
  catch { throw new WebRTCError(`${action} failed in this browser. Refresh both devices and try again.`); }
}
function directConnectionFailure() {
  const pc = app.pc;
  if (pc && !app.connectingAt) return 'Direct connection lost. Check the network and get new codes.';
  if (!pc?.remoteDescription) return 'The other device did not finish exchanging connection settings. Keep both tabs open and get new codes.';
  if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
    return 'A direct route was found, but the secure file channel did not open. Refresh both devices and try again.';
  }
  if (!app.ice.local) return 'This browser provided no direct network addresses. Check its WebRTC settings.';
  if (!app.ice.remote) return 'The other device provided no direct network addresses. Check its WebRTC settings.';
  const counts = `ICE candidates: local ${app.ice.local}, remote ${app.ice.remote}, STUN ${app.ice.reflexive}.`;
  const errors = app.ice.errors.length ? ` STUN errors: ${app.ice.errors.map(error => `${error.code} (${error.url})`).join(', ')}.` : '';
  return `No direct route was found. ${counts}${errors} NAT, firewall or VPN may block the route.`;
}
function connectionProgress() {
  const pc = app.pc;
  if (!pc || app.channelStarted) return;
  if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
    status('Opening file channel'); notice('Direct route found. Opening the secure file channel.');
  } else if (pc.iceConnectionState === 'checking') {
    status('Checking direct routes'); notice('Codes verified. Checking direct routes between the devices.');
  } else if (!pc.remoteDescription) {
    status('Exchanging connection details'); notice('Codes verified. Waiting for the other device\'s connection details.');
  } else if (pc.iceGatheringState === 'gathering') {
    status('Finding direct addresses'); notice('Finding direct network addresses with STUN. File data is not sent to STUN.');
  } else {
    status('Waiting direct connection'); notice('Waiting for a working direct route.');
  }
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
    const localUfrag = pc.localDescription?.sdp.match(/^a=ice-ufrag:(\S+)/m)?.[1];
    const candidateUfrag = event.candidate?.usernameFragment
      || event.candidate?.candidate.match(/(?:^|\s)ufrag\s+(\S+)/)?.[1];
    // Gathering callbacks from a previous restart must never be relabeled.
    if (!app.iceUfrag || (candidateUfrag ? candidateUfrag !== app.iceUfrag : localUfrag !== app.iceUfrag)) return;
    if (!event.candidate && pc.iceGatheringState !== 'complete') return;
    if (event.candidate) {
      app.ice.local++;
      if (event.candidate.type === 'srflx' || /\btyp srflx\b/.test(event.candidate.candidate)) app.ice.reflexive++;
    }
    if (!app.ws && app.channel?.readyState === 'open') return;
    signalSend({ type: 'candidate', candidate: event.candidate?.toJSON() ?? null, generation: app.iceGeneration }, generation)
      .catch(() => { if (current(generation)) closeSession('Could not send WebRTC connection details.'); });
  };
  pc.onicecandidateerror = event => {
    if (!current(generation) || typeof event.url !== 'string' || !/^stuns?:/.test(event.url)) return;
    const code = Number.isInteger(event.errorCode) ? event.errorCode : 0;
    const url = event.url.slice(0, 200);
    if (app.ice.errors.length < 8 && !app.ice.errors.some(error => error.code === code && error.url === url)) app.ice.errors.push({ code, url });
  };
  pc.onicegatheringstatechange = () => { if (current(generation)) connectionProgress(); };
  pc.oniceconnectionstatechange = () => {
    if (!current(generation)) return;
    if (pc.iceConnectionState === 'failed') recoverConnection();
    else connectionProgress();
  };
  pc.ondatachannel = event => {
    if (!current(generation)) return;
    try { attachChannel(event.channel); } catch { securityFailure(); }
  };
  pc.onconnectionstatechange = () => {
    if (!current(generation)) return;
    switch (pc.connectionState) {
      case 'failed': recoverConnection(); break;
      case 'closed': closeSession('Direct connection closed. Get new codes on both devices.'); break;
      case 'disconnected':
        if (!app.disconnectedAt) app.disconnectedAt = sessionNow();
        status('Connection interrupted'); text('route', 'direct connection interrupted');
        notice('Direct connection interrupted. Preparing to restore the route.'); renderFiles(); break;
      case 'connected':
        app.disconnectedAt = 0;
        if (!app.channelStarted) app.connectingAt = sessionNow();
        if (pc.signalingState === 'stable') app.restartingAt = 0;
        for (const transfer of [app.outgoing, app.incoming]) if (transfer) transfer.activity = sessionNow();
        if (channelsOpen()) {
          app.restartAttempts = 0;
          status('Both devices online', 'connected'); notice(''); updateRoute();
        }
        else connectionProgress();
        renderFiles(); break;
    }
  };
  return pc;
}
function localSdp(pc) {
  const sdp = pc.localDescription?.sdp;
  if (typeof sdp !== 'string' || byteLength(sdp) > 128 * 1024 || !sdp.includes('a=fingerprint:')) throw Error('Missing DTLS fingerprint');
  return sdp;
}
async function applyLocalDescription(pc, description, iceGeneration, generation, action) {
  const ufrag = description.sdp?.match(/^a=ice-ufrag:(\S+)/m)?.[1];
  if (!ufrag) throw new WebRTCError('The browser did not provide ICE credentials.');
  if (!current(generation)) return;
  app.iceGeneration = iceGeneration;
  app.iceUfrag = ufrag;
  await rtc(() => pc.setLocalDescription(description), action);
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
  const pending = app.remoteCandidates;
  app.remoteCandidates = [];
  for (const item of pending) {
    if (!current(generation)) return;
    if (item.generation > app.remoteIceGeneration) { app.remoteCandidates.push(item); continue; }
    if (item.generation < app.remoteIceGeneration) continue;
    await rtc(() => pc.addIceCandidate(item.candidate), 'Applying a direct network address');
  }
}
async function createOffer(generation) {
  if (!current(generation)) return;
  const pc = setupPeer();
  const channel = await rtc(() => pc.createDataChannel('folder', { ordered: true }), 'Creating the file channel');
  if (!current(generation)) return;
  attachChannel(channel);
  const dataChannel = await rtc(() => pc.createDataChannel('files', { ordered: true }), 'Creating the data channel');
  if (!current(generation)) return;
  attachChannel(dataChannel);
  const offer = await rtc(() => pc.createOffer(), 'Preparing connection details');
  if (!current(generation)) return;
  await applyLocalDescription(pc, offer, 0, generation, 'Applying local connection details');
  if (current(generation)) await signalSend({ type: 'offer', sdp: localSdp(pc), generation: 0 }, generation);
}
function recoverConnection() {
  if (!app.pc || app.restartingAt || app.restartBusy) return;
  if (!app.pc.remoteDescription || app.pc.signalingState !== 'stable') {
    if (app.connectingAt && sessionNow() - app.connectingAt >= CHANNEL_OPEN_TIMEOUT) closeSession(directConnectionFailure());
    return;
  }
  if (app.ws?.readyState !== WebSocket.OPEN || app.restartAttempts >= MAX_ICE_RESTARTS) {
    closeSession(directConnectionFailure()); return;
  }
  app.restartAttempts++;
  app.restartingAt = sessionNow();
  if (!app.channelStarted) app.connectingAt = app.restartingAt;
  status('Restoring direct connection'); text('route', 'restoring direct connection');
  notice('Trying a new direct route. Keep both devices online.');
  const generation = app.generation;
  if (app.role === 'b') {
    signalSend({ type: 'restart' }, generation).catch(() => {
      if (current(generation)) closeSession('Could not request a new direct route.');
    });
    return;
  }
  app.restartBusy = true;
  const pc = app.pc;
  (async () => {
    const iceGeneration = app.iceGeneration + 1;
    const offer = await rtc(() => pc.createOffer({ iceRestart: true }), 'Preparing a new direct route');
    if (!current(generation)) return;
    app.restartingAt = sessionNow();
    await applyLocalDescription(pc, offer, iceGeneration, generation, 'Applying a new direct route');
    if (current(generation)) await signalSend({ type: 'offer', sdp: localSdp(pc), generation: iceGeneration }, generation);
  })().catch(error => {
    if (current(generation)) closeSession(errorText(error));
  }).finally(() => { if (current(generation)) app.restartBusy = false; });
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
    app.expiresAt = app.localExpiresAt = Math.min(app.expiresAt, app.localExpiresAt, expiry - app.serverOffset);
    if (app.expiresAt <= sessionNow()) throw Error('Folder expired. Temporary state cleared.');
    app.lifetimeConfirmed = true;
    status('Exchanging connection details'); notice('Codes verified. Preparing a direct connection.');
    tick(); wsSend({ type: 'paired' });
    if (app.role === 'a') await createOffer(generation);
    return;
  }
  if (!app.lifetimeConfirmed) throw Error('Lifetime not confirmed');
  if (value?.type === 'restart') {
    if (app.role !== 'a' || !app.pc?.remoteDescription) throw Error('Invalid route recovery');
    recoverConnection(); return;
  }
  if (value?.type === 'candidate') {
    if (value.generation === undefined) throw new WebRTCError('The other device is using an older client. Refresh both devices before connecting.');
    if (!unsigned(value.generation) || value.generation > app.remoteIceGeneration + 1
      || !validCandidate(value.candidate) || app.remoteCandidates.length >= 256) throw Error('Invalid ICE candidate');
    if (value.generation < app.remoteIceGeneration) return;
    if (value.candidate) {
      if (value.candidate.candidate && !/\btyp (host|srflx|prflx)\b/.test(value.candidate.candidate)) throw new WebRTCError('The other device supplied an unsupported network address. Refresh both devices.');
      if (value.candidate.candidate) app.ice.remote++;
    }
    app.remoteCandidates.push({ candidate: value.candidate, generation: value.generation });
    if (app.pc?.remoteDescription) await applyCandidates(app.pc, generation);
    return;
  }
  const sdp = value?.sdp;
  if (value.generation === undefined) throw new WebRTCError('The other device is using an older client. Refresh both devices before connecting.');
  if (!unsigned(value.generation)) throw Error('Invalid route generation');
  if (typeof sdp !== 'string' || byteLength(sdp) > 128 * 1024 || !sdp.includes('a=fingerprint:')) throw Error('Missing DTLS fingerprint');
  if ((sdp.match(/^a=candidate:.*$/gm) || []).some(candidate => !/\btyp (host|srflx|prflx)\b/.test(candidate))) throw new WebRTCError('The other device supplied an unsupported network address. Refresh both devices.');
  app.ice.remote += (sdp.match(/^a=candidate:/gm) || []).length;
  if (value.type === 'offer' && app.role === 'b') {
    const pc = app.pc || setupPeer();
    if (pc.remoteDescription ? value.generation !== app.remoteIceGeneration + 1 : value.generation !== 0) throw Error('Invalid connection offer');
    if (value.generation > 0) {
      app.restartingAt = sessionNow();
      if (!app.channelStarted) app.connectingAt = app.restartingAt;
      status('Restoring direct connection');
    }
    app.remoteIceGeneration = value.generation;
    await rtc(() => pc.setRemoteDescription({ type: 'offer', sdp }), 'Applying the other device\'s connection details');
    if (!current(generation)) return;
    await applyCandidates(pc, generation);
    const answer = await rtc(() => pc.createAnswer(), 'Preparing the connection response');
    if (!current(generation)) return;
    await applyLocalDescription(pc, answer, value.generation, generation, 'Applying the connection response');
    if (current(generation)) await signalSend({ type: 'answer', sdp: localSdp(pc), generation: value.generation }, generation);
  } else if (value.type === 'answer' && app.role === 'a') {
    if (!app.pc || app.pc.signalingState !== 'have-local-offer' || value.generation !== app.iceGeneration) throw Error('Invalid answer');
    app.remoteIceGeneration = value.generation;
    await rtc(() => app.pc.setRemoteDescription({ type: 'answer', sdp }), 'Applying the other device\'s connection response');
    if (current(generation)) await applyCandidates(app.pc, generation);
  } else throw Error('Invalid SDP');
  if (current(generation) && app.pc?.connectionState === 'connected' && app.pc.signalingState === 'stable') {
    app.restartingAt = app.disconnectedAt = 0;
    if (channelsOpen()) app.restartAttempts = 0;
    for (const transfer of [app.outgoing, app.incoming]) if (transfer) transfer.activity = sessionNow();
  }
}
function attachChannel(channel) {
  const slot = channel.label === 'folder' ? 'channel' : channel.label === 'files' ? 'dataChannel' : null;
  if (!slot || app[slot] || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) throw Error('Invalid channel');
  app[slot] = channel; channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER;
  const generation = app.generation;
  channel.onopen = () => { if (current(generation)) channelReady(); };
  channel.onmessage = event => {
    if (!current(generation)) return;
    try {
      if (slot === 'channel' && typeof event.data === 'string') {
        if (byteLength(event.data) > MAX_CONTROL) throw Error('Message size limit exceeded');
        handleControl(parseControl(event.data), generation);
      } else if (slot === 'dataChannel' && event.data instanceof ArrayBuffer && event.data.byteLength <= CHUNK + 40) {
        receiveChunk(event.data, generation);
      } else throw Error('Invalid file chunk');
    } catch (error) { closeSession(errorText(error)); }
  };
  channel.onclose = () => { if (current(generation)) closeSession('The other device closed the direct file channel. Get new codes on both devices.'); };
  channel.onerror = () => { if (current(generation)) closeSession('The direct file channel failed. Get new codes on both devices.'); };
  if (channel.readyState === 'open') channelReady();
}
function channelsOpen() {
  return app.channel?.readyState === 'open' && app.dataChannel?.readyState === 'open';
}
function channelReady() {
  if (!channelsOpen() || app.channelStarted) return;
  if (!app.paired || !app.lifetimeConfirmed || sessionNow() >= Math.min(app.expiresAt, app.localExpiresAt) || !app.pc?.remoteDescription) { securityFailure(); return; }
  app.channelStarted = true;
  app.restartAttempts = 0;
  app.connectingAt = 0;
  text('route', 'direct connection');
  status('Both devices online', 'connected'); tick(); hidden('folder', false); notice('');
  hidden('speed-row', false); updateSpeedUI();
  renderFiles(); sendInventory(); updateRoute();
}
async function updateRoute() {
  const pc = app.pc;
  if (!pc || app.routeBusy || pc.connectionState !== 'connected' || !channelsOpen()) return;
  const generation = app.generation;
  app.routeBusy = true; app.routeAt = sessionNow();
  try {
    const stats = await pc.getStats();
    if (!current(generation) || pc.connectionState !== 'connected') return;
    let pair;
    for (const report of stats.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    }
    if (!pair) pair = Array.from(stats.values()).find(report => report.type === 'candidate-pair'
      && report.state === 'succeeded' && report.nominated);
    if (!pair) return;
    const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
    const route = ['direct', local?.protocol, local?.candidateType && remote?.candidateType
      ? `${local.candidateType} ↔ ${remote.candidateType}` : null];
    if (Number.isFinite(pair.currentRoundTripTime)) route.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    text('route', route.filter(Boolean).join(' · '));
  } catch { /* Route statistics are optional and never interrupt file transfers. */ }
  finally { if (current(generation)) app.routeBusy = false; }
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
    start: ['transfer', 'id', 'version', 'size'], ack: ['transfer', 'offset'], done: ['transfer'],
    received: ['transfer'], cancel: ['transfer'], error: ['transfer', 'message'],
    speed_request: ['transfer'], speed_ready: ['transfer'], speed_next: ['transfer'],
    speed_end: ['transfer', 'size'], speed_result: ['transfer', 'size', 'duration'],
    speed_busy: ['transfer'], speed_cancel: ['transfer'] };
  const required = fields[value?.type];
  if (!required || Object.keys(value).length !== required.length + 1 || !required.every(key => Object.hasOwn(value, key))) throw Error('Invalid folder message');
  if (required.includes('transfer') && !validHex(value.transfer)) throw Error('Invalid transfer');
  if (required.includes('id') && typeof value.id !== 'string') throw Error('Invalid file ID');
  if (required.includes('version') && !unsigned(value.version)) throw Error('Invalid version');
  if (required.includes('size') && !unsigned(value.size)) throw Error('Invalid size');
  if (required.includes('offset') && !unsigned(value.offset)) throw Error('Invalid acknowledgement');
  if (required.includes('duration') && (!positive(value.duration) || value.duration > SPEED_TIMEOUT)) throw Error('Invalid speed measurement');
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
        if (app.speedTest) throw Error('Speed test is running');
        if (app.outgoing) throw Error('Source is already sending a file');
        const entry = app.files.get(value.id);
        if (!entry || entryKind(entry) !== 'file' || entryUnavailable(entry)) throw Error('File unavailable');
        if (entry.version !== value.version || entry.owner !== app.role) throw Error('File version changed. Retry the request.');
        const file = app.local.get(value.id);
        if (!file) throw Error('Source unavailable');
        app.outgoing = { transfer: value.transfer, file, offset: 0, acknowledged: 0, size: entry.size, busy: false, startedAck: false,
          started: sessionNow(), activity: sessionNow() };
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
      if (receiver.speed || receiver.id !== value.id || receiver.version !== value.version || receiver.size !== value.size
        || receiver.offset !== 0 || receiver.startedAck) throw Error('Invalid transfer start');
      receiver.startedAck = true;
      receiver.activity = sessionNow();
      try { acknowledge(receiver, true); } catch { clearTransfer('Transfer failed'); }
      break;
    }
    case 'ack': {
      const sender = app.outgoing;
      if (sender?.transfer !== value.transfer) return;
      if (value.offset < sender.acknowledged || value.offset > sender.offset
        || (value.offset !== sender.size && value.offset % CHUNK !== 0)) throw Error('Invalid completion offset');
      if (sender.startedAck && value.offset === sender.acknowledged) return;
      sender.startedAck = true; sender.acknowledged = value.offset; sender.activity = sessionNow();
      transferProgress(false); pumpTransfer(sender, generation); break;
    }
    case 'done': {
      const receiver = app.incoming;
      if (receiver?.transfer !== value.transfer) break;
      if (receiver.speed || receiver.endSignal) throw Error('Invalid transfer completion');
      receiver.endSignal = true;
      finishDownload(value.transfer, generation).catch(error => { if (current(generation)) closeSession(errorText(error)); }); break;
    }
    case 'received': {
      const sender = app.outgoing;
      if (!sender || sender.transfer !== value.transfer) return;
      if (sender.speed || !sender.finishing || sender.offset !== sender.size || sender.acknowledged !== sender.size) throw Error('Invalid completion acknowledgement');
      app.outgoing = null;
      hidden('transfer', !app.incoming && !app.folderDownload); notice('Transfer completed on the other device'); break;
    }
    case 'cancel': cancelOne(value.transfer, 'Transfer cancelled'); break;
    case 'error':
      if (byteLength(value.message) > 1024) throw Error('Invalid transfer message');
      cancelOne(value.transfer, value.message); break;
    case 'speed_request': acceptSpeedTest(value.transfer); break;
    case 'speed_ready':
      if (app.speedTest?.transfer !== value.transfer) return;
      if (!app.speedTest.initiator || app.speedTest.phase !== 'waiting') throw Error('Invalid speed test state');
      startSpeedSender(); break;
    case 'speed_next':
      if (app.speedTest?.transfer !== value.transfer) return;
      if (app.speedTest.initiator || app.speedTest.phase !== 'waiting_reverse') throw Error('Invalid speed test state');
      startSpeedSender(); break;
    case 'speed_end': finishSpeedReceive(value); break;
    case 'speed_result': finishSpeedSend(value); break;
    case 'speed_busy':
      if (app.speedTest?.transfer === value.transfer && app.speedTest.phase === 'waiting') stopSpeedTest('The other device is busy. Try again later.', false);
      break;
    case 'speed_cancel':
      if (app.speedTest?.transfer === value.transfer) stopSpeedTest('Speed test stopped', false);
      break;
  }
}
function cancelOne(transfer, message) {
  if (app.speedTest?.transfer === transfer) { stopSpeedTest(message); return; }
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
function pumpTransfer(sender, generation) {
  sendChunks(sender, generation).catch(error => {
    if (current(generation) && app.outgoing === sender) {
      tryControl({ type: 'cancel', transfer: sender.transfer }); cancelOne(sender.transfer, errorText(error));
    }
  });
}
async function sendChunks(sender, generation) {
  if (!current(generation) || app.outgoing !== sender || sender.busy || sender.finishing) return;
  sender.busy = true;
  const channel = app.dataChannel;
  const header = encoder.encode(sender.transfer);
  try {
    while (current(generation) && app.outgoing === sender) {
      if (sender.speed && performance.now() - sender.sampleStarted >= SPEED_DURATION) break;
      const remaining = Math.min(sender.size - sender.offset, TRANSFER_WINDOW - (sender.offset - sender.acknowledged));
      if (!remaining) break;
      const start = sender.offset;
      let length = Math.min(WRITE_BATCH, remaining);
      sender.activity = sessionNow();
      let bytes;
      if (sender.speed) bytes = sender.pattern.subarray(0, length);
      else {
        if (!sender.readBuffer || start >= sender.readBuffer.offset + sender.readBuffer.bytes.length) {
          const batch = await (sender.readAhead || readTransferBatch(sender, start));
          if (!current(generation) || app.outgoing !== sender) return;
          if (batch.error) throw batch.error;
          sender.readBuffer = batch;
          const next = batch.offset + batch.bytes.length;
          sender.readAhead = next < sender.size ? readTransferBatch(sender, next) : null;
        }
        const index = start - sender.readBuffer.offset;
        length = Math.min(length, sender.readBuffer.bytes.length - index);
        bytes = sender.readBuffer.bytes.subarray(index, index + length);
      }
      if (bytes.length !== length) throw Error('File changed or unavailable');
      for (let index = 0; index < length; index += CHUNK) {
        if (channel.readyState !== 'open' || channel.bufferedAmount > CHANNEL_HIGH_WATER) await waitForBuffer(channel, generation);
        if (!current(generation) || app.outgoing !== sender) return;
        if (sender.speed && performance.now() - sender.sampleStarted >= SPEED_DURATION) break;
        const chunk = bytes.subarray(index, Math.min(index + CHUNK, length));
        const packet = new Uint8Array(40 + chunk.length);
        packet.set(header); new DataView(packet.buffer).setBigUint64(32, BigInt(sender.offset), false);
        packet.set(chunk, 40); channel.send(packet.buffer);
        sender.offset += chunk.length;
      }
    }
    if (!current(generation) || app.outgoing !== sender) return;
    if (sender.offset === sender.size || (sender.speed && performance.now() - sender.sampleStarted >= SPEED_DURATION)) {
      sender.readBuffer = sender.readAhead = null;
      sender.finishing = true; sender.activity = sessionNow();
      if (sender.speed) {
        sender.size = sender.offset; app.speedTest.phase = 'await_result'; app.speedTest.activity = sessionNow();
        controlSend({ type: 'speed_end', transfer: sender.transfer, size: sender.size });
      } else {
        controlSend({ type: 'done', transfer: sender.transfer });
        notice('File sent. Waiting for the other device to finish saving.');
      }
    }
  } finally {
    sender.busy = false;
    if (current(generation) && app.outgoing === sender) transferProgress(false);
  }
}
async function readTransferBatch(sender, offset) {
  try {
    const end = Math.min(offset + WRITE_BATCH, sender.size);
    const bytes = new Uint8Array(await sender.file.slice(offset, end).arrayBuffer());
    if (bytes.length !== end - offset) throw Error('File changed or unavailable');
    return { offset, bytes };
  } catch (error) { return { error }; }
}
function receiverState(fields) {
  return { ...fields, offset: 0, receivedOffset: 0, acknowledged: 0, queue: [], queuedBytes: 0,
    busy: false, drain: null, batchTimer: null, flushBatch: null, endSignal: false,
    endReceived: false, startedAck: false, started: sessionNow(), activity: sessionNow() };
}
function acknowledge(receiver, force = false) {
  if (!force && receiver.offset - receiver.acknowledged < ACK_BYTES && receiver.offset !== receiver.size) return;
  controlSend({ type: 'ack', transfer: receiver.transfer, offset: receiver.offset });
  receiver.acknowledged = receiver.offset;
}
function receiveChunk(buffer, generation) {
  if (!current(generation)) return;
  if (buffer.byteLength < 40) throw Error('Invalid file header');
  const packet = new Uint8Array(buffer);
  const transfer = decoder.decode(packet.subarray(0, 32));
  const offset = new DataView(buffer).getBigUint64(32, false);
  const length = packet.byteLength - 40;
  const receiver = app.incoming;
  // A bounded window can remain in flight after a cancellation.
  if (!receiver || receiver.transfer !== transfer) return;
  if (!receiver.startedAck || receiver.endReceived || offset !== BigInt(receiver.receivedOffset)
    || length === 0 || length !== Math.min(receiver.size - receiver.receivedOffset, CHUNK)
    || receiver.receivedOffset + length - receiver.acknowledged > TRANSFER_WINDOW) throw Error('Invalid file chunk');
  receiver.receivedOffset += length; receiver.activity = sessionNow();
  const bytes = packet.subarray(40);
  if (receiver.speed) {
    const now = performance.now();
    if (receiver.firstByteAt === undefined) receiver.firstByteAt = now;
    receiver.lastByteAt = now; receiver.offset += length;
    acknowledge(receiver);
    if (receiver.speedEnd && receiver.receivedOffset === receiver.speedEnd.size) finishSpeedReceive(receiver.speedEnd);
    return;
  }
  if (!receiver.download && !receiver.writer) throw Error('Download destination is unavailable');
  receiver.queue.push(bytes); receiver.queuedBytes += length;
  scheduleReceiverWrite(receiver, generation);
  if (receiver.endSignal && receiver.receivedOffset === receiver.size) {
    finishDownload(transfer, generation).catch(error => { if (current(generation)) closeSession(errorText(error)); });
  }
}
function scheduleReceiverWrite(receiver, generation) {
  if (!receiver.drain) {
    const ready = new Promise(resolve => {
      receiver.flushBatch = resolve;
      receiver.batchTimer = setTimeout(resolve, WRITE_DELAY);
    });
    receiver.drain = ready.then(() => {
      clearTimeout(receiver.batchTimer); receiver.batchTimer = null; receiver.flushBatch = null;
      if (current(generation) && app.incoming === receiver) return drainReceiver(receiver, generation);
    }).catch(error => {
      if (current(generation) && app.incoming === receiver) {
        tryControl({ type: 'cancel', transfer: receiver.transfer });
        cancelOne(receiver.transfer, `Could not write file: ${errorText(error)}`);
      }
    }).finally(() => {
      receiver.drain = null;
      if (receiver.queue.length && current(generation) && app.incoming === receiver) scheduleReceiverWrite(receiver, generation);
    });
  }
  if (receiver.queuedBytes >= WRITE_BATCH || receiver.receivedOffset === receiver.size) receiver.flushBatch?.();
}
async function drainReceiver(receiver, generation) {
  receiver.busy = true;
  try {
    if (receiver.queue.length && current(generation) && app.incoming === receiver) {
      const chunks = []; let length = 0;
      while (receiver.queue.length && length + receiver.queue[0].length <= WRITE_BATCH) {
        const chunk = receiver.queue.shift(); chunks.push(chunk); length += chunk.length;
      }
      receiver.queuedBytes -= length;
      const bytes = chunks.length === 1 ? chunks[0] : new Uint8Array(length);
      if (chunks.length > 1) { let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } }
      if (receiver.folder) checkFolderDownload(receiver.folder, receiver.entry);
      receiver.activity = sessionNow();
      if (receiver.download) await receiver.download.push(bytes);
      else await receiver.writer.write(bytes);
      if (!current(generation) || app.incoming !== receiver) return;
      receiver.offset += length; receiver.activity = sessionNow();
      acknowledge(receiver); transferProgress(true);
    }
  } finally { receiver.busy = false; }
}
async function finishDownload(transfer, generation) {
  if (!current(generation)) return;
  const receiver = app.incoming;
  if (!receiver || receiver.transfer !== transfer || receiver.endReceived) return;
  if (receiver.speed || !receiver.startedAck) throw Error('Invalid transfer completion');
  // Commands and payloads use different streams and can arrive in either order.
  if (!receiver.endSignal || receiver.receivedOffset !== receiver.size) return;
  receiver.endReceived = true; app.receivingDone = true;
  while (receiver.drain) {
    receiver.flushBatch?.();
    await receiver.drain;
  }
  if (!current(generation) || app.incoming !== receiver) return;
  if (receiver.offset !== receiver.size || receiver.queuedBytes || receiver.busy) throw Error('Incomplete transfer');
  receiver.busy = true; receiver.activity = sessionNow();
  let message, failure;
  try {
    if (receiver.folder) checkFolderDownload(receiver.folder, receiver.entry);
    if (receiver.download) await receiver.download.finish();
    else if (receiver.writer) await receiver.writer.close();
    else throw Error('Download destination is unavailable');
    message = receiver.writer ? 'File saved' : 'Sent to download manager';
  } catch (error) {
    failure = error;
    abortReceiver(receiver); message = 'Could not save file';
  }
  if (!current(generation) || app.incoming !== receiver) return;
  app.receivingDone = false; app.incoming = null;
  hidden('transfer', !app.outgoing && !app.folderDownload);
  if (failure) {
    tryControl({ type: 'error', transfer, message: 'Could not save file' });
    receiver.reject?.(failure);
  } else {
    try {
      acknowledge(receiver, true);
      controlSend({ type: 'received', transfer });
      receiver.resolve?.();
    } catch (error) {
      receiver.reject?.(error);
      throw error;
    }
  }
  if (!receiver.resolve) notice(message);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function downloadFile(id) {
  if (app.speedTest) throw Error('Wait for the speed test to finish');
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
      await prepare();
      if (!current(generation)) return;
      downloader = await Download.create(file.name, file.size);
      const latest = app.files.get(id);
      if (!current(generation) || !latest || entryUnavailable(latest) || latest.version !== file.version || latest.owner !== file.owner) throw Error('File version changed. Retry the request.');
      const transfer = randomId();
      app.incoming = receiverState({ transfer, name: file.name, id, version: file.version, size: file.size, download: downloader });
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
    app.incoming = receiverState({ transfer, name: entry.name, id: entry.id, version: entry.version, size: entry.size,
      writer, folder: job, entry, resolve, reject });
    try { controlSend({ type: 'get', transfer, id: entry.id, version: entry.version }); }
    catch (error) { cancelOne(transfer, errorText(error)); }
    transferProgress(true);
  });
}
async function downloadFolder(id) {
  if (app.speedTest) throw Error('Wait for the speed test to finish');
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
    progress: { name: root.name, size: 0, offset: 0, started: sessionNow() } };
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
        job.progress = { name: entry.name, size: entry.size, offset: 0, started: sessionNow() };
        transferProgress(true);
        for (let offset = 0; offset < entry.size; offset += WRITE_BATCH) {
          const end = Math.min(offset + WRITE_BATCH, entry.size);
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
function speedAvailable() {
  return channelsOpen() && app.pc?.connectionState === 'connected'
    && !app.outgoing && !app.incoming && !app.folderDownload && !app.preparingDownload && !app.receivingDone;
}
function speedRate(value) { return value === null ? '--.-' : value.toFixed(1); }
function updateSpeedUI() {
  const active = app.speedTest;
  text('speed-test', active ? 'stop test' : 'speedtest');
  const upload = active && ['sending', 'await_result'].includes(active.phase) ? '...' : speedRate(app.speedRates.upload);
  const download = active?.phase === 'receiving' ? '...' : speedRate(app.speedRates.download);
  text('speed-results', `↑${upload} ↓${download} MB/s`);
  element('speed-results').title = `Upload ${speedRate(app.speedRates.upload)} MB/s; download ${speedRate(app.speedRates.download)} MB/s`;
  disableButton(element('speed-test'), !active && (!speedAvailable() || sessionNow() - app.lastSpeedTest < SPEED_COOLDOWN));
}
function beginSpeedTest(transfer, initiator) {
  app.lastSpeedTest = sessionNow();
  app.speedRates = { upload: null, download: null };
  app.speedTest = { transfer, initiator, phase: initiator ? 'waiting' : 'receiving', activity: sessionNow() };
  notice('');
  updateSpeedUI();
}
function speedReceiver() {
  const receiver = receiverState({ transfer: app.speedTest.transfer, speed: true, size: SPEED_MAX_BYTES });
  receiver.startedAck = true; app.incoming = receiver;
}
function requestSpeedTest() {
  if (app.speedTest) { stopSpeedTest('Speed test stopped'); return; }
  if (!speedAvailable() || sessionNow() - app.lastSpeedTest < SPEED_COOLDOWN) return;
  beginSpeedTest(randomId(), true);
  try { controlSend({ type: 'speed_request', transfer: app.speedTest.transfer }); }
  catch (error) { stopSpeedTest(errorText(error), false); }
}
function acceptSpeedTest(transfer) {
  if (app.speedTest || !speedAvailable() || sessionNow() - app.lastSpeedTest < SPEED_COOLDOWN) {
    tryControl({ type: 'speed_busy', transfer }); return;
  }
  beginSpeedTest(transfer, false); speedReceiver();
  controlSend({ type: 'speed_ready', transfer });
}
function startSpeedSender() {
  const job = app.speedTest;
  if (app.incoming || app.outgoing || !job) throw Error('Invalid speed test state');
  const pattern = new Uint8Array(WRITE_BATCH);
  for (let offset = 0; offset < pattern.length; offset += 65536) crypto.getRandomValues(pattern.subarray(offset, offset + 65536));
  app.outgoing = { transfer: job.transfer, speed: true, pattern, offset: 0, acknowledged: 0, size: SPEED_MAX_BYTES,
    busy: false, startedAck: true, sampleStarted: performance.now(), activity: sessionNow() };
  job.phase = 'sending'; job.activity = sessionNow(); updateSpeedUI();
  pumpTransfer(app.outgoing, app.generation);
}
function finishSpeedReceive(value) {
  const job = app.speedTest, receiver = app.incoming;
  if (job?.transfer !== value.transfer) return;
  if (!receiver?.speed || job.phase !== 'receiving' || value.size > SPEED_MAX_BYTES
    || value.size < receiver.receivedOffset || (value.size && value.size % CHUNK)) throw Error('Invalid speed test completion');
  if (receiver.speedEnd && receiver.speedEnd !== value) throw Error('Duplicate speed test completion');
  receiver.speedEnd = value;
  receiver.size = value.size;
  if (value.size !== receiver.receivedOffset) return;
  const duration = Math.max(1, Math.ceil((receiver.lastByteAt ?? performance.now()) - (receiver.firstByteAt ?? performance.now())));
  if (duration > SPEED_TIMEOUT) { stopSpeedTest('Speed test timed out'); return; }
  const measured = Math.max(0, value.size - CHUNK);
  app.speedRates.download = measured ? measured / duration / 1000 : null;
  acknowledge(receiver, true); app.incoming = null;
  controlSend({ type: 'speed_result', transfer: value.transfer, size: value.size, duration });
  if (job.initiator) {
    app.speedTest = null; updateSpeedUI();
  } else {
    job.phase = 'waiting_reverse'; job.activity = sessionNow(); updateSpeedUI();
  }
}
function finishSpeedSend(value) {
  const job = app.speedTest, sender = app.outgoing;
  if (job?.transfer !== value.transfer) return;
  if (!sender?.speed || !sender.finishing || job.phase !== 'await_result'
    || value.size !== sender.size || sender.acknowledged !== sender.size) throw Error('Invalid speed test result');
  const measured = Math.max(0, value.size - CHUNK);
  app.speedRates.upload = measured ? measured / value.duration / 1000 : null;
  app.outgoing = null;
  if (job.initiator) {
    job.phase = 'receiving'; job.activity = sessionNow(); speedReceiver();
    controlSend({ type: 'speed_next', transfer: value.transfer });
  } else app.speedTest = null;
  updateSpeedUI();
}
function stopSpeedTest(message = '', notify = true) {
  const job = app.speedTest;
  if (!job) return;
  if (notify) tryControl({ type: 'speed_cancel', transfer: job.transfer });
  if (app.incoming?.speed) app.incoming = null;
  if (app.outgoing?.speed) app.outgoing = null;
  app.speedTest = null; updateSpeedUI();
  if (message) notice(message);
}
function transferProgress(receiving) {
  const transfer = receiving ? app.incoming || app.folderDownload?.progress : app.outgoing;
  if (!transfer || transfer.speed) return;
  const offset = receiving ? transfer.offset : transfer.acknowledged;
  const { size, started } = transfer;
  const now = sessionNow();
  if (transfer.uiUpdated && now - transfer.uiUpdated < 200 && offset !== size) return;
  transfer.uiUpdated = now;
  const elapsed = Math.max((sessionNow() - started) / 1000, 0.001);
  const speed = offset / elapsed;
  const percentage = size === 0 ? 100 : 100 * offset / size;
  hidden('transfer', false);
  text('transfer-label', `${receiving ? '↓' : '↑'} ${receiving ? transfer.name : transfer.file.name}`);
  element('progress').value = percentage;
  text('progress-text', `${fileSize(offset)} / ${fileSize(size)} · ${percentage.toFixed(0)}%${speed > 0 ? ` · ${(speed / 1000000).toFixed(1)} MB/s · ~${timeLeft((size - offset) / speed)}` : ''}`);
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
  if (app.speedTest && sessionNow() - app.speedTest.activity > SPEED_TIMEOUT) stopSpeedTest('Speed test timed out');
  updateSpeedUI();
  if (app.signalingAt && sessionNow() - app.signalingAt > SIGNAL_OPEN_TIMEOUT) {
    closeSession('The pairing server did not issue a code within 15 seconds. Check your connection and try again.'); return;
  }
  const connectionTimeout = app.pc?.connectionState === 'connected' ? DATA_CHANNEL_OPEN_TIMEOUT : CHANNEL_OPEN_TIMEOUT;
  if (app.connectingAt && sessionNow() - app.connectingAt > connectionTimeout) {
    if (!app.pc) { closeSession(directConnectionFailure()); return; }
    if (!app.restartingAt) {
      if (app.pc?.connectionState === 'connected' || ['connected', 'completed'].includes(app.pc?.iceConnectionState)) {
        closeSession('A direct route was found, but both file channels did not open. Refresh both devices and try again.'); return;
      }
      recoverConnection();
    }
    if (!app.pc) return;
  }
  if (app.restartingAt && sessionNow() - app.restartingAt > ICE_RESTART_TIMEOUT) {
    app.restartingAt = 0;
    if (app.pc?.signalingState !== 'stable') {
      closeSession('The other device did not answer the direct route recovery request.'); return;
    }
    recoverConnection();
    if (!app.pc) return;
  }
  if (app.disconnectedAt && sessionNow() - app.disconnectedAt > 3000 && !app.restartingAt) {
    recoverConnection();
    if (!app.pc) return;
  }
  if (app.channelStarted && sessionNow() - app.routeAt > 2000) updateRoute();
  if (app.incoming?.download?.cancelled) {
    const transfer = app.incoming.transfer; tryControl({ type: 'cancel', transfer }); cancelOne(transfer, 'Download cancelled in browser');
  }
  for (const direction of ['incoming', 'outgoing']) {
    const transfer = app[direction];
    const timeout = transfer?.busy || transfer?.finishing ? TRANSFER_WRITE_TIMEOUT : TRANSFER_IDLE_TIMEOUT;
    if (transfer && !app.restartingAt && !app.disconnectedAt && sessionNow() - transfer.activity > timeout) {
      tryControl({ type: 'cancel', transfer: transfer.transfer });
      cancelOne(transfer.transfer, direction === 'incoming' ? 'File source is not responding' : 'File destination is not responding');
    }
  }
  const expires = Math.min(app.expiresAt, app.localExpiresAt);
  const deadline = Math.min(app.pairingDeadline, app.localPairingDeadline);
  // Apply local bounds even while a server never sends its initial response.
  if (app.ws && sessionNow() >= app.localExpiresAt) { closeSession('Folder expired. Temporary state cleared.'); return; }
  if (app.ws && !app.lifetimeConfirmed && sessionNow() >= app.localPairingDeadline) {
    tryWs({ type: 'invalidate' }); closeSession('Code expired. Get a new code.'); return;
  }
  if (!expires) return;
  if (sessionNow() >= expires) { closeSession('Folder expired. Temporary state cleared.'); return; }
  if (!app.lifetimeConfirmed && sessionNow() >= deadline) { tryWs({ type: 'invalidate' }); closeSession('Code expired. Get a new code.'); return; }
  text('timer', app.lifetimeConfirmed
    ? `TTL ${timeLeft((expires - sessionNow()) / 1000)}`
    : `TTL ${timeLeft((deadline - sessionNow()) / 1000)}`);
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
  if (sessionNow() >= Math.min(app.pairingDeadline, app.localPairingDeadline)) throw Error('Your code has expired. Get a new code.');
  app.peer = peer; app.peerSecret = secret; clearJoinCode(); disableButton(element('join'), true);
  wsSend({ type: 'select', peer }); status('Waiting other device');
  notice('Code submitted. Enter this device\'s code on the other device to continue.');
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
listen('speed-test', 'click', requestSpeedTest);
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
// Hiding or suspending the tab must not clear the session.
// If beforeunload is skipped, the browser closes the transports on destruction.
window.addEventListener('beforeunload', () => closeSession());
