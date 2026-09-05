import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireTestDatabaseUrl } from '../test/integration/database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = requireTestDatabaseUrl();
const result = spawnSync(process.execPath, [
  path.join(root, 'scripts/prisma-cli.js'),
  'migrate', 'diff',
  '--from-schema-datasource', 'prisma/schema.prisma',
  '--to-schema-datamodel', 'prisma/schema.prisma',
  '--exit-code',
], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status === 2) {
  console.error('The migrated test database differs from prisma/schema.prisma');
}
process.exitCode = result.status ?? 1;
