import { useEffect, useMemo, useState } from 'react';
import {
  isStrengthCheckerLoaded,
  loadStrengthChecker,
  rateLoadedPassphrase,
  type PassphraseStrength,
} from '../lib/vault';

export interface PassphraseStrengthState {
  /** The rating, or `null` until the checker has loaded (or while nothing is typed): never accept on `null`. */
  strength: PassphraseStrength | null;
  /** A passphrase is typed and the checker is still loading. */
  checking: boolean;
  /** The checker couldn't be loaded (offline?). Nothing is accepted until `retry` works. */
  failed: boolean;
  retry: () => void;
}

/**
 * Rates `passphrase` with the lazily loaded strength checker. The (large) checker is only fetched
 * once a passphrase is being typed, and `strength` stays `null` until it's there.
 */
export function usePassphraseStrength(passphrase: string): PassphraseStrengthState {
  const wanted = passphrase.length > 0;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>(isStrengthCheckerLoaded() ? 'ready' : 'loading');

  useEffect(() => {
    if (!wanted) return;
    if (isStrengthCheckerLoaded()) {
      setLoad('ready');
      return;
    }
    let live = true;
    setLoad('loading');
    loadStrengthChecker().then(
      () => live && setLoad('ready'),
      () => live && setLoad('error'),
    );
    return () => {
      live = false;
    };
  }, [wanted, attempt]);

  const strength = useMemo(() => (wanted ? rateLoadedPassphrase(passphrase) : null), [wanted, passphrase, load]);
  const failed = wanted && strength === null && load === 'error';
  return {
    strength,
    checking: wanted && strength === null && !failed,
    failed,
    retry: () => setAttempt((a) => a + 1),
  };
}
