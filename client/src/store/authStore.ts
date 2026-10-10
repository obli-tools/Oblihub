import { create } from 'zustand';
import { authApi } from '@/api/auth.api';
import { reconnectSocket } from '@/hooks/useSocket';
import type { User } from '@oblihub/shared';

interface AuthState {
  user: User | null;
  isInitialized: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isInitialized: false,
  isLoading: false,

  login: async (username, password) => {
    set({ isLoading: true });
    try {
      const { user } = await authApi.login(username, password);
      set({ user, isLoading: false });
      // The server refuses sockets without a session: one refused before sign-in retries now.
      reconnectSocket();
    } catch {
      set({ isLoading: false });
      throw new Error('Invalid credentials');
    }
  },

  logout: async () => {
    await authApi.logout();
    set({ user: null });
  },

  checkSession: async () => {
    try {
      const { user } = await authApi.me();
      set({ user, isInitialized: true });
    } catch {
      set({ user: null, isInitialized: true });
    }
  },
}));
