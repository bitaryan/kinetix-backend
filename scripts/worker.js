import { loadConfig } from '../src/config/env.js';
import { createPrisma } from '../src/db/prisma.js';
import { createDeliveryWorker } from '../src/workflows/delivery.js';

let prisma;
let stopping = false;
let timer;
let wake;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  clearTimeout(timer);
  wake?.();
});
try {
  const config = loadConfig();
  if (!config.notificationWebhookUrl) throw new Error('Delivery is not configured');
  prisma = createPrisma(config);
  const worker = createDeliveryWorker({ prisma, config });
  do {
    const processed = await worker.runOne();
    if (process.argv.includes('--once')) break;
    if (!processed && !stopping) await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, 2000); });
  } while (!stopping);
} catch {
  console.error(JSON.stringify({ event: 'delivery_worker_failed' }));
  process.exitCode = 1;
} finally { await prisma?.$disconnect(); }
