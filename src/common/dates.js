import { validationError } from './api.js';

function validUtcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw validationError();
  }
  return date;
}

export function parseDate(value) {
  if (typeof value !== 'string') throw validationError();
  const text = value.trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(text);
  if (match) return validUtcDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (match) return validUtcDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
  throw validationError();
}

function two(number) {
  return String(number).padStart(2, '0');
}

export function formatDateShort(value) {
  const date = new Date(value);
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${two(date.getUTCFullYear() % 100)}`;
}

export function formatDateLong(value) {
  const date = new Date(value);
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}
