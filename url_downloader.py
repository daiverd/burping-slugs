"""URL download utilities using audio-url-transformer and yt-dlp."""

import hashlib
import json
import re
import threading
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests
import yt_dlp
from audio_url_transformer import AudioURLTransformer

from audio_utils import get_duration

# Shared transformer instance
_transformer = AudioURLTransformer()

# Minimum duration to consider a valid audio file (in seconds)
MIN_DURATION_SECONDS = 1.0

# URL regex pattern for http/https URLs
URL_PATTERN = re.compile(r'https?://[^\s<>"{}|\\^`\[\]]+')


class JobStatus(Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    COMPLETE = "complete"
    FAILED = "failed"


@dataclass
class DownloadResult:
    """Result of a successful download."""
    filepath: Path
    title: str
    duration: float
    source_url: str


@dataclass
class DownloadJob:
    """Tracks state of a download job."""
    id: str
    url: str
    status: JobStatus = JobStatus.PENDING
    progress: float = 0.0
    message: str = ""
    result: DownloadResult | None = None
    error: str | None = None


# Global job registry (GIL-safe for basic dict operations)
_jobs: dict[str, DownloadJob] = {}
_jobs_lock = threading.Lock()


def parse_urls(text: str) -> list[str]:
    """Extract http/https URLs from text.

    Args:
        text: Input text that may contain URLs

    Returns:
        List of extracted URLs
    """
    return URL_PATTERN.findall(text)


def normalize_url(url: str) -> str:
    """Normalize URL for cache lookup.

    Removes tracking parameters and normalizes format.

    Args:
        url: URL to normalize

    Returns:
        Normalized URL string
    """
    # Remove common tracking params
    url = re.sub(r'[?&](utm_\w+|fbclid|ref|feature)=[^&]*', '', url)
    # Normalize YouTube URLs
    url = re.sub(r'(?:www\.)?youtu\.be/', 'youtube.com/watch?v=', url)
    url = re.sub(r'(?:www\.)?youtube\.com/shorts/', 'youtube.com/watch?v=', url)
    # Remove trailing slashes
    url = url.rstrip('/')
    return url


def url_hash(url: str) -> str:
    """Generate cache key from URL.

    Args:
        url: URL to hash

    Returns:
        First 16 chars of SHA256 hash
    """
    normalized = normalize_url(url)
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def safe_filename(title: str, max_length: int = 100) -> str:
    """Convert title to filesystem-safe name.

    Args:
        title: Original title
        max_length: Maximum filename length

    Returns:
        Safe filename string
    """
    # Replace problematic characters
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title)
    # Collapse multiple underscores/spaces
    safe = re.sub(r'[_\s]+', '_', safe)
    # Remove leading/trailing underscores and dots
    safe = safe.strip('_.')
    # Truncate
    if len(safe) > max_length:
        safe = safe[:max_length].rstrip('_.')
    return safe or 'untitled'


def load_cache_index(cache_dir: Path) -> dict:
    """Load cache index from disk.

    Args:
        cache_dir: Cache directory path

    Returns:
        Dict mapping URL hashes to cache entries
    """
    index_path = cache_dir / "index.json"
    if index_path.exists():
        try:
            with open(index_path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_cache_index(cache_dir: Path, index: dict) -> None:
    """Save cache index to disk.

    Args:
        cache_dir: Cache directory path
        index: Cache index dict
    """
    index_path = cache_dir / "index.json"
    cache_dir.mkdir(parents=True, exist_ok=True)
    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)


def get_cached(url: str, cache_dir: Path) -> DownloadResult | None:
    """Check if URL is already cached.

    Args:
        url: URL to check
        cache_dir: Cache directory path

    Returns:
        DownloadResult if cached and file exists, None otherwise
    """
    cache_key = url_hash(url)
    index = load_cache_index(cache_dir)

    if cache_key not in index:
        return None

    entry = index[cache_key]
    filepath = cache_dir / entry["filename"]

    if not filepath.exists():
        # Stale cache entry
        del index[cache_key]
        save_cache_index(cache_dir, index)
        return None

    return DownloadResult(
        filepath=filepath,
        title=entry["title"],
        duration=entry["duration"],
        source_url=entry["url"],
    )


def _download_direct_url(
    url: str,
    output_path: Path,
    on_progress: Callable[[float, str], None] | None = None,
) -> None:
    """Download a direct audio URL with progress.

    Args:
        url: Direct URL to audio file
        output_path: Where to save the file
        on_progress: Callback(percent, message)
    """
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"}
    response = requests.get(url, headers=headers, stream=True)
    response.raise_for_status()

    total = int(response.headers.get("content-length", 0))
    downloaded = 0

    with open(output_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if on_progress and total > 0:
                percent = (downloaded / total) * 100
                on_progress(percent, f"Downloading: {percent:.0f}%")

    if on_progress:
        on_progress(100.0, "Download complete")


def _title_from_url(url: str) -> str:
    """Extract a title from a URL path."""
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    if path:
        # Get filename without extension
        filename = path.split("/")[-1]
        name = filename.rsplit(".", 1)[0] if "." in filename else filename
        # Clean up
        name = name.replace("-", " ").replace("_", " ")
        return name.title() if name else "Unknown"
    return "Unknown"


def _get_page_title(url: str) -> str | None:
    """Fetch page and extract title from og:title or <title> tag.

    Args:
        url: Page URL to fetch

    Returns:
        Title string or None if not found
    """
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"}
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        html = response.text

        # Try og:title first
        match = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html)
        if not match:
            match = re.search(r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:title["\']', html)
        if match:
            return match.group(1).strip()

        # Fall back to <title> tag
        match = re.search(r'<title>([^<]+)</title>', html, re.IGNORECASE)
        if match:
            title = match.group(1).strip()
            # Clean up common suffixes
            for suffix in [" - Suno", " | Suno", " - SoundCloud", " - YouTube"]:
                if title.endswith(suffix):
                    title = title[:-len(suffix)]
            return title

    except Exception:
        pass
    return None


def download_url(
    url: str,
    cache_dir: Path,
    job_id: str,
    on_progress: Callable[[str, float, str], None] | None = None,
) -> DownloadResult:
    """Download audio from URL using audio-url-transformer or yt-dlp.

    First tries audio-url-transformer to get a direct audio URL,
    then falls back to yt-dlp for sites it doesn't support.

    Args:
        url: URL to download
        cache_dir: Cache directory for storing downloaded files
        job_id: Job ID for progress tracking
        on_progress: Callback(job_id, percent, message)

    Returns:
        DownloadResult with file info

    Raises:
        Exception: If download fails
    """
    # Check cache first
    cached = get_cached(url, cache_dir)
    if cached:
        if on_progress:
            on_progress(job_id, 100.0, f"Using cached: {cached.title}")
        return cached

    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = url_hash(url)

    # Try audio-url-transformer first (but not for YouTube - yt-dlp handles it better)
    direct_url = None
    is_youtube = bool(re.search(r'(youtube\.com|youtu\.be)/', url))
    if not is_youtube and _transformer.is_audio_url(url):
        try:
            if on_progress:
                on_progress(job_id, 0, "Resolving audio URL...")
            direct_url = _transformer.transform(url)
        except Exception:
            # Transformer failed, will fall back to yt-dlp
            pass

    if direct_url and direct_url != url:
        # Download the direct URL
        # Determine extension from URL
        parsed = urlparse(direct_url)
        ext = Path(parsed.path).suffix or ".mp3"
        output_file = cache_dir / f"{cache_key}{ext}"

        def progress_cb(percent, message):
            if on_progress:
                on_progress(job_id, percent, message)

        _download_direct_url(direct_url, output_file, progress_cb)

        # Get duration from the file using ffprobe
        duration = get_duration(output_file) or 0.0

        # Reject files that are too short (likely invalid/error pages)
        if duration < MIN_DURATION_SECONDS:
            output_file.unlink(missing_ok=True)
            raise ValueError(f"Audio too short ({duration:.1f}s) - likely invalid URL")

        # Try to get title from page, fall back to URL
        title = _get_page_title(url) or _title_from_url(url)

        # Update cache index
        index = load_cache_index(cache_dir)
        index[cache_key] = {
            "url": url,
            "title": title,
            "duration": duration,
            "filename": output_file.name,
        }
        save_cache_index(cache_dir, index)

        if on_progress:
            on_progress(job_id, 100.0, f"Complete: {title}")

        return DownloadResult(
            filepath=output_file,
            title=title,
            duration=duration,
            source_url=url,
        )

    # Fall back to yt-dlp
    def progress_hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            if total > 0:
                percent = (downloaded / total) * 100
            else:
                percent = 0
            if on_progress:
                on_progress(job_id, percent, f"Downloading: {percent:.0f}%")
        elif d["status"] == "finished":
            if on_progress:
                on_progress(job_id, 100.0, "Processing audio...")

    # yt-dlp options
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(cache_dir / f"{cache_key}.%(ext)s"),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "progress_hooks": [progress_hook],
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # Find the downloaded file (yt-dlp may have converted to mp3)
    output_file = None
    for ext in ["mp3", "m4a", "webm", "opus", "ogg", "wav"]:
        candidate = cache_dir / f"{cache_key}.{ext}"
        if candidate.exists():
            output_file = candidate
            break

    if output_file is None:
        raise RuntimeError("Download completed but output file not found")

    title = info.get("title", "Unknown")
    duration = info.get("duration", 0.0) or 0.0

    # If yt-dlp didn't provide duration, get it from the file
    if duration == 0.0:
        duration = get_duration(output_file) or 0.0

    # Reject files that are too short (likely invalid/error pages)
    if duration < MIN_DURATION_SECONDS:
        output_file.unlink(missing_ok=True)
        raise ValueError(f"Audio too short ({duration:.1f}s) - likely invalid URL")

    # Update cache index
    index = load_cache_index(cache_dir)
    index[cache_key] = {
        "url": url,
        "title": title,
        "duration": duration,
        "filename": output_file.name,
    }
    save_cache_index(cache_dir, index)

    if on_progress:
        on_progress(job_id, 100.0, f"Complete: {title}")

    return DownloadResult(
        filepath=output_file,
        title=title,
        duration=duration,
        source_url=url,
    )


def get_job(job_id: str) -> DownloadJob | None:
    """Get job by ID.

    Args:
        job_id: Job ID to look up

    Returns:
        DownloadJob if found, None otherwise
    """
    with _jobs_lock:
        return _jobs.get(job_id)


def start_download(
    url: str,
    cache_dir: Path,
    on_complete: Callable[[DownloadJob], None] | None = None,
) -> str:
    """Start a background download job.

    Args:
        url: URL to download
        cache_dir: Cache directory path
        on_complete: Callback when download completes (success or failure)

    Returns:
        Job ID string
    """
    job_id = str(uuid.uuid4())
    job = DownloadJob(id=job_id, url=url)

    with _jobs_lock:
        _jobs[job_id] = job

    def run():
        job.status = JobStatus.DOWNLOADING
        job.message = "Starting download..."

        def on_progress(jid, percent, message):
            job.progress = percent
            job.message = message
            if percent >= 100:
                job.status = JobStatus.PROCESSING

        try:
            result = download_url(url, cache_dir, job_id, on_progress)
            job.status = JobStatus.COMPLETE
            job.progress = 100.0
            job.result = result
            job.message = f"Complete: {result.title}"
        except Exception as e:
            job.status = JobStatus.FAILED
            job.error = str(e)
            job.message = f"Failed: {e}"

        if on_complete:
            on_complete(job)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    return job_id


def cleanup_job(job_id: str) -> None:
    """Remove a job from the registry.

    Args:
        job_id: Job ID to remove
    """
    with _jobs_lock:
        _jobs.pop(job_id, None)


def get_all_jobs() -> dict[str, DownloadJob]:
    """Get all current jobs.

    Returns:
        Copy of jobs dictionary
    """
    with _jobs_lock:
        return dict(_jobs)
