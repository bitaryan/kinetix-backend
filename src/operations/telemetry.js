import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

// Only registered route templates become labels. Never record raw URLs, query
// strings, headers, bodies, user IDs, IPs, database errors, or credentials.
export function createTelemetry({ log = () => {}, now = () => performance.now() } = {}) {
  const series = new Map();
  let sockets = 0;
  let socketFailures = 0;
  function middleware(req, res, next) {
    const start = now();
    const requestId = randomUUID();
    const traceId = randomBytes(16).toString('hex');
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('Traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      const method = METHODS.has(req.method) ? req.method : 'OTHER';
      const route = res.locals.telemetryRoute ?? 'unmatched';
      const status = res.writableFinished ? res.statusCode : 499;
      const seconds = Math.max(0, now() - start) / 1000;
      const labels = `method="${method}",route="${route}",status="${status}"`;
      const entry = series.get(labels) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      entry.count += 1;
      entry.sum += seconds;
      BUCKETS.forEach((bound, i) => { if (seconds <= bound) entry.buckets[i] += 1; });
      series.set(labels, entry);
      try { log({ event: 'http_request', requestId, traceId, method, route, status,
        durationMs: Math.round(seconds * 1000), timestamp: new Date().toISOString() }); } catch { /* Logging cannot fail a response. */ }
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  }
  function render() {
    const lines = [
      '# HELP gpss_http_requests_total Completed HTTP requests.',
      '# TYPE gpss_http_requests_total counter',
      '# HELP gpss_http_duration_seconds HTTP response duration.',
      '# TYPE gpss_http_duration_seconds histogram',
    ];
    for (const [labels, entry] of series) {
      lines.push(`gpss_http_requests_total{${labels}} ${entry.count}`);
      BUCKETS.forEach((bound, i) => lines.push(`gpss_http_duration_seconds_bucket{${labels},le="${bound}"} ${entry.buckets[i]}`));
      lines.push(`gpss_http_duration_seconds_bucket{${labels},le="+Inf"} ${entry.count}`,
        `gpss_http_duration_seconds_sum{${labels}} ${entry.sum}`,
        `gpss_http_duration_seconds_count{${labels}} ${entry.count}`);
    }
    lines.push('# HELP gpss_websocket_connections Currently open dashboard sockets.',
      '# TYPE gpss_websocket_connections gauge', `gpss_websocket_connections ${sockets}`,
      '# HELP gpss_websocket_failures_total Failed dashboard connections.',
      '# TYPE gpss_websocket_failures_total counter', `gpss_websocket_failures_total ${socketFailures}`,
      '# HELP gpss_process_resident_memory_bytes Resident process memory in bytes.',
      '# TYPE gpss_process_resident_memory_bytes gauge', `gpss_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# HELP gpss_process_uptime_seconds Process uptime in seconds.',
      '# TYPE gpss_process_uptime_seconds gauge', `gpss_process_uptime_seconds ${process.uptime()}`);
    return `${lines.join('\n')}\n`;
  }
  return { middleware, render,
    socketOpened() { sockets += 1; },
    socketClosed() { sockets = Math.max(0, sockets - 1); },
    socketFailed() { socketFailures += 1; },
  };
}

export function metricsAuthorized(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Capture templates at registration time: Express's req.baseUrl can contain
// attacker-supplied path segments. Labels must never come from it at runtime.
export function instrumentRoutes(router, prefix = '') {
  for (const layer of router.stack ?? router.router?.stack ?? []) {
    if (layer.route && typeof layer.route.path === 'string') {
      const label = `${prefix}${layer.route.path}`.replace(/\/$/, '') || '/';
      const handle = layer.handle;
      layer.handle = function tracked(req, res, next) {
        res.locals.telemetryRoute = label;
        return handle(req, res, next);
      };
    }
  }
  return router;
}
