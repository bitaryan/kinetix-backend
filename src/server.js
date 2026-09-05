import { startServer } from './runtime.js';

try {
  const runtime = await startServer();
  console.log(`${runtime.config.appName} listening on port ${runtime.server.address().port}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`Received ${signal}; shutting down`);
      const deadline = setTimeout(() => process.exit(1), runtime.config.shutdownTimeoutMs + 5000);
      deadline.unref();
      runtime.stop().catch(() => {
        console.error('Graceful shutdown failed');
        process.exitCode = 1;
      }).finally(() => clearTimeout(deadline));
    });
  }
} catch {
  // Connection exceptions can embed URLs/passwords. Deployment logs must not.
  console.error('Backend startup failed; check configuration, database, Redis, and upload storage');
  process.exitCode = 1;
}
