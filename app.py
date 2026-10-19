"""Audio CD Burner - Flask web application."""

import json
import os
import random
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file

from audio_utils import (
    convert_to_cd_wav,
    convert_to_mp3,
    get_duration,
    get_file_size,
    get_mp3_bitrate,
    is_mp3,
    normalize_mp3,
)
from cd_utils import (
    DEFAULT_CAPACITY_SECONDS,
    DEFAULT_DATA_CAPACITY_MB,
    burn_cd,
    burn_mp3_cd,
    get_cd_capacity,
    get_data_cd_capacity,
)
from url_downloader import (
    DownloadJob,
    JobStatus,
    cleanup_job,
    get_job,
    parse_urls,
    start_download,
)

app = Flask(__name__)

# XDG data directory for persistence
XDG_DATA_HOME = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
DATA_DIR = Path(XDG_DATA_HOME) / "burping-slugs"
FILES_DIR = DATA_DIR / "files"
CACHE_DIR = DATA_DIR / "cache"
WAV_DIR = DATA_DIR / "wav"    # Converted WAV files for audio CD
MP3_DIR = DATA_DIR / "mp3"    # Converted MP3 files for MP3 CD
PLAYLIST_FILE = DATA_DIR / "playlist.json"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
WAV_DIR.mkdir(parents=True, exist_ok=True)
MP3_DIR.mkdir(parents=True, exist_ok=True)

# In-memory track storage (loaded from disk on startup)
tracks: list[dict] = []
cd_type: str = "audio"  # "audio" or "mp3"

# Playlist schema version
PLAYLIST_VERSION = 1


def load_playlist() -> None:
    """Load playlist from disk on startup."""
    global tracks, cd_type
    if not PLAYLIST_FILE.exists():
        tracks = []
        cd_type = "audio"
        return

    try:
        with open(PLAYLIST_FILE) as f:
            data = json.load(f)

        if data.get("version") != PLAYLIST_VERSION:
            # Future: handle migrations
            tracks = []
            cd_type = "audio"
            return

        loaded_tracks = []
        for t in data.get("tracks", []):
            filepath = FILES_DIR / t["filename"]
            if filepath.exists():
                loaded_tracks.append({
                    "id": t["id"],
                    "name": t["name"],
                    "duration": t["duration"],
                    "filepath": str(filepath),
                    "source_url": t.get("source_url"),
                    "folder": t.get("folder", ""),
                    "size": t.get("size", get_file_size(filepath)),
                })
        tracks = loaded_tracks
        cd_type = data.get("cd_type", "audio")
    except (json.JSONDecodeError, OSError, KeyError):
        tracks = []
        cd_type = "audio"


def save_playlist() -> None:
    """Save playlist to disk."""
    data = {
        "version": PLAYLIST_VERSION,
        "cd_type": cd_type,
        "tracks": [
            {
                "id": t["id"],
                "name": t["name"],
                "duration": t["duration"],
                "filename": Path(t["filepath"]).name,
                "source_url": t.get("source_url"),
                "folder": t.get("folder", ""),
                "size": t.get("size", 0),
            }
            for t in tracks
        ],
    }
    with open(PLAYLIST_FILE, "w") as f:
        json.dump(data, f, indent=2)


def sse_event(data: dict, event: str = None) -> str:
    """Format data as SSE event."""
    lines = []
    if event:
        lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines)


# Load playlist on startup
load_playlist()



@app.route("/")
def index():
    """Serve main page."""
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    """Handle file uploads. Returns list of track info."""
    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    new_tracks = []

    # Parse paths JSON if provided (for folder uploads)
    paths_json = request.form.get("paths", "[]")
    try:
        paths = json.loads(paths_json)
    except json.JSONDecodeError:
        paths = []

    for i, file in enumerate(files):
        if not file.filename:
            continue

        # Generate unique ID and save file
        track_id = str(uuid.uuid4())
        ext = Path(file.filename).suffix or ".audio"
        filepath = FILES_DIR / f"{track_id}{ext}"
        file.save(filepath)

        # Get duration
        duration = get_duration(filepath)
        if duration is None:
            filepath.unlink()  # Remove invalid file
            continue

        # Get file size
        size = get_file_size(filepath)

        # Determine folder from relative path
        folder = ""
        if i < len(paths) and paths[i]:
            rel_path = paths[i]
            # Folder is everything except the filename
            folder_path = Path(rel_path).parent
            if folder_path != Path("."):
                folder = str(folder_path)

        track = {
            "id": track_id,
            "name": file.filename,
            "duration": duration,
            "filepath": str(filepath),
            "source_url": None,
            "folder": folder,
            "size": size,
        }
        tracks.append(track)
        new_tracks.append({
            "id": track_id,
            "name": file.filename,
            "duration": duration,
            "folder": folder,
            "size": size,
        })

    if new_tracks:
        save_playlist()

    return jsonify({"tracks": new_tracks})


@app.route("/tracks", methods=["GET"])
def get_tracks():
    """Get current track list."""
    return jsonify({
        "cd_type": cd_type,
        "tracks": [
            {
                "id": t["id"],
                "name": t["name"],
                "duration": t["duration"],
                "folder": t.get("folder", ""),
                "size": t.get("size", 0),
            }
            for t in tracks
        ]
    })


@app.route("/track/<track_id>", methods=["DELETE"])
def delete_track(track_id):
    """Remove a track from the queue."""
    global tracks
    for i, track in enumerate(tracks):
        if track["id"] == track_id:
            # Remove original file
            filepath = Path(track["filepath"])
            if filepath.exists():
                filepath.unlink()
            # Remove cached WAV conversion
            wav_path = WAV_DIR / f"{track_id}.wav"
            if wav_path.exists():
                wav_path.unlink()
            # Remove cached MP3 conversion
            mp3_path = MP3_DIR / f"{track_id}.mp3"
            if mp3_path.exists():
                mp3_path.unlink()
            # Remove from list
            tracks.pop(i)
            save_playlist()
            return jsonify({"success": True})

    return jsonify({"error": "Track not found"}), 404


@app.route("/reorder", methods=["POST"])
def reorder():
    """Update track order."""
    global tracks
    data = request.get_json()
    if not data or "order" not in data:
        return jsonify({"error": "Missing order"}), 400

    new_order = data["order"]  # List of track IDs in new order

    # Build new track list maintaining order
    track_map = {t["id"]: t for t in tracks}
    new_tracks = []
    for track_id in new_order:
        if track_id in track_map:
            new_tracks.append(track_map[track_id])

    tracks = new_tracks
    save_playlist()
    return jsonify({"success": True})


@app.route("/cd-type", methods=["POST"])
def set_cd_type():
    """Set CD type (audio or mp3)."""
    global cd_type
    data = request.get_json()
    if not data or "cd_type" not in data:
        return jsonify({"error": "Missing cd_type"}), 400

    new_type = data["cd_type"]
    if new_type not in ("audio", "mp3"):
        return jsonify({"error": "Invalid cd_type"}), 400

    cd_type = new_type
    save_playlist()
    return jsonify({"success": True, "cd_type": cd_type})


@app.route("/randomize", methods=["POST"])
def randomize():
    """Shuffle track order."""
    global tracks
    random.shuffle(tracks)
    save_playlist()
    return jsonify({
        "tracks": [
            {
                "id": t["id"],
                "name": t["name"],
                "duration": t["duration"],
                "folder": t.get("folder", ""),
                "size": t.get("size", 0),
            }
            for t in tracks
        ]
    })


@app.route("/clear", methods=["POST"])
def clear_all():
    """Remove all tracks and their files."""
    global tracks
    # Remove original files
    for track in tracks:
        filepath = Path(track["filepath"])
        if filepath.exists():
            filepath.unlink()
    # Clear WAV cache directory
    for wav_file in WAV_DIR.iterdir():
        if wav_file.is_file():
            wav_file.unlink()
    # Clear MP3 cache directory
    for mp3_file in MP3_DIR.iterdir():
        if mp3_file.is_file():
            mp3_file.unlink()
    tracks = []
    save_playlist()
    return jsonify({"success": True})


@app.route("/audio/<track_id>")
def serve_audio(track_id):
    """Serve audio file for playback or download."""
    download = request.args.get("download", "false").lower() == "true"

    for track in tracks:
        if track["id"] == track_id:
            filepath = Path(track["filepath"])
            if filepath.exists():
                if download:
                    # Build download name from track name + original extension
                    ext = filepath.suffix
                    download_name = track["name"]
                    if not download_name.lower().endswith(ext.lower()):
                        download_name += ext
                    return send_file(filepath, as_attachment=True, download_name=download_name)
                return send_file(filepath)
            break
    return jsonify({"error": "Track not found"}), 404


@app.route("/cd-info", methods=["GET"])
def cd_info():
    """Get CD capacity info."""
    capacity = get_cd_capacity()
    data_capacity = get_data_cd_capacity()
    return jsonify({
        "capacity": capacity,  # None if no disc (seconds)
        "default_capacity": DEFAULT_CAPACITY_SECONDS,
        "data_capacity": data_capacity,  # None if no disc (MB)
        "default_data_capacity": DEFAULT_DATA_CAPACITY_MB,
    })


@app.route("/download", methods=["POST"])
def download():
    """Start downloading URLs. Returns job IDs."""
    data = request.get_json()
    if not data or "text" not in data:
        return jsonify({"error": "Missing text"}), 400

    urls = parse_urls(data["text"])
    if not urls:
        return jsonify({"error": "No URLs found"}), 400

    jobs = []

    def on_complete(job: DownloadJob):
        """Called when a download job completes."""
        if job.status == JobStatus.COMPLETE and job.result:
            # Copy file from cache to files dir
            result = job.result
            track_id = str(uuid.uuid4())
            ext = result.filepath.suffix
            dest_path = FILES_DIR / f"{track_id}{ext}"
            shutil.copy2(result.filepath, dest_path)

            track = {
                "id": track_id,
                "name": result.title,
                "duration": result.duration,
                "filepath": str(dest_path),
                "source_url": result.source_url,
                "folder": "",  # Downloads don't have folder structure
                "size": get_file_size(dest_path),
            }
            tracks.append(track)
            save_playlist()

    for url in urls:
        job_id = start_download(url, CACHE_DIR, on_complete=on_complete)
        jobs.append({"id": job_id, "url": url})

    return jsonify({"jobs": jobs})


@app.route("/download-progress")
def download_progress():
    """SSE stream for download progress."""
    ids = request.args.get("ids", "").split(",")
    ids = [i.strip() for i in ids if i.strip()]

    if not ids:
        return jsonify({"error": "No job IDs provided"}), 400

    def generate():
        pending = set(ids)

        while pending:
            for job_id in list(pending):
                job = get_job(job_id)
                if job is None:
                    # Job not found, remove from pending
                    pending.discard(job_id)
                    yield sse_event({
                        "id": job_id,
                        "status": "not_found",
                    }, "update")
                    continue

                yield sse_event({
                    "id": job.id,
                    "url": job.url,
                    "status": job.status.value,
                    "progress": job.progress,
                    "message": job.message,
                    "error": job.error,
                    "result": {
                        "title": job.result.title,
                        "duration": job.result.duration,
                    } if job.result else None,
                }, "update")

                if job.status in (JobStatus.COMPLETE, JobStatus.FAILED):
                    pending.discard(job_id)
                    cleanup_job(job_id)

            if pending:
                time.sleep(0.5)

        yield sse_event({"done": True}, "complete")

    return Response(generate(), mimetype="text/event-stream")


@app.route("/job/<job_id>")
def job_status(job_id):
    """Get single job status (polling fallback)."""
    job = get_job(job_id)
    if job is None:
        return jsonify({"error": "Job not found"}), 404

    return jsonify({
        "id": job.id,
        "url": job.url,
        "status": job.status.value,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "result": {
            "title": job.result.title,
            "duration": job.result.duration,
        } if job.result else None,
    })


def _strip_leading_numbers(name: str) -> str:
    """Strip leading numbers and separators from a filename/folder name.

    Examples:
        "01_Song.mp3" -> "Song.mp3"
        "01 - Artist" -> "Artist"
        "Track 01.mp3" -> "Track 01.mp3" (doesn't start with number)
    """
    import re
    # Match leading digits followed by optional separator (space, dash, underscore, dot)
    return re.sub(r"^\d+[\s._-]*", "", name)


def _build_mp3_staging_dir(staging_path: Path):
    """Build staging directory with numbered folders and files.

    Creates directory structure like:
        01_Artist1/01_Album1/01_Song1.mp3
        01_Artist1/02_Album2/01_Song2.mp3
        02_Artist2/01_Album1/01_Song3.mp3
        03_Song.mp3 (root-level files)

    Yields:
        (track_index, track_name, dest_path) for progress reporting
    """
    # Track numbering at each folder level
    # Key: parent path (e.g., "" for root, "Artist1" for first level)
    # Value: dict mapping folder name -> assigned number
    level_numbers: dict[str, dict[str, int]] = {}
    level_next_num: dict[str, int] = {}  # next number to assign at each level

    # Track file counts within each full folder path
    folder_file_counts: dict[str, int] = {}
    next_root_num = 1  # for files without folders

    staging_path.mkdir(parents=True, exist_ok=True)

    def get_numbered_path(folder_path: str) -> Path:
        """Convert folder path to numbered path, assigning numbers as needed."""
        if not folder_path:
            return staging_path

        parts = Path(folder_path).parts
        numbered_parts = []
        current_parent = ""

        for part in parts:
            # Initialize tracking for this level if needed
            if current_parent not in level_numbers:
                level_numbers[current_parent] = {}
                level_next_num[current_parent] = 1

            # Assign number to this folder if not already assigned
            if part not in level_numbers[current_parent]:
                level_numbers[current_parent][part] = level_next_num[current_parent]
                level_next_num[current_parent] += 1

            num = level_numbers[current_parent][part]
            numbered_part = f"{num:02d}_{_strip_leading_numbers(part)}"
            numbered_parts.append(numbered_part)

            # Update parent path for next level
            if current_parent:
                current_parent = current_parent + "/" + part
            else:
                current_parent = part

        return staging_path.joinpath(*numbered_parts)

    for i, track in enumerate(tracks):
        original_folder = track.get("folder", "")
        original_name = track["name"]

        if original_folder:
            # Get numbered folder path
            numbered_folder_path = get_numbered_path(original_folder)

            # Track file count within this folder
            if original_folder not in folder_file_counts:
                folder_file_counts[original_folder] = 0
            folder_file_counts[original_folder] += 1
            file_num = folder_file_counts[original_folder]

            numbered_file = f"{file_num:02d}_{_strip_leading_numbers(original_name)}"

            # Ensure .mp3 extension
            if not numbered_file.lower().endswith(".mp3"):
                numbered_file = Path(numbered_file).stem + ".mp3"

            dest = numbered_folder_path / numbered_file
            dest.parent.mkdir(parents=True, exist_ok=True)
        else:
            numbered_file = f"{next_root_num:02d}_{_strip_leading_numbers(original_name)}"
            next_root_num += 1

            if not numbered_file.lower().endswith(".mp3"):
                numbered_file = Path(numbered_file).stem + ".mp3"

            dest = staging_path / numbered_file

        yield (i, original_name, dest)


@app.route("/burn", methods=["GET"])
def burn():
    """Burn CD with SSE progress updates."""
    dummy = request.args.get("dummy", "false").lower() == "true"
    gaps = request.args.get("gaps", "true").lower() == "true"
    cd_type = request.args.get("cd_type", "audio")  # "audio" or "mp3"

    def generate():
        if not tracks:
            yield sse_event({"success": False, "message": "No tracks to burn"}, "complete")
            return

        if cd_type == "mp3":
            # MP3 CD burn
            yield from _burn_mp3_cd(dummy)
        else:
            # Audio CD burn (original behavior)
            yield from _burn_audio_cd(dummy, gaps)

    return Response(generate(), mimetype="text/event-stream")


def _burn_audio_cd(dummy: bool, gaps: bool):
    """Generator for audio CD burn process."""
    wav_files = []

    # Convert all tracks to CD-compatible WAV (cached by track ID)
    for i, track in enumerate(tracks):
        track_num = i + 1
        track_id = track["id"]
        input_path = Path(track["filepath"])
        output_path = WAV_DIR / f"{track_id}.wav"

        # Check if cached WAV already exists
        if output_path.exists():
            yield sse_event({
                "track": track_num,
                "percent": 100,
                "status": "converting",
                "message": f"Using cached WAV for track {track_num}: {track['name']}",
            }, "progress")
        else:
            yield sse_event({
                "track": track_num,
                "percent": 0,
                "status": "converting",
                "message": f"Converting track {track_num} of {len(tracks)}: {track['name']}",
            }, "progress")

            success = convert_to_cd_wav(input_path, output_path)
            if not success:
                yield sse_event({
                    "success": False,
                    "message": f"Failed to convert track {track_num}: {track['name']}",
                }, "complete")
                return

            yield sse_event({
                "track": track_num,
                "percent": 100,
                "status": "converting",
                "message": f"Converted track {track_num} of {len(tracks)}",
            }, "progress")

        wav_files.append(output_path)

    # Burn to disc - iterate over generator for real-time progress
    for update in burn_cd(wav_files, dummy=dummy, gaps=gaps):
        if update[0] == "progress":
            _, track, percent, message = update
            yield sse_event({
                "track": track,
                "percent": percent,
                "status": "burning",
                "message": message,
            }, "progress")
        elif update[0] == "result":
            _, success, message = update
            yield sse_event({
                "success": success,
                "message": message,
            }, "complete")


def _burn_mp3_cd(dummy: bool):
    """Generator for MP3 CD burn process."""
    # Step 1: Ensure all tracks are cached as normalized MP3s
    for i, track in enumerate(tracks):
        track_num = i + 1
        track_id = track["id"]
        input_path = Path(track["filepath"])
        cache_path = MP3_DIR / f"{track_id}.mp3"

        # Check if cached MP3 already exists
        if cache_path.exists():
            yield sse_event({
                "track": track_num,
                "percent": 100,
                "status": "converting",
                "message": f"Using cached MP3 for track {track_num}: {track['name']}",
            }, "progress")
            continue

        yield sse_event({
            "track": track_num,
            "percent": 0,
            "status": "converting",
            "message": f"Processing track {track_num} of {len(tracks)}: {track['name']}",
        }, "progress")

        # Determine processing needed
        if is_mp3(input_path):
            bitrate = get_mp3_bitrate(input_path)
            if bitrate is not None and bitrate <= 192:
                # Already low-bitrate MP3: normalize only
                success = normalize_mp3(input_path, cache_path)
            else:
                # High-bitrate MP3: re-encode to VBR Q2 + normalize
                success = convert_to_mp3(input_path, cache_path, normalize=True)
        else:
            # Not MP3: convert to MP3 VBR Q2 + normalize
            success = convert_to_mp3(input_path, cache_path, normalize=True)

        if not success:
            yield sse_event({
                "success": False,
                "message": f"Failed to process track {track_num}: {track['name']}",
            }, "complete")
            return

        yield sse_event({
            "track": track_num,
            "percent": 100,
            "status": "converting",
            "message": f"Processed track {track_num} of {len(tracks)}",
        }, "progress")

    # Step 2: Create temporary staging directory with numbered structure
    staging_dir = Path(tempfile.mkdtemp(prefix="cd-burner-mp3-"))

    try:
        # Build staging directory by copying from cache with proper names
        for track_idx, track_name, dest_path in _build_mp3_staging_dir(staging_dir):
            track = tracks[track_idx]
            cache_path = MP3_DIR / f"{track['id']}.mp3"
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_path, dest_path)

        # Burn to disc
        for update in burn_mp3_cd(staging_dir, dummy=dummy):
            if update[0] == "progress":
                _, stage, percent, message = update
                yield sse_event({
                    "track": stage,
                    "percent": percent,
                    "status": "burning",
                    "message": message,
                }, "progress")
            elif update[0] == "result":
                _, success, message = update
                yield sse_event({
                    "success": success,
                    "message": message,
                }, "complete")

    finally:
        # Clean up staging directory (keep MP3 cache)
        shutil.rmtree(staging_dir, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3379, debug=True, use_reloader=False)
