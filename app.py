"""Audio CD Burner - Flask web application."""

import json
import random
import tempfile
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request

from audio_utils import convert_to_cd_wav, get_duration
from cd_utils import DEFAULT_CAPACITY_SECONDS, burn_cd, get_cd_capacity

app = Flask(__name__)

# In-memory track storage (single-user local tool)
tracks: list[dict] = []
upload_dir = Path(tempfile.mkdtemp(prefix="cd-burner-"))
wav_dir = Path(tempfile.mkdtemp(prefix="cd-burner-wav-"))


def sse_event(data: dict, event: str = None) -> str:
    """Format data as SSE event."""
    lines = []
    if event:
        lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data)}")
    lines.append("")
    lines.append("")
    return "\n".join(lines)


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
        filepath = upload_dir / f"{track_id}{ext}"
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
        }
        tracks.append(track)
        new_tracks.append({
            "id": track_id,
            "name": file.filename,
            "duration": duration,
        })

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
    return jsonify({"success": True})


@app.route("/randomize", methods=["POST"])
def randomize():
    """Shuffle track order."""
    global tracks
    random.shuffle(tracks)
    return jsonify({
        "tracks": [
            {"id": t["id"], "name": t["name"], "duration": t["duration"]}
            for t in tracks
        ]
    })


@app.route("/clear", methods=["POST"])
def clear_all():
    """Remove all tracks."""
    global tracks
    for track in tracks:
        filepath = Path(track["filepath"])
        if filepath.exists():
            filepath.unlink()
    tracks = []
    return jsonify({"success": True})


@app.route("/cd-info", methods=["GET"])
def cd_info():
    """Get CD capacity info."""
    capacity = get_cd_capacity()
    return jsonify({
        "capacity": capacity,  # None if no disc
        "default_capacity": DEFAULT_CAPACITY_SECONDS,
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
