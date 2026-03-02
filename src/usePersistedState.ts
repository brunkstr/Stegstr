import { useState, useEffect } from "react";

/**
 * Like useState, but syncs to localStorage under a profile-scoped key.
 * Uses the same key format as the existing App.tsx getStorageKey function.
 *
 * - `baseKey`: The base key name (e.g. "stegstr_relays")
 * - `profile`: The profile identifier for key scoping (null = no prefix)
 * - `initialValue`: Default value if nothing in localStorage
 * - `serialize` / `deserialize`: Custom serialization (defaults to JSON)
 */
export function usePersistedState<T>(
  baseKey: string,
  profile: string | null | undefined,
  initialValue: T | (() => T),
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (raw: string) => T;
  },
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const prefix = profile ? `stegstr_test_${profile}_` : "";
  const key = prefix + baseKey;
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = options?.deserialize ?? JSON.parse;

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return deserialize(raw);
    } catch (_) {}
    return typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value));
    } catch (_) {}
  }, [value, key, serialize]);

  return [value, setValue];
}
