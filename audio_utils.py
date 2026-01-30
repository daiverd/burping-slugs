"""Audio processing utilities using ffmpeg/ffprobe."""

import json
import subprocess
from pathlib import Path


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


def convert_to_cd_wav(input_path: Path, output_path: Path) -> bool:
    """Convert audio file to CD-compatible WAV format.

    CD audio requires: 44100Hz, 16-bit, stereo PCM.

    Args:
        input_path: Source audio file (any ffmpeg-supported format)
        output_path: Destination WAV file path

    Returns:
        True if conversion successful, False otherwise
    """
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",  # Overwrite output
                "-i", str(input_path),
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
