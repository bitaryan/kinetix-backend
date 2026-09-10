import { loadConfig } from '../src/config/env.js';
import { createPrisma } from '../src/db/prisma.js';
import { runRetention } from '../src/operations/retention.js';

let prisma;
try {
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('Unknown argument');
  prisma = createPrisma(loadConfig());
  const result = await runRetention(prisma, { days: Number(process.env.OPERATIONAL_RETENTION_DAYS || 30), apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(result));
} catch {
  console.error('Retention failed; check configuration and database');
  process.exitCode = 1;
} finally { await prisma?.$disconnect(); }
