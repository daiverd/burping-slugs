"""CD detection and burning utilities using wodim."""

import re
import subprocess
from pathlib import Path

# Default CD capacity in seconds (80 minute disc)
DEFAULT_CAPACITY_SECONDS = 80 * 60


def get_cd_capacity(device: str = "/dev/sr0") -> int | None:
    """Get CD capacity in seconds by reading ATIP info.

    Args:
        device: CD device path

    Returns:
        Capacity in seconds, or None if no disc/device
    """
    try:
        result = subprocess.run(
            ["wodim", f"dev={device}", "-atip"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        # Parse output for lead-out time (indicates disc capacity)
        # Format: "ATIP start of lead out: 359849 (79:57/74)"
        # The time in parentheses is MM:SS/frames
        for line in result.stdout.split("\n"):
            if "ATIP start of lead out" in line:
                match = re.search(r"\((\d+):(\d+)/\d+\)", line)
                if match:
                    minutes = int(match.group(1))
                    seconds = int(match.group(2))
                    return minutes * 60 + seconds

        # Also check stderr (wodim outputs there too)
        for line in result.stderr.split("\n"):
            if "ATIP start of lead out" in line:
                match = re.search(r"\((\d+):(\d+)/\d+\)", line)
                if match:
                    minutes = int(match.group(1))
                    seconds = int(match.group(2))
                    return minutes * 60 + seconds

        return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def burn_cd(
    wav_files: list[Path],
    device: str = "/dev/sr0",
    dummy: bool = False,
    gaps: bool = True,
):
    """Burn WAV files to audio CD.

    Generator that yields progress updates and final result.

    Args:
        wav_files: List of WAV file paths in track order
        device: CD device path
        dummy: If True, perform dry run without actually burning
        gaps: If True, use 2-second gaps between tracks (default). If False, no gaps.

    Yields:
        ("progress", track_num, percent, message) for progress updates
        ("result", success, message) as final yield
    """
    if not wav_files:
        yield ("result", False, "No tracks to burn")
        return

    # Build wodim command
    cmd = [
        "wodim",
        f"dev={device}",
        "-v",         # Verbose
        "-audio",     # Audio mode
        "-pad",       # Pad tracks to sector boundary
        "speed=4",    # Burn speed
    ]

    if dummy:
        cmd.append("-dummy")  # Dry run

    # Add tracks with optional pregap control
    for i, wav_file in enumerate(wav_files):
        if not gaps and i > 0:
            # No pregap for tracks after the first (track 1 always has standard lead-in)
            cmd.append("pregap=0")
        cmd.append(str(wav_file))

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,  # Line buffered
        )

        current_track = 0
        total_tracks = len(wav_files)
        output_lines = []  # Capture output for error reporting

        for line in iter(process.stdout.readline, ""):
            line = line.strip()
            output_lines.append(line)

            # Track progress: "Track 01:    5 of   45 MB written (fifo 100%) [buf  99%]   4.0x."
            track_match = re.search(r"Track\s+(\d+):\s+(\d+)\s+of\s+(\d+)\s+MB", line)
            if track_match:
                track_num = int(track_match.group(1))
                written_mb = int(track_match.group(2))
                total_mb = int(track_match.group(3))

                if track_num != current_track:
                    current_track = track_num
                    yield ("progress", current_track, 0, f"Burning track {current_track} of {total_tracks}")

                if total_mb > 0:
                    percent = min(100, int(written_mb * 100 / total_mb))
                    yield ("progress", current_track, percent, f"Burning track {current_track} of {total_tracks}")

            # Fixating: "Fixating..."
            if "Fixating" in line:
                yield ("progress", total_tracks, 100, "Fixating disc...")

        process.wait()

        if process.returncode == 0:
            # Eject disc after successful burn (not in dummy mode)
            if not dummy:
                try:
                    subprocess.run(["eject", device], timeout=30)
                except Exception:
                    pass  # Eject failure is not critical
            yield ("result", True, "Burn completed successfully")
        else:
            # Find error lines (wodim prefixes errors with "wodim:")
            error_lines = [l for l in output_lines if l.startswith("wodim:") or "Cannot" in l or "error" in l.lower()]
            error_detail = "; ".join(error_lines[-3:]) if error_lines else "unknown error"
            yield ("result", False, f"Burn failed (exit {process.returncode}): {error_detail}")

    except FileNotFoundError:
        yield ("result", False, "wodim not found - please install cdrecord/wodim")
    except Exception as e:
        yield ("result", False, f"Burn failed: {str(e)}")
