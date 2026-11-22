import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AuthState, Me, SignedIn } from '@budget/shared';
import { api, setAuthHandlers } from '../api/client.ts';
import { signInWithPasskey, verifyWithPasskey } from '../auth/passkey.ts';

type Waiter = (ok: boolean) => void;

export const useAuthStore = defineStore('auth', () => {
  const loaded = ref(false);
  const setupRequired = ref(false);
  const user = ref<Me | null>(null);
  const locked = ref(false);
  /** True while a sensitive action waits for the user to re-verify. */
  const reauthPending = ref(false);

  const authenticated = computed(() => user.value !== null);
  const isAdmin = computed(() => user.value?.role === 'admin');

  let unlockWaiters: Waiter[] = [];
  let reauthWaiters: Waiter[] = [];
  let onSignedOut: ((explicit: boolean) => void) | null = null;

  function settle(waiters: Waiter[], ok: boolean): Waiter[] {
    for (const resolve of waiters) resolve(ok);
    return [];
  }

  function apply(state: AuthState): void {
    setupRequired.value = state.setupRequired;
    user.value = state.user;
    locked.value = state.locked;
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    apply(await api.get<AuthState>('/auth/session', { raw: true }));
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await refresh();
  }

  function signedIn(result: SignedIn): void {
    user.value = result.user;
    locked.value = false;
    setupRequired.value = false;
    loaded.value = true;
  }

  function clearSession(): void {
    user.value = null;
    locked.value = false;
    unlockWaiters = settle(unlockWaiters, false);
    reauthWaiters = settle(reauthWaiters, false);
    reauthPending.value = false;
  }

  async function loginWithPassword(loginName: string, password: string): Promise<void> {
    signedIn(
      await api.post<SignedIn>('/auth/login/password', { loginName, password }, { raw: true }),
    );
  }

  async function loginWithPasskey(): Promise<void> {
    signedIn(await signInWithPasskey());
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout', {}, { raw: true });
    } finally {
      clearSession();
      onSignedOut?.(true);
    }
  }

  /** Lock now (e.g. the app went to the background with the 즉시 setting). */
  function lock(options: { keepalive?: boolean } = {}): void {
    if (!user.value || locked.value) return;
    locked.value = true;
    void api.post('/auth/lock', {}, { raw: true, keepalive: options.keepalive }).catch(() => {});
  }

  /** After a successful passkey/password check: unlock and release waiting requests. */
  function verified(): void {
    locked.value = false;
    unlockWaiters = settle(unlockWaiters, true);
    reauthPending.value = false;
    reauthWaiters = settle(reauthWaiters, true);
  }

  async function verifyPasskey(): Promise<void> {
    await verifyWithPasskey();
    verified();
  }

  async function verifyPassword(password: string): Promise<void> {
    await api.post('/auth/verify/password', { password }, { raw: true });
    verified();
  }

  function cancelReauth(): void {
    reauthPending.value = false;
    reauthWaiters = settle(reauthWaiters, false);
  }

  function updateUser(next: Me): void {
    user.value = next;
  }

  /** Wire the API client's central handlers to this store. */
  function install(options: { onSignedOut: (explicit: boolean) => void }): void {
    onSignedOut = options.onSignedOut;
    setAuthHandlers({
      onUnauthenticated: () => {
        if (user.value) {
          clearSession();
          onSignedOut?.(false);
        }
      },
      onLocked: () => {
        locked.value = true;
        return new Promise<boolean>((resolve) => unlockWaiters.push(resolve));
      },
      onReauthRequired: () => {
        reauthPending.value = true;
        return new Promise<boolean>((resolve) => reauthWaiters.push(resolve));
      },
    });
  }

  return {
    loaded,
    setupRequired,
    user,
    locked,
    reauthPending,
    authenticated,
    isAdmin,
    refresh,
    ensureLoaded,
    signedIn,
    loginWithPassword,
    loginWithPasskey,
    logout,
    lock,
    verifyPasskey,
    verifyPassword,
    cancelReauth,
    updateUser,
    install,
  };
});
