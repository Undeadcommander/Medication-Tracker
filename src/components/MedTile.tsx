import { memo, useMemo } from 'react';
import { describeSchedule } from '../../shared/schedule';
import type { DoseLog, Medication } from '../../shared/types';
import { dosesForDay, formatWhen, nextDoseFor, supplyDaysLeft } from '../lib/doses';
import { logsByMed, supplyOnHand } from '../lib/supply';

interface Props {
  med: Medication;
  /** This medication's dose logs only. */
  medLogs: DoseLog[];
  /** Units on hand now (derived), undefined if supply isn't tracked. */
  onHand: number | undefined;
  now: Date;
  /** One stable callback for every tile; gets the medication id. */
  onOpen: (id: string) => void;
}

const NO_LOGS: DoseLog[] = [];
const minuteOf = (d: Date) => Math.floor(d.getTime() / 60_000);

function sameLogs(a: DoseLog[], b: DoseLog[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && (x.scheduledFor !== y.scheduledFor || x.status !== y.status)) return false;
  }
  return true;
}

function MedTileView({ med, medLogs, onHand, now, onOpen }: Props) {
  const today = dosesForDay([med], medLogs, now, now);
  const takenToday = today.filter((d) => d.status === 'taken').length;
  const next = nextDoseFor(med, medLogs, now);
  const daysLeft = supplyDaysLeft(med, onHand, now);
  const lowSupply = daysLeft !== null && daysLeft <= 7;
  const purpose = med.drugInfo?.purpose;
  const subtitle = [med.dosage, med.quantityPerDose && med.form ? `${med.quantityPerDose} × ${med.form}` : med.form]
    .filter(Boolean)
    .join(' · ');

  return (
    <button type="button" className="tile card" onClick={() => onOpen(med.id)} style={{ '--accent': med.color } as React.CSSProperties}>
      <span className="tile-accent" aria-hidden />
      <span className="tile-head">
        <span className="tile-title">
          <span className="tile-name">{med.name}</span>
          {subtitle && <span className="tile-sub">{subtitle}</span>}
        </span>
        <span
          className={`tile-bell ${med.notificationsEnabled ? 'on' : ''}`}
          title={med.notificationsEnabled ? 'Reminders on' : 'Reminders off'}
          aria-label={med.notificationsEnabled ? 'Reminders on' : 'Reminders off'}
        >
          {med.notificationsEnabled ? '🔔' : '🔕'}
        </span>
      </span>

      {purpose && <span className="tile-purpose">{purpose}</span>}

      <span className="tile-rows">
        <span className="tile-row">
          <span className="tile-label">Schedule</span>
          <span>{describeSchedule(med.schedule)}</span>
        </span>
        <span className="tile-row">
          <span className="tile-label">Next dose</span>
          <span className={next?.status === 'due' ? 'tile-due' : ''}>
            {next ? (next.status === 'due' ? `Due ${formatWhen(next.at, now)}` : formatWhen(next.at, now)) : 'No upcoming doses'}
          </span>
        </span>
        {med.instructions && (
          <span className="tile-row">
            <span className="tile-label">Instructions</span>
            <span>{med.instructions}</span>
          </span>
        )}
      </span>

      <span className="tile-foot">
        {today.length > 0 ? (
          <span className="tile-progress" aria-label={`${takenToday} of ${today.length} doses taken today`}>
            {today.map((d) => (
              <span key={d.key} className={`dot dot-${d.status}`} />
            ))}
            <span className="muted">
              {takenToday}/{today.length} today
            </span>
          </span>
        ) : (
          <span className="muted">No doses today</span>
        )}
        {typeof onHand === 'number' && (
          <span className={`chip ${lowSupply ? 'chip-warn' : ''}`}>
            {onHand} left{daysLeft !== null ? ` · ~${daysLeft}d` : ''}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Re-renders only when this medication, its own logs or its supply changed, or the clock minute
 * moved (the labels are minute-granular), not on every 30s tick, dialog change or other medication's dose.
 */
export const MedTile = memo(
  MedTileView,
  (a, b) =>
    a.med === b.med &&
    a.onHand === b.onHand &&
    a.onOpen === b.onOpen &&
    minuteOf(a.now) === minuteOf(b.now) &&
    sameLogs(a.medLogs, b.medLogs),
);

interface GridProps {
  meds: Medication[];
  logs: DoseLog[];
  now: Date;
  onOpen: (id: string) => void;
}

/** The medication tiles. Memoised as a whole so opening/closing dialogs doesn't touch 500 tiles. */
export const MedGrid = memo(function MedGrid({ meds, logs, now, onOpen }: GridProps) {
  const byMed = logsByMed(logs); // cached per log array
  const onHand = useMemo(() => new Map(meds.map((m) => [m.id, supplyOnHand(m, logs)])), [meds, logs]);
  return (
    <div className="tiles">
      {meds.map((m) => (
        <MedTile key={m.id} med={m} medLogs={byMed.get(m.id) ?? NO_LOGS} onHand={onHand.get(m.id)} now={now} onOpen={onOpen} />
      ))}
    </div>
  );
});
