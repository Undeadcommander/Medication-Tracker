/**
 * The zxcvbn engine and its dictionaries (about 1 MB). Only ever imported dynamically, by
 * `loadStrengthChecker` in vault.ts, so it's a chunk of its own and not part of the first load.
 */
import { ZxcvbnFactory, type ZxcvbnResult } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary as commonDictionary } from '@zxcvbn-ts/language-common';
import { dictionary as enDictionary, translations } from '@zxcvbn-ts/language-en';

export type ZxcvbnCheck = (password: string) => ZxcvbnResult;

export function createZxcvbn(): ZxcvbnCheck {
  const zxcvbn = new ZxcvbnFactory({
    translations,
    graphs: adjacencyGraphs,
    dictionary: { ...commonDictionary, ...enDictionary },
  });
  return (password) => zxcvbn.check(password);
}
