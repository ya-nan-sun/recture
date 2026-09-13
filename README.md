# Recture

Record lectures. Get accurate, searchable transcripts, organised by class.

Recture is a desktop app for students. Press record when the professor starts
talking; when the lecture ends you get a searchable, timestamped transcript you can
correct, search, and export to Markdown, PDF, Word, subtitles and more. It's built for
the reality of a lecture hall — a laptop microphone, background noise, echo, accents,
and vocabulary no ordinary transcription app has heard of.

Your recordings are ordinary files in an ordinary folder. Transcription runs either
entirely on your own computer for free, or in the cloud for speed — your choice, and
the app is explicit about which one sends your audio anywhere.

## Contents

- [How it works](#how-it-works) — the two-pass design, in one diagram
- [Your options](#your-options) — **free vs paid**, speed vs accuracy
- [Install](#install) — the app, Python support, Deepgram key
- [Using it](#using-it) — from class to transcript
- [Reading and exporting](#reading-and-exporting) — corrections, search, formats
- [Your files](#your-files) — where recordings live
- [If something breaks](#if-something-breaks)

---

## How it works

```
  🎙  YOU RECORD                      📁  OR IMPORT A FILE
      │                                   phone memo · Zoom · Panopto
      │                                        │
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
  Recording and importing             Live draft      (Deepgram)
  Storage                             Cloud transcript(Deepgram)
  Transcribing on your computer
  Corrections, search, exports        New accounts get $200 free credit
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

Runs in the background, one lecture at a time — keep using your laptop, or record
the next lecture straight away.

---

## Install

**1. Get the app**

Download `Recture Setup.exe` from [Releases](../../releases) and run it.

> Windows shows **"Windows protected your PC"** — expected, the app isn't signed
> with a paid certificate. Click **More info → Run anyway**.

The first launch asks which of the four setups above you want.

**2. Get what your setup needs**

```
  Want it free and private?          → install Python support (below)
  Want live text or cloud speed?     → get a Deepgram key (below)
  Want both?                         → do both
```

**Python support** (for free, on-device transcription):

```bash
pip install faster-whisper
```

Install [Python](https://www.python.org/downloads/) first if needed — tick
**"Add Python to PATH"**. The first transcription downloads the speech model (~1.5 GB, once).

**Deepgram key** (for live text or cloud transcription):

Sign up at [deepgram.com](https://deepgram.com) — $200 free credit, no card.
Paste the key into **Settings → Deepgram API key**.

The record screen warns you **before** you record if your setup isn't ready.

---

## Using it

```
  1. Create a class                      +  in the sidebar
  2. Add course vocabulary               Glossary tab   ← biggest accuracy win
  3. Test your mic                       Mic check · the mic you pick is the one used
  4. Record                              button, or Ctrl+Shift+R from any app
       ★ flag a moment                   Alt+Shift+B, even from another app
       ⏸ pause for a break               Pause / Resume
  5. Stop                                transcribes in the background
  6. Review flagged terms                Accept / Reject
```

**Already recorded it somewhere else?** Click **Import recording…** or drop audio or
video files onto a class.

**Glossary** = `eigenvalue`, `Nyquist`, your professor's name. These are fed to the
speech engine as hints, *and* used afterwards to flag likely mishearings. The app
only ever **suggests** — nothing changes until you click Accept.

**While you record**, Recture keeps the laptop awake, and warns you if the mic goes
silent or disconnects, or if disk space or battery run low.

---

## Reading and exporting

```
  Double-click a sentence        fix a word (the original is kept, so you can undo)
  Search, in the sidebar         every lecture · opens at the moment it was said
  Ctrl+F                         find in this lecture
  Outline                        a section every 5 minutes, plus your bookmarks
  Hide "um" and "uh"             easier reading · the word-for-word record is kept
  Speakers                       rename "Speaker 1" to your professor's name
  Space · ← → · [ ]              play/pause · skip 5 s · slower/faster
```

| Export | Good for |
|---|---|
| Markdown | Obsidian, Notion, OneNote |
| PDF | printing and annotating |
| Word | editing in Word, Google Docs, Pages |
| Plain text | anywhere |
| Subtitles (SRT / WebVTT) | captions on the recording |
| Spreadsheet (CSV) | Excel or Sheets, one row per sentence |
| JSON | scripts and other tools |

Export one lecture from its page, or a whole class from **Export…** on the class —
as one file, or a file per lecture.

---

## Your files

Ordinary folders. Back them up, sync them, rearrange them — the app follows along.

```
Documents\Recture\Classes\
└── CS 4501 Machine Learning\
    ├── glossary.json                    your course vocabulary
    └── 2026-09-12 - Week 3\
        ├── audio\                       the recording (one file once transcribed)
        ├── transcript.json              the master copy, corrections included
        ├── bookmarks.json               moments you flagged
        └── transcript.md · .pdf · .docx exports you saved here
```

**~115 MB per hour**, or **~15 MB** with compressed storage (Settings). A 10 hrs/week semester ≈ 18 GB, or ≈ 2.5 GB compressed.

Rename a class folder in File Explorer, drag a lecture to another class, or restore
one from backup — it shows up in the app within seconds.

---

## If something breaks

| Problem | Fix |
|---|---|
| "faster-whisper is not installed" | Re-run `pip install faster-whisper` |
| "No sound picked up" while recording | Mic muted, or wrong mic — pick it in **Mic check** |
| Laptop went to sleep mid-lecture | Everything up to then is saved — press **Resume** |
| App crashed mid-lecture | Reopen — recording is repaired automatically |
| Transcription failed | Audio is safe → **Retry transcription** |
| "Needs attention" | Part of the audio failed its integrity check; the rest is fine |
| Deepgram key asked for again | Paste it once more in **Settings** (it couldn't carry over from LectureRec) |
| App doesn't match my folders | **Sync with disk** in the sidebar |

**Your recording survives all of these.** Audio is written continuously and
fingerprinted so damage is detected rather than silently passed along.

---

Technical details: [DEVELOPERS.md](DEVELOPERS.md)
