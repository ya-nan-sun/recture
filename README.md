# LectureRec

Record your lectures. Get accurate transcripts, organised by class.

LectureRec is a desktop app for students. You press record when the professor starts talking, and
when the lecture ends you get a searchable, timestamped transcript you can export to Markdown or
PDF. It's built for the reality of a lecture hall — a laptop microphone, background noise, echo, and
professors who use words no ordinary transcription app has heard of.

Your recordings are stored as ordinary files in an ordinary folder on your computer. Nothing is
locked inside the app.

---

## Contents

- [What makes it different](#what-makes-it-different)
- [Choosing how to transcribe](#choosing-how-to-transcribe)
- [Installing](#installing)
- [First-time setup](#first-time-setup)
- [Using it](#using-it)
- [Where your files live](#where-your-files-live)
- [If something goes wrong](#if-something-goes-wrong)

---

## What makes it different

**It teaches itself your course vocabulary.** Each class has a glossary — `eigenvalue`, `Nyquist`,
your professor's name, whatever your course actually uses. Those words get sent to the transcription
engine as hints, which makes it far more likely to get them right. Afterwards, the app double-checks
the transcript against that same glossary and flags anything that looks like a misheard term.

It only ever *suggests*. It can't invent a word or rewrite a sentence — it can only propose swapping
in a term you already added yourself, and nothing changes until you click Accept.

**It's careful with your recordings.** Audio is written to disk continuously while you record, in
small chunks, each one fingerprinted so the app can prove it hasn't been corrupted. If your laptop
crashes or the battery dies mid-lecture, the app repairs the recording next time it opens. If
transcription fails, your audio is kept and you can retry. Losing a lecture is the one thing this
app is built hardest to prevent.

**Your files stay yours.** Everything lives in a normal folder. Rename a class folder in File
Explorer and the app follows it. Delete a folder and the app notices. Even if the app's internal
database is deleted, it rebuilds itself from your files.

---

## Choosing how to transcribe

This is the main decision, and there are really just **two independent switches**.

### Switch 1 — who writes the final transcript?

This is the transcript that actually gets saved.

| Option | What happens | Trade-off |
| --- | --- | --- |
| **On your computer** (faster-whisper) | Your laptop does the work | Free, private, but takes time |
| **In the cloud** (Deepgram) | The recording is uploaded | Fast, costs a little, audio leaves your device |

### Switch 2 — do you want to see text while you record?

The **live draft** shows words on screen as the professor speaks, so you can follow along and mark
moments. It's rough, and it gets thrown away — the real transcript is made after you stop.

The live draft always uses Deepgram (the cloud service). There's no on-your-computer version of it,
so it needs an internet connection and a free Deepgram account.

### Putting them together

| Live draft | Final transcript | Does audio leave your computer? | Cost for a 3-hour lecture |
| --- | --- | --- | --- |
| Off | On your computer | **Never** | **Free** |
| On | On your computer | Only while recording | ~$0.86 |
| Off | Cloud | Uploaded afterwards | ~$0.77 |
| On | Cloud | Both | ~$1.64 |

**A common-sense default:** live draft **on**, final transcript **on your computer**. You get text
during the lecture, and the transcript that matters is made for free on your own machine.

**If privacy is the priority:** live draft **off**, final transcript **on your computer**. Then
nothing ever leaves your laptop. You record "blind" — a timer and a sound meter, but no text until
processing finishes.

> ⚠️ Worth knowing: choosing "on your computer" for the final transcript does **not** mean nothing
> is uploaded. If the live draft is on, audio is streaming to the cloud the whole time you record.
> For truly nothing-leaves-your-laptop, turn the live draft off too.

### How long does it take?

Measured on a 12-core laptop, for a **90-minute lecture**:

| Setting | Time to transcribe |
| --- | --- |
| On your computer — `small` model | about 11 minutes |
| On your computer — `medium` model (default) | about 30 minutes |
| Cloud (Deepgram) | a few minutes, mostly upload time |

It runs in the background — you can close the lecture, use your laptop normally, or start another
recording. Bigger models are more accurate, and the difference shows up exactly where you need it:
noisy rooms, accents and technical words.

### About cost

Deepgram gives new accounts **$200 of free credit**, which at these prices is well over a hundred
three-hour lectures. After that it's roughly **$36–76 per semester** depending on which switches you
use. If you pick "on your computer" for everything, it's free forever.

---

## Installing

### The easy way — the installer

1. Download `LectureRec Setup.exe` from the [Releases](../../releases) page.
2. Run it. Windows will show a blue **"Windows protected your PC"** warning — this is expected,
   because the app isn't signed with a paid certificate. Click **More info → Run anyway**.
3. Launch LectureRec.

You do **not** need to install Node, Python or anything else just to open the app. But to transcribe
*on your computer*, you need one more step — see below.

### To transcribe on your computer, install Python support

Skip this if you only plan to use the cloud option.

1. Install [Python](https://www.python.org/downloads/) if you don't have it. **Tick "Add Python to
   PATH"** during installation.
2. Open Command Prompt or PowerShell and run:

   ```
   pip install faster-whisper
   ```

3. Open LectureRec → **Settings**. The final-transcript option should now say **Ready**.

The first time you record, the app downloads the speech model (about 1.5 GB for the default). That
happens once.

### The developer way — running from source

If you'd rather run the code directly (and skip the Windows warning):

```bash
git clone <this repository>
cd lecturerec
npm install
npm run dev
```

Requires [Node.js](https://nodejs.org/) 20 or newer. See [DEVELOPERS.md](DEVELOPERS.md) for the
technical details.

---

## First-time setup

1. **Open Settings.** Check where your lectures will be saved — by default,
   `Documents\LectureRec`. Change it if you'd rather they lived elsewhere (a synced folder works
   fine).

2. **Pick your transcription options** using the two switches above.

3. **If you want the live draft or cloud transcription**, get a free API key:
   - Sign up at [deepgram.com](https://deepgram.com) (free credit, no card required)
   - Copy your API key
   - Paste it into Settings → Deepgram API key → Save

   Your key is stored using Windows' own secure credential storage, not in a plain text file.

4. **Create your first class** with the **+** button in the sidebar.

5. **Add your course vocabulary** in the class's **Glossary** tab. This is the single most valuable
   thing you can do for accuracy. Add the professor's name, module names, recurring technical terms.
   Use **Import list…** to paste a whole list at once.

---

## Using it

### Before the lecture

Open your class and click **Test microphone**. This listens without recording and tells you plainly
whether sound is getting through. Worth ten seconds in an unfamiliar room — especially if you're
sitting at the back.

### Recording

Start recording in either of two ways:

- The **Start recording** button on the class page
- **Ctrl + Shift + R** — works from any app, so you don't have to go hunting for the window when the
  professor starts early

While recording you'll see a timer, a live sound meter, a count of chunks safely saved to disk, and
(if enabled) the live draft scrolling past.

Press **Stop & transcribe** when the lecture ends. You can then close the window or go to your next
class — transcription continues in the background.

### After the lecture

When the transcript is ready:

- **Glossary review** shows anything that looked like a misheard course term. Accept or reject each
  one. Nothing changes until you accept it.
- **Click any timestamp** to jump the audio to that exact moment.
- **Export** to Markdown or PDF, or copy the text straight to your clipboard.
- **Search transcripts** in the sidebar searches every lecture you've ever recorded.

### Organising

You can **rename**, **move** and **remove** classes and lectures from inside the app, and the folders
on your computer are kept in step automatically.

When you remove something, you're asked whether to keep the files. **Keeping them is the default** —
removing a lecture from the app leaves every recording safely on your disk. Deleting the files for
real requires ticking a box *and* typing the name to confirm.

---

## Where your files live

Everything sits in your lectures folder as ordinary files:

```
Documents\LectureRec\Classes\
  CS 4501 Machine Learning\
    glossary.json                     your course vocabulary
    2026-09-12 - Week 3\
      audio\                          the recording, in chunks
      transcript.json                 the master transcript
      transcript.md                   exported when you ask
      transcript.pdf
```

You can back this folder up, sync it, or copy it to another computer. You can rearrange things in
File Explorer and the app will notice and follow along — rename a class folder, drag a lecture into a
different class, or restore an old lecture from a backup, and it shows up in the app within seconds.

**Storage:** about **115 MB per hour** of recording. A full semester of 10 hours a week works out to
roughly 18 GB.

---

## If something goes wrong

**"faster-whisper is not installed"** — Python support is missing or was removed. Run
`pip install faster-whisper` again. Settings will tell you exactly what it can't find.

**Recording won't start** — check Windows microphone permissions
(Settings → Privacy & security → Microphone) and make sure no other app has exclusive control of
the microphone.

**The app crashed mid-lecture** — reopen it. Your recording is repaired automatically and the
lecture will be waiting, marked **Needs transcription**. Click **Retry transcription**.

**Transcription failed** — your audio is safe. The lecture is marked **Needs transcription** and
there's a **Retry transcription** button. A failure never costs you the recording.

**A lecture says "Needs attention"** — one or more chunks of audio failed their integrity check.
The app excluded the damaged part rather than pretending it was fine, and tells you which file.
The rest of the lecture is intact and the damaged file is still on your disk.

**The app's list doesn't match my folders** — click **Sync with disk** in the sidebar. This should
happen automatically, but the button forces it.

---

## Privacy summary

- Recordings and transcripts are always stored locally, as ordinary files.
- With the default settings, the final transcript is made on your own computer.
- If you enable any cloud option, the app says so plainly in Settings and on the recording screen.
- Audio sent for cloud transcription is transient — it's used to produce the transcript, not to
  store your lectures.
- The app relies on your computer's own disk encryption (BitLocker) rather than adding its own.
  Settings shows you whether that's switched on.

---

Built for students who'd rather listen than scribble.
