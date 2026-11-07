import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  return { data, error, loading, reload: load };
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

export const MeContext = createContext<{ me: Me; reload: () => void } | null>(null);
export const useMe = () => useContext(MeContext)!;

/** Runs an async action, exposing busy/error state for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
