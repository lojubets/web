import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Me } from '../shared/types';
import { getEntry, revalidate, subscribe, type Entry } from './cache';

const NONE: Entry = {};
const noop = () => () => {};

/**
 * Data from a GET endpoint. What was fetched before (on this or another screen) shows at once and is refreshed from the
 * server in the background. `placeholder` can stand in on the first visit, worked out from other cached data.
 */
export function useFetch<T>(path: string | null, placeholder?: () => T | undefined) {
  const entry = useSyncExternalStore(
    useCallback((cb: () => void) => (path ? subscribe(path, cb) : noop()), [path]),
    () => (path ? getEntry(path) : NONE),
  );
  useEffect(() => {
    if (path) revalidate(path);
  }, [path]);
  const reload = useCallback(() => (path ? revalidate(path, true) : Promise.resolve()), [path]);
  const data = (entry.data ?? (path ? placeholder?.() : undefined) ?? null) as T | null;
  const error = entry.error ?? null;
  return { data, error, loading: data === null && error === null, reload };
}

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
