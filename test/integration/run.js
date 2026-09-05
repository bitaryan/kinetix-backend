import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireTestDatabaseUrl } from './database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Validate before starting any child process; the normal development/production
// datasource is never a fallback. Migrate deploy never resets existing tables.
const databaseUrl = requireTestDatabaseUrl();
const env = {
  ...process.env,
  APP_ENV: 'test',
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
};
const tests = readdirSync(path.join(root, 'test/integration'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `test/integration/${name}`);

for (const args of [
  ['scripts/prisma-cli.js', 'migrate', 'deploy'],
  ['scripts/verify-schema.js'],
  ['--test', '--test-concurrency=1', ...tests],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
