# Recture

Record lectures. Get accurate, searchable transcripts, organised by class.

Recture is a desktop app for students. Press record when the professor starts
talking; when the lecture ends you get a searchable, timestamped transcript you can
export to Markdown or PDF. It's built for the reality of a lecture hall — a laptop
microphone, background noise, echo, accents, and vocabulary no ordinary
transcription app has heard of.

Your recordings are ordinary files in an ordinary folder. Transcription runs either
entirely on your own computer for free, or in the cloud for speed — your choice, and
the app is explicit about which one sends your audio anywhere.

## Contents

- [How it works](#how-it-works) — the two-pass design, in one diagram
- [Your options](#your-options) — **free vs paid**, speed vs accuracy
- [Install](#install) — the app, Python support, Deepgram key
- [Using it](#using-it) — from class to exported transcript
- [Your files](#your-files) — where recordings live
- [If something breaks](#if-something-breaks)

---

## How it works

```
  🎙  YOU RECORD
      │
      │   audio is saved to your disk in chunks, continuously
      │   ── always local ── always free ── never uploaded ──
      │
      ├──────────────── WHILE RECORDING ────────────────┐
      │                                    (optional)   │
      │                                                 ▼
      │                                       ┌──────────────────┐
      │                                       │   LIVE DRAFT     │
      │                                       │  rough text on   │
      │                                       │  screen as they  │
      │                                       │  speak           │
      │                                       │                  │
      │                                       │  Deepgram only   │
      │                                       │  → thrown away   │
      │                                       └──────────────────┘
      │
      └──────────────── WHEN YOU STOP ──────────────────┐
                                          (always)      │
                                                        ▼
                                            ┌──────────────────────┐
                                            │  FINAL TRANSCRIPT    │
                                            │  this is what's kept │
                                            │                      │
                                            │  pick ONE:           │
                                            │   • your computer    │
                                            │   • Deepgram cloud   │
                                            └──────────────────────┘
```

**Two independent switches.** The live draft is throwaway — it just lets you follow
along. The final transcript is the real one.

---

## Your options

| | Live draft | Final transcript | Audio leaves your laptop? | 3-hr lecture |
|---|---|---|---|---|
| 🟢 **Free + private** | off | your computer | **never** | **$0.00** |
| 🟢 **Free + live text** | on | your computer | while recording | **$0.86** |
| 🔵 **Fast** | off | Deepgram | uploaded after | **$0.77** |
| 🔵 **Everything** | on | Deepgram | both | **$1.64** |

> **The catch:** picking "your computer" does **not** mean nothing is uploaded.
> If the live draft is on, audio streams to Deepgram the whole time you record.
> For truly nothing-leaves-your-laptop, you need **row 1**.

### Free vs paid, plainly

```
  FREE FOREVER                        COSTS MONEY
  ────────────                        ───────────
  Recording                           Live draft      (Deepgram)
  Storage                             Cloud transcript(Deepgram)
  Transcribing on your computer
  Exports, search, glossary           New accounts get $200 free credit
                                      ≈ 120+ three-hour lectures
                                      After that: ~$36–76 / semester
```

### Speed vs accuracy (transcribing on your computer)

90-minute lecture, measured on a 12-core laptop:

```
  tiny      ▓                    2.5 min   testing only
  small     ▓▓▓▓                  11 min   good for most lectures
  medium    ▓▓▓▓▓▓▓▓▓▓▓           30 min   best for noise + accents  ← default
  ─────────────────────────────────────────────────────────────────
  Deepgram  ▓                   ~2–4 min   mostly upload time
```

Runs in the background — keep using your laptop, or start another recording.

---

## Install

**1. Get the app**

Download `Recture Setup.exe` from [Releases](../../releases) and run it.

> Windows shows **"Windows protected your PC"** — expected, the app isn't signed
> with a paid certificate. Click **More info → Run anyway**.

**2. Choose your transcription setup**

```
  Want it free and private?          → install Python support (below)
  Want live text while recording?    → get a Deepgram key (below)
  Want both?                         → do both
```

**Python support** (for free, on-device transcription):

```bash
pip install faster-whisper
```

Install [Python](https://www.python.org/downloads/) first if needed — tick
**"Add Python to PATH"**. First recording downloads the speech model (~1.5 GB, once).

**Deepgram key** (for live text or cloud transcription):

Sign up at [deepgram.com](https://deepgram.com) — $200 free credit, no card.
Paste the key into **Settings → Deepgram API key**.

Settings tells you whether each option is **Ready** and what's missing if not.

---

## Using it

```
  1. Create a class                      +  in the sidebar
  2. Add course vocabulary               Glossary tab   ← biggest accuracy win
  3. Test your mic                       Test microphone
  4. Record                              button, or Ctrl+Shift+R from any app
  5. Stop                                transcript appears in a few minutes
  6. Review flagged terms                Accept / Reject
  7. Export                              Markdown · PDF · clipboard
```

**Glossary** = `eigenvalue`, `Nyquist`, your professor's name. These are fed to the
speech engine as hints, *and* used afterwards to flag likely mishearings. The app
only ever **suggests** — it can't invent words or rewrite sentences, and nothing
changes until you click Accept.

---

## Your files

Ordinary folders. Back them up, sync them, rearrange them — the app follows along.

```
Documents\Recture\Classes\
└── CS 4501 Machine Learning\
    ├── glossary.json              your course vocabulary
    └── 2026-09-12 - Week 3\
        ├── audio\                 the recording, in chunks
        ├── transcript.json        the master copy
        ├── transcript.md          exports
        └── transcript.pdf
```

**~115 MB per hour.** A 10 hrs/week semester ≈ 18 GB.

Rename a class folder in File Explorer, drag a lecture to another class, or restore
one from backup — it shows up in the app within seconds.

---

## If something breaks

| Problem | Fix |
|---|---|
| "faster-whisper is not installed" | Re-run `pip install faster-whisper` |
| Recording won't start | Check Windows mic permissions |
| App crashed mid-lecture | Reopen — recording is repaired automatically |
| Transcription failed | Audio is safe → **Retry transcription** |
| "Needs attention" | Part of the audio failed its integrity check; the rest is fine |
| App doesn't match my folders | **Sync with disk** in the sidebar |

**Your recording survives all of these.** Audio is written continuously and
fingerprinted so damage is detected rather than silently passed along.

---

Technical details: [DEVELOPERS.md](DEVELOPERS.md)
