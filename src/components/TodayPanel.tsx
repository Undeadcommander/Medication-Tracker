import { memo, useMemo } from 'react';
import type { DoseLog, DoseStatus, Medication } from '../../shared/types';
import { dosesForDay, formatClock, type Dose } from '../lib/doses';

interface Props {
  meds: Medication[];
  logs: DoseLog[];
  now: Date;
  onLog: (medId: string, key: string, status: DoseStatus) => void;
  onUndo: (medId: string, key: string) => void;
  onOpenMed: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  taken: 'Taken',
  skipped: 'Skipped',
  missed: 'Missed',
  due: 'Due now',
  upcoming: 'Upcoming',
};

interface RowProps {
  med: Medication;
  doseKey: string;
  /** Scheduled time (ms), a primitive so unchanged rows compare equal across renders. */
  atMs: number;
  status: Dose['status'];
  onLog: Props['onLog'];
  onUndo: Props['onUndo'];
  onOpenMed: Props['onOpenMed'];
}

const TodayRow = memo(function TodayRow({ med, doseKey, atMs, status, onLog, onUndo, onOpenMed }: RowProps) {
  return (
    <li className={`today-item status-${status}`}>
      <span className="today-time">{formatClock(new Date(atMs))}</span>
      <span className="today-swatch" style={{ background: med.color }} aria-hidden />
      <button type="button" className="today-med" onClick={() => onOpenMed(med.id)}>
        <span className="today-name">{med.name}</span>
        <span className="muted today-dose">{[med.dosage, med.quantityPerDose ? `×${med.quantityPerDose}` : ''].filter(Boolean).join(' ')}</span>
      </button>
      <span className={`today-status status-pill-${status}`}>{STATUS_LABEL[status]}</span>
      <span className="today-actions">
        {status === 'taken' || status === 'skipped' ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onUndo(med.id, doseKey)}>
            Undo
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onLog(med.id, doseKey, 'taken')}>
              Take
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onLog(med.id, doseKey, 'skipped')}>
              Skip
            </button>
          </>
        )}
      </span>
    </li>
  );
});

export const TodayPanel = memo(function TodayPanel({ meds, logs, now, onLog, onUndo, onOpenMed }: Props) {
  const doses = useMemo(() => dosesForDay(meds, logs, now, now), [meds, logs, now]);
  const done = useMemo(() => doses.filter((d) => d.status === 'taken').length, [doses]);
  if (!doses.length) return null;

  return (
    <section className="today card" aria-labelledby="today-title">
      <div className="today-head">
        <h2 id="today-title">Today</h2>
        <span className="muted">
          {done} of {doses.length} taken
        </span>
      </div>
      <div className="today-bar" aria-hidden>
        <span style={{ width: `${(done / doses.length) * 100}%` }} />
      </div>
      <ul className="today-list">
        {doses.map((d) => (
          <TodayRow
            key={`${d.med.id}|${d.key}`}
            med={d.med}
            doseKey={d.key}
            atMs={d.at.getTime()}
            status={d.status}
            onLog={onLog}
            onUndo={onUndo}
            onOpenMed={onOpenMed}
          />
        ))}
      </ul>
    </section>
  );
});
