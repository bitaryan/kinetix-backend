import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import argon2 from 'argon2';

import { runCreateAdmin } from '../../src/bootstrap/create-admin.js';

test('administrator bootstrap never echoes the password in an interactive terminal', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const rawModes = [];
  input.setRawMode = (enabled) => rawModes.push(enabled);
  let transcript = '';
  const password = 'Bootstrap-secret-123';
  const replies = new Map([
    ['Administrator employee ID: ', 'ADMIN001'],
    ['Administrator name: ', 'Administrator'],
    ['Administrator email: ', 'admin@example.com'],
    ['Administrator password (12+ characters): ', password],
  ]);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      transcript += text;
      for (const [label, answer] of replies) {
        if (!text.includes(label)) continue;
        replies.delete(label);
        queueMicrotask(() => input.write(`${answer}\r`));
        break;
      }
      callback();
    },
  });
  output.isTTY = true;
  let created;
  const tx = {
    user: {
      findUnique: async () => null,
      create: async ({ data }) => { created = data; return { id: 'admin-id', ...data }; },
    },
  };
  const user = await runCreateAdmin({
    input, output,
    env: {
      APP_ENV: 'development', JWT_SECRET_KEY: 'bootstrap-test-secret-key-0123456789abcdef',
      DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/gpss_bootstrap_test',
    },
    prisma: { $transaction: async (operation) => operation(tx) },
  });
  assert.equal(user.role, 'ADMIN');
  assert.equal(created.employeeId, 'ADMIN001');
  assert.equal(await argon2.verify(created.passwordHash, password), true);
  assert.equal(transcript.includes(password), false);
  assert.match(transcript, /Created administrator ADMIN001/);
  assert.deepEqual(rawModes, [true, false]);
  input.destroy();
  output.destroy();
});
