import multer from 'multer';

const CLIENT_BODY_ERRORS = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
  'request.size.invalid',
]);
const DIAGNOSTIC_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientValidationError', 'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);
const MULTIPART_BODY_ERRORS = new Set([
  'Multipart: Boundary not found',
  'Malformed content type',
  'Malformed part header',
  'Unexpected end of form',
  'Unexpected end of file',
  'Request aborted',
  'Request closed',
]);

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function success(data, meta) {
  const envelope = { success: true, data, error: null };
  if (meta !== undefined) envelope.meta = meta;
  return envelope;
}

export function failure(code, message) {
  return { success: false, data: null, error: { code, message } };
}

export function sendSuccess(res, data, status = 200, meta) {
  return res.status(status).json(success(data, meta));
}

export function validationError(message = 'Request data is invalid') {
  return new ApiError(422, 'VALIDATION_ERROR', message);
}

export function notFound(message) {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function isMalformedMultipartError(error) {
  return error instanceof Error && MULTIPART_BODY_ERRORS.has(error.message);
}

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof ApiError) {
    return res.status(error.status).json(failure(error.code, error.message));
  }
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json(failure('IMAGE_TOO_LARGE', 'Upload exceeds the maximum upload size'));
    }
    return res.status(422).json(failure('VALIDATION_ERROR', 'Request data is invalid'));
  }
  if ((error instanceof SyntaxError && Object.hasOwn(error, 'body'))
      || CLIENT_BODY_ERRORS.has(error?.type)
      || (error?.status === 400 && ['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(error?.code))) {
    return res.status(422).json(failure('VALIDATION_ERROR', 'Request data is invalid'));
  }
  // Prisma errors can embed complete mutation arguments, including password
  // and refresh-token hashes. Neither messages, stacks, bodies nor metadata
  // are safe to print here; retain only allow-listed diagnostic identifiers.
  const diagnostic = {
    name: DIAGNOSTIC_ERROR_NAMES.has(error?.name) ? error.name : 'Error',
  };
  if (typeof error?.code === 'string' && /^P\d{4}$/.test(error.code)) {
    diagnostic.code = error.code;
  }
  console.error('Unhandled application error', diagnostic);
  return res.status(500).json(failure('INTERNAL_ERROR', 'An unexpected error occurred'));
}

export function routeNotFound(_req, res) {
  return res.status(404).json(failure('NOT_FOUND', 'Resource not found'));
}
