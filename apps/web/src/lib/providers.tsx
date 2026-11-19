'use client';

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  makeClient,
  unwrap,
  type ApiClient,
  type AuthResultDto,
  type CategoryDto,
  type CityDto,
  type UserDto,
  type WalletDto,
} from './api';
import { syncServerTime } from './clock';

const TOKEN_STORAGE_KEY = 'auction_jwt_token';

export interface OutbidToast {
  lotId: string;
  seq: number;
  currentPrice: number;
  minNextBid: number;
}

interface AppContextValue {
  apiUrl: string;
  token: string | null;
  user: UserDto | null;
  isReady: boolean;
  client: ApiClient;
  socket: Socket | null;
  socketConnected: boolean;
  outbidToast: OutbidToast | null;
  dismissOutbidToast: () => void;
  setSession: (auth: AuthResultDto) => void;
  logout: () => void;
  wallet: WalletDto | null;
  unreadNotifications: number;
  categories: CategoryDto[];
  cities: CityDto[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProviders({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            retry: (count, err) => {
              const status = (err as { status?: number } | null)?.status;
              if (status && status >= 400 && status < 500) return false;
              return count < 1;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthAndSocketProvider apiUrl={apiUrl}>{children}</AuthAndSocketProvider>
    </QueryClientProvider>
  );
}

function AuthAndSocketProvider({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [outbidToast, setOutbidToast] = useState<OutbidToast | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!saved) {
      setIsReady(true);
      return;
    }
    const c = makeClient(apiUrl, saved);
    c.GET('/auth/me')
      .then((res) => {
        if (res.data) {
          setToken(saved);
          setUser(res.data);
        } else {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      })
      .catch(() => {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      })
      .finally(() => setIsReady(true));
  }, [apiUrl]);

  const setSession = useCallback((auth: AuthResultDto) => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, auth.token);
    setToken(auth.token);
    setUser(auth.user);
    void qc.invalidateQueries();
  }, [qc]);

  const logout = useCallback(() => {
    if (token) {
      void makeClient(apiUrl, token).POST('/auth/logout').catch(() => undefined);
    }
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
    setOutbidToast(null);
    void qc.clear();
  }, [apiUrl, token, qc]);

  useEffect(() => {
    const s = io(apiUrl, {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    setSocket(s);

    const onConnect = () => {
      setSocketConnected(true);
      s.emit('time:sync', (ack: { serverTime?: string } | undefined) => {
        if (ack?.serverTime) syncServerTime(ack.serverTime);
      });
    };
    const onDisconnect = () => setSocketConnected(false);
    const onOutbid = (payload: OutbidToast) => {
      setOutbidToast(payload);
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('user:outbid', onOutbid);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('user:outbid', onOutbid);
      s.disconnect();
      setSocket(null);
      setSocketConnected(false);
    };
  }, [apiUrl, token, qc]);

  const client = useMemo(() => makeClient(apiUrl, token), [apiUrl, token]);

  const canWallet = user?.role === 'buyer' || user?.role === 'seller';

  const walletQuery = useQuery({
    queryKey: ['wallet', token],
    enabled: Boolean(token && canWallet),
    queryFn: async () => unwrap(await client.GET('/wallet')),
  });

  const notifQuery = useQuery({
    queryKey: ['notifications', 'unread', token],
    enabled: Boolean(token),
    queryFn: async () => unwrap(await client.GET('/notifications', { params: { query: { unreadOnly: 'true', limit: 50 } } })),
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    staleTime: 60_000,
    queryFn: async () => unwrap(await client.GET('/categories')),
  });

  const citiesQuery = useQuery({
    queryKey: ['cities'],
    staleTime: 60_000,
    queryFn: async () => unwrap(await client.GET('/cities')),
  });

  const value = useMemo<AppContextValue>(
    () => ({
      apiUrl,
      token,
      user,
      isReady,
      client,
      socket,
      socketConnected,
      outbidToast,
      dismissOutbidToast: () => setOutbidToast(null),
      setSession,
      logout,
      wallet: walletQuery.data ?? null,
      unreadNotifications: notifQuery.data?.length ?? 0,
      categories: categoriesQuery.data ?? [],
      cities: citiesQuery.data ?? [],
    }),
    [
      apiUrl,
      token,
      user,
      isReady,
      client,
      socket,
      socketConnected,
      outbidToast,
      setSession,
      logout,
      walletQuery.data,
      notifQuery.data,
      categoriesQuery.data,
      citiesQuery.data,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProviders');
  return ctx;
}
