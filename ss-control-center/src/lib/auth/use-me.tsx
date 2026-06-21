"use client";

/**
 * Shared "current user" context. One `/api/auth/me` fetch for the whole
 * authed shell — the sidebar, the access guard, and any page that needs the
 * user's role / module permissions all read from here instead of each firing
 * their own request.
 *
 * `/api/auth/me` also refreshes the signed access cookie the proxy reads, so
 * mounting this provider keeps the proxy gate fresh on every page load.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export interface MeUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  isAdmin: boolean;
  modules: string[];
}

interface MeState {
  user: MeUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeState>({
  user: null,
  loading: true,
  refresh: async () => {},
});

export function MeProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setUser(data.user ?? null);
      } else {
        setUser(null);
      }
    } catch {
      // Network hiccup — keep whatever we had.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <MeContext.Provider value={{ user, loading, refresh }}>
      {children}
    </MeContext.Provider>
  );
}

export function useMe(): MeState {
  return useContext(MeContext);
}
