import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { ApiError } from '../common/api.js';
import { loadConfig } from '../config/env.js';
import { createPrisma } from '../db/prisma.js';
import { createAuthService } from '../auth/service.js';
import { createJwtService } from '../security/jwt.js';

export async function runCreateAdmin({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  prisma: injectedPrisma,
} = {}) {
  const config = loadConfig(env);
  const prisma = injectedPrisma ?? createPrisma(config);
  const service = createAuthService({
    prisma,
    config,
    jwtService: createJwtService(config),
  });
  let secretInput = false;
  const promptOutput = new Writable({
    write(chunk, encoding, callback) {
      // Consume prompt output synchronously: buffering writes behind the real
      // terminal's callback could replay secret keystrokes after input unmutes.
      if (!secretInput) output.write(chunk, encoding);
      callback();
    },
  });
  const prompt = createInterface({
    input,
    output: promptOutput,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  const cancellation = new AbortController();
  prompt.once('close', () => cancellation.abort());
  prompt.on('SIGINT', () => prompt.close());
  const question = (message) => prompt.question(message, { signal: cancellation.signal });

  try {
    const userId = await question('Administrator employee ID: ');
    const employeeName = await question('Administrator name: ');
    const email = await question('Administrator email: ');
    output.write('Administrator password (12+ characters): ');
    secretInput = true;
    let password;
    try {
      password = await question('');
    } finally {
      secretInput = false;
      output.write('\n');
    }
    const user = await service.createUser(
      { userId, employeeName, email, password, role: 'ADMIN' },
      { allowAdminRole: true },
    );
    output.write(`Created administrator ${user.employeeId}.\n`);
    return user;
  } finally {
    prompt.close();
    promptOutput.end();
    if (!injectedPrisma) await prisma.$disconnect();
  }
}

async function main() {
  try {
    await runCreateAdmin();
  } catch (error) {
    if (error instanceof ApiError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      // Prisma diagnostics may include the attempted password hash. Keep
      // unexpected database/configuration failures out of terminal transcripts.
      process.stderr.write('Unable to create administrator; check configuration and database connectivity.\n');
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();
