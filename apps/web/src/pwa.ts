/**
 * Service worker registration and updates.
 *
 * A new build is installed in the background (the worker waits) and the app
 * shows "새 버전" so nothing is reloaded under someone's fingers. The update is
 * applied right away when it arrives during start-up, and an installed app
 * that is closed and reopened picks it up by itself (the waiting worker takes
 * over once no window uses the old one). Updates are checked at start, each
 * time the app comes back to the foreground, and hourly.
 */
import { ref } from 'vue';

/** A new version is installed and waiting. */
export const updateReady = ref(false);

/** Build stamp of the running bundle (shown in 설정). */
export const APP_BUILD = __APP_BUILD__;

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** An update found this soon after start is applied without asking. */
const STARTUP_GRACE_MS = 8_000;

let waiting: ServiceWorker | null = null;
let reloading = false;

function offer(worker: ServiceWorker): void {
  waiting = worker;
  if (performance.now() < STARTUP_GRACE_MS) {
    applyUpdate();
    return;
  }
  updateReady.value = true;
}

export function applyUpdate(): void {
  updateReady.value = false;
  if (waiting) {
    // Workbox's generated worker listens for this and calls skipWaiting();
    // controllerchange below then reloads into the new version.
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } else {
    window.location.reload();
  }
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const sw = navigator.serviceWorker;
  // Only reload when a worker replaces an existing one (not on first install).
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  void sw
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      if (registration.waiting && sw.controller) offer(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && sw.controller) offer(worker);
        });
      });
      const check = () => void registration.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, CHECK_INTERVAL_MS);
    })
    .catch(() => {
      // No worker (private mode, unsupported): the app still works online.
    });
}

/**
 * A lazily loaded screen from an older build can be gone from the server after
 * an update; load the page again so the current build is used.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    message,
  );
}
