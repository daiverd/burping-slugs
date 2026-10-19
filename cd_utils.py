"""CD detection and burning utilities using wodim."""

import re
import subprocess
from pathlib import Path

# Default CD capacity in seconds (80 minute disc)
DEFAULT_CAPACITY_SECONDS = 80 * 60

# Default data CD capacity in MB (700 MB disc)
DEFAULT_DATA_CAPACITY_MB = 700


def get_cd_capacity(device: str = "/dev/sr0") -> int | None:
    """Get CD capacity in seconds by reading ATIP info.

    If a non-writable disc is detected (already burned/finalized),
    it will be ejected automatically.

    Args:
        device: CD device path

    Returns:
        Capacity in seconds, or None if no disc/device/not writable
    """
    try:
        result = subprocess.run(
            ["wodim", f"dev={device}", "-atip"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        output = result.stdout + result.stderr

        # Check if disc is writable (incomplete = blank/appendable)
        # "Disc status: incomplete" means writable
        # "Disc status: complete" means finalized/not writable
        if "Disc status: complete" in output:
            # Eject non-writable disc
            try:
                subprocess.run(["eject", device], timeout=30)
            except Exception:
                pass
            return None

        # Parse output for lead-out time (indicates disc capacity)
        # Format: "ATIP start of lead out: 359849 (79:57/74)"
        # The time in parentheses is MM:SS/frames
        for line in output.split("\n"):
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


def get_data_cd_capacity(device: str = "/dev/sr0") -> int | None:
    """Get data CD capacity in MB by reading ATIP info.

    Args:
        device: CD device path

    Returns:
        Capacity in MB, or None if no disc/device
    """
    try:
        result = subprocess.run(
            ["wodim", f"dev={device}", "-atip"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        output = result.stdout + result.stderr

        # Check if disc is writable
        if "Disc status: complete" in output:
            return None

        # Parse for capacity - look for lead-out in sectors
        # "ATIP start of lead out: 359849" - sectors * 2048 bytes / 1024^2 = MB
        for line in output.split("\n"):
            if "ATIP start of lead out" in line:
                match = re.search(r"ATIP start of lead out:\s*(\d+)", line)
                if match:
                    sectors = int(match.group(1))
                    # Each sector is 2048 bytes for data CD
                    return (sectors * 2048) // (1024 * 1024)

        return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def burn_mp3_cd(
    staging_dir: Path,
    device: str = "/dev/sr0",
    dummy: bool = False,
):
    """Burn MP3 files to data CD using genisoimage and wodim.

    Generator that yields progress updates and final result.

    Args:
        staging_dir: Directory containing the organized MP3 files
        device: CD device path
        dummy: If True, perform dry run without actually burning

    Yields:
        ("progress", stage, percent, message) for progress updates
        ("result", success, message) as final yield
    """
    import tempfile

    iso_path = Path(tempfile.mktemp(suffix=".iso", prefix="mp3cd-"))

    try:
        # Stage 1: Create ISO image
        yield ("progress", 1, 0, "Creating ISO image...")

        iso_cmd = [
            "genisoimage",
            "-r",              # Rock Ridge extensions
            "-J",              # Joliet extensions (Windows compatibility)
            "-joliet-long",    # Allow longer filenames in Joliet
            "-o", str(iso_path),
            str(staging_dir),
        ]

        result = subprocess.run(
            iso_cmd,
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else "unknown error"
            yield ("result", False, f"Failed to create ISO: {error_msg}")
            return

        yield ("progress", 1, 100, "ISO image created")

        # Stage 2: Burn ISO to disc
        yield ("progress", 2, 0, "Burning to disc...")

        burn_cmd = [
            "wodim",
            f"dev={device}",
            "-v",
            "-data",
            "speed=4",
        ]

        if dummy:
            burn_cmd.append("-dummy")

        burn_cmd.append(str(iso_path))

        process = subprocess.Popen(
            burn_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        output_lines = []

        for line in iter(process.stdout.readline, ""):
            line = line.strip()
            output_lines.append(line)

            # Parse progress: "Track 01:    5 of   45 MB written"
            track_match = re.search(r"Track\s+\d+:\s+(\d+)\s+of\s+(\d+)\s+MB", line)
            if track_match:
                written_mb = int(track_match.group(1))
                total_mb = int(track_match.group(2))
                if total_mb > 0:
                    percent = min(100, int(written_mb * 100 / total_mb))
                    yield ("progress", 2, percent, f"Writing: {written_mb} / {total_mb} MB")

            if "Fixating" in line:
                yield ("progress", 2, 100, "Fixating disc...")

        process.wait()

        if process.returncode == 0:
            # Eject disc after successful burn
            if not dummy:
                try:
                    subprocess.run(["eject", device], timeout=30)
                except Exception:
                    pass
            yield ("result", True, "MP3 CD burn completed successfully")
        else:
            error_lines = [l for l in output_lines if l.startswith("wodim:") or "error" in l.lower()]
            error_detail = "; ".join(error_lines[-3:]) if error_lines else "unknown error"
            yield ("result", False, f"Burn failed (exit {process.returncode}): {error_detail}")

    except FileNotFoundError as e:
        if "genisoimage" in str(e):
            yield ("result", False, "genisoimage not found - please install genisoimage")
        else:
            yield ("result", False, "wodim not found - please install cdrecord/wodim")
    except subprocess.TimeoutExpired:
        yield ("result", False, "Burn timed out")
    except Exception as e:
        yield ("result", False, f"Burn failed: {str(e)}")
    finally:
        # Clean up ISO file
        if iso_path.exists():
            iso_path.unlink()
