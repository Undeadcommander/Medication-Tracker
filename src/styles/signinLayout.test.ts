import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 320px viewport layout arithmetic for the sign-in screen:
 *   viewport width:               320px
 *   .signin horizontal padding:   16px * 2 = 32px  -> .signin-card outer width = 288px
 *   .signin-card side padding:    28px * 2 = 56px  -> inner content width = 320 - 32 - 56 = 232px
 *   (.card also adds a 1px border on each side, leaving 230px inside the border box.)
 * A plain `min-width: 260px` overflows the 232px content box at 320px viewports unless clamped
 * with `min(260px, 100%)` and `max-width: 100%`.
 */
describe('#6 sign-in button responsive layout at 320px', () => {
  it('clamps .google-btn to its container and avoids any plain px min-width > 232px', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'app.css'), 'utf8');
    const match = css.match(/\.google-btn\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const rule = match![1]!;

    expect(rule).toMatch(/max-width:\s*100%\s*;/);

    const plainPxMinWidths = [...rule.matchAll(/(?:^|[;\s])min-width\s*:\s*(\d+(?:\.\d+)?)px\s*;/g)];
    for (const m of plainPxMinWidths) {
      expect(Number(m[1])).toBeLessThanOrEqual(232);
    }

    // Ensure min-width itself still adapts (either <= 232px or wrapped in min(..., 100%) / 100%).
    expect(rule).toMatch(/min-width\s*:\s*(?:min\([^)]*100%[^)]*\)|100%|(?:\d+(?:\.\d+)?)px)/);
  });
});
