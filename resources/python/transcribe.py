#!/usr/bin/env python3
"""Local high-accuracy transcription pass using faster-whisper.

Reads a JSON request on argv[1] (a file path, so long glossaries never hit the
command-line length limit) and streams newline-delimited JSON events on stdout:

    {"event": "progress", "progress": 0.42, "message": "..."}
    {"event": "segment",  "start": 1.2, "end": 4.8, "text": "...", "words": [...]}
    {"event": "done",     "duration": 3612.0, "language": "en", "model": "medium.en"}
    {"event": "error",    "message": "...", "permanent": true}

Audio never leaves the machine on this path.
"""

import json
import sys

# The Node side reads this stream as UTF-8. Windows defaults stdout to the
# locale encoding (cp1252 on many machines), which would raise
# UnicodeEncodeError the first time a transcript contains a character outside
# it -- one Greek letter in a maths lecture is enough to kill the whole pass.
# Force UTF-8 so both sides agree.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    if len(sys.argv) < 2:
        emit({"event": "error", "message": "No request file given", "permanent": True})
        return 2

    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            request = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "message": f"Bad request file: {exc}", "permanent": True})
        return 2

    audio_path = request["audioPath"]
    model_name = request.get("model", "medium.en")
    language = request.get("language") or None
    compute_type = request.get("computeType", "int8")
    keyterms = request.get("keyterms", [])

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        emit(
            {
                "event": "error",
                "message": (
                    "faster-whisper is not installed. Install it with: "
                    "pip install faster-whisper  (details: %s)" % exc
                ),
                "permanent": True,
            }
        )
        return 3

    try:
        emit({"event": "progress", "progress": None, "message": f"Loading {model_name}…"})
        model = WhisperModel(model_name, device="auto", compute_type=compute_type)

        # Course vocabulary is fed in as an initial prompt. Whisper conditions on
        # it, which measurably improves technical terms, but it is a hint only —
        # it cannot force a term into the output.
        initial_prompt = None
        if keyterms:
            initial_prompt = "Technical terms used in this lecture: " + ", ".join(keyterms) + "."

        segments, info = model.transcribe(
            audio_path,
            language=language,
            initial_prompt=initial_prompt,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )

        total = float(getattr(info, "duration", 0.0) or 0.0)
        emit({"event": "progress", "progress": 0.0, "message": "Transcribing…"})

        for segment in segments:
            words = []
            for word in getattr(segment, "words", None) or []:
                words.append(
                    {
                        "word": word.word.strip(),
                        "start": float(word.start),
                        "end": float(word.end),
                        # faster-whisper reports word probability; treat it as
                        # the confidence the correction step gates on.
                        "confidence": float(getattr(word, "probability", 1.0)),
                    }
                )
            emit(
                {
                    "event": "segment",
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment.text.strip(),
                    "words": words,
                }
            )
            if total > 0:
                emit(
                    {
                        "event": "progress",
                        "progress": min(1.0, float(segment.end) / total),
                        "message": "Transcribing…",
                    }
                )

        emit(
            {
                "event": "done",
                "duration": total,
                "language": getattr(info, "language", language or "en"),
                "model": model_name,
            }
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "message": str(exc), "permanent": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
