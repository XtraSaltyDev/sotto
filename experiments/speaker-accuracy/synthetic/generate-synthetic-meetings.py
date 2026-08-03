#!/usr/bin/env python3
"""Generate annotated multi-speaker recordings for the speaker-accuracy harness.

Each scenario is synthesized from macOS TTS voices, so the ground truth is
known exactly by construction: every utterance's start and end in the final
mix is computed to the sample, the speaker of every range is the voice that
rendered it, and the reference transcript is the script itself (never Whisper
output, so WER scoring stays non-circular).

The audio is written as 16 kHz mono LEI16 WAV and referenced through
normalizedWavPath, so the harness skips media import and Whisper/diarization
consume exactly this mixture. Generated media stays out of git; the
annotation, reference, and config JSON files land next to this script.

Limitations, stated up front: TTS speech is cleaner than a real meeting
(no room reverb, no crosstalk, no overlap), so results are supporting
evidence for candidate promotion, not a substitute for a real annotated
meeting.
"""

from __future__ import annotations

import json
import math
import random
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 16_000
HERE = Path(__file__).resolve().parent
MEDIA_DIRECTORY = HERE / "media"

Turn = tuple[str, str, int]  # (speaker label, text, gap before turn in ms)

Voice = tuple[str, int, float]  # (macOS voice, words per minute, pitch factor)


def pitch_shift(samples: bytes, factor: float) -> bytes:
    """Crude resampling pitch shift. A factor above 1 raises pitch (and
    shortens the audio); below 1 lowers it. Formants move with the pitch,
    which exaggerates speaker differences — exactly what distinguishes the
    otherwise too-uniform TTS voices for the embedding model. Ranges are
    measured after shifting, so annotations stay sample-accurate."""
    if factor == 1.0:
        return samples
    values = struct.unpack(f"<{len(samples) // 2}h", samples)
    output_length = int(len(values) / factor)
    shifted = []
    for index in range(output_length):
        position = index * factor
        low = int(position)
        high = min(low + 1, len(values) - 1)
        fraction = position - low
        shifted.append(
            int(values[low] * (1 - fraction) + values[high] * fraction),
        )
    return struct.pack(f"<{len(shifted)}h", *shifted)


def render_utterance(voice: str, rate: int, text: str, destination: Path) -> None:
    subprocess.run(
        [
            "say",
            "-v",
            voice,
            "-r",
            str(rate),
            "-o",
            str(destination),
            "--data-format=LEI16@16000",
            text,
        ],
        check=True,
    )


def read_samples(path: Path) -> bytes:
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != SAMPLE_RATE or handle.getnchannels() != 1:
            raise RuntimeError(f"unexpected format in {path}")
        return handle.readframes(handle.getnframes())


def trim_silence(samples: bytes, threshold: int = 260) -> bytes:
    """Trim leading/trailing near-silence so annotated ranges hug speech."""
    values = struct.unpack(f"<{len(samples) // 2}h", samples)
    first = 0
    last = len(values)
    for index, value in enumerate(values):
        if abs(value) > threshold:
            first = max(0, index - SAMPLE_RATE // 50)
            break
    for index in range(len(values) - 1, -1, -1):
        if abs(values[index]) > threshold:
            last = min(len(values), index + SAMPLE_RATE // 50)
            break
    return struct.pack(f"<{last - first}h", *values[first:last])


def degrade(samples: bytes, noise_amplitude: int = 850, window: int = 13) -> bytes:
    """Low-pass (moving average) plus noise. Applied to selected turns to
    imitate a degraded stretch of a real meeting — far-from-mic speech whose
    embeddings drift away from the clean clusters and clump together."""
    values = struct.unpack(f"<{len(samples) // 2}h", samples)
    smoothed = []
    running = 0
    for index, value in enumerate(values):
        running += value
        if index >= window:
            running -= values[index - window]
        sample = running // min(index + 1, window)
        sample += int(random.gauss(0, noise_amplitude))
        smoothed.append(max(-32768, min(32767, sample)))
    return struct.pack(f"<{len(smoothed)}h", *smoothed)


def generate_scenario(
    name: str,
    voices: dict[str, Voice],
    turns: list[Turn],
    noise_amplitude: int = 0,
    degraded_turns: frozenset[int] = frozenset(),
) -> None:
    random.seed(name)
    MEDIA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    mixture = bytearray()
    ranges: list[dict[str, object]] = []
    script_words: list[str] = []

    with tempfile.TemporaryDirectory() as scratch:
        for index, (speaker, text, gap_ms) in enumerate(turns):
            voice, rate, pitch = voices[speaker]
            utterance_path = Path(scratch) / f"turn-{index}.wav"
            render_utterance(voice, rate, text, utterance_path)
            samples = trim_silence(
                pitch_shift(read_samples(utterance_path), pitch),
            )
            if index in degraded_turns:
                samples = degrade(samples)
            gap_frames = int(SAMPLE_RATE * gap_ms / 1000)
            mixture.extend(b"\x00\x00" * gap_frames)
            start_ms = round(len(mixture) / 2 / SAMPLE_RATE * 1000)
            mixture.extend(samples)
            end_ms = round(len(mixture) / 2 / SAMPLE_RATE * 1000)
            ranges.append({"startMs": start_ms, "endMs": end_ms, "speaker": speaker})
            script_words.append(text)

    # A short tail keeps the last word clear of the file edge.
    mixture.extend(b"\x00\x00" * (SAMPLE_RATE // 2))

    if noise_amplitude > 0:
        values = list(struct.unpack(f"<{len(mixture) // 2}h", bytes(mixture)))
        for index in range(len(values)):
            noise = int(random.gauss(0, noise_amplitude))
            values[index] = max(-32768, min(32767, values[index] + noise))
        mixture = bytearray(struct.pack(f"<{len(values)}h", *values))

    duration_ms = round(len(mixture) / 2 / SAMPLE_RATE * 1000)
    wav_path = MEDIA_DIRECTORY / f"{name}.wav"
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(mixture))

    speakers = sorted({speaker for speaker, _, _ in turns})
    (HERE / f"{name}.annotation.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "durationMs": duration_ms,
                "speakers": speakers,
                "ranges": ranges,
                "words": [],
            },
            indent=2,
        )
        + "\n",
    )
    (HERE / f"{name}.transcript-reference.json").write_text(
        json.dumps(
            {"schemaVersion": 1, "text": " ".join(script_words)},
            indent=2,
        )
        + "\n",
    )

    anchor_defaults = {
        "minimumInternalMedianSimilarity": 0.4,
        "minimumSimilarity": 0.5,
        "minimumMargin": 0.2,
        "minimumSampleDurationMs": 500,
    }
    base = {
        "clusteringThreshold": 0.75,
        "diarizationShiftMs": 0,
        "expectedSpeakerCount": None,
        "minDurationOn": 0.2,
        "minDurationOff": 0.5,
    }
    configurations = [
        {**base, "name": "production", "recoveryMode": "production"},
        {
            **base,
            "name": "guard",
            "recoveryMode": "novel-speaker-balanced-segment-guard",
        },
        {
            **base,
            "name": "anchor-conservative",
            "recoveryMode": "novel-speaker-balanced-segment-reassignment",
            "segmentAnchorOptions": anchor_defaults,
        },
        {
            **base,
            "name": "anchor-relaxed",
            "recoveryMode": "novel-speaker-balanced-segment-reassignment",
            "segmentAnchorOptions": {
                **anchor_defaults,
                "minimumSimilarity": 0.48,
                "minimumSampleDurationMs": 250,
            },
        },
    ]
    (HERE / f"{name}.config.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "name": name,
                "normalizedWavPath": f"media/{name}.wav",
                "annotationPath": f"{name}.annotation.json",
                "transcriptReferencePath": f"{name}.transcript-reference.json",
                "configurations": configurations,
            },
            indent=2,
        )
        + "\n",
    )
    print(f"{name}: {duration_ms} ms, {len(turns)} turns, {len(speakers)} speakers")


RAPID_TWO: list[Turn] = [
    ("Speaker A", "Alright, let's pick up where we left off on the rollout plan.", 400),
    ("Speaker B", "Sure. The staging cluster is ready.", 120),
    ("Speaker A", "Good.", 90),
    ("Speaker B", "But we still need sign off on the migration window.", 100),
    ("Speaker A", "Right, I sent that to operations yesterday.", 80),
    ("Speaker B", "Okay.", 70),
    ("Speaker A", "They want us to run it on Thursday night instead of Friday.", 150),
    ("Speaker B", "Thursday works.", 90),
    ("Speaker A", "Perfect.", 80),
    ("Speaker B", "What about the rollback script? Did anyone test it end to end?", 120),
    ("Speaker A", "I did, twice. It restores the snapshot in about four minutes.", 100),
    ("Speaker B", "Four minutes is fine.", 90),
    ("Speaker A", "Agreed.", 70),
    ("Speaker B", "Then I will update the checklist and notify the support team today.", 140),
    ("Speaker A", "Thanks. One more thing, the dashboard alerts were too noisy last week.", 160),
    ("Speaker B", "Yes.", 60),
    ("Speaker A", "Can you raise the paging threshold before the rollout?", 90),
    ("Speaker B", "I will raise it to five minutes sustained and post the change for review.", 110),
    ("Speaker A", "That closes everything on my list.", 150),
    ("Speaker B", "Same here. Talk tomorrow.", 120),
]

SIMILAR_PAIR: list[Turn] = [
    ("Speaker A", "Did the vendor send the revised contract this morning?", 400),
    ("Speaker B", "They did, and the payment terms finally match what we asked for.", 200),
    ("Speaker A", "Net forty five?", 100),
    ("Speaker B", "Net forty five, with the early payment discount intact.", 130),
    ("Speaker A", "Good. Legal still needs to check the liability clause.", 180),
    ("Speaker B", "I flagged it.", 80),
    ("Speaker A", "Okay.", 70),
    ("Speaker B", "Their limit is capped at the annual fee, which our counsel wanted doubled.", 140),
    ("Speaker A", "If they refuse the doubling, we should ask for a longer cure period instead.", 160),
    ("Speaker B", "That is a sensible fallback.", 110),
    ("Speaker A", "Yes.", 70),
    ("Speaker B", "I will draft both options and send them before the call on Wednesday.", 130),
    ("Speaker A", "Please copy the finance team when you do.", 120),
    ("Speaker B", "Will do.", 90),
    ("Speaker A", "Anything else pending from their side?", 140),
    ("Speaker B", "Just the insurance certificate, promised by Friday.", 120),
]

THREE_CLEAN: list[Turn] = [
    ("Speaker A", "Welcome back everyone. Today we are reviewing the quarterly numbers.", 500),
    ("Speaker B", "Revenue landed four percent above the forecast we set in April.", 600),
    ("Speaker C", "And support costs stayed flat even with the new customers onboarded.", 550),
    ("Speaker A", "That is better than I expected. What drove the revenue beat?", 500),
    ("Speaker B", "Mostly the enterprise renewals. Two accounts expanded their seats early.", 600),
    ("Speaker C", "The onboarding automation helped there. Setup time dropped by half.", 550),
    ("Speaker A", "Let's put both of those in the board summary as highlights.", 500),
    ("Speaker B", "I can draft the revenue section by Monday.", 450),
    ("Speaker C", "And I will add the support metrics with the charts from the dashboard.", 500),
    ("Speaker A", "Thank you both. We will review the draft together next week.", 550),
]


# Structured like the retained mixed-cluster recording: long clear turns
# build two stable clusters, then a rapid exchange that the segmenter is
# likely to glue into one mixed cluster, then clear turns again.
MIXED_CLUSTER: list[Turn] = [
    ("Speaker A", "Before we start, I want to walk through the incident timeline from last night, because the paging sequence matters for the postmortem.", 600),
    ("Speaker B", "Go ahead. I have the monitoring charts open on my side and can confirm each step as you describe it.", 550),
    ("Speaker A", "The first alert fired at eleven twenty, and the on-call engineer acknowledged it within two minutes, which is well inside our target.", 500),
    ("Speaker B", "Confirmed. The latency graph shows the spike beginning at eleven eighteen, so detection lagged reality by roughly two minutes.", 550),
    # Rapid exchange engineered to glue into a single mixed cluster.
    ("Speaker A", "Then the cache failed over.", 120),
    ("Speaker B", "Right, automatically.", 100),
    ("Speaker A", "And traffic recovered.", 110),
    ("Speaker B", "Within a minute.", 100),
    ("Speaker A", "Exactly.", 90),
    # Back to long, clearly separated turns.
    ("Speaker B", "The remaining question is why the failover took the cache node out of rotation permanently instead of returning it after the health check passed.", 700),
    ("Speaker A", "That is the part we need engineering to dig into this week, and I would like the findings written up before the review on Friday.", 600),
    ("Speaker B", "I will own that writeup and circulate a draft by Thursday afternoon so everyone has time to comment before the meeting.", 600),
]


def main() -> int:
    generate_scenario(
        "synthetic-rapid-two",
        {"Speaker A": ("Samantha", 185, 1.0), "Speaker B": ("Karen", 178, 0.86)},
        RAPID_TWO,
    )
    generate_scenario(
        "synthetic-similar-pair",
        {"Speaker A": ("Karen", 180, 1.0), "Speaker B": ("Tessa", 176, 0.9)},
        SIMILAR_PAIR,
        noise_amplitude=180,
    )
    generate_scenario(
        "synthetic-three-clean",
        {
            "Speaker A": ("Samantha", 180, 1.08),
            "Speaker B": ("Daniel", 175, 1.0),
            "Speaker C": ("Rishi", 172, 0.85),
        },
        THREE_CLEAN,
    )
    generate_scenario(
        "synthetic-mixed-cluster",
        {"Speaker A": ("Samantha", 182, 1.05), "Speaker B": ("Daniel", 174, 0.88)},
        MIXED_CLUSTER,
    )
    # Same conversation, but the rapid exchange (turns 4-8) is muffled and
    # noisy, aiming to detach those segments from both clean clusters into
    # one internally inconsistent cluster — the guard's precondition.
    generate_scenario(
        "synthetic-guarded-mix",
        {"Speaker A": ("Samantha", 182, 1.05), "Speaker B": ("Daniel", 174, 0.88)},
        MIXED_CLUSTER,
        degraded_turns=frozenset({4, 5, 6, 7, 8}),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
