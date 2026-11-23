import { IMPORT_ERROR_MESSAGES } from '@budget/shared';
import { ApiError } from '../api/client.ts';

const MESSAGES: Record<string, string> = {
  invalid_credentials:
    '아이디나 비밀번호가 맞지 않습니다. 여러 번 틀리면 잠시 로그인이 제한됩니다.',
  rate_limited: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
  login_name_taken: '이미 사용 중인 아이디입니다.',
  invite_invalid: '초대 링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청하세요.',
  challenge_invalid: '요청 시간이 지났습니다. 다시 시도하세요.',
  last_admin: '활성 관리자가 최소 한 명은 있어야 합니다.',
  setup_closed: '초기 설정이 이미 끝났습니다.',
  validation_error: '입력값을 확인하세요.',
  passkey_invalid: '이미 등록되었거나 사용할 수 없는 패스키입니다.',
  forbidden: '권한이 없습니다.',
  network_error: '서버에 연결할 수 없습니다. Tailscale 연결을 확인하세요.',
  not_found: '대상을 찾을 수 없습니다.',
};

/** Korean message for an error from the API client or WebAuthn. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return (
      MESSAGES[error.code] ??
      IMPORT_ERROR_MESSAGES[error.code] ??
      '문제가 발생했습니다. 다시 시도하세요.'
    );
  }
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      return '패스키 인증이 취소되었거나 시간이 지났습니다.';
    }
    if (error.name === 'InvalidStateError') return '이 기기에는 이미 패스키가 등록되어 있습니다.';
  }
  return '문제가 발생했습니다. 다시 시도하세요.';
}

export function isPasskeyCancel(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}
