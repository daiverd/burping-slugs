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

from audio_utils import convert_to_cd_wav, get_duration
from cd_utils import DEFAULT_CAPACITY_SECONDS, burn_cd, get_cd_capacity
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
PLAYLIST_FILE = DATA_DIR / "playlist.json"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Temporary directory for WAV conversion (not persisted)
wav_dir = Path(tempfile.mkdtemp(prefix="cd-burner-wav-"))

# In-memory track storage (loaded from disk on startup)
tracks: list[dict] = []

# Playlist schema version
PLAYLIST_VERSION = 1


def load_playlist() -> None:
    """Load playlist from disk on startup."""
    global tracks
    if not PLAYLIST_FILE.exists():
        tracks = []
        return

    try:
        with open(PLAYLIST_FILE) as f:
            data = json.load(f)

        if data.get("version") != PLAYLIST_VERSION:
            # Future: handle migrations
            tracks = []
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
                })
        tracks = loaded_tracks
    except (json.JSONDecodeError, OSError, KeyError):
        tracks = []


def save_playlist() -> None:
    """Save playlist to disk."""
    data = {
        "version": PLAYLIST_VERSION,
        "tracks": [
            {
                "id": t["id"],
                "name": t["name"],
                "duration": t["duration"],
                "filename": Path(t["filepath"]).name,
                "source_url": t.get("source_url"),
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

    for file in files:
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

        track = {
            "id": track_id,
            "name": file.filename,
            "duration": duration,
            "filepath": str(filepath),
            "source_url": None,
        }
        tracks.append(track)
        new_tracks.append({
            "id": track_id,
            "name": file.filename,
            "duration": duration,
        })

    if new_tracks:
        save_playlist()

    return jsonify({"tracks": new_tracks})


@app.route("/tracks", methods=["GET"])
def get_tracks():
    """Get current track list."""
    return jsonify({
        "tracks": [
            {"id": t["id"], "name": t["name"], "duration": t["duration"]}
            for t in tracks
        ]
    })


@app.route("/track/<track_id>", methods=["DELETE"])
def delete_track(track_id):
    """Remove a track from the queue."""
    global tracks
    for i, track in enumerate(tracks):
        if track["id"] == track_id:
            # Remove file
            filepath = Path(track["filepath"])
            if filepath.exists():
                filepath.unlink()
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


@app.route("/randomize", methods=["POST"])
def randomize():
    """Shuffle track order."""
    global tracks
    random.shuffle(tracks)
    save_playlist()
    return jsonify({
        "tracks": [
            {"id": t["id"], "name": t["name"], "duration": t["duration"]}
            for t in tracks
        ]
    })


@app.route("/clear", methods=["POST"])
def clear_all():
    """Remove all tracks and their files."""
    global tracks
    for track in tracks:
        filepath = Path(track["filepath"])
        if filepath.exists():
            filepath.unlink()
    tracks = []
    save_playlist()
    return jsonify({"success": True})


@app.route("/audio/<track_id>")
def serve_audio(track_id):
    """Serve audio file for playback."""
    for track in tracks:
        if track["id"] == track_id:
            filepath = Path(track["filepath"])
            if filepath.exists():
                return send_file(filepath)
            break
    return jsonify({"error": "Track not found"}), 404


@app.route("/cd-info", methods=["GET"])
def cd_info():
    """Get CD capacity info."""
    capacity = get_cd_capacity()
    return jsonify({
        "capacity": capacity,  # None if no disc
        "default_capacity": DEFAULT_CAPACITY_SECONDS,
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


@app.route("/burn", methods=["GET"])
def burn():
    """Burn CD with SSE progress updates."""
    dummy = request.args.get("dummy", "false").lower() == "true"
    gaps = request.args.get("gaps", "true").lower() == "true"

    def generate():
        if not tracks:
            yield sse_event({"success": False, "message": "No tracks to burn"}, "complete")
            return

        wav_files = []

        # Convert all tracks to CD-compatible WAV
        for i, track in enumerate(tracks):
            track_num = i + 1
            yield sse_event({
                "track": track_num,
                "percent": 0,
                "status": "converting",
                "message": f"Converting track {track_num} of {len(tracks)}: {track['name']}",
            }, "progress")

            input_path = Path(track["filepath"])
            output_path = wav_dir / f"track_{track_num:02d}.wav"

            success = convert_to_cd_wav(input_path, output_path)
            if not success:
                yield sse_event({
                    "success": False,
                    "message": f"Failed to convert track {track_num}: {track['name']}",
                }, "complete")
                return

            wav_files.append(output_path)

            yield sse_event({
                "track": track_num,
                "percent": 100,
                "status": "converting",
                "message": f"Converted track {track_num} of {len(tracks)}",
            }, "progress")

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

        # Clean up WAV files
        for wav_file in wav_files:
            if wav_file.exists():
                wav_file.unlink()

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3379, debug=True, use_reloader=False)
