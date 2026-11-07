import type { Bet, Friend, Invitation, Me } from '../shared/types';
import { api, ApiError } from './api';

/**
 * The signed-in user's data as the app knows it: who they are, their friends, their invitations and their bets.
 *
 * Screens read from here, so what is known shows at once, and ask the server for the latest. Every answer updates the
 * model (a bet is one bet, whether it came from the bets list, its own page or the response to an action), and every
 * screen showing that data follows. The model is also kept in localStorage, so it shows at once after a reload, and
 * other open tabs pick up what this one learns. It belongs to one user: `setOwner` empties it when someone else signs
 * in, and `clearStore` when the user signs out.
 */
export interface Invitations {
  sent: Invitation[];
  received: Invitation[];
}

export interface Model {
  me?: Me;
  friends?: Friend[];
  invitations?: Invitations;
  /** Every bet seen, by id. Includes bets the user has left (a declined invitation) when they opened one. */
  bets: Record<string, Bet>;
  /** The user's bets (the ones they are in), newest first; undefined until the list has been loaded. */
  betIds?: string[];
}

export interface State {
  owner: string | null;
  model: Model;
  /** The last failure per resource, cleared by the next success. */
  errors: Record<string, string>;
}

/** What can be fetched: the user's friends, invitations and bets, or one bet (`bet:<id>`). */
export type Resource = 'friends' | 'invitations' | 'bets' | `bet:${string}`;

export const STORAGE_KEY = 'lojubets:model:v1';
const OLD_KEYS = ['lojubets:cache:v1'];

const EMPTY_MODEL: Model = { bets: {} };
let state: State = { owner: null, model: EMPTY_MODEL, errors: {} };
const listeners = new Set<() => void>();
/** How many screens show each resource; those are refetched when the model is emptied for another user. */
const shown = new Map<Resource, number>();
/** The latest request per resource; an older one that finishes later must not overwrite a newer answer. */
const latest = new Map<Resource, { seq: number; promise: Promise<void> }>();
let seq = 0;
let loaded = false;

// ---------- the user's bets ----------

/** Whether the bets list includes this bet: the user is in it (or invited), and it wasn't cancelled. */
export const isMine = (b: Bet) =>
  b.status !== 'cancelled' && b.participants.some((p) => p.isMe && (p.status === 'joined' || p.status === 'invited'));

/** Whether `friendId` is in the bet with the user (or invited to it): what a friend's page lists. */
export const involves = (b: Bet, friendId: string) =>
  b.participants.some((p) => p.id === friendId && (p.status === 'joined' || p.status === 'invited'));

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Keeps the old object when nothing in it changed, so screens showing it don't redraw. */
const keep = <T>(old: T | undefined, next: T): T => (old !== undefined && same(old, next) ? old : next);

function withBet(m: Model, bet: Bet): Model {
  const b = keep(m.bets[bet.id], bet);
  let betIds = m.betIds;
  if (betIds) {
    const listed = betIds.includes(b.id);
    if (isMine(b) && !listed) {
      const created = (id: string) => (id === b.id ? b : m.bets[id])?.createdAt ?? 0;
      betIds = [...betIds, b.id].sort((x, y) => created(y) - created(x));
    } else if (!isMine(b) && listed) betIds = betIds.filter((id) => id !== b.id);
  }
  return { ...m, bets: { ...m.bets, [b.id]: b }, betIds };
}

function withBetList(m: Model, list: Bet[]): Model {
  const bets = { ...m.bets };
  for (const b of list) bets[b.id] = keep(m.bets[b.id], b);
  const betIds = list.map((b) => b.id);
  return { ...m, bets, betIds: m.betIds && same(m.betIds, betIds) ? m.betIds : betIds };
}

function withoutBet(m: Model, id: string): Model {
  const bets = { ...m.bets };
  delete bets[id];
  return { ...m, bets, betIds: m.betIds?.filter((x) => x !== id) };
}

// ---------- state, storage and subscriptions ----------

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by the browser
  }
}

function read(): State {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as { owner?: unknown; model?: Model }) : null;
    if (s && typeof s.owner === 'string' && s.model?.bets) return { owner: s.owner, model: s.model, errors: {} };
  } catch {
    // unreadable: start empty
  }
  return { owner: null, model: EMPTY_MODEL, errors: {} };
}

function write() {
  try {
    const s = storage();
    if (!s) return;
    OLD_KEYS.forEach((k) => s.removeItem(k));
    if (!state.owner) return s.removeItem(STORAGE_KEY);
    // Bets the user has left are kept in memory only, so storage doesn't grow with every bet ever opened
    const { model } = state;
    const bets = Object.fromEntries((model.betIds ?? []).filter((id) => model.bets[id]).map((id) => [id, model.bets[id]]));
    s.setItem(STORAGE_KEY, JSON.stringify({ owner: state.owner, model: { ...model, bets } }));
  } catch {
    // full or blocked: the model still works in memory
  }
}

function publish(next: State, persist = true) {
  state = next;
  if (persist) write();
  listeners.forEach((fn) => fn());
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  state = read();
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      // Another tab learnt something: take it in. If another user signed in there, fetch what this tab's screens show.
      const before = state.owner;
      latest.clear();
      publish(read(), false);
      if (state.owner && state.owner !== before) refetchShown();
    });
  }
}

export function getState(): State {
  ensureLoaded();
  return state;
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** A screen shows `resource` from now until the returned function is called. */
export function show(resource: Resource) {
  shown.set(resource, (shown.get(resource) ?? 0) + 1);
  return () => {
    const n = (shown.get(resource) ?? 1) - 1;
    if (n) shown.set(resource, n);
    else shown.delete(resource);
  };
}

function refetchShown() {
  for (const r of shown.keys()) refresh(r);
}

// ---------- the signed-in user ----------

/** The signed-in user as last seen, so the app can render before the server confirms it. */
export function cachedMe(): Me | undefined {
  return getState().model.me;
}

/** Records who is signed in. A different user than the model belongs to empties it, and open screens refetch. */
export function setOwner(me: Me | null) {
  const { owner, model } = getState();
  const id = me?.id ?? null;
  if (id !== owner) {
    latest.clear();
    publish({ owner: id, model: { ...EMPTY_MODEL, me: me ?? undefined }, errors: {} });
    if (id) refetchShown();
  } else if (me && !same(model.me, me)) publish({ ...state, model: { ...model, me } });
}

/** Forgets everything, in memory and in localStorage (signing out). */
export function clearStore() {
  setOwner(null);
}

// ---------- fetching ----------

function pathOf(r: Resource) {
  return r.startsWith('bet:') ? `/bets/${encodeURIComponent(r.slice(4))}` : `/${r}`;
}

function apply(m: Model, r: Resource, data: unknown): Model {
  if (r === 'friends') return { ...m, friends: keep(m.friends, data as Friend[]) };
  if (r === 'invitations') return { ...m, invitations: keep(m.invitations, data as Invitations) };
  if (r === 'bets') return withBetList(m, data as Bet[]);
  return withBet(m, data as Bet);
}

function update(model: Model, errors: Record<string, string>) {
  const changed = !same(model, state.model);
  if (!changed && same(errors, state.errors)) return; // nothing new: no redraw, no write
  publish({ ...state, model: changed ? model : state.model, errors }, changed);
}

function setError(r: Resource, message: string | null) {
  const errors = { ...state.errors };
  if (message === null) delete errors[r];
  else errors[r] = message;
  return errors;
}

/**
 * Asks the server for `resource` and updates the model with the answer. A request already in flight is shared,
 * unless `force` is set: after the user changed something, a request that started before could return the old state.
 */
export function refresh(r: Resource, force = false): Promise<void> {
  ensureLoaded();
  const running = latest.get(r);
  if (running && !force) return running.promise;
  const mine = ++seq;
  const owner = state.owner;
  const current = () => latest.get(r)?.seq === mine && state.owner === owner;
  const promise = api(pathOf(r))
    .then(
      (data) => {
        if (current()) update(apply(state.model, r, data), setError(r, null));
      },
      (e: Error) => {
        if (!current()) return;
        // A bet that is gone (or never was the user's) leaves the model; other failures may pass, so keep what we have
        const gone = r.startsWith('bet:') && e instanceof ApiError && e.status === 404;
        update(gone ? withoutBet(state.model, r.slice(4)) : state.model, setError(r, e.message));
      },
    )
    .finally(() => {
      if (latest.get(r)?.seq === mine) latest.delete(r);
    });
  latest.set(r, { seq: mine, promise });
  return promise;
}

// ---------- what the user did ----------

/** A bet as the server returned it after an action (or creating it): every screen showing it updates. */
export function putBet(bet: Bet) {
  ensureLoaded();
  update(withBet(state.model, bet), state.errors);
}

/** The user left a bet (declined, backed out, cancelled it, removed it from history): it leaves their list. */
export function dropBet(id: string) {
  ensureLoaded();
  const m = state.model;
  if (m.betIds?.includes(id)) update({ ...m, betIds: m.betIds.filter((x) => x !== id) }, state.errors);
}
