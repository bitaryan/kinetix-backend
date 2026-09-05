import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { notFound } from '../common/api.js';

const UUID_PATH_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function employeeOwner(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.length >= 2 && parts[0] === 'attendance' && UUID_PATH_SEGMENT.test(parts[1])) {
    return parts[1].toLowerCase();
  }
  if (parts.length >= 4 && parts[0] === 'client_logs' && UUID_PATH_SEGMENT.test(parts[3])) {
    return parts[3].toLowerCase();
  }
  return null;
}

export function createUploadService({ config }) {
  async function resolveFile(user, relative) {
    if (!relative || relative.includes('\0')) throw notFound('File not found');

    let root;
    let candidate;
    let details;
    try {
      root = await realpath(config.uploadDir);
      const lexicalCandidate = path.resolve(root, relative);
      if (!contained(root, lexicalCandidate)) throw notFound('File not found');
      candidate = await realpath(lexicalCandidate);
      if (!contained(root, candidate)) throw notFound('File not found');
      details = await stat(candidate);
    } catch (error) {
      if (error?.code === 'NOT_FOUND') throw error;
      throw notFound('File not found');
    }
    if (!details.isFile()) throw notFound('File not found');

    if (user.role === 'EMPLOYEE') {
      const ownerId = employeeOwner(path.relative(root, candidate));
      if (ownerId === null || ownerId !== user.id.toLowerCase()) {
        throw notFound('File not found');
      }
    }
    return { absolutePath: candidate, size: details.size };
  }

  return Object.freeze({ resolveFile });
}
