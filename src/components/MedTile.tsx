import { describeSchedule } from '../../shared/schedule';
import type { DoseLog, Medication } from '../../shared/types';
import { dosesForDay, formatWhen, nextDoseFor, supplyDaysLeft } from '../lib/doses';

interface Props {
  med: Medication;
  logs: DoseLog[];
  now: Date;
  onOpen: () => void;
}

export function MedTile({ med, logs, now, onOpen }: Props) {
  const today = dosesForDay([med], logs, now, now);
  const takenToday = today.filter((d) => d.status === 'taken').length;
  const next = nextDoseFor(med, logs, now);
  const daysLeft = supplyDaysLeft(med, now);
  const lowSupply = daysLeft !== null && daysLeft <= 7;
  const purpose = med.drugInfo?.purpose;
  const subtitle = [med.dosage, med.quantityPerDose && med.form ? `${med.quantityPerDose} × ${med.form}` : med.form]
    .filter(Boolean)
    .join(' · ');

  return (
    <button type="button" className="tile card" onClick={onOpen} style={{ '--accent': med.color } as React.CSSProperties}>
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
        {typeof med.supplyRemaining === 'number' && (
          <span className={`chip ${lowSupply ? 'chip-warn' : ''}`}>
            {med.supplyRemaining} left{daysLeft !== null ? ` · ~${daysLeft}d` : ''}
          </span>
        )}
      </span>
    </button>
  );
}
