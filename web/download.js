// Bounded page-to-worker bridge; file data is never accumulated here.
const CHUNK_LIMIT = 16 * 1024;
let ready = false;
let preparation;
async function timeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Download service did not respond')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export async function prepare() {
  if (preparation) return preparation;
  preparation = (async () => {
    ready = false;
    if (!navigator.serviceWorker) throw new Error('Service Worker is unavailable');
    await timeout(navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' }), 15000);
    await timeout(navigator.serviceWorker.ready, 15000);
    const started = Date.now();
    while (!navigator.serviceWorker.controller) {
      if (Date.now() - started > 10000) throw new Error('Service Worker is not active');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    ready = true;
  })();
  try { await preparation; } catch (error) { preparation = undefined; throw error; }
}
export function available() { return ready && Boolean(navigator.serviceWorker?.controller); }
export class Download {
  constructor(port, token) {
    Object.assign(this, { port, token, pending: null, cancelled: false, finished: false, frame: null, heartbeat: null, failure: null });
    port.onmessage = event => {
      const kind = event.data?.type;
      if (kind === 'pong') return;
      if (kind === 'cancel' || kind === 'error') {
        this.abort(event.data.message || 'Download manager cancelled the download');
        return;
      }
      if (!this.pending || kind !== this.pending.expected) {
        this.abort('Unexpected download acknowledgement');
        return;
      }
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve();
    };
    port.onmessageerror = () => this.abort('Download port failed');
    port.start();
    this.onPageHide = () => this.abort('Page closed');
    window.addEventListener('pagehide', this.onPageHide);
  }
  static async create(name, size) {
    if (!available() || typeof name !== 'string' || !name || new TextEncoder().encode(name).length > 1024 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(name) || !Number.isSafeInteger(size) || size < 0 || size > 2 ** 50) {
      throw new Error('Streaming download is unavailable or file metadata is invalid');
    }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const channel = new MessageChannel();
    const download = new Download(channel.port1, token);
    try {
      await download.request('ready', () => navigator.serviceWorker.controller.postMessage({ type: 'open', token, name, size }, [channel.port2]));
      download.heartbeat = setInterval(() => {
        const worker = navigator.serviceWorker.controller;
        if (!worker) download.abort('Service Worker is not active');
        else worker.postMessage({ type: 'ping', token });
      }, 10000);
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.title = 'Streaming download';
      frame.src = `/download/${token}`;
      download.frame = frame;
      await download.request('started', () => document.body.appendChild(frame));
      return download;
    } catch (error) {
      download.abort(error);
      channel.port2.close();
      throw error;
    }
  }
  async request(expected, send) {
    if (this.cancelled || this.finished) throw this.failure || new Error('Download is closed');
    if (this.pending) throw new Error('Chunk has not been acknowledged');
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.abort('Download stopped: missing acknowledgement'), 60000);
        this.pending = { expected, resolve, reject, timer };
        try { send(); } catch (error) { this.abort(error); }
      });
    } catch (error) { this.abort(error); throw error; }
  }
  async push(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_LIMIT) throw new Error('Invalid chunk size');
    // Preserve the caller's bytes; only the bounded independent copy is detached.
    const buffer = bytes.slice().buffer;
    await this.request('ack', () => this.port.postMessage({ type: 'chunk', bytes: buffer }, [buffer]));
  }
  async finish() {
    await this.request('done', () => this.port.postMessage({ type: 'end' }));
    this.finished = true;
    this.cleanup();
  }
  abort(reason = 'Download cancelled') {
    if (this.cancelled || this.finished) return;
    this.cancelled = true;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    try { this.port.postMessage({ type: 'abort' }); } catch { /* Port may already be closed. */ }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = null;
    }
    this.cleanup();
  }
  cleanup() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    this.port.close();
    this.frame?.remove();
    this.frame = null;
    window.removeEventListener('pagehide', this.onPageHide);
  }
}
