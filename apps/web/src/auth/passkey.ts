import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { PasskeyInfo, SignedIn } from '@budget/shared';
import { api } from '../api/client.ts';

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

type Options<T> = { challengeId: string; options: T };

/** Username-less sign-in. Any authenticator, including a phone via QR. */
export async function signInWithPasskey(): Promise<SignedIn> {
  const { challengeId, options } = await api.post<Options<PublicKeyCredentialRequestOptionsJSON>>(
    '/auth/login/passkey/options',
    {},
    { raw: true },
  );
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<SignedIn>('/auth/login/passkey/verify', { challengeId, response }, { raw: true });
}

/** Prove identity in the current session (unlock or step-up). */
export async function verifyWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.post<Options<PublicKeyCredentialRequestOptionsJSON>>(
    '/auth/verify/passkey/options',
    {},
    { raw: true },
  );
  const response = await startAuthentication({ optionsJSON: options });
  await api.post('/auth/verify/passkey', { challengeId, response }, { raw: true });
}

export async function registerPasskey(): Promise<PasskeyInfo> {
  const { challengeId, options } =
    await api.post<Options<PublicKeyCredentialCreationOptionsJSON>>('/me/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  return api.post<PasskeyInfo>('/me/passkeys', {
    challengeId,
    response,
    deviceName: guessDeviceName(),
  });
}

/** A friendly default name for the passkey list; the user can rename it. */
export function guessDeviceName(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return '아이폰';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return '아이패드';
  if (/Macintosh/.test(ua)) return '맥';
  if (/Android/.test(ua)) return '안드로이드';
  if (/Windows/.test(ua)) return 'Windows PC';
  return '이 기기';
}
