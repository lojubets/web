import type { NextFunction, Request, Response } from 'express';
import { db } from './db.js';

/** Counts a hit against `key` in a fixed window and says whether it is still within `max`. */
export async function hit(key: string, max: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const r = await db.execute({
    sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
          RETURNING count`,
    args: [key, now, now - windowMs, now - windowMs, now],
  });
  return Number(r.rows[0].count) <= max;
}

/** Throttles by client IP, and optionally also by a value from the request body (e.g. the email being attacked) or by the signed-in user. */
export function rateLimit(name: string, opts: { perIp: number; perBody?: { field: string; max: number }; perUser?: number; windowMs?: number }) {
  const windowMs = opts.windowMs ?? 15 * 60_000;
  return async (req: Request, res: Response, next: NextFunction) => {
    const keys: [string, number][] = [[`${name}:ip:${req.ip}`, opts.perIp]];
    const v = opts.perBody && req.body?.[opts.perBody.field];
    if (typeof v === 'string' && v) keys.push([`${name}:${opts.perBody!.field}:${v.trim().toLowerCase().slice(0, 200)}`, opts.perBody!.max]);
    if (opts.perUser && res.locals.userId) keys.push([`${name}:user:${res.locals.userId}`, opts.perUser]);
    for (const [key, max] of keys) {
      if (!(await hit(key, max, windowMs))) {
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
    }
    next();
  };
}
