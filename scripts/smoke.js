// Read-only deployed-client gate. Supply a short-lived test-user access token.
try {
  const base = new URL(process.env.SMOKE_BASE_URL);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid origin');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('HTTPS required');
  const token = process.env.SMOKE_ACCESS_TOKEN;
  if (!token) throw new Error('Test access token required');
  for (const pathname of ['/livez', '/readyz', '/health', '/api/v1/auth/me', '/api/v2/attendance', '/api/v2/notifications', '/api/v2/policy']) {
    const response = await fetch(new URL(pathname, base), { headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || !body.success || body.error !== null) throw new Error('Smoke check failed');
    console.log(JSON.stringify({ check: pathname, status: response.status }));
  }
} catch {
  console.error('Smoke gate failed; verify SMOKE_BASE_URL, SMOKE_ACCESS_TOKEN and deployment readiness');
  process.exitCode = 1;
}
