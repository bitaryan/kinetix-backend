import { PrismaClient } from '@prisma/client';

let singleton;

export function createPrisma(config) {
  const url = new URL(config.databaseUrl);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(config.databasePoolSize));
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', String(config.databaseConnectionTimeoutSeconds));
  }
  return new PrismaClient({
    datasources: { db: { url: url.toString() } },
    transactionOptions: {
      maxWait: 5_000,
      timeout: 15_000,
    },
  });
}

export function getPrisma(config) {
  singleton ??= createPrisma(config);
  return singleton;
}

export async function disconnectPrisma() {
  if (!singleton) return;
  await singleton.$disconnect();
  singleton = undefined;
}
