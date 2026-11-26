import { describe, expect, it, vi } from 'vitest';
import { bodyLimitFor, parseOriginList } from '../src/validate';

describe('parseOriginList', () => {
  it('compares canonical origins (lowercase, no path or trailing slash) and drops invalid entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = parseOriginList(' https://UndeadCommander.GitHub.io/ , http://localhost:5173/app,, nope ');
    expect([...set]).toEqual(['https://undeadcommander.github.io', 'http://localhost:5173']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('bodyLimitFor', () => {
  it('gives only the reminder sync the large cap', () => {
    expect(bodyLimitFor('/api/push/reminders')).toBe(2 * 1024 * 1024);
    expect(bodyLimitFor('/api/push/subscribe')).toBe(64 * 1024);
  });
});
