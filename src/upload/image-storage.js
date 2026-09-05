import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, realpath, unlink, writeFile } from 'node:fs/promises';

import { ApiError } from '../common/api.js';

const ATTENDANCE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const CLIENT_LOG_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const CLIENT_LOG_IMAGE_MESSAGE = 'Image size exceeds 5MB or invalid format';
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
]);

function normalizedMime(file) {
  return typeof file?.mimetype === 'string' ? file.mimetype.trim().toLowerCase() : '';
}

function payloadOf(file) {
  return Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
}

export function extensionFromMagic(payload) {
  if (payload.length >= 3
      && payload[0] === 0xff
      && payload[1] === 0xd8
      && payload[2] === 0xff) {
    return '.jpg';
  }
  if (payload.length >= 8
      && payload[0] === 0x89
      && payload[1] === 0x50
      && payload[2] === 0x4e
      && payload[3] === 0x47
      && payload[4] === 0x0d
      && payload[5] === 0x0a
      && payload[6] === 0x1a
      && payload[7] === 0x0a) {
    return '.png';
  }
  if (payload.length >= 12
      && payload.subarray(0, 4).toString('ascii') === 'RIFF'
      && payload.subarray(8, 12).toString('ascii') === 'WEBP') {
    return '.webp';
  }
  return null;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function createImageStorage(config) {
  const root = path.resolve(config.uploadDir);
  const maxBytes = config.maxUploadBytes;

  function cappedPayload(file, { clientLog = false } = {}) {
    const payload = payloadOf(file);
    const declaredSize = Number(file?.size ?? payload.length);
    if (declaredSize > maxBytes || payload.length > maxBytes) {
      if (clientLog) throw new ApiError(400, 'INVALID_IMAGE', CLIENT_LOG_IMAGE_MESSAGE);
      throw new ApiError(400, 'IMAGE_TOO_LARGE', 'Upload exceeds the maximum upload size');
    }
    return payload;
  }

  async function persist(relativePath, payload, { exclusive = false } = {}) {
    const absolute = path.resolve(root, relativePath);
    if (!inside(root, absolute)) {
      throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }
    try {
      await mkdir(root, { recursive: true });
      const canonicalRoot = await realpath(root);
      let canonicalParent = canonicalRoot;
      const directories = path.relative(root, path.dirname(absolute)).split(path.sep).filter(Boolean);
      for (const directory of directories) {
        const candidate = path.join(canonicalParent, directory);
        await mkdir(candidate, { recursive: true });
        canonicalParent = await realpath(candidate);
        if (!inside(canonicalRoot, canonicalParent)) throw new Error('Upload parent escapes its root');
      }
      // Resolve parent symlinks before writing, and refuse a symlink in the final
      // component. Lexical containment alone can still overwrite outside files.
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW
        | (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
      await writeFile(path.join(canonicalParent, path.basename(absolute)), payload, { flag: flags });
    } catch {
      throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }
    return relativePath.split(path.sep).join('/');
  }

  async function saveAttendanceImage(file, userId, sessionId, kind) {
    if (!ATTENDANCE_MIME_TYPES.has(normalizedMime(file))) {
      throw new ApiError(400, 'INVALID_IMAGE', `${kind} must be a JPEG, PNG, or WebP image`);
    }
    const payload = cappedPayload(file);
    if (payload.length === 0) {
      throw new ApiError(400, 'INVALID_IMAGE', `${kind} file is empty`);
    }
    const extension = extensionFromMagic(payload);
    if (extension === null || MIME_EXTENSIONS.get(normalizedMime(file)) !== extension) {
      throw new ApiError(400, 'INVALID_IMAGE', `${kind} must be a valid JPEG, PNG, or WebP image`);
    }
    // Multiple serializable punch-out attempts can coexist before one commits.
    // Immutable, independently owned files keep loser cleanup from deleting the
    // successful caller's image. Existing database paths remain readable.
    const exclusive = kind === 'closing_odo';
    const filename = exclusive ? `${kind}_${randomUUID()}${extension}` : `${kind}${extension}`;
    return persist(path.join('attendance', userId, sessionId, filename), payload, { exclusive });
  }

  async function saveClientLogSelfie(file, userId, logId, now = new Date()) {
    if (!CLIENT_LOG_MIME_TYPES.has(normalizedMime(file))) {
      throw new ApiError(400, 'INVALID_IMAGE', CLIENT_LOG_IMAGE_MESSAGE);
    }
    const payload = cappedPayload(file, { clientLog: true });
    if (payload.length === 0) {
      throw new ApiError(400, 'INVALID_IMAGE', CLIENT_LOG_IMAGE_MESSAGE);
    }
    const extension = extensionFromMagic(payload);
    if ((extension !== '.jpg' && extension !== '.png')
        || MIME_EXTENSIONS.get(normalizedMime(file)) !== extension) {
      throw new ApiError(400, 'INVALID_IMAGE', CLIENT_LOG_IMAGE_MESSAGE);
    }
    const year = String(now.getUTCFullYear()).padStart(4, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return persist(path.join('client_logs', year, month, userId, `${logId}${extension}`), payload);
  }

  async function deleteStoredFiles(...relativePaths) {
    await Promise.all(relativePaths.map(async (relativePath) => {
      if (typeof relativePath !== 'string' || relativePath.trim() === '') return;
      const absolute = path.resolve(root, relativePath);
      if (!inside(root, absolute)) return;
      try {
        const canonicalRoot = await realpath(root);
        const canonicalFile = await realpath(absolute);
        if (!inside(canonicalRoot, canonicalFile)) return;
        await unlink(absolute);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`Failed to delete orphaned upload ${absolute}`, error);
        }
      }
    }));
  }

  function selfieUrl(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.trim() === '') return null;
    const cleanPath = relativePath.replace(/^\/+/, '').split(path.sep).join('/');
    const uploadPath = `/uploads/${cleanPath}`;
    return config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, '')}${uploadPath}` : uploadPath;
  }

  return Object.freeze({
    deleteStoredFiles,
    saveAttendanceImage,
    saveClientLogSelfie,
    selfieUrl,
  });
}
