import type { Me } from '../shared/types';
import { api } from './api';

/**
 * A cache of GET responses, so a screen the user has seen before (friends, bets) renders at once and is then brought up
 * to date from the server ("stale while revalidate"). Every screen still asks the server; when the answer differs from
 * what was cached, the cache (and so the screen) is updated.
 *
 * Friends, invitations and bets lists, and the signed-in user, are also kept in localStorage, so they show at once after
 * a reload too, and other open tabs pick up what this one learns. The cache belongs to one signed-in user:
 * `setCacheOwner` empties it when someone else signs in, and `clearCache` when the user signs out.
 */
export interface Entry {
  data?: unknown;
  error?: string;
}

interface Stored {
  owner: string;
  me?: Me;
  entries: Record<string, unknown>;
}

export const STORAGE_KEY = 'lojubets:cache:v1';
/** What is kept across reloads. Other responses (a single bet, settings) are cached in memory only. */
const persisted = (path: string) => /^\/(friends|invitations|bets)(\?|$)/.test(path);

const EMPTY: Entry = {};
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
/** The latest request per path; an older one that finishes later must not overwrite a newer answer. */
const latest = new Map<string, { seq: number; promise: Promise<void> }>();
let seq = 0;
let owner: string | null = null;
let me: Me | undefined;
let loaded = false;

const notify = (path: string) => listeners.get(path)?.forEach((fn) => fn());

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by the browser
  }
}

function read(): Stored | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as Stored) : null;
    return s && typeof s.owner === 'string' && s.entries ? s : null;
  } catch {
    return null;
  }
}

function write() {
  try {
    const s = storage();
    if (!s) return;
    if (!owner) return s.removeItem(STORAGE_KEY);
    const out: Stored = { owner, me, entries: {} };
    for (const [path, e] of entries) if (persisted(path) && e.data !== undefined) out.entries[path] = e.data;
    s.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // full or blocked: the in-memory cache still works
  }
}

/** Takes in what localStorage holds (on start, and when another tab changed it). */
function adopt(s: Stored | null) {
  const before = new Set(entries.keys());
  entries.clear();
  latest.clear();
  owner = s?.owner ?? null;
  me = s?.me;
  for (const [path, data] of Object.entries(s?.entries ?? {})) entries.set(path, { data });
  new Set([...before, ...entries.keys()]).forEach(notify);
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  adopt(read());
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY || e.key === null) adopt(read());
    });
  }
}

/** The signed-in user as last seen, so the app can render before the server confirms it. */
export function cachedMe(): Me | undefined {
  ensureLoaded();
  return me;
}

/** Records the signed-in user. A different user than the cache belongs to empties it. */
export function setCacheOwner(user: Me | null) {
  ensureLoaded();
  const id = user?.id ?? null;
  if (id !== owner) {
    adopt(null);
    owner = id;
  }
  me = user ?? undefined;
  write();
}

/** Forgets everything, in memory and in localStorage (signing out). */
export function clearCache() {
  setCacheOwner(null);
}

export function getEntry(path: string): Entry {
  ensureLoaded();
  return entries.get(path) ?? EMPTY;
}

export function peek<T>(path: string): T | undefined {
  return getEntry(path).data as T | undefined;
}

export function subscribe(path: string, fn: () => void) {
  let set = listeners.get(path);
  if (!set) listeners.set(path, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(path);
  };
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function store(path: string, entry: Entry) {
  const old = getEntry(path);
  if (same(old.data, entry.data) && old.error === entry.error) return; // nothing new: no re-render, no write
  const changedData = !same(old.data, entry.data);
  entries.set(path, entry);
  if (changedData && persisted(path)) write();
  notify(path);
}

/**
 * Fetches `path` and stores the answer. A request already in flight is shared, unless `force` is set: after a change
 * on the server (the user did something), a request that started before it could return the old state.
 */
export function revalidate(path: string, force = false): Promise<void> {
  ensureLoaded();
  const running = latest.get(path);
  if (running && !force) return running.promise;
  const mine = ++seq;
  const forOwner = owner;
  const current = () => latest.get(path)?.seq === mine && owner === forOwner;
  const promise = api(path)
    .then(
      (data) => current() && store(path, { data }),
      (e: Error) => current() && store(path, { ...getEntry(path), error: e.message }),
    )
    .finally(() => {
      if (latest.get(path)?.seq === mine) latest.delete(path);
    })
    .then(() => undefined);
  latest.set(path, { seq: mine, promise });
  return promise;
}
