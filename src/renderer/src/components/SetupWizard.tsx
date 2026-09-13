import { useEffect, useState, type ReactNode } from 'react'
import type { ClassRecord, ProviderAvailability } from '@shared/types'
import { SETUP_CHOICES, matchSetup, setupStatus, type SetupChoiceId } from '@shared/setup'

type Step = 'welcome' | 'choose' | 'ready' | 'class'
const STEPS: Step[] = ['welcome', 'choose', 'ready', 'class']

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * First launch: where lectures are saved, which of the four setups to use, what
 * that setup still needs, and a first class. Everything here can be changed
 * later in Settings, and all of it can be put off.
 */
export function SetupWizard({ onDone }: { onDone: (created: ClassRecord | null) => void }): ReactNode {
  const [step, setStep] = useState<Step>('welcome')
  const [rootDir, setRootDir] = useState('')
  const [choiceId, setChoiceId] = useState<SetupChoiceId>('free-private')
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [className, setClassName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choice = SETUP_CHOICES.find((c) => c.id === choiceId)!

  useEffect(() => {
    void window.recture.settings
      .get()
      .then((settings) => {
        setRootDir(settings.rootDir)
        const current = matchSetup(settings)
        if (current) setChoiceId(current)
      })
      .catch(() => undefined)
    void window.recture.settings
      .hasApiKey('deepgram')
      .then(setHasKey)
      .catch(() => undefined)
  }, [])

  const checkProviders = async (): Promise<void> => {
    setChecking(true)
    try {
      setProviders(await window.recture.settings.providers())
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (step === 'ready' && choice.needsPython && providers === null) void checkProviders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, choiceId])

  const local = providers?.find((p) => p.id === 'whisper-local') ?? null
  const status = setupStatus(choice, { hasDeepgramKey: hasKey, localAvailable: local ? local.available : null })

  const move = (direction: 1 | -1): void => {
    setError(null)
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, STEPS.indexOf(step) + direction))]!)
  }

  const chooseFolder = async (): Promise<void> => {
    try {
      const chosen = await window.recture.settings.chooseRoot()
      if (chosen) setRootDir(chosen)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const saveKey = async (): Promise<void> => {
    try {
      setHasKey(await window.recture.settings.setApiKey('deepgram', apiKey.trim()))
      setApiKey('')
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const finish = async (withClass: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.recture.settings.update({
        liveProvider: choice.liveProvider,
        batchProvider: choice.batchProvider,
        setupComplete: true
      })
      const created =
        withClass && className.trim() ? await window.recture.classes.create({ name: className.trim() }) : null
      onDone(created)
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  const putOff = async (): Promise<void> => {
    try {
      await window.recture.settings.update({ setupComplete: true })
    } catch {
      // Worst case the welcome shows again next time.
    }
    onDone(null)
  }

  const stepIndex = STEPS.indexOf(step)

  return (
    <div className="setup-overlay">
      <div className="setup" role="dialog" aria-label="Set up Recture">
        <div className="setup-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={i <= stepIndex ? 'done' : undefined} />
          ))}
        </div>

        {error && <div className="banner danger">{error}</div>}

        {step === 'welcome' && (
          <>
            <h1>Welcome to Recture</h1>
            <p className="subtitle">
              Record lectures and get transcripts you can search, correct and export. Three quick choices and you’re
              ready.
            </p>
            <div className="card">
              <label>Lectures are saved in</label>
              <div className="row">
                <input readOnly className="mono" value={rootDir} aria-label="Lectures folder" />
                <button onClick={() => void chooseFolder()}>Change…</button>
              </div>
              <div className="faint" style={{ marginTop: 8 }}>
                Ordinary folders you can back up or sync. Nothing is stored anywhere else.
              </div>
            </div>
          </>
        )}

        {step === 'choose' && (
          <>
            <h1>How should lectures be transcribed?</h1>
            <p className="subtitle">You can switch at any time in Settings.</p>
            <div role="radiogroup" aria-label="Transcription setup">
              {SETUP_CHOICES.map((option) => (
                <label key={option.id} className={`setup-choice${option.id === choiceId ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name="setup-choice"
                    checked={option.id === choiceId}
                    onChange={() => setChoiceId(option.id)}
                  />
                  <span>
                    <span className="row" style={{ gap: 8 }}>
                      <strong>{option.label}</strong>
                      <span className={option.cost === 'Free' ? 'chip ok' : 'chip'}>{option.cost}</span>
                    </span>
                    <span className="faint" style={{ display: 'block', marginTop: 4 }}>
                      {option.privacy}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="faint">Deepgram gives new accounts $200 of free credit, enough for well over 100 lecture hours.</div>
          </>
        )}

        {step === 'ready' && (
          <>
            <h1>Get it ready</h1>
            <p className="subtitle">
              {status.ready
                ? 'Everything this setup needs is in place.'
                : 'You can do this now or later. Recordings are saved either way.'}
            </p>

            {choice.needsPython && (
              <div className="card">
                <div className="row" style={{ marginBottom: 6 }}>
                  <strong>On-device transcription</strong>
                  <div className="spacer" />
                  <span className={local?.available ? 'chip ok' : local ? 'chip warn' : 'chip busy'}>
                    {checking || !local ? 'Checking…' : local.available ? 'Ready' : 'Not ready'}
                  </span>
                </div>
                {local && !local.available && <div className="faint">{local.detail}</div>}
                {local && !local.available && (
                  <>
                    <div style={{ marginTop: 8 }}>
                      Install <a href="https://www.python.org/downloads/" target="_blank" rel="noreferrer">Python</a>{' '}
                      (tick “Add Python to PATH”), then run:
                    </div>
                    <code className="block mono">pip install faster-whisper</code>
                  </>
                )}
                <button onClick={() => void checkProviders()} disabled={checking}>
                  Check again
                </button>
              </div>
            )}

            {choice.needsDeepgramKey && (
              <div className="card">
                <div className="row" style={{ marginBottom: 6 }}>
                  <strong>Deepgram API key</strong>
                  <div className="spacer" />
                  <span className={hasKey ? 'chip ok' : 'chip warn'}>{hasKey ? 'Saved' : 'Needed'}</span>
                </div>
                {!hasKey && (
                  <>
                    <div className="faint" style={{ marginBottom: 8 }}>
                      Sign up at{' '}
                      <a href="https://deepgram.com" target="_blank" rel="noreferrer">
                        deepgram.com
                      </a>
                      , create a key, and paste it here. It is kept in your operating system’s secure storage.
                    </div>
                    <div className="row">
                      <input
                        type="password"
                        aria-label="Deepgram API key"
                        placeholder="Paste your Deepgram API key"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                      <button onClick={() => void saveKey()} disabled={!apiKey.trim()}>
                        Save
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {step === 'class' && (
          <>
            <h1>Add your first class</h1>
            <p className="subtitle">Each class gets its own folder, glossary and lectures.</p>
            <label htmlFor="setup-class-name">Class name</label>
            <input
              id="setup-class-name"
              autoFocus
              value={className}
              placeholder="CS 4501 Machine Learning"
              onChange={(e) => setClassName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && className.trim() && !busy) void finish(true)
              }}
            />
          </>
        )}

        <div className="row setup-actions">
          {step === 'welcome' ? (
            <button className="ghost" onClick={() => void putOff()}>
              Set up later
            </button>
          ) : (
            <button onClick={() => move(-1)} disabled={busy}>
              Back
            </button>
          )}
          <div className="spacer" />
          {step === 'class' ? (
            <>
              <button onClick={() => void finish(false)} disabled={busy}>
                Skip
              </button>
              <button className="primary" onClick={() => void finish(true)} disabled={busy || !className.trim()}>
                Finish
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => move(1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
