// Explicit target only; GET requests do not create shifts or mutate real users.
const local = new Set(['localhost', '127.0.0.1', '[::1]']);
try {
  const url = new URL(process.env.LOAD_TEST_URL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (!local.has(url.hostname) && process.env.LOAD_TEST_ACK !== 'authorized-staging')) throw new Error('Target not authorized');
  const concurrency = Number(process.env.LOAD_CONCURRENCY || 5);
  const requests = Number(process.env.LOAD_REQUESTS || 100);
  const maxP95 = Number(process.env.LOAD_MAX_P95_MS || 2000);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100 ||
      !Number.isSafeInteger(requests) || requests < 1 || requests > 100000 || !Number.isFinite(maxP95) || maxP95 <= 0) throw new Error('Invalid limits');
  const headers = process.env.LOAD_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.LOAD_ACCESS_TOKEN}` } : {};
  const times = [];
  const statuses = {};
  let next = 0;
  const began = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next++ < requests) {
      const start = performance.now();
      let status;
      try {
        const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
        await response.arrayBuffer();
        status = response.status;
      } catch { status = 0; }
      statuses[status] = (statuses[status] ?? 0) + 1;
      times.push(performance.now() - start);
    }
  }));
  times.sort((a, b) => a - b);
  const percentile = (p) => Math.round(times[Math.ceil(p * times.length) - 1]);
  const result = { requests, concurrency, requestsPerSecond: Math.round(requests / ((performance.now() - began) / 1000)),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), statuses };
  console.log(JSON.stringify(result));
  if (Object.keys(statuses).some((status) => Number(status) < 200 || Number(status) >= 400) || result.p95Ms > maxP95) process.exitCode = 1;
} catch {
  console.error('Load test failed; supply LOAD_TEST_URL, valid bounded limits, and LOAD_TEST_ACK=authorized-staging for remote targets');
  process.exitCode = 1;
}
