import { useState } from 'react';
import { describeSchedule, effectiveTimes, formatTime12, fromDateKey, WEEKDAY_SHORT } from '../../shared/schedule';
import type { DoseLog, DoseStatus, Medication } from '../../shared/types';
import { adherence, dosesInRange, formatClock, formatDay, formatWhen, nextDoseFor, supplyDaysLeft } from '../lib/doses';
import { Modal } from './Modal';

interface Props {
  med: Medication;
  logs: DoseLog[];
  now: Date;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleNotifications: (on: boolean) => void;
  onLog: (key: string, status: DoseStatus) => void;
  onUndo: (key: string) => void;
}

function Section({ title, text, defaultOpen = false }: { title: string; text?: string; defaultOpen?: boolean }) {
  if (!text) return null;
  return (
    <details className="info-section" open={defaultOpen}>
      <summary>{title}</summary>
      <p>{text}</p>
    </details>
  );
}

export function MedDetail({ med, logs, now, onClose, onEdit, onDelete, onToggleNotifications, onLog, onUndo }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const info = med.drugInfo;
  const next = nextDoseFor(med, logs, now);
  const adh = adherence(med, logs, 30, now);
  const daysLeft = supplyDaysLeft(med, now);

  const histFrom = new Date(now);
  histFrom.setDate(histFrom.getDate() - 14);
  const history = dosesInRange(med, logs, histFrom, now, now)
    .filter((d) => d.status !== 'upcoming')
    .reverse();
  const upcomingTo = new Date(now);
  upcomingTo.setDate(upcomingTo.getDate() + 30);
  const upcoming = dosesInRange(med, logs, now, upcomingTo, now)
    .filter((d) => d.status === 'upcoming')
    .slice(0, 6);

  const s = med.schedule;
  const facts: [string, string | undefined][] = [
    ['Dose', [med.dosage, med.quantityPerDose ? `${med.quantityPerDose} ${med.form ?? 'unit'}(s) per dose` : med.form].filter(Boolean).join(' · ')],
    ['Instructions', med.instructions],
    ['Generic name', info?.genericName && info.genericName.toLowerCase() !== med.name.toLowerCase() ? info.genericName : undefined],
    ['Brand names', info?.brandNames.length ? info.brandNames.slice(0, 6).join(', ') : undefined],
    ['Drug class', info?.drugClasses.length ? info.drugClasses.join(', ') : undefined],
    ['Prescriber', med.prescriber],
    ['Pharmacy', med.pharmacy],
    ['Refill date', med.refillDate ? formatDay(fromDateKey(med.refillDate)) : undefined],
    [
      'Supply',
      typeof med.supplyRemaining === 'number'
        ? `${med.supplyRemaining} remaining${daysLeft !== null ? ` (about ${daysLeft} days)` : ''}`
        : undefined,
    ],
  ];

  return (
    <Modal
      title={med.name}
      onClose={onClose}
      maxWidth={720}
      footer={
        confirmDelete ? (
          <>
            <span className="muted" style={{ marginRight: 'auto' }}>
              Delete {med.name} and its history?
            </span>
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
            <button type="button" className="btn btn-primary" onClick={onEdit}>
              Edit
            </button>
          </>
        )
      }
    >
      <div className="detail" style={{ '--accent': med.color } as React.CSSProperties}>
        <div className="detail-hero">
          <span className="detail-swatch" aria-hidden />
          <div>
            <div className="detail-dose">{[med.dosage, med.form].filter(Boolean).join(' · ') || 'No dose set'}</div>
            {info?.purpose && <p className="detail-purpose">{info.purpose}</p>}
          </div>
        </div>

        {info?.boxedWarning && (
          <div className="alert alert-error detail-boxed" role="note">
            <strong>Boxed warning.</strong> {info.boxedWarning}
          </div>
        )}

        <div className="detail-stats">
          <div className="stat">
            <span className="stat-label">Next dose</span>
            <span className="stat-value">{next ? formatWhen(next.at, now) : '—'}</span>
          </div>
          <div className="stat">
            <span className="stat-label">30-day adherence</span>
            <span className="stat-value">{adh.pct === null ? '—' : `${adh.pct}%`}</span>
            {adh.total > 0 && (
              <span className="stat-sub muted">
                {adh.taken} of {adh.total} doses
              </span>
            )}
          </div>
          <div className="stat">
            <span className="stat-label">Supply</span>
            <span className="stat-value">{typeof med.supplyRemaining === 'number' ? med.supplyRemaining : '—'}</span>
            {daysLeft !== null && <span className="stat-sub muted">~{daysLeft} days</span>}
          </div>
        </div>

        <h3 className="detail-h">Schedule</h3>
        <div className="detail-schedule">
          <p>{describeSchedule(s)}</p>
          <div className="detail-times">
            {effectiveTimes(s).map((t) => (
              <span key={t} className="chip">
                {formatTime12(t)}
              </span>
            ))}
            {s.preset === 'custom' && s.unit === 'week' && (
              <span className="muted">
                on {(s.weekdays ?? []).slice().sort().map((d) => WEEKDAY_SHORT[d]).join(', ')}
              </span>
            )}
          </div>
          <p className="muted">
            Starting {formatDay(fromDateKey(s.startDate))}
            {s.endDate ? ` · ending ${formatDay(fromDateKey(s.endDate))}` : ''}
          </p>
          <label className="switch-row">
            <input
              type="checkbox"
              role="switch"
              checked={med.notificationsEnabled}
              onChange={(e) => onToggleNotifications(e.target.checked)}
            />
            <span>Reminder notifications for this medication</span>
          </label>
        </div>

        {upcoming.length > 0 && (
          <>
            <h3 className="detail-h">Upcoming</h3>
            <ul className="dose-list">
              {upcoming.map((d) => (
                <li key={d.key}>
                  <span>
                    {formatDay(d.at)} · {formatClock(d.at)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="detail-h">Last 14 days</h3>
        {history.length ? (
          <ul className="dose-list">
            {history.map((d) => (
              <li key={d.key}>
                <span>
                  {formatDay(d.at)} · {formatClock(d.at)}
                </span>
                <span className={`today-status status-pill-${d.status}`}>{d.status === 'due' ? 'Due now' : d.status}</span>
                {d.status === 'taken' || d.status === 'skipped' ? (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => onUndo(d.key)}>
                    Undo
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => onLog(d.key, 'taken')}>
                    Mark taken
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No doses recorded yet.</p>
        )}

        <h3 className="detail-h">Details</h3>
        <dl className="facts">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        {med.notes && (
          <div className="detail-notes">
            <strong>Notes</strong>
            <p>{med.notes}</p>
          </div>
        )}

        {info && (
          <>
            <h3 className="detail-h">About this medication</h3>
            <Section title="Uses" text={info.indications} defaultOpen />
            <Section title="How to take it" text={info.dosageAndAdministration} />
            <Section title="Warnings" text={info.warnings} />
            <Section title="Side effects" text={info.sideEffects} />
            <Section title="Interactions" text={info.interactions} />
            {info.sources.length > 0 && (
              <p className="detail-sources muted">
                Learn more:{' '}
                {info.sources.map((src, i) => (
                  <span key={src.url}>
                    {i > 0 && ' · '}
                    <a href={src.url} target="_blank" rel="noopener noreferrer">
                      {src.label}
                    </a>
                  </span>
                ))}
              </p>
            )}
            <p className="detail-disclaimer muted">
              Drug information comes from public NLM RxNorm and FDA label data. It's a reference, not medical advice, so
              follow your prescriber's and pharmacist's directions.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
