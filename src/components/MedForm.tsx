import { useEffect, useId, useRef, useState } from 'react';
import { makeSchedule, normalizeTimes } from '../../shared/schedule';
import type { DoseLog, DrugInfo, Medication } from '../../shared/types';
import { fetchDrugInfo, parseStrengthLabel } from '../lib/drugLookup';
import { MED_COLORS, newId } from '../lib/store';
import { supplyOnHand } from '../lib/supply';
import { MedicationNameInput } from './MedicationNameInput';
import { Modal } from './Modal';
import { ScheduleEditor } from './ScheduleEditor';

interface Props {
  initial?: Medication;
  /** All dose logs, to work out the supply on hand for `initial`. */
  logs: DoseLog[];
  existingCount: number;
  /** `supplyShownAs`: the on-hand count the form opened with (a different value is a new count). */
  onSave: (med: Medication, supplyShownAs?: number) => void;
  onClose: () => void;
}

const FORMS = ['Tablet', 'Capsule', 'Extended-release tablet', 'Liquid', 'Suspension', 'Injection', 'Inhaler', 'Patch', 'Cream', 'Drops', 'Spray', 'Other'];

function blankMed(colorIndex: number): Medication {
  const now = new Date().toISOString();
  return {
    id: newId(),
    name: '',
    dosage: '',
    quantityPerDose: 1,
    color: MED_COLORS[colorIndex % MED_COLORS.length],
    schedule: makeSchedule('daily'),
    notificationsEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function hasUsefulInfo(info: DrugInfo): boolean {
  return Boolean(info.rxcui || info.genericName || info.purpose || info.indications);
}

export function MedForm({ initial, logs, existingCount, onSave, onClose }: Props) {
  const uid = useId();
  // The supply field shows (and saves) what's on hand now, not the stored baseline count.
  const [shownSupply] = useState(() => (initial ? supplyOnHand(initial, logs) : undefined));
  const [med, setMed] = useState<Medication>(() =>
    initial ? { ...initial, supplyRemaining: shownSupply } : blankMed(existingCount),
  );
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'found' | 'none'>(initial?.drugInfo ? 'found' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const lookupFor = useRef<string>(initial?.drugInfo ? initial.name.toLowerCase() : '');
  const abortRef = useRef<AbortController | null>(null);

  const set = <K extends keyof Medication>(k: K, v: Medication[K]) => setMed((m) => ({ ...m, [k]: v }));

  const runLookup = (name: string, rxcui?: string) => {
    const key = name.trim().toLowerCase();
    if (key.length < 3) return;
    lookupFor.current = key;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLookup('loading');
    fetchDrugInfo(name.trim(), rxcui, ctrl.signal)
      .then((info) => {
        if (ctrl.signal.aborted) return;
        if (hasUsefulInfo(info)) {
          setMed((m) => ({ ...m, drugInfo: info }));
          setLookup('found');
        } else {
          setMed((m) => ({ ...m, drugInfo: undefined }));
          setLookup('none');
        }
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLookup('none');
      });
  };

  // Auto-recognize typed names (no suggestion picked) after the user pauses.
  useEffect(() => {
    const key = med.name.trim().toLowerCase();
    if (key.length < 3 || key === lookupFor.current) return;
    const t = setTimeout(() => runLookup(med.name), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [med.name]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = med.name.trim();
    if (!name) return setError('Enter a medication name.');
    const s = med.schedule;
    if (s.useSpecificTimes && (!s.times.length || normalizeTimes(s.times).length !== s.times.length)) {
      return setError('Each dose time must be filled in and different.');
    }
    if (s.preset === 'custom' && s.unit === 'week' && !s.weekdays?.length) return setError('Choose at least one day of the week.');
    if (s.endDate && s.endDate < s.startDate) return setError('The end date must be after the start date.');
    const schedule = { ...s, times: s.useSpecificTimes ? normalizeTimes(s.times) : s.times };
    onSave({
      ...med,
      name,
      dosage: med.dosage.trim(),
      instructions: med.instructions?.trim() || undefined,
      notes: med.notes?.trim() || undefined,
      prescriber: med.prescriber?.trim() || undefined,
      pharmacy: med.pharmacy?.trim() || undefined,
      schedule,
    }, shownSupply);
  };

  const info = med.drugInfo;

  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : 'Add medication'}
      onClose={onClose}
      maxWidth={720}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`${uid}-form`} className="btn btn-primary">
            {initial ? 'Save changes' : 'Add medication'}
          </button>
        </>
      }
    >
      <form id={`${uid}-form`} className="medform" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${uid}-name`}>Medication name</label>
          <MedicationNameInput
            id={`${uid}-name`}
            value={med.name}
            autoFocus={!initial}
            onChange={(text) => {
              if (text.trim().toLowerCase() !== lookupFor.current) {
                // The name no longer matches the looked-up drug: drop its info and any lookup in flight.
                abortRef.current?.abort();
                lookupFor.current = '';
                setMed((m) => ({ ...m, name: text, drugInfo: undefined }));
                setLookup('idle');
              } else {
                set('name', text);
              }
            }}
            onPick={({ name, strength }) => {
              setMed((m) => {
                const next = { ...m, name };
                if (strength) {
                  const parsed = parseStrengthLabel(strength.label);
                  next.dosage = parsed.dosage;
                  if (parsed.form) next.form = parsed.form;
                }
                return next;
              });
              runLookup(name, strength?.rxcui);
            }}
          />
          <div className="lookup-status" aria-live="polite">
            {lookup === 'loading' && <span className="muted">Looking up medication info…</span>}
            {lookup === 'found' && info && (
              <span className="lookup-found">
                ✓ {info.genericName && info.genericName.toLowerCase() !== med.name.toLowerCase() ? `${info.genericName} · ` : ''}
                {info.purpose ?? info.drugClasses[0] ?? 'Recognized medication'}
              </span>
            )}
            {lookup === 'none' && (
              <span className="muted">Not found in drug databases. You can still add it with your own details.</span>
            )}
          </div>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${uid}-dosage`}>Strength / dose</label>
            <input
              id={`${uid}-dosage`}
              className="input"
              placeholder="e.g. 10 mg"
              maxLength={100}
              value={med.dosage}
              onChange={(e) => set('dosage', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-dform`}>Form</label>
            <input
              id={`${uid}-dform`}
              className="input"
              list={`${uid}-forms`}
              placeholder="e.g. Tablet"
              maxLength={100}
              value={med.form ?? ''}
              onChange={(e) => set('form', e.target.value || undefined)}
            />
            <datalist id={`${uid}-forms`}>
              {FORMS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-qty`}>Amount per dose</label>
            <input
              id={`${uid}-qty`}
              className="input"
              type="number"
              inputMode="decimal"
              min={0.25}
              step={0.25}
              value={med.quantityPerDose ?? ''}
              onChange={(e) => set('quantityPerDose', e.target.value ? Math.max(0, Number(e.target.value)) : undefined)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor={`${uid}-instr`}>Instructions</label>
          <input
            id={`${uid}-instr`}
            className="input"
            placeholder="e.g. Take with food"
            maxLength={2000}
            value={med.instructions ?? ''}
            onChange={(e) => set('instructions', e.target.value)}
          />
        </div>

        <ScheduleEditor value={med.schedule} onChange={(s) => set('schedule', s)} />

        <label className="switch-row notify-row">
          <input
            type="checkbox"
            role="switch"
            checked={med.notificationsEnabled}
            onChange={(e) => set('notificationsEnabled', e.target.checked)}
          />
          <span>
            <strong>Remind me</strong>
            <span className="field-hint" style={{ display: 'block' }}>
              Sends a notification at each scheduled dose time. Turn on notifications for this device in the account menu.
            </span>
          </span>
        </label>

        <details className="more-details">
          <summary>More details: supply, refill, prescriber, color</summary>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`${uid}-supply`}>Supply on hand</label>
              <input
                id={`${uid}-supply`}
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="e.g. 30"
                value={med.supplyRemaining ?? ''}
                onChange={(e) => set('supplyRemaining', e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-refill`}>Refill date</label>
              <input
                id={`${uid}-refill`}
                className="input"
                type="date"
                value={med.refillDate ?? ''}
                onChange={(e) => set('refillDate', e.target.value || undefined)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-prescriber`}>Prescriber</label>
              <input
                id={`${uid}-prescriber`}
                className="input"
                maxLength={200}
                value={med.prescriber ?? ''}
                onChange={(e) => set('prescriber', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-pharmacy`}>Pharmacy</label>
              <input
                id={`${uid}-pharmacy`}
                className="input"
                maxLength={200}
                value={med.pharmacy ?? ''}
                onChange={(e) => set('pharmacy', e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <span className="field-label" id={`${uid}-color`}>
              Tile color
            </span>
            <div className="colors" role="radiogroup" aria-labelledby={`${uid}-color`}>
              {MED_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={med.color === c}
                  aria-label={c}
                  className={`color ${med.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  onClick={() => set('color', c)}
                />
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-notes`}>Notes</label>
            <textarea
              id={`${uid}-notes`}
              className="textarea"
              maxLength={5000}
              value={med.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </details>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
