import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { isAbortError, searchDrugs, suggestSpellings, type DrugStrength, type DrugSuggestion } from '../lib/drugLookup';
import './MedicationNameInput.css';

export interface MedicationNameInputProps {
  id?: string;
  value: string;
  onChange: (text: string) => void;
  /** Called when the user selects a suggestion, and again when they pick a strength. */
  onPick: (pick: { name: string; strength?: DrugStrength }) => void;
  autoFocus?: boolean;
}

const DEBOUNCE_MS = 250;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function MedicationNameInput({ id, value, onChange, onPick, autoFocus }: MedicationNameInputProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const statusId = `${autoId}-status`;

  const [items, setItems] = useState<DrugSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [spellings, setSpellings] = useState<string[]>([]);
  /** The query the current items/spellings were fetched for. */
  const [searched, setSearched] = useState('');
  const [picked, setPicked] = useState<DrugSuggestion | null>(null);
  const [strengthRxcui, setStrengthRxcui] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const cancelPending = useCallback(() => {
    window.clearTimeout(timerRef.current);
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const runSearch = useCallback(async (query: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      let found = await searchDrugs(query, controller.signal);
      let alternatives: string[] = [];
      if (found.length === 0) {
        alternatives = await suggestSpellings(query, controller.signal).catch((e: unknown) => {
          if (isAbortError(e)) throw e;
          return [];
        });
        found = [];
      }
      if (controller.signal.aborted) return;
      setItems(found);
      setSpellings(alternatives);
      setSearched(query.trim());
      setActive(-1);
      setOpen(found.length > 0);
      setLoading(false);
    } catch (e) {
      if (isAbortError(e) || controller.signal.aborted) return;
      // Network/API failure: stay quiet, free text keeps working.
      setItems([]);
      setSpellings([]);
      setOpen(false);
      setLoading(false);
    }
  }, []);

  const scheduleSearch = useCallback(
    (text: string) => {
      cancelPending();
      if (text.trim().length < 2) {
        setItems([]);
        setSpellings([]);
        setSearched('');
        setOpen(false);
        setActive(-1);
        setLoading(false);
        return;
      }
      setLoading(true);
      timerRef.current = window.setTimeout(() => void runSearch(text), DEBOUNCE_MS);
    },
    [cancelPending, runSearch],
  );

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    onChange(text);
    if (picked && norm(text) !== norm(picked.name)) {
      setPicked(null);
      setStrengthRxcui(null);
    }
    scheduleSearch(text);
  };

  const selectSuggestion = (s: DrugSuggestion) => {
    cancelPending();
    setLoading(false);
    setOpen(false);
    setActive(-1);
    setPicked(s);
    setStrengthRxcui(null);
    onChange(s.name);
    onPick({ name: s.name });
  };

  const selectStrength = (s: DrugStrength) => {
    if (!picked) return;
    setStrengthRxcui(s.rxcui);
    onPick({ name: picked.name, strength: s });
  };

  const applySpelling = (word: string) => {
    onChange(word);
    setPicked(null);
    setStrengthRxcui(null);
    cancelPending();
    void runSearch(word);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        if (items.length === 0) return;
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(0);
        } else {
          setActive((i) => (i + 1) % items.length);
        }
        break;
      case 'ArrowUp':
        if (items.length === 0) return;
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(items.length - 1);
        } else {
          setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
        }
        break;
      case 'Enter':
        if (open && active >= 0 && items[active]) {
          e.preventDefault();
          selectSuggestion(items[active]);
        }
        break;
      case 'Escape':
        if (open) {
          // Close the list only; don't let an enclosing dialog treat this as "close".
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          setActive(-1);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const recognized = picked !== null && norm(value) === norm(picked.name);
  const showSpellings = !loading && !open && spellings.length > 0 && searched === value.trim();
  const expanded = open && items.length > 0;
  const activeId = expanded && active >= 0 ? `${listId}-opt-${active}` : undefined;

  let status = '';
  if (loading) status = 'Searching medications…';
  else if (expanded) status = `${items.length} suggestion${items.length === 1 ? '' : 's'} available`;
  else if (showSpellings) status = `No matches. Did you mean ${spellings.join(' or ')}?`;

  return (
    <div className="med-name">
      <div className="med-name__control">
        <input
          id={inputId}
          className={`input med-name__input${recognized || loading ? ' med-name__input--adorned' : ''}`}
          type="text"
          maxLength={200}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={statusId}
          autoComplete="off"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="e.g. Lisinopril"
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (items.length > 0 && !recognized && searched === value.trim()) setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
        />
        {loading ? (
          <span className="med-name__spinner" aria-hidden="true" />
        ) : recognized ? (
          <span className="med-name__badge">✓ Recognized</span>
        ) : null}

        <ul
          id={listId}
          role="listbox"
          aria-label="Medication suggestions"
          className="med-name__list"
          hidden={!expanded}
        >
          {expanded &&
            items.map((s, i) => (
              <li
                key={`${s.name}|${s.route ?? ''}|${i}`}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`med-name__option${i === active ? ' is-active' : ''}`}
                // Keep focus in the input so blur doesn't close the list before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectSuggestion(s)}
                onMouseMove={() => i !== active && setActive(i)}
              >
                <span className="med-name__option-name">{s.name}</span>
                {s.route && <span className="med-name__option-route">{s.route}</span>}
              </li>
            ))}
        </ul>
      </div>

      <div id={statusId} className="visually-hidden" role="status" aria-live="polite">
        {status}
      </div>

      {showSpellings && (
        <div className="med-name__spell">
          <span className="med-name__spell-label">Did you mean:</span>
          {spellings.map((word) => (
            <button key={word} type="button" className="med-name__spell-btn" onClick={() => applySpelling(word)}>
              {word}
            </button>
          ))}
          <span className="med-name__spell-label">?</span>
        </div>
      )}

      {recognized && picked && picked.strengths.length > 0 && (
        <div className="med-name__strengths" role="group" aria-label="Choose a strength">
          <div className="field-hint">Choose a strength</div>
          <div className="med-name__strength-row">
            {picked.strengths.map((s) => (
              <button
                key={s.rxcui}
                type="button"
                className={`chip med-name__strength${strengthRxcui === s.rxcui ? ' is-selected' : ''}`}
                aria-pressed={strengthRxcui === s.rxcui}
                onClick={() => selectStrength(s)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default MedicationNameInput;
