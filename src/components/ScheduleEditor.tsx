import { useId } from 'react';
import {
  DEFAULT_TIMES,
  describeSchedule,
  effectiveTimes,
  formatTime12,
  PRESET_LABELS,
  WEEKDAY_SHORT,
} from '../../shared/schedule';
import type { FrequencyPreset, RepeatUnit, Schedule } from '../../shared/types';

interface Props {
  value: Schedule;
  onChange: (s: Schedule) => void;
}

const PRESETS: { id: FrequencyPreset; hint: string }[] = [
  { id: 'daily', hint: 'Once a day' },
  { id: 'twice_daily', hint: 'Morning & evening' },
  { id: 'every_other_day', hint: 'Every 2nd day' },
  { id: 'custom', hint: 'Days, weeks, times' },
];

/** Fixed dose counts per preset; custom allows 1–8. */
const PRESET_COUNT: Partial<Record<FrequencyPreset, number>> = { daily: 1, twice_daily: 2, every_other_day: 1 };
const MAX_TIMES = 8;

function addHours(hhmm: string, h: number): string {
  const [hh, mm] = hhmm.split(':').map(Number);
  return `${String((hh + h) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function fitTimes(times: string[], count: number | undefined, preset: FrequencyPreset): string[] {
  if (!count) return times.length ? times : [...DEFAULT_TIMES[preset]];
  const out = times.slice(0, count);
  while (out.length < count) out.push(out.length ? addHours(out[out.length - 1], 12) : DEFAULT_TIMES[preset][out.length] ?? '09:00');
  return out;
}

export function ScheduleEditor({ value: s, onChange }: Props) {
  const uid = useId();
  const set = (patch: Partial<Schedule>) => onChange({ ...s, ...patch });

  const setPreset = (preset: FrequencyPreset) => {
    const base = s.useSpecificTimes ? s.times : DEFAULT_TIMES[preset];
    const next: Schedule = { ...s, preset, times: fitTimes(base, PRESET_COUNT[preset], preset) };
    if (preset === 'custom') {
      next.interval ??= 1;
      next.unit ??= 'week';
      next.weekdays ??= [1, 2, 3, 4, 5];
    }
    onChange(next);
  };

  const toggleSpecific = (on: boolean) =>
    set({ useSpecificTimes: on, times: on ? [...effectiveTimes(s)] : [...DEFAULT_TIMES[s.preset]] });

  const setTime = (i: number, t: string) => {
    const times = [...s.times];
    times[i] = t;
    set({ times });
  };

  const fixedCount = PRESET_COUNT[s.preset];
  const interval = s.interval ?? 1;
  const unit = s.unit ?? 'week';
  const weekdays = s.weekdays ?? [];

  return (
    <fieldset className="sched">
      <legend className="field-label">How often?</legend>
      <div className="preset-grid" role="radiogroup" aria-label="Frequency">
        {PRESETS.map((p) => (
          <label key={p.id} className={`preset ${s.preset === p.id ? 'selected' : ''}`}>
            <input
              type="radio"
              name={`${uid}-preset`}
              value={p.id}
              checked={s.preset === p.id}
              onChange={() => setPreset(p.id)}
            />
            <span className="preset-title">{PRESET_LABELS[p.id]}</span>
            <span className="preset-hint">{p.hint}</span>
          </label>
        ))}
      </div>

      {s.preset === 'custom' && (
        <div className="sched-custom">
          <div className="sched-repeat">
            <label htmlFor={`${uid}-interval`}>Repeat every</label>
            <input
              id={`${uid}-interval`}
              className="input sched-num"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              value={interval}
              onChange={(e) => set({ interval: Math.min(365, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
            />
            <select
              className="select sched-unit"
              aria-label="Repeat unit"
              value={unit}
              onChange={(e) => set({ unit: e.target.value as RepeatUnit })}
            >
              <option value="day">{interval === 1 ? 'day' : 'days'}</option>
              <option value="week">{interval === 1 ? 'week' : 'weeks'}</option>
            </select>
          </div>
          {unit === 'week' && (
            <div className="field">
              <span className="field-label" id={`${uid}-wd`}>
                On these days
              </span>
              <div className="weekdays" role="group" aria-labelledby={`${uid}-wd`}>
                {WEEKDAY_SHORT.map((label, d) => {
                  const on = weekdays.includes(d);
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`weekday ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort();
                        if (next.length) set({ weekdays: next });
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="weekday-shortcuts">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ weekdays: [0, 1, 2, 3, 4, 5, 6] })}>
                  Every day
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ weekdays: [1, 2, 3, 4, 5] })}>
                  Weekdays
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ weekdays: [0, 6] })}>
                  Weekends
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sched-times">
        <label className="switch-row">
          <input type="checkbox" role="switch" checked={s.useSpecificTimes} onChange={(e) => toggleSpecific(e.target.checked)} />
          <span>Choose specific times</span>
        </label>
        {s.useSpecificTimes ? (
          <div className="time-list">
            {s.times.map((t, i) => (
              <div key={i} className="time-row">
                <label className="visually-hidden" htmlFor={`${uid}-t${i}`}>
                  Dose {i + 1} time
                </label>
                <input
                  id={`${uid}-t${i}`}
                  className="input time-input"
                  type="time"
                  value={t}
                  onChange={(e) => setTime(i, e.target.value)}
                  aria-invalid={!t || s.times.indexOf(t) !== i}
                  required
                />
                {!fixedCount && s.times.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Remove dose ${i + 1} time`}
                    onClick={() => set({ times: s.times.filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {!fixedCount && s.times.length < MAX_TIMES && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => set({ times: [...s.times, addHours(s.times[s.times.length - 1] ?? '08:00', 4)] })}
              >
                + Add a time
              </button>
            )}
            {fixedCount && (
              <span className="field-hint">
                {PRESET_LABELS[s.preset]} uses {fixedCount === 1 ? 'one time' : `${fixedCount} times`}. Pick Custom for more.
              </span>
            )}
          </div>
        ) : (
          <p className="field-hint">
            Using default {DEFAULT_TIMES[s.preset].length > 1 ? 'times' : 'time'}:{' '}
            {DEFAULT_TIMES[s.preset].map(formatTime12).join(' and ')}
          </p>
        )}
      </div>

      <div className="sched-dates">
        <div className="field">
          <label htmlFor={`${uid}-start`}>Start date</label>
          <input
            id={`${uid}-start`}
            className="input"
            type="date"
            value={s.startDate}
            required
            onChange={(e) => e.target.value && set({ startDate: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-end`}>
            End date <span className="muted">(optional)</span>
          </label>
          <input
            id={`${uid}-end`}
            className="input"
            type="date"
            value={s.endDate ?? ''}
            min={s.startDate}
            onChange={(e) => set({ endDate: e.target.value || undefined })}
          />
        </div>
      </div>

      <p className="sched-summary" aria-live="polite">
        <strong>Summary:</strong> {describeSchedule(s)}
      </p>
    </fieldset>
  );
}
