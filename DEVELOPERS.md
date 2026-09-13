# LectureRec — developer notes

Technical reference. For the user-facing guide see [README.md](README.md).

Record in-person lectures on a laptop and get accurate transcripts, organized by class.

Everything is stored locally. Audio leaves the device only if you choose a cloud transcription
provider, and the app says so on screen wherever that is the case.

## Running it

```bash
npm install
npm run dev          # development, with hot reload
npm run build        # typecheck + bundle
npm start            # run the built app
```

### Verification

```bash
npm test             # 80 unit tests (pure logic: audio, correction, exports)
npm run smoke        # 54 integration checks, run inside Electron
```

The split exists for a concrete reason: `better-sqlite3` is compiled against **Electron's** ABI, so
the plain-Node test runner cannot load it. Anything touching SQLite is therefore exercised by
`npm run smoke`, which boots a real Electron process, writes real audio, and runs the real pipeline
against a stubbed transcription provider. It covers recording, checksums, assembly, corruption
handling, failed-transcription recovery, crash recovery, exports, rename/move/delete, and
disk↔index reconciliation (including a full rebuild after wiping the database).

## Transcription providers

Two passes, by design:

| Pass | Purpose | Default |
| --- | --- | --- |
| **Live** | Rough draft on screen while recording | Deepgram streaming |
| **Final** | The transcript that is saved and exported | faster-whisper, locally |

The live draft is never the source of truth. When recording stops, the complete audio is
re-transcribed and that result replaces the draft. If the final pass fails after retries, the draft
is kept as a clearly-labelled fallback and the lecture is marked **needs transcription** — the audio
is never discarded.

### Local final pass (default — no audio leaves the device)

```bash
pip install faster-whisper
```

Set `LECTUREREC_PYTHON` if your interpreter is not on `PATH`.

### Cloud (optional)

Add a Deepgram API key in **Settings**, or set `DEEPGRAM_API_KEY`. Keys are stored through the OS
secret store (DPAPI / Keychain / libsecret), never in a plain file.

## On-disk layout

The files are the source of truth. The SQLite database is an index over them and can be rebuilt.

```
<root>/Classes/<Class Name>/
  glossary.json
  class.json
  <YYYY-MM-DD - Title>/
    lecture.json
    audio/
      segments.json        manifest: checksums + verification state
      segment-0001.wav …   rolling segments, each checksummed at write time
      final.wav            assembled from verified segments only
    transcript.json        source of truth for every export
    transcript.live.json   live draft, kept only as a fallback
    transcript.md
    transcript.pdf
```

Markdown, PDF and clipboard output are all generated from `transcript.json`, so they cannot drift
apart.

## How the audio pipeline protects a lecture

- Frames are written to disk as they arrive. A lecture is never held in memory.
- Writes are serialized, so frames cannot interleave or land out of order.
- Each segment is fsync'd, closed, then **re-read from disk** to compute its SHA-256 — hashing the
  in-memory buffer would certify a file the disk never took.
- Before assembly every segment is re-hashed. A segment that fails is excluded *and* reported, in
  the UI and in the transcript itself. It is never silently dropped or silently included, and the
  file is never deleted.
- If the app dies mid-lecture, the next launch repairs the partially-written segment (truncating to
  a whole sample frame) and marks the lecture ready to transcribe.

## Disk is the source of truth

`src/main/rescan.ts` reconciles the SQLite index with the filesystem. Identity comes from the `id`
written into `class.json` / `lecture.json`, not from the path, so a folder renamed or moved in
Explorer is recognised as the *same* entity and updated in place rather than deleted and re-adopted.

It runs at startup, on a debounced recursive `fs.watch`, and on demand ("Sync with disk"). The only
destructive action it takes is removing an index row whose folder is gone. It never writes into a
lecture's audio and never deletes a file.

Removing something from the library while keeping its files writes a `.lecturerec-ignore` marker into
the folder, so the scanner skips it — otherwise the watcher would re-adopt it within seconds and
"remove from library" would be a no-op. Deleting that marker re-admits the folder.

## Glossary and corrections

Each class keeps a glossary. It is sent to the transcription provider as keyterm hints, and it is
the **only** vocabulary the post-transcription correction step may propose.

That step is deliberately conservative. It can only ever suggest replacing a span with a term that
already exists in the glossary — there is no generative step, so it cannot invent a word or rewrite
a sentence. Nothing is applied automatically; every match is a pending suggestion you accept or
reject. Ordinary English words are protected by a much higher matching bar, so "the" never becomes
"theta".

## Version pinning

`electron@42.11.3` and `better-sqlite3@12.11.1` are pinned to exact versions, and the pairing
matters: Electron 42 is ABI 146, the newest Electron major for which better-sqlite3 publishes a
prebuilt binary. Any other pairing forces a source build, which needs a full MSVC toolchain.
If you bump either one, check that a matching `better-sqlite3-v*-electron-v<abi>-<platform>.tar.gz`
exists on the better-sqlite3 releases page first.

## Privacy

- Recordings and transcripts are always stored locally.
- With the default settings the final transcript is produced on-device.
- If a cloud provider is selected, audio is uploaded transiently for transcription and the app says
  so in Settings and on the recording screen.
- There is no app-level encryption of lecture audio, on purpose. Every OS this targets ships
  full-disk encryption, and a second home-grown lock would add a key we cannot protect better than
  the OS does while risking permanent loss of the recordings. Settings reports the OS-level
  encryption status instead.

## Giving the app to someone else

```bash
npm run dist        # -> release/LectureRec Setup 0.1.0.exe  (~124 MB)
```

Electron is bundled, so the recipient does **not** need Node, npm, or this repo. They run the
installer and the app works — with one caveat below.

electron-builder can only build for the platform it runs on (without extra tooling), so a Windows
machine produces the Windows installer, a Mac the `.dmg`, and so on. Targets for all three are
already configured.

### Two things to tell whoever you give it to

1. **The installer is unsigned.** Windows SmartScreen will show "Windows protected your PC" —
   they need *More info → Run anyway*. macOS will need right-click → Open. Removing that warning
   means buying a code-signing certificate (~$100–400/yr) and setting `CSC_LINK` / `CSC_KEY_PASSWORD`.

2. **The default transcription provider needs Python.** The app ships `transcribe.py`, but not
   Python or the ~1.5 GB of model weights. On a fresh machine the student must either:
   - run `pip install faster-whisper` (first transcription then downloads the model), **or**
   - switch to Deepgram in Settings and paste an API key.

   Settings shows each provider's readiness and says exactly what is missing, so this is visible
   rather than a silent failure.

### Packaging notes

`transcribe.py` is shipped via `extraResources`, not `files`. Anything in `files` goes inside
`app.asar`, and a path inside an asar cannot be handed to an external Python interpreter — the
script must exist as a real file on disk. `better-sqlite3` is likewise listed in `asarUnpack`
because a native `.node` binary cannot be loaded from inside an archive.
