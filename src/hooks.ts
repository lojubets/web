import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Bet, Friend, Me } from '../shared/types';
import { api } from './api';
import { getState, involves, refresh, show, subscribe, type Invitations, type Model, type Resource } from './store';

/** A one-off GET, not kept anywhere: for things that aren't part of the user's model (settings, a merge preview). */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);
  return { data, error, loading, reload: load, set: setData };
}

// ---------- the user's model (see store.ts) ----------

const useModelState = () => useSyncExternalStore(subscribe, getState);

/**
 * Shows what the model knows about `resource` at once and asks the server for the latest; when the answer arrives,
 * every screen showing it updates. `reload` asks again after the user changed something.
 */
function useModel<T>(resource: Resource | null, select: (m: Model) => T | undefined) {
  const { model, errors } = useModelState();
  useEffect(() => {
    if (!resource) return;
    const hide = show(resource);
    refresh(resource);
    return hide;
  }, [resource]);
  const reload = useCallback(() => (resource ? refresh(resource, true) : Promise.resolve()), [resource]);
  const data = select(model) ?? null;
  const error = (resource && errors[resource]) || null;
  return { data, error, loading: data === null && error === null, reload };
}

export const useFriends = () => useModel<Friend[]>('friends', (m) => m.friends);

export const useInvitations = () => useModel<Invitations>('invitations', (m) => m.invitations);

/** The user's bets, newest first. `enabled: false` reads nothing (the profile page while the email is unverified). */
export function useMyBets(enabled = true) {
  const r = useModel<string[]>(enabled ? 'bets' : null, (m) => m.betIds);
  const bets = useModelState().model.bets;
  const data = useMemo(() => r.data?.map((id) => bets[id]).filter(Boolean) ?? null, [r.data, bets]);
  return { ...r, data };
}

/** The user's bets with one friend (they are in it, or invited). */
export function useBetsWith(friendId: string) {
  const r = useMyBets();
  const data = useMemo(() => r.data?.filter((b) => involves(b, friendId)) ?? null, [r.data, friendId]);
  return { ...r, data };
}

export const useBet = (id: string) => useModel<Bet>(`bet:${id}`, (m) => m.bets[id]);

// ---------- the signed-in user and actions ----------

/** The signed-in user. `setMe` takes the user as a change to the account returned it; `reload` asks the server. */
export const MeContext = createContext<{ me: Me; reload: () => Promise<unknown>; setMe: (me: Me) => void } | null>(null);
export const useMe = () => useContext(MeContext)!;

/**
 * Runs an async action (a request that changes something), exposing busy/error state for buttons and forms.
 * `run(fn, key)` names which button started it: `busyOn(key)` is true for that button only, so it can show a spinner
 * (`aria-busy`), while `busy` disables the buttons that share the action. A second run while one is pending is ignored.
 */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, key = 'default'): Promise<T | undefined> => {
    if (running.current) return;
    running.current = true;
    setPending(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setPending(null);
    }
  }, []);
  const busyOn = useCallback((key = 'default') => pending === key, [pending]);
  return { busy: pending !== null, busyOn, error, run };
}
