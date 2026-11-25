import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AppData } from '../../shared/types';
import {
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  decryptVault,
  downloadVault,
  encryptVault,
  estimatePassphraseStrength,
  generatePassphrase,
  readVaultFile,
} from '../lib/vault';
import { Modal } from './Modal';
import './ExportImportDialog.css';

interface ExportImportDialogProps {
  data: AppData;
  onImport: (data: AppData, mode: 'merge' | 'replace') => void;
  onClose: () => void;
}

type Tab = 'export' | 'import';
type ImportMode = 'merge' | 'replace';

const TABS: { id: Tab; label: string }[] = [
  { id: 'export', label: 'Export' },
  { id: 'import', label: 'Import' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Maps any thrown error to a user-facing message. Never includes the passphrase or any data. */
function describeError(e: unknown): string {
  if (e instanceof VaultError) {
    switch (e.code) {
      case 'wrong-passphrase':
        return 'Wrong passphrase, or the file was changed. Check the passphrase and try again.';
      case 'unsupported-version':
        return 'This backup was made by a newer version of the app. Update the app and try again.';
      case 'invalid-file':
        return e.message;
      case 'invalid-data':
        return e.message;
    }
  }
  return 'Something went wrong. Please try again.';
}

export function ExportImportDialog({ data, onImport, onClose }: ExportImportDialogProps) {
  const uid = useId();
  const [tab, setTab] = useState<Tab>('export');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ export: null, import: null });

  // Export state
  const [expPass, setExpPass] = useState('');
  const [expConfirm, setExpConfirm] = useState('');
  const [expShow, setExpShow] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [expBusy, setExpBusy] = useState(false);
  const [expError, setExpError] = useState<string | null>(null);
  const [expDone, setExpDone] = useState(false);

  // Import state
  const [fileName, setFileName] = useState('');
  const [vaultJson, setVaultJson] = useState<unknown>(null);
  const [impPass, setImpPass] = useState('');
  const [impShow, setImpShow] = useState(false);
  const [impBusy, setImpBusy] = useState(false);
  const [impError, setImpError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AppData | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [imported, setImported] = useState<ImportMode | null>(null);

  const clearSecrets = useCallback(() => {
    setExpPass('');
    setExpConfirm('');
    setImpPass('');
    setVaultJson(null);
    setPreview(null);
  }, []);

  // Drop passphrases and decrypted data when the dialog goes away.
  useEffect(() => clearSecrets, [clearSecrets]);

  const close = useCallback(() => {
    clearSecrets();
    onClose();
  }, [clearSecrets, onClose]);

  // ---- Export -------------------------------------------------------------------------------
  const strength = useMemo(() => estimatePassphraseStrength(expPass), [expPass]);
  const filledSegments = expPass ? Math.max(1, strength.score) : 0;
  const tooShort =expPass.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = expConfirm.length > 0 && expPass !== expConfirm;
  const canExport = !tooShort && expPass === expConfirm && strength.score >= 1 && !expBusy;

  let expProblem: string | null = null;
  if (expPass.length > 0 && tooShort) {
    expProblem = `Use at least ${MIN_PASSPHRASE_LENGTH} characters (${MIN_PASSPHRASE_LENGTH - expPass.length} more).`;
  } else if (expPass.length > 0 && strength.score < 1) {
    expProblem = 'That passphrase is too easy to guess. Try a longer one or use the generator.';
  } else if (mismatch) {
    expProblem = 'The two passphrases do not match.';
  }

  const onGenerate = () => {
    const p = generatePassphrase();
    setExpPass(p);
    setExpConfirm(p);
    setExpShow(true);
    setGenerated(true);
    setCopied(null);
    setExpDone(false);
    setExpError(null);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(expPass);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  const submitExport = async (e: FormEvent) => {
    e.preventDefault();
    if (!canExport) return;
    setExpBusy(true);
    setExpError(null);
    setExpDone(false);
    try {
      const file = await encryptVault(data, expPass);
      downloadVault(file);
      setExpDone(true);
    } catch (err) {
      setExpError(describeError(err));
    } finally {
      setExpBusy(false);
    }
  };

  // ---- Import -------------------------------------------------------------------------------
  const resetPreview = () => {
    setPreview(null);
    setConfirmReplace(false);
    setImported(null);
  };

  const onPickFile = async (file: File | undefined) => {
    setImpError(null);
    resetPreview();
    setVaultJson(null);
    setFileName('');
    if (!file) return;
    try {
      const json = await readVaultFile(file);
      setVaultJson(json);
      setFileName(file.name);
    } catch (err) {
      setImpError(describeError(err));
    }
  };

  const submitDecrypt = async (e: FormEvent) => {
    e.preventDefault();
    if (vaultJson === null || impPass.length === 0 || impBusy) return;
    setImpBusy(true);
    setImpError(null);
    resetPreview();
    try {
      setPreview(await decryptVault(vaultJson, impPass));
    } catch (err) {
      setImpError(describeError(err));
    } finally {
      setImpBusy(false);
    }
  };

  const doImport = () => {
    if (!preview) return;
    onImport(preview, mode);
    setImported(mode);
    setConfirmReplace(false);
    setPreview(null);
    setVaultJson(null);
    setImpPass('');
    setFileName('');
  };

  const onImportClick = () => {
    if (mode === 'replace' && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    doImport();
  };

  // ---- Tabs ---------------------------------------------------------------------------------
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const ids = {
    tab: (t: Tab) => `${uid}-tab-${t}`,
    panel: (t: Tab) => `${uid}-panel-${t}`,
  };
  const exportFormId = `${uid}-export-form`;
  const importFormId = `${uid}-import-form`;

  // ---- Footer -------------------------------------------------------------------------------
  let footer;
  if (tab === 'export') {
    footer = (
      <>
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
        <button type="submit" form={exportFormId} className="btn btn-primary" disabled={!canExport}>
          {expBusy ? 'Encrypting…' : 'Download encrypted file'}
        </button>
      </>
    );
  } else if (preview) {
    footer = confirmReplace ? (
      <>
        <button type="button" className="btn" onClick={() => setConfirmReplace(false)}>
          Go back
        </button>
        <button type="button" className="btn btn-danger" onClick={doImport}>
          Yes, replace everything
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className={mode === 'replace' ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onImportClick}
        >
          {mode === 'replace' ? 'Replace my data…' : 'Merge into my data'}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <button type="button" className="btn" onClick={close}>
          {imported ? 'Done' : 'Close'}
        </button>
        {!imported && (
          <button
            type="submit"
            form={importFormId}
            className="btn btn-primary"
            disabled={vaultJson === null || impPass.length === 0 || impBusy}
          >
            {impBusy ? 'Decrypting…' : 'Decrypt and preview'}
          </button>
        )}
      </>
    );
  }

  // ---- Render -------------------------------------------------------------------------------
  const namesShown = preview ? preview.medications.slice(0, 8).map((m) => m.name) : [];
  const namesExtra = preview ? preview.medications.length - namesShown.length : 0;

  return (
    <Modal title="Back up or move your data" onClose={close} footer={footer} maxWidth={560}>
      <div className="ei-tabs" role="tablist" aria-label="Export or import">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={ids.tab(t.id)}
            type="button"
            role="tab"
            className="ei-tab"
            aria-selected={tab === t.id}
            aria-controls={ids.panel(t.id)}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'export' && (
        <div role="tabpanel" id={ids.panel('export')} aria-labelledby={ids.tab('export')} className="ei-panel">
          <p className="ei-lead">
            Your file is encrypted on this device before it is saved, and only your passphrase can open it. Nothing is
            sent to any server, so we cannot recover a lost passphrase.
          </p>
          <p className="ei-summary">
            <strong>Included:</strong> {plural(data.medications.length, 'medication')} and{' '}
            {plural(data.doseLogs.length, 'dose record')}.
          </p>

          <form id={exportFormId} onSubmit={submitExport} className="ei-form" autoComplete="off">
            <div className="field">
              <label htmlFor={`${uid}-exp-pass`}>Passphrase</label>
              <div className="ei-input-row">
                <input
                  id={`${uid}-exp-pass`}
                  className="input"
                  type={expShow ? 'text' : 'password'}
                  value={expPass}
                  onChange={(e) => {
                    setExpPass(e.target.value);
                    setGenerated(false);
                    setCopied(null);
                    setExpDone(false);
                  }}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby={`${uid}-exp-hint`}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setExpShow((s) => !s)}
                  aria-pressed={expShow}
                  aria-label={expShow ? 'Hide passphrase' : 'Show passphrase'}
                >
                  {expShow ? 'Hide' : 'Show'}
                </button>
              </div>
              <span id={`${uid}-exp-hint`} className="field-hint">
                At least {MIN_PASSPHRASE_LENGTH} characters. Several random words work best.
              </span>
            </div>

            <div className="field">
              <label htmlFor={`${uid}-exp-confirm`}>Confirm passphrase</label>
              <input
                id={`${uid}-exp-confirm`}
                className="input"
                type={expShow ? 'text' : 'password'}
                value={expConfirm}
                onChange={(e) => {
                  setExpConfirm(e.target.value);
                  setExpDone(false);
                }}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={mismatch}
              />
            </div>

            <div className="ei-meter-wrap" aria-live="polite">
              <div className="ei-meter" data-score={expPass ? strength.score : -1} aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={i < filledSegments ? 'on' : ''} />
                ))}
              </div>
              <span className="ei-meter-label">{expPass ? `Strength: ${strength.label}` : 'Strength: not set'}</span>
            </div>

            {expProblem && (
              <div className="alert alert-warning" role="status">
                {expProblem}
              </div>
            )}

            <div>
              <button type="button" className="btn" onClick={onGenerate}>
                Generate a strong passphrase
              </button>
            </div>

            {generated && (
              <div className="ei-generated" role="group" aria-label="Generated passphrase">
                <code className="ei-generated-text" data-testid="generated-passphrase">
                  {expPass}
                </code>
                <button type="button" className="btn btn-sm" onClick={onCopy}>
                  {copied === 'ok' ? 'Copied' : 'Copy'}
                </button>
                <p className="field-hint ei-generated-note">
                  Write it down or save it in a password manager now. Without it the file cannot be opened.
                  {copied === 'fail' && ' Copying was blocked, so select the text and copy it manually.'}
                </p>
              </div>
            )}

            {expError && (
              <div className="alert alert-error" role="alert">
                {expError}
              </div>
            )}
            {expDone && (
              <div className="alert alert-success" role="status">
                Encrypted file saved. Keep your passphrase safe: it is the only way to open the file on your other
                device.
              </div>
            )}
          </form>
        </div>
      )}

      {tab === 'import' && (
        <div role="tabpanel" id={ids.panel('import')} aria-labelledby={ids.tab('import')} className="ei-panel">
          {imported ? (
            <div className="alert alert-success" role="status">
              {imported === 'merge'
                ? 'Your backup was merged into your data.'
                : 'Your data was replaced with the backup.'}
            </div>
          ) : (
            <>
              <p className="ei-lead">
                Choose a <code>.medvault</code> file made by this app and enter the passphrase you used. It is decrypted
                on this device only.
              </p>

              <form id={importFormId} onSubmit={submitDecrypt} className="ei-form" autoComplete="off">
                <div className="field">
                  <label htmlFor={`${uid}-imp-file`}>Backup file</label>
                  <input
                    id={`${uid}-imp-file`}
                    className="input ei-file"
                    type="file"
                    accept=".medvault,application/json"
                    onChange={(e) => {
                      void onPickFile(e.target.files?.[0]);
                    }}
                  />
                  {fileName && <span className="field-hint">Selected: {fileName}</span>}
                </div>

                <div className="field">
                  <label htmlFor={`${uid}-imp-pass`}>Passphrase</label>
                  <div className="ei-input-row">
                    <input
                      id={`${uid}-imp-pass`}
                      className="input"
                      type={impShow ? 'text' : 'password'}
                      value={impPass}
                      onChange={(e) => {
                        setImpPass(e.target.value);
                        resetPreview();
                        setImpError(null);
                      }}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setImpShow((s) => !s)}
                      aria-pressed={impShow}
                      aria-label={impShow ? 'Hide passphrase' : 'Show passphrase'}
                    >
                      {impShow ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              </form>

              {impError && (
                <div className="alert alert-error" role="alert">
                  {impError}
                </div>
              )}

              {preview && (
                <div className="ei-preview" aria-live="polite">
                  <div className="alert alert-success">
                    Decrypted successfully. This backup contains {plural(preview.medications.length, 'medication')}
                    {preview.medications.length > 0 && (
                      <>
                        : {namesShown.join(', ')}
                        {namesExtra > 0 && ` and ${namesExtra.toLocaleString()} more`}
                      </>
                    )}
                    {' '}and {plural(preview.doseLogs.length, 'dose record')}.
                  </div>

                  <fieldset className="ei-modes">
                    <legend className="field-label">How should it be imported?</legend>
                    <label className="ei-mode">
                      <input
                        type="radio"
                        name={`${uid}-mode`}
                        checked={mode === 'merge'}
                        onChange={() => {
                          setMode('merge');
                          setConfirmReplace(false);
                        }}
                      />
                      <span>
                        <strong>Merge with my current data</strong>
                        <span className="field-hint">
                          Keeps what you have and adds the backup. If a medication is in both, the most recently
                          edited copy wins.
                        </span>
                      </span>
                    </label>
                    <label className="ei-mode">
                      <input
                        type="radio"
                        name={`${uid}-mode`}
                        checked={mode === 'replace'}
                        onChange={() => setMode('replace')}
                      />
                      <span>
                        <strong>Replace all my data</strong>
                        <span className="field-hint">Deletes everything currently on this device first.</span>
                      </span>
                    </label>
                  </fieldset>

                  {confirmReplace && (
                    <div className="alert alert-warning" role="alert">
                      This will permanently delete your {plural(data.medications.length, 'medication')} and{' '}
                      {plural(data.doseLogs.length, 'dose record')} on this device and replace them with the backup.
                      This cannot be undone. Export first if you want a copy.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
