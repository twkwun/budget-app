import { describe, expect, it } from 'vitest';
import { LOGIN_NAME_PATTERN, isLockTimeout, normalizeLoginName } from '../src/auth.ts';

describe('auth helpers', () => {
  it('normalizes and validates login names', () => {
    expect(normalizeLoginName('  Mom.Kim ')).toBe('mom.kim');
    for (const ok of ['mom', 'dad_2', 'a.b-c', '0abc'])
      expect(LOGIN_NAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ['ab', '_mom', 'Mom', 'mo m', '엄마', 'a'.repeat(33)]) {
      expect(LOGIN_NAME_PATTERN.test(bad)).toBe(false);
    }
  });

  it('accepts only the four lock choices', () => {
    for (const v of [0, 300, 3600, null]) expect(isLockTimeout(v)).toBe(true);
    for (const v of [1, 60, undefined, '300']) expect(isLockTimeout(v)).toBe(false);
  });
});
