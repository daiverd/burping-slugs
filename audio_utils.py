"""Audio processing utilities using ffmpeg/ffprobe."""

import json
import re
import subprocess
from pathlib import Path

# Normalization targets (EBU R128)
TARGET_LUFS = -14.0  # Integrated loudness target (typical for music)
TARGET_TP = -1.0     # True peak limit (prevents intersample clipping)
TARGET_LRA = 11.0    # Loudness range


def get_duration(filepath: Path) -> float | None:
    """Get audio duration in seconds using ffprobe.

    Args:
        filepath: Path to audio file

    Returns:
        Duration in seconds, or None if unable to determine
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                str(filepath),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None

        data = json.loads(result.stdout)
        duration_str = data.get("format", {}).get("duration")
        if duration_str:
            return float(duration_str)
        return None
    except (subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, FileNotFoundError):
        return None


def _analyze_loudness(input_path: Path) -> dict | None:
    """Analyze audio loudness using ffmpeg loudnorm filter (pass 1).

    Args:
        input_path: Source audio file

    Returns:
        Dict with measured values, or None on failure
    """
    af_filter = f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json"

    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-i", str(input_path),
                "-af", af_filter,
                "-f", "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )

        # loudnorm outputs JSON to stderr after processing
        # Find the JSON block in stderr
        stderr = result.stderr
        json_match = re.search(r'\{[^{}]*"input_i"[^{}]*\}', stderr, re.DOTALL)
        if not json_match:
            return None

        return json.loads(json_match.group())
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return None


def convert_to_cd_wav(input_path: Path, output_path: Path, normalize: bool = True) -> bool:
    """Convert audio file to CD-compatible WAV format with normalization.

    CD audio requires: 44100Hz, 16-bit, stereo PCM.
    Uses two-pass EBU R128 loudness normalization for consistent volume.

    Args:
        input_path: Source audio file (any ffmpeg-supported format)
        output_path: Destination WAV file path
        normalize: If True, apply loudness normalization (default True)

    Returns:
        True if conversion successful, False otherwise
    """
    try:
        if normalize:
            # Pass 1: Analyze loudness
            measurements = _analyze_loudness(input_path)
            if measurements is None:
                # Fall back to no normalization if analysis fails
                normalize = False

        if normalize:
            # Pass 2: Normalize with measured values
            af_filter = (
                f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
                f":measured_I={measurements['input_i']}"
                f":measured_TP={measurements['input_tp']}"
                f":measured_LRA={measurements['input_lra']}"
                f":measured_thresh={measurements['input_thresh']}"
                f":offset={measurements['target_offset']}"
                f":linear=true"
            )
            af_args = ["-af", af_filter]
        else:
            af_args = []

        result = subprocess.run(
            [
                "ffmpeg",
                "-y",  # Overwrite output
                "-i", str(input_path),
                *af_args,
                "-ar", "44100",      # Sample rate
                "-ac", "2",          # Stereo
                "-sample_fmt", "s16",  # 16-bit signed
                "-f", "wav",
                str(output_path),
            ],
            capture_output=True,
            text=True,
            timeout=300,  # 5 minutes max for large files
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
