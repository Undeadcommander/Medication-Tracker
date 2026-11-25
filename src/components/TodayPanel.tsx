import type { DoseLog, DoseStatus, Medication } from '../../shared/types';
import { dosesForDay, formatClock } from '../lib/doses';

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

export function TodayPanel({ meds, logs, now, onLog, onUndo, onOpenMed }: Props) {
  const doses = dosesForDay(meds, logs, now, now);
  if (!doses.length) return null;
  const done = doses.filter((d) => d.status === 'taken').length;

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
          <li key={`${d.med.id}|${d.key}`} className={`today-item status-${d.status}`}>
            <span className="today-time">{formatClock(d.at)}</span>
            <span className="today-swatch" style={{ background: d.med.color }} aria-hidden />
            <button type="button" className="today-med" onClick={() => onOpenMed(d.med.id)}>
              <span className="today-name">{d.med.name}</span>
              <span className="muted today-dose">
                {[d.med.dosage, d.med.quantityPerDose ? `×${d.med.quantityPerDose}` : ''].filter(Boolean).join(' ')}
              </span>
            </button>
            <span className={`today-status status-pill-${d.status}`}>{STATUS_LABEL[d.status]}</span>
            <span className="today-actions">
              {d.status === 'taken' || d.status === 'skipped' ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => onUndo(d.med.id, d.key)}>
                  Undo
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => onLog(d.med.id, d.key, 'taken')}>
                    Take
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => onLog(d.med.id, d.key, 'skipped')}>
                    Skip
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
