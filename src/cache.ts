import { api } from './api';

/**
 * An in-memory cache of GET responses, so a screen the user has seen before (friends, bets) renders at once on
 * navigation and is then brought up to date from the server ("stale while revalidate").
 *
 * It lives only in memory: nothing is written to localStorage or other browser storage (the privacy policy says so).
 * It belongs to one signed-in user; `setCacheOwner` empties it when someone else signs in or the user signs out.
 */
export interface Entry {
  data?: unknown;
  error?: string;
}

const EMPTY: Entry = {};
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
/** The latest request per path; an older one that finishes later must not overwrite a newer answer. */
const latest = new Map<string, { seq: number; promise: Promise<void> }>();
let seq = 0;
let owner: string | null = null;

const notify = (path: string) => listeners.get(path)?.forEach((fn) => fn());

function set(path: string, entry: Entry) {
  entries.set(path, entry);
  notify(path);
}

/** Says whose data the cache holds. A different user (or null, signed out) empties it. */
export function setCacheOwner(id: string | null) {
  if (id === owner) return;
  owner = id;
  const paths = [...entries.keys()];
  entries.clear();
  latest.clear();
  paths.forEach(notify);
}

export const getEntry = (path: string): Entry => entries.get(path) ?? EMPTY;

export function peek<T>(path: string): T | undefined {
  return entries.get(path)?.data as T | undefined;
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

/**
 * Fetches `path` and stores the answer. A request already in flight is shared, unless `force` is set: after a change
 * on the server (the user did something), a request that started before it could return the old state.
 */
export function revalidate(path: string, force = false): Promise<void> {
  const running = latest.get(path);
  if (running && !force) return running.promise;
  const mine = ++seq;
  const forOwner = owner;
  const current = () => latest.get(path)?.seq === mine && owner === forOwner;
  const promise = api(path)
    .then(
      (data) => current() && set(path, { data }),
      (e: Error) => current() && set(path, { ...getEntry(path), error: e.message }),
    )
    .finally(() => {
      if (latest.get(path)?.seq === mine) latest.delete(path);
    })
    .then(() => undefined);
  latest.set(path, { seq: mine, promise });
  return promise;
}
