import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { normalizeDatabaseUrl } from '../src/config/env.js';

const executable = process.platform === 'win32'
  ? path.resolve('node_modules/.bin/prisma.cmd')
  : path.resolve('node_modules/.bin/prisma');

const result = spawnSync(executable, process.argv.slice(2), {
  env: {
    ...process.env,
    DATABASE_URL: normalizeDatabaseUrl(process.env.DATABASE_URL),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
