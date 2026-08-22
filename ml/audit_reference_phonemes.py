#!/usr/bin/env python3
"""Audit every reference recording against its own target sounds.

A reference mp3 is a correct pronunciation by definition, so any target sound
the GOP engine scores low on its own reference exposes a phoneme-mapping gap
(like the bird øː case), not a pronunciation error.
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, "/Users/navindusamaranayake/Documents/AURIVA/auriva-backend/ml")
os.environ.setdefault("HF_HOME", "/Users/navindusamaranayake/Documents/AURIVA/auriva-backend/models/hf-cache")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from phoneme_gop_worker import GopEngine  # noqa: E402

AUDIO_DIR = "/Users/navindusamaranayake/Documents/AURIVA/auriva-backend/assets/reference-audio"
def load_targets():
    out = subprocess.run(
        ["node", "-e",
         "const {WORD_PROFILES, LETTER_SOUNDS} = require('"
         "/Users/navindusamaranayake/Documents/AURIVA/auriva-backend/src/services/wordProfiles');"
         "const t={};for(const [w,p] of Object.entries(WORD_PROFILES)) t[w]=p.sounds;"
         "for(const [l,s] of Object.entries(LETTER_SOUNDS)) t[l]=s;"
         "console.log(JSON.stringify(t));"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)

TARGETS = load_targets()

LOW = 60  # flag threshold

def to_wav(mp3_path, wav_path):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", mp3_path, "-ac", "1", "-ar", "16000", wav_path],
        check=True,
    )

def main():
    engine = GopEngine()
    flagged = []
    tokenization_issues = []

    for word, sounds in sorted(TARGETS.items()):
        mp3 = os.path.join(AUDIO_DIR, f"{word}.mp3")
        if not os.path.exists(mp3):
            print(f"SKIP {word}: no reference mp3", flush=True)
            continue
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            to_wav(mp3, tmp.name)
            result = engine.assess(tmp.name, sounds)

        for entry in result["tokenization"]:
            if entry["unmatched"]:
                tokenization_issues.append((word, entry["sound"], entry["unmatched"]))

        lows = [
            (e["sound"], e["score"], e["realized"])
            for e in result["per_sound"]
            if e["score"] is not None and e["score"] < LOW
        ]
        none_scored = [e["sound"] for e in result["per_sound"] if e["score"] is None]
        overall = result["overall_gop_score"]
        decoded = " ".join(result["decoded_phonemes"])
        status = "LOW" if lows or none_scored or (overall or 0) < 70 else "ok"
        print(f"{status:4} {word:12} overall={overall} decoded=[{decoded}]", flush=True)
        if lows:
            for sound, score, realized in lows:
                print(f"       weak sound /{sound}/ score={score} realized={realized}", flush=True)
        if none_scored:
            print(f"       unscored sounds: {none_scored}", flush=True)
        if lows or none_scored or (overall or 0) < 70:
            flagged.append(word)

    print("\n=== SUMMARY ===")
    print("flagged words:", flagged)
    print("tokenization issues:", tokenization_issues)

if __name__ == "__main__":
    main()
