import { useEffect, useState, type ReactNode } from 'react'
import type {
  AppSettings,
  AudioStorageFormat,
  BatchProviderId,
  HotkeyStatus,
  ProviderAvailability
} from '@shared/types'

/**
 * Settings, including the privacy disclosure.
 *
 * Where audio goes is stated at the top of this screen rather than buried in a
 * policy link, because it is the one thing about this app a student might
 * reasonably object to.
 */
export function SettingsView({ onToast }: { onToast: (m: string) => void }): ReactNode {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [providers, setProviders] = useState<ProviderAvailability[]>([])
  const [disk, setDisk] = useState<{ encrypted: boolean | null; detail: string } | null>(null)
  const [hasKey, setHasKey] = useState(false)
  const [apiKey, setApiKey] = useState('')

  const reload = async (): Promise<void> => {
    setSettings(await window.recture.settings.get())
    setHasKey(await window.recture.settings.hasApiKey('deepgram'))
    setProviders(await window.recture.settings.providers())
  }

  useEffect(() => {
    void reload()
    void window.recture.settings.diskEncryption().then(setDisk)
  }, [])

  if (!settings) return <div className="main-inner">Loading…</div>

  const patch = async (next: Partial<AppSettings>): Promise<void> => {
    try {
      setSettings(await window.recture.settings.update(next))
      setProviders(await window.recture.settings.providers())
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  const batch = providers.find((p) => p.id === settings.batchProvider)
  const cloudInUse = settings.liveProvider === 'deepgram-live' || settings.batchProvider === 'deepgram-batch'

  return (
    <div className="main-inner">
      <h1>Settings</h1>
      <p className="subtitle">Where your lectures live, and who gets to hear them.</p>

      <h2>Where your audio goes</h2>
      <div className={`banner ${cloudInUse ? 'warn' : 'info'}`}>
        {cloudInUse ? (
          <>
            <strong>Some audio leaves this device.</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {settings.liveProvider === 'deepgram-live' && (
                <li>
                  <strong>Live draft:</strong> audio is streamed to <strong>Deepgram</strong> (US) while you record.
                </li>
              )}
              {settings.batchProvider === 'deepgram-batch' && (
                <li>
                  <strong>Final transcript:</strong> the full recording is uploaded to <strong>Deepgram</strong> once
                  recording stops.
                </li>
              )}
              {settings.batchProvider === 'whisper-local' && (
                <li>
                  <strong>Final transcript:</strong> runs on this device. Nothing is uploaded for the final pass.
                </li>
              )}
            </ul>
            <div style={{ marginTop: 8 }}>
              Recordings and transcripts are always stored locally. Audio sent for transcription is transient — it is
              not used to store your lectures.
            </div>
          </>
        ) : (
          <>
            <strong>Everything stays on this device.</strong> No audio is uploaded anywhere with your current
            settings.
          </>
        )}
      </div>

      <h2>Library</h2>
      <div className="card">
        <label>Lectures folder</label>
        <div className="row">
          <input readOnly value={settings.rootDir} className="mono" />
          <button
            onClick={async () => {
              const chosen = await window.recture.settings.chooseRoot()
              if (chosen) {
                await reload()
                onToast('New lectures will be saved here. Existing lectures stay where they are.')
              }
            }}
          >
            Change…
          </button>
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          {disk
            ? disk.encrypted === true
              ? `Disk encryption: on. ${disk.detail}`
              : disk.encrypted === false
                ? `⚠️ ${disk.detail} Turn on full-disk encryption if your lectures are sensitive — the app relies on it rather than adding a second lock of its own.`
                : disk.detail
            : 'Checking disk encryption…'}
        </div>

        <div style={{ marginTop: 14 }}>
          <label htmlFor="audio-storage">Keep transcribed recordings as</label>
          <select
            id="audio-storage"
            value={settings.audioStorage}
            onChange={(e) => void patch({ audioStorage: e.target.value as AudioStorageFormat })}
          >
            <option value="wav">Original quality (WAV) · about 115 MB per hour</option>
            <option value="opus">Compressed (Opus) · about 15 MB per hour</option>
          </select>
          <div className="faint" style={{ marginTop: 8 }}>
            Applies once a lecture has been transcribed. While recording, audio is always saved uncompressed in small
            checksummed pieces, so a crash costs seconds rather than the lecture. Compressed recordings still
            re-transcribe well but sound slightly less clear.
          </div>
        </div>
      </div>

      <h2>Transcription</h2>
      <div className="card">
        <label htmlFor="batch">Final transcript (the one that is saved)</label>
        <select
          id="batch"
          value={settings.batchProvider}
          onChange={(e) => void patch({ batchProvider: e.target.value as BatchProviderId })}
        >
          <option value="whisper-local">faster-whisper — on this device</option>
          <option value="deepgram-batch">Deepgram — cloud batch</option>
        </select>
        {batch && (
          <div className="faint" style={{ marginTop: 8 }}>
            <span className={batch.available ? 'chip ok' : 'chip warn'}>
              {batch.available ? 'Ready' : 'Unavailable'}
            </span>{' '}
            {batch.detail}
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label htmlFor="live">Live draft while recording</label>
          <select
            id="live"
            value={settings.liveProvider}
            onChange={(e) => void patch({ liveProvider: e.target.value as AppSettings['liveProvider'] })}
          >
            <option value="deepgram-live">Deepgram streaming</option>
            <option value="none">Off — record only</option>
          </select>
        </div>

        <div className="grid-2" style={{ marginTop: 14 }}>
          <div>
            <label htmlFor="whisper-model">Whisper model</label>
            <select
              id="whisper-model"
              value={settings.whisperModel}
              onChange={(e) => void patch({ whisperModel: e.target.value })}
            >
              {['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="segment">Segment length (seconds)</label>
            <input
              id="segment"
              type="number"
              min={10}
              max={300}
              value={settings.segmentSeconds}
              onChange={(e) => void patch({ segmentSeconds: Math.max(10, Number(e.target.value) || 45) })}
            />
          </div>
        </div>
        <div className="faint" style={{ marginTop: 8 }}>
          Shorter segments bound how much audio a crash can cost, at the price of more files per lecture.
        </div>
      </div>

      <h2>Deepgram API key</h2>
      <div className="card">
        {settings.apiKeyReentryNotice && !hasKey && (
          <div className="banner warn" style={{ marginBottom: 10 }}>
            Your Deepgram API key couldn’t be carried over when the app was renamed from LectureRec, because it was
            locked to the old app. Paste it again below.
          </div>
        )}
        <div className="row">
          <input
            type="password"
            placeholder={hasKey ? '•••••••••• (saved)' : 'Paste your Deepgram API key'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            onClick={async () => {
              setHasKey(await window.recture.settings.setApiKey('deepgram', apiKey || null))
              setApiKey('')
              await reload()
              onToast('API key saved.')
            }}
            disabled={!apiKey.trim()}
          >
            Save
          </button>
          {hasKey && (
            <button
              className="danger"
              onClick={async () => {
                setHasKey(await window.recture.settings.setApiKey('deepgram', null))
                await reload()
                onToast('API key removed.')
              }}
            >
              Remove
            </button>
          )}
        </div>
        <div className="faint" style={{ marginTop: 8 }}>
          Stored with your operating system’s secret store (DPAPI / Keychain / libsecret), not in a plain file. The
          <code> DEEPGRAM_API_KEY</code> environment variable takes precedence if set.
        </div>
      </div>

      <h2>Shortcuts</h2>
      <div className="card stack">
        <ShortcutField
          name="record"
          label="Start / stop recording"
          placeholder="CommandOrControl+Shift+R"
          hint="Works from any app, so you never have to find the window when the professor starts."
          onToast={onToast}
        />
        <ShortcutField
          name="bookmark"
          label="Bookmark this moment"
          placeholder="Alt+Shift+B"
          hint="Flags the current moment while recording, even from another app. Add notes to bookmarks later."
          onToast={onToast}
        />
      </div>
    </div>
  )
}

/**
 * One global shortcut: typed, applied and reported. Committed on blur or
 * Enter, never per keystroke, because saving every character used to persist
 * half-typed shortcuts that could not be registered.
 */
function ShortcutField({
  name,
  label,
  placeholder,
  hint,
  onToast
}: {
  name: 'record' | 'bookmark'
  label: string
  placeholder: string
  hint: string
  onToast: (m: string) => void
}): ReactNode {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<HotkeyStatus | null>(null)

  useEffect(() => {
    void window.recture.settings.hotkeyStatus(name).then((current) => {
      setStatus(current)
      setValue(current.accelerator)
    })
  }, [name])

  const apply = async (): Promise<void> => {
    const next = value.trim()
    if (!next) return
    // Nothing to do if it is already this shortcut and working.
    if (status?.registered && status.accelerator === next) return
    try {
      const result = await window.recture.settings.setHotkey(next, name)
      setStatus(result)
      setValue(result.accelerator)
      onToast(result.registered ? `${label}: shortcut active.` : `${label}: ${result.detail}`)
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  const id = `shortcut-${name}`
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <div className="row">
        <input
          id={id}
          value={value}
          className="mono"
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void apply()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void apply()
          }}
        />
        <button onClick={() => void apply()} disabled={!value.trim()}>
          Apply
        </button>
      </div>
      <div className="faint" style={{ marginTop: 8 }}>
        {status && (
          <>
            <span className={status.registered ? 'chip ok' : 'chip warn'}>
              {status.registered ? 'Active' : 'Not working'}
            </span>{' '}
            {status.registered ? hint : status.detail}
          </>
        )}
      </div>
    </div>
  )
}
