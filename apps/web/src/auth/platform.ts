/** Name of the platform authenticator the user will see, for passkey buttons. */
export function biometricName(
  ua = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
): string {
  if (/iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'Face ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return '패스키';
}

/** `Face ID로 로그인`, `패스키로 로그인` (particle follows the final sound). */
export function withRo(name: string): string {
  const last = name.at(-1) ?? '';
  const code = last.charCodeAt(0) - 0xac00;
  // Hangul with a final consonant other than ㄹ takes 으로; Latin names (ID, Hello) read as 로.
  if (code >= 0 && code < 11172) {
    const jong = code % 28;
    return jong === 0 || jong === 8 ? `${name}로` : `${name}으로`;
  }
  return `${name}로`;
}
