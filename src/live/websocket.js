import { randomUUID } from 'node:crypto';

import WebSocket, { WebSocketServer } from 'ws';

import { ApiError, failure } from '../common/api.js';

export const LIVE_LOCATIONS_TOPIC = '/topic/live-locations';

export const LIVE_WEBSOCKET_LIMITS = Object.freeze({
  frameBytes: 64 * 1024,
  queuedBytes: 256 * 1024,
  queuedFrames: 32,
  subscriptions: 16,
  connections: 1024,
  connectTimeoutMs: 10_000,
  authConcurrency: 8,
  authTimeoutMs: 10_000,
  revalidateIntervalMs: 30_000,
});
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;

function decodeHeader(value) {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\c/g, ':').replace(/\\\\/g, '\\');
}

function encodeHeader(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/:/g, '\\c');
}

function parseFrame(raw) {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  if (!normalized.trim()) return null;
  const separator = normalized.indexOf('\n\n');
  const headerBlock = separator === -1 ? normalized : normalized.slice(0, separator);
  const body = separator === -1 ? '' : normalized.slice(separator + 2);
  const lines = headerBlock.split('\n');
  const command = lines.shift()?.trim();
  if (!command) return null;
  const headers = Object.create(null);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = decodeHeader(line.slice(0, colon));
    if (!(name in headers)) headers[name] = decodeHeader(line.slice(colon + 1));
  }
  return { command, headers, body };
}

function stompFrame(command, headers = {}, body = '') {
  const payload = String(body);
  const entries = Object.entries(headers).map(([name, value]) => (
    `${encodeHeader(name)}:${encodeHeader(value)}`
  ));
  return `${command}\n${entries.join('\n')}\n\n${payload}\0`;
}

function send(ws, frame, callback) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount + Buffer.byteLength(frame) > MAX_OUTPUT_BYTES) {
    ws.terminate();
    return;
  }
  ws.send(frame, callback);
}

function sendReceipt(ws, headers) {
  if (headers.receipt) send(ws, stompFrame('RECEIPT', { 'receipt-id': headers.receipt }));
}

function protocolVersion(acceptVersion) {
  const accepted = String(acceptVersion || '1.0').split(',').map((item) => item.trim());
  if (accepted.includes('1.2')) return '1.2';
  if (accepted.includes('1.1')) return '1.1';
  return '1.0';
}

function roleOf(principal) {
  return principal?.user?.role ?? principal?.role;
}

function errorFrame(error) {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  const body = JSON.stringify(failure(apiError.code, apiError.message));
  return stompFrame('ERROR', {
    message: apiError.message,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  }, body);
}

function closeWithError(ws, error) {
  if (ws.readyState !== WebSocket.OPEN) return;
  send(ws, errorFrame(error), () => ws.close(1008, 'STOMP error'));
}

export function attachLiveWebSocket({
  server,
  auth,
  liveHub,
  config = {},
  path = '/ws',
  limits: overrides = {},
  telemetry,
}) {
  if (!server?.on) throw new TypeError('HTTP server is required');
  if (typeof auth?.authenticateToken !== 'function') {
    throw new TypeError('auth.authenticateToken is required');
  }
  if (typeof liveHub?.subscribe !== 'function') throw new TypeError('liveHub is required');

  const limits = { ...LIVE_WEBSOCKET_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid WebSocket limit: ${name}`);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes });
  const states = new WeakMap();
  const allowedOrigins = new Set(config.corsOrigins ?? []);
  const authQueue = new Map();
  let activeAuthorizations = 0;

  function pumpAuthorizations() {
    while (activeAuthorizations < limits.authConcurrency && authQueue.size > 0) {
      const [ws, job] = authQueue.entries().next().value;
      authQueue.delete(ws);
      activeAuthorizations += 1;
      Promise.resolve()
        .then(() => auth.authenticateToken(job.token))
        .then((principal) => {
          if (!['ADMIN', 'MANAGER'].includes(roleOf(principal))) {
            throw new ApiError(403, 'FORBIDDEN', 'You do not have permission for this action');
          }
          return principal;
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          // Keep the slot until the actual database work settles, even if the
          // peer times out. Hung authentication cannot spawn unlimited work.
          activeAuthorizations -= 1;
          pumpAuthorizations();
        });
    }
  }

  function authorize(ws) {
    const state = states.get(ws);
    if (state.authJob) return state.authJob.promise;
    const job = { token: state.token };
    const pending = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    const deadline = setTimeout(() => {
      state.fail(new ApiError(401, 'UNAUTHORIZED', 'Access session is no longer active'));
    }, limits.authTimeoutMs);
    deadline.unref();
    job.promise = pending.finally(() => {
      clearTimeout(deadline);
      if (state.authJob === job) state.authJob = null;
    });
    state.authJob = job;
    authQueue.set(ws, job);
    pumpAuthorizations();
    return job.promise;
  }

  function flushOutput(ws, state) {
    if (state.delivering) return;
    state.delivering = true;
    // Coalesce synchronous fan-out into one authorization job per socket. New
    // events that arrive during a check require a subsequent fresh check.
    Promise.resolve().then(async () => {
      if (state.authJob) await state.authJob.promise;
      while (state.output.length && !state.stopped && ws.readyState === WebSocket.OPEN) {
        const batch = state.output;
        state.output = [];
        const principal = await authorize(ws);
        const allowed = typeof liveHub.filterEvents === 'function'
          ? (await liveHub.filterEvents(batch.map((body) => JSON.parse(body)))).map((event) => JSON.stringify(event))
          : batch;
        if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
        state.principal = principal;
        for (const body of batch) {
          state.outputBytes -= Buffer.byteLength(body);
          state.outputFrames -= 1;
        }
        for (const body of allowed) {
          for (const [subscription, destination] of state.subscriptions) {
            if (destination !== LIVE_LOCATIONS_TOPIC) continue;
            send(ws, stompFrame('MESSAGE', {
              subscription,
              'message-id': randomUUID(),
              destination: LIVE_LOCATIONS_TOPIC,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            }, body));
          }
        }
      }
    }).catch(state.fail).finally(() => { state.delivering = false; });
  }

  const unsubscribe = liveHub.subscribe((data) => {
    const body = JSON.stringify(data);
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const state = states.get(ws);
      if (!state?.connected || state.stopped) continue;
      if (![...state.subscriptions.values()].includes(LIVE_LOCATIONS_TOPIC)) continue;
      const bytes = Buffer.byteLength(body);
      if (state.outputFrames >= limits.queuedFrames || state.outputBytes + bytes > limits.queuedBytes) {
        state.fail(new ApiError(422, 'VALIDATION_ERROR', 'Request data is invalid'));
        continue;
      }
      state.output.push(body);
      state.outputBytes += bytes;
      state.outputFrames += 1;
      flushOutput(ws, state);
    }
  });

  async function handleFrame(ws, frame) {
    if (!frame) return;
    const state = states.get(ws);
    if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
    if (frame.command === 'CONNECT' || frame.command === 'STOMP') {
      if (state.connected) throw new ApiError(400, 'VALIDATION_ERROR', 'Request data is invalid');
      const authorization = frame.headers.Authorization;
      if (!authorization || !/^Bearer /i.test(authorization)) {
        throw new ApiError(401, 'UNAUTHORIZED', 'A bearer access token is required');
      }
      const token = authorization.slice(7).trim();
      if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
      state.token = token;
      const principal = await authorize(ws);
      if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
      state.connected = true;
      state.principal = principal;
      clearTimeout(state.connectTimer);
      state.revalidateTimer = setInterval(() => {
        if (state.stopped || state.authJob || state.delivering || ws.readyState !== WebSocket.OPEN) return;
        authorize(ws).then((updated) => { state.principal = updated; }).catch(state.fail);
      }, limits.revalidateIntervalMs);
      state.revalidateTimer.unref();
      send(ws, stompFrame('CONNECTED', {
        version: protocolVersion(frame.headers['accept-version']),
        'heart-beat': '0,0',
      }));
      return;
    }

    if (!state.connected) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A bearer access token is required');
    }
    if (frame.command === 'SUBSCRIBE') {
      const destination = frame.headers.destination;
      const subscription = frame.headers.id ?? randomUUID();
      if (!destination) throw new ApiError(422, 'VALIDATION_ERROR', 'Request data is invalid');
      if (!state.subscriptions.has(subscription) && state.subscriptions.size >= limits.subscriptions) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Request data is invalid');
      }
      state.subscriptions.set(subscription, destination);
      sendReceipt(ws, frame.headers);
      return;
    }
    if (frame.command === 'UNSUBSCRIBE') {
      if (frame.headers.id) state.subscriptions.delete(frame.headers.id);
      sendReceipt(ws, frame.headers);
      return;
    }
    if (frame.command === 'DISCONNECT') {
      if (frame.headers.receipt) {
        send(ws, stompFrame('RECEIPT', { 'receipt-id': frame.headers.receipt }), () => ws.close(1000));
      } else {
        ws.close(1000);
      }
      return;
    }
    // The Java simple broker has no /app message handlers. ACK/NACK/SEND are harmless here.
    sendReceipt(ws, frame.headers);
  }

  wss.on('connection', (ws) => {
    telemetry?.socketOpened();
    const state = {
      connected: false,
      stopped: false,
      principal: null,
      token: null,
      authJob: null,
      subscriptions: new Map(),
      output: [],
      outputBytes: 0,
      outputFrames: 0,
      delivering: false,
      input: Buffer.alloc(0),
      queue: Promise.resolve(),
      queuedFrames: 0,
      queuedBytes: 0,
      connectTimer: null,
      closeTimer: null,
      revalidateTimer: null,
    };
    states.set(ws, state);

    function stop() {
      state.stopped = true;
      state.input = Buffer.alloc(0);
      state.subscriptions.clear();
      state.output = [];
      state.outputBytes = 0;
      state.outputFrames = 0;
      state.token = null;
      clearTimeout(state.connectTimer);
      clearInterval(state.revalidateTimer);
      authQueue.delete(ws);
      state.authJob?.reject(new ApiError(401, 'UNAUTHORIZED', 'Access session is no longer active'));
    }

    function fail(error) {
      if (state.stopped) return;
      telemetry?.socketFailed();
      stop();
      // A peer need not read the ERROR frame or complete the close handshake.
      state.closeTimer = setTimeout(() => ws.terminate(), CLOSE_TIMEOUT_MS);
      state.closeTimer.unref();
      closeWithError(ws, error);
    }
    state.fail = fail;

    state.connectTimer = setTimeout(() => {
      fail(new ApiError(401, 'UNAUTHORIZED', 'A bearer access token is required'));
    }, limits.connectTimeoutMs);
    state.connectTimer.unref();
    ws.on('error', () => {
      if (!state.stopped) telemetry?.socketFailed();
      // Protocol errors (including invalid UTF-8 and maxPayload) are emitted by
      // ws, not by our message handler. Never let an untrusted frame exit Node.
      stop();
      ws.terminate();
    });
    ws.on('close', () => {
      telemetry?.socketClosed();
      stop();
      clearTimeout(state.closeTimer);
    });
    ws.on('message', (chunk) => {
      if (state.stopped) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (state.input.length + bytes.length > limits.frameBytes) {
        fail(new ApiError(422, 'VALIDATION_ERROR', 'Request data is invalid'));
        return;
      }
      state.input = Buffer.concat([state.input, bytes]);
      // Heartbeats are not partial STOMP frames and must not accumulate forever.
      let prefix = 0;
      while (state.input[prefix] === 10 || state.input[prefix] === 13) prefix += 1;
      state.input = state.input.subarray(prefix);
      let terminator = state.input.indexOf(0);
      while (terminator >= 0) {
        const frameBytes = terminator + 1;
        if (state.queuedFrames >= limits.queuedFrames
            || state.queuedBytes + frameBytes > limits.queuedBytes) {
          fail(new ApiError(422, 'VALIDATION_ERROR', 'Request data is invalid'));
          return;
        }
        const raw = state.input.subarray(0, terminator).toString('utf8');
        state.input = state.input.subarray(frameBytes);
        state.queuedFrames += 1;
        state.queuedBytes += frameBytes;
        state.queue = state.queue
          .then(() => handleFrame(ws, parseFrame(raw)))
          .catch(fail)
          .finally(() => {
            state.queuedFrames -= 1;
            state.queuedBytes -= frameBytes;
          });
        terminator = state.input.indexOf(0);
      }
    });
  });

  const onUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path || wss.clients.size >= limits.connections) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      const body = JSON.stringify(failure('FORBIDDEN', 'You do not have permission for this action'));
      socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
  server.on('upgrade', onUpgrade);

  function detach() {
    server.off('upgrade', onUpgrade);
    unsubscribe();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return Object.freeze({ wss, detach });
}

export const attachLiveWebSocketServer = attachLiveWebSocket;
