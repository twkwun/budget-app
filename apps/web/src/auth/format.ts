/** Short Korean date-time for lists, in the household zone. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Rough device label from a user-agent string for the sessions list. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return '알 수 없는 기기';
  const device = /iPhone/.test(ua)
    ? '아이폰'
    : /iPad/.test(ua)
      ? '아이패드'
      : /Android/.test(ua)
        ? '안드로이드'
        : /Macintosh/.test(ua)
          ? '맥'
          : /Windows/.test(ua)
            ? 'Windows PC'
            : /Linux/.test(ua)
              ? 'Linux'
              : '기기';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}
