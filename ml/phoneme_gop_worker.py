#!/usr/bin/env python3
"""Persistent phoneme-GOP worker.

Loads a wav2vec2 CTC phoneme model once, then serves JSON-lines requests on
stdin, one response per line on stdout:

  {"id": 1, "wav_path": "/tmp/x.wav", "target_sounds": ["k", "æ", "t"]}
  -> {"id": 1, "ok": true, "result": {...}}

The result carries per-sound Goodness of Pronunciation (GOP) values computed
from CTC forced alignment of the target phoneme sequence, plus the free
CTC-decoded phoneme sequence actually recognized in the audio.
"""

import json
import math
import sys

import numpy as np
import soundfile as sf
import torch

MODEL_ID = "facebook/wav2vec2-lv-60-espeak-cv-ft"
SAMPLE_RATE = 16000

# Fallbacks for IPA symbols used in WORD_PROFILES that the model vocabulary
# may write differently (British vs American espeak conventions).
SUBSTITUTIONS = {
    "ɒ": ["ɑː", "ɑ", "ɔ"],
    "əʊ": ["oʊ"],
    "e": ["ɛ", "e"],
    "ɜː": ["ɜː", "ɜ", "ɚ"],
    "ɪə": ["ɪə", "iə", "ɪɹ"],
    "əl": ["əl", "l̩", "əɫ"],
    "ɔː": ["ɔː", "ɔ", "oː"],
}

# Accent-equivalent realizations accepted as correct for a target sound.
# WORD_PROFILES is British-flavored IPA while recordings and the model often
# realize American variants; a child saying /dɑːɡ/ for "dog" is not wrong.
ALTERNATIVES = {
    "ɒ": ["ɑː", "ɑ", "ɔ", "ɔː"],
    "æ": ["a"],
    "e": ["ɛ"],
    "ɜː": ["ɜ", "ɚ", "ɝ"],
    "əʊ": ["oʊ", "o"],
    "ɔː": ["ɔ", "oː", "ɑː"],
    "iː": ["i"],
    "uː": ["u"],
    "ʊ": ["u"],
    "ʌ": ["ɐ", "a"],
    "r": ["ɹ"],
    "ə": ["ɐ"],
    "ɪ": ["i", "ɨ"],
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class GopEngine:
    def __init__(self):
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        self.model = Wav2Vec2ForCTC.from_pretrained(MODEL_ID)
        self.model.eval()
        self.processor = Wav2Vec2Processor.from_pretrained(MODEL_ID)
        self.vocab = self.processor.tokenizer.get_vocab()
        self.id_to_token = {i: t for t, i in self.vocab.items()}
        self.blank_id = self.processor.tokenizer.pad_token_id

    # ── target tokenization ──────────────────────────────────────────────
    def tokenize_sound(self, sound):
        """Map one WORD_PROFILES sound (may be a cluster like 'flaɪ') to a
        list of model token ids. Greedy longest-match against the vocab,
        with substitution fallbacks. Returns (ids, unmatched_parts)."""
        sound = sound.replace("g", "ɡ")  # ASCII g -> IPA U+0261 used by the vocab
        candidates = [sound] + SUBSTITUTIONS.get(sound, [])
        for candidate in candidates:
            ids = self._greedy_match(candidate)
            if ids is not None:
                return ids, []
        # Cluster: tokenize piecewise, substituting per piece.
        ids, unmatched = [], []
        rest = sound
        while rest:
            matched = False
            for length in range(len(rest), 0, -1):
                piece = rest[:length]
                for candidate in [piece] + SUBSTITUTIONS.get(piece, []):
                    piece_ids = self._greedy_match(candidate)
                    if piece_ids is not None:
                        ids.extend(piece_ids)
                        rest = rest[length:]
                        matched = True
                        break
                if matched:
                    break
            if not matched:
                unmatched.append(rest[0])
                rest = rest[1:]
        return ids, unmatched

    def _greedy_match(self, text):
        """Tokenize text greedily against vocab; None if any part unmatched."""
        ids = []
        rest = text
        while rest:
            for length in range(len(rest), 0, -1):
                token = rest[:length]
                if token in self.vocab:
                    ids.append(self.vocab[token])
                    rest = rest[length:]
                    break
            else:
                return None
        return ids if ids else None

    # ── inference ────────────────────────────────────────────────────────
    def posteriors(self, wav_path):
        audio, rate = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if rate != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE}Hz wav, got {rate}")
        inputs = self.processor(
            audio, sampling_rate=SAMPLE_RATE, return_tensors="pt"
        )
        with torch.no_grad():
            logits = self.model(inputs.input_values).logits[0]
        return torch.log_softmax(logits, dim=-1).numpy(), len(audio) / SAMPLE_RATE

    def decode_free(self, log_probs):
        ids = log_probs.argmax(axis=-1)
        out = []
        previous = None
        for i in ids:
            if i != self.blank_id and i != previous:
                out.append(self.id_to_token.get(int(i), "?"))
            previous = i
        return out

    # ── CTC forced alignment (Viterbi over blank-interleaved states) ─────
    def align(self, log_probs, acceptance_sets):
        """acceptance_sets: one set of acceptable token ids per target token
        position. Emission for a position = max log-prob over its set, so
        accent variants anchor the path as well as the canonical symbol."""
        T = log_probs.shape[0]
        states = [None]  # interleaved: blank, pos0, blank, pos1, ... blank
        for ids in acceptance_sets:
            states.append(sorted(ids))
            states.append(None)
        S = len(states)
        NEG = -1e30

        def emission(t, s):
            if states[s] is None:
                return log_probs[t][self.blank_id]
            return max(log_probs[t][i] for i in states[s])

        dp = np.full((T, S), NEG)
        back = np.zeros((T, S), dtype=np.int8)
        dp[0][0] = emission(0, 0)
        if S > 1:
            dp[0][1] = emission(0, 1)

        for t in range(1, T):
            for s in range(S):
                best, arg = dp[t - 1][s], 0
                if s >= 1 and dp[t - 1][s - 1] > best:
                    best, arg = dp[t - 1][s - 1], 1
                if (
                    s >= 2
                    and states[s] is not None
                    and states[s] != states[s - 2]
                    and dp[t - 1][s - 2] > best
                ):
                    best, arg = dp[t - 1][s - 2], 2
                if best <= NEG:
                    continue
                dp[t][s] = best + emission(t, s)
                back[t][s] = arg

        end = S - 1 if dp[T - 1][S - 1] >= dp[T - 1][S - 2] else S - 2
        if dp[T - 1][end] <= NEG:
            return None

        # Backtrace: token emission frames.
        frames_per_state = [[] for _ in range(S)]
        s = end
        for t in range(T - 1, -1, -1):
            frames_per_state[s].append(t)
            s -= back[t][s]
        return [sorted(frames_per_state[2 * k + 1]) for k in range(len(acceptance_sets))]

    # ── GOP ──────────────────────────────────────────────────────────────
    def gop_for_frames(self, log_probs, acceptance_ids, frames):
        """Mean over frames of log P(best acceptable variant) - log max
        P(non-blank), with the posterior renormalized to exclude blank (CTC
        blank dominance fix). Returns (gop, realized_token_id)."""
        if not frames:
            return None, None
        values = []
        realized_counts = {}
        for t in frames:
            row = np.array(log_probs[t], dtype=np.float64)
            blank_lp = row[self.blank_id]
            row[self.blank_id] = -np.inf
            denom = np.log1p(-min(math.exp(blank_lp), 1 - 1e-9))
            target_id = max(acceptance_ids, key=lambda i: row[i])
            realized_counts[target_id] = realized_counts.get(target_id, 0) + 1
            target = row[target_id] - denom
            best = row.max() - denom
            values.append(target - best)
        realized = max(realized_counts, key=realized_counts.get)
        return float(np.mean(values)), realized

    def gop_to_score(self, gop):
        # gop <= 0; 0 -> 100. Provisional curve until Phase 4 calibration.
        return max(0, min(100, round(100 * math.exp(gop * 0.55))))

    def acceptance_for_sound(self, sound, primary_ids):
        """Acceptable token ids per token position: the canonical token plus
        single-token accent variants (variants only for single-token sounds)."""
        sets = [{tid} for tid in primary_ids]
        if len(primary_ids) == 1:
            for alternative in ALTERNATIVES.get(sound, []):
                normalized = alternative.replace("g", "ɡ")
                if normalized in self.vocab:
                    sets[0].add(self.vocab[normalized])
        return sets

    def assess(self, wav_path, target_sounds):
        log_probs, duration = self.posteriors(wav_path)
        frame_seconds = duration / max(1, log_probs.shape[0])

        acceptance_sets = []
        unit_of_position = []
        tokenization = []
        for unit_index, sound in enumerate(target_sounds):
            ids, unmatched = self.tokenize_sound(sound)
            tokenization.append({
                "sound": sound,
                "tokens": [self.id_to_token[i] for i in ids],
                "unmatched": unmatched,
            })
            for id_set in self.acceptance_for_sound(sound, ids):
                acceptance_sets.append(id_set)
                unit_of_position.append(unit_index)

        alignment = self.align(log_probs, acceptance_sets) if acceptance_sets else None

        per_sound = []
        for unit_index, sound in enumerate(target_sounds):
            entry = {
                "sound": sound,
                "tokens": tokenization[unit_index]["tokens"],
                "gop": None,
                "score": None,
                "realized": None,
                "start": None,
                "end": None,
            }
            if alignment is not None:
                gops, frames_all, realized_tokens = [], [], []
                for k, id_set in enumerate(acceptance_sets):
                    if unit_of_position[k] != unit_index:
                        continue
                    gop, realized = self.gop_for_frames(log_probs, sorted(id_set), alignment[k])
                    if gop is not None:
                        gops.append(gop)
                        frames_all.extend(alignment[k])
                        realized_tokens.append(self.id_to_token.get(realized, "?"))
                if gops:
                    gop = float(np.mean(gops))
                    entry["gop"] = round(gop, 4)
                    entry["score"] = self.gop_to_score(gop)
                    entry["realized"] = "".join(realized_tokens)
                    entry["start"] = round(min(frames_all) * frame_seconds, 3)
                    entry["end"] = round((max(frames_all) + 1) * frame_seconds, 3)
            per_sound.append(entry)

        scored = [e["score"] for e in per_sound if e["score"] is not None]
        return {
            "model_id": MODEL_ID,
            "duration": round(duration, 3),
            "decoded_phonemes": self.decode_free(log_probs),
            "aligned": alignment is not None,
            "tokenization": tokenization,
            "per_sound": per_sound,
            "overall_gop_score": round(float(np.mean(scored))) if scored else None,
        }


def main():
    engine = GopEngine()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if request.get("op") == "ping":
                print(json.dumps({"id": request.get("id"), "ok": True, "pong": True}), flush=True)
                continue
            result = engine.assess(request["wav_path"], request["target_sounds"])
            print(json.dumps({"id": request.get("id"), "ok": True, "result": result}), flush=True)
        except Exception as error:  # noqa: BLE001 — worker must never die on one request
            log(f"gop request failed: {error}")
            print(
                json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                            "ok": False, "error": str(error)}),
                flush=True,
            )


if __name__ == "__main__":
    main()
