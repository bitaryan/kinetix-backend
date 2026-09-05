import { isIP } from 'node:net';

import { ApiError } from '../common/api.js';

const WINDOW_MS = 60_000;
const CLEANUP_MS = 300_000;

export class RateLimiter {
  #events = new Map();
  #lastCleanup = Date.now();

  constructor(config) {
    this.config = config;
  }

  hit(key, limit, cost = 1) {
    if (limit <= 0 || cost <= 0) return;
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const bucket = (this.#events.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (bucket.length + cost > limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again later');
    }
    for (let index = 0; index < cost; index += 1) bucket.push(now);
    this.#events.set(key, bucket);
    this.#cleanup(now, cutoff);
  }

  clientIp(req) {
    const normalize = (ip) => ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    const peer = normalize(req.socket?.remoteAddress) || 'unknown';
    const trusted = new Set(this.config.trustedProxyIps.map(normalize));
    if (!trusted.has(peer)) return peer;
    const header = req.get?.('X-Forwarded-For') ?? req.headers?.['x-forwarded-for'];
    if (typeof header !== 'string') return peer;
    const chain = header.split(',').map((ip) => normalize(ip.trim()));
    if (chain.some((ip) => !isIP(ip))) return peer;
    // A trusted edge may append to a client-supplied header. Walk from the
    // trusted peer back to the first untrusted hop, never the spoofable first item.
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (!trusted.has(chain[index])) return chain[index];
    }
    return chain[0] || peer;
  }

  enforceLogin(req) {
    return this.hit(`login:${this.clientIp(req)}`, this.config.loginRateLimitPerMinute);
  }

  enforceRefresh(req) {
    return this.hit(`refresh:${this.clientIp(req)}`, this.config.refreshRateLimitPerMinute);
  }

  enforceLocationPing(req, userId) {
    const limit = this.config.locationPingRateLimitPerMinute;
    this.hit(`locping:user:${userId}`, limit);
    this.hit(`locping:ip:${this.clientIp(req)}`, Math.max(limit * 100, limit));
  }

  clear() {
    this.#events.clear();
  }

  #cleanup(now, cutoff) {
    if (now - this.#lastCleanup < CLEANUP_MS) return;
    this.#lastCleanup = now;
    for (const [key, bucket] of this.#events) {
      if (bucket.length === 0 || bucket.at(-1) <= cutoff) this.#events.delete(key);
    }
  }
}
