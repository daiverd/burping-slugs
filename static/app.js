/* Audio CD Burner - Frontend Logic */

(function () {
    'use strict';

    // DOM elements
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const browseBtn = document.getElementById('browse-btn');
    const trackList = document.getElementById('track-list');
    const trackCount = document.getElementById('track-count');
    const emptyMessage = document.getElementById('empty-message');
    const randomizeBtn = document.getElementById('randomize-btn');
    const clearBtn = document.getElementById('clear-btn');
    const capacityProgress = document.getElementById('capacity-progress');
    const capacityText = document.getElementById('capacity-text');
    const discStatus = document.getElementById('disc-status');
    const burnBtn = document.getElementById('burn-btn');
    const trackGaps = document.getElementById('track-gaps');
    const dummyMode = document.getElementById('dummy-mode');
    const statusDiv = document.getElementById('status');
    const progressContainer = document.getElementById('progress-container');
    const progressText = document.getElementById('progress-text');
    const burnProgress = document.getElementById('burn-progress');
    const downloadSection = document.getElementById('download-section');
    const downloadList = document.getElementById('download-list');
    const playButtonsContainer = document.getElementById('track-play-buttons');
    const deleteButtonsContainer = document.getElementById('track-delete-buttons');
    const downloadButtonsContainer = document.getElementById('track-download-buttons');

    // State
    let tracks = [];
    let selectedIndex = -1;
    let cdCapacity = 80 * 60; // Default 80 minutes in seconds
    let hasDisc = false;
    let isBurning = false;
    let isDownloading = false;
    let activeDownloads = new Map(); // job_id -> {url, status, progress, message}

    // Audio playback
    let audioPlayer = null;
    let playingTrackId = null;

    // URL pattern for detecting URLs in pasted text
    const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/;

    // Initialize
    function init() {
        setupDropzone();
        setupFileInput();
        setupKeyboardNav();
        setupButtons();
        loadTracks();
        checkCdInfo();

        // Check CD info periodically
        setInterval(checkCdInfo, 5000);

        // Update capacity when gap setting changes
        trackGaps.addEventListener('change', updateCapacity);
    }

    // Load existing tracks from server on page load
    async function loadTracks() {
        try {
            const response = await fetch('/tracks');
            const data = await response.json();
            if (data.tracks) {
                tracks = data.tracks;
                renderTracks();
                updateCapacity();
            }
        } catch (error) {
            console.error('Failed to load tracks:', error);
        }
    }

    // Check if text contains URLs
    function containsUrls(text) {
        return URL_PATTERN.test(text);
    }

    // Dropzone setup
    function setupDropzone() {
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                uploadFiles(e.dataTransfer.files);
            }
        });

        // Enter key opens file picker
        dropzone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInput.click();
            }
        });

        // Paste handler - check for URLs or files
        document.addEventListener('paste', (e) => {
            if (isBurning) return;

            // Check for text with URLs first
            const text = e.clipboardData?.getData('text');
            if (text && containsUrls(text)) {
                e.preventDefault();
                downloadUrls(text);
                return;
            }

            // Fall back to file paste
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
                uploadFiles(files);
            }
        });
    }

    // Download URLs from pasted text
    async function downloadUrls(text) {
        if (isDownloading) {
            showStatus('Download already in progress', 'warning');
            return;
        }

        showStatus('Starting download...');

        try {
            const response = await fetch('/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });

            const data = await response.json();

            if (data.error) {
                showStatus(data.error, 'error');
                return;
            }

            if (!data.jobs || data.jobs.length === 0) {
                showStatus('No downloadable URLs found', 'warning');
                return;
            }

            // Start tracking downloads
            isDownloading = true;
            activeDownloads.clear();

            for (const job of data.jobs) {
                activeDownloads.set(job.id, {
                    url: job.url,
                    status: 'pending',
                    progress: 0,
                    message: 'Starting...',
                });
            }

            renderDownloads();
            downloadSection.hidden = false;

            // Connect to SSE for progress updates
            const jobIds = data.jobs.map(j => j.id).join(',');
            const eventSource = new EventSource(`/download-progress?ids=${jobIds}`);

            eventSource.addEventListener('update', (e) => {
                const update = JSON.parse(e.data);
                if (activeDownloads.has(update.id)) {
                    activeDownloads.set(update.id, {
                        url: update.url,
                        status: update.status,
                        progress: update.progress,
                        message: update.message,
                        result: update.result,
                        error: update.error,
                    });
                    renderDownloads();

                    // If completed successfully, refresh track list
                    if (update.status === 'complete' && update.result) {
                        loadTracks();
                    }
                }
            });

            eventSource.addEventListener('complete', (e) => {
                eventSource.close();
                isDownloading = false;

                // Count results
                let completed = 0;
                let failed = 0;
                for (const dl of activeDownloads.values()) {
                    if (dl.status === 'complete') completed++;
                    if (dl.status === 'failed') failed++;
                }

                if (failed > 0) {
                    showStatus(`Downloaded ${completed} track(s), ${failed} failed`, completed > 0 ? 'warning' : 'error');
                } else {
                    showStatus(`Downloaded ${completed} track(s)`);
                }

                // Hide download section after a delay
                setTimeout(() => {
                    downloadSection.hidden = true;
                    activeDownloads.clear();
                    renderDownloads();
                }, 3000);
            });

            eventSource.onerror = () => {
                eventSource.close();
                isDownloading = false;
                showStatus('Download connection lost', 'error');
            };

        } catch (error) {
            showStatus('Download failed: ' + error.message, 'error');
            isDownloading = false;
        }
    }

    // Render download progress list
    function renderDownloads() {
        downloadList.innerHTML = '';

        for (const [id, dl] of activeDownloads) {
            const li = document.createElement('li');
            li.className = `download-item download-${dl.status}`;

            // Truncate URL for display
            let displayUrl = dl.url;
            if (displayUrl.length > 50) {
                displayUrl = displayUrl.substring(0, 47) + '...';
            }

            let statusIcon = '';
            if (dl.status === 'complete') statusIcon = '[Done] ';
            else if (dl.status === 'failed') statusIcon = '[Failed] ';
            else if (dl.status === 'downloading' || dl.status === 'processing') statusIcon = `[${Math.round(dl.progress)}%] `;

            li.innerHTML = `
                <span class="download-status">${statusIcon}</span>
                <span class="download-url" title="${escapeHtml(dl.url)}">${escapeHtml(displayUrl)}</span>
                <span class="download-message">${escapeHtml(dl.message)}</span>
            `;

            downloadList.appendChild(li);
        }
    }

    // File input setup
    function setupFileInput() {
        browseBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                uploadFiles(fileInput.files);
                fileInput.value = ''; // Reset for re-upload
            }
        });
    }

    // Upload files to server
    async function uploadFiles(files) {
        if (isBurning) {
            showStatus('Cannot add tracks while burning', 'warning');
            return;
        }

        const formData = new FormData();
        for (const file of files) {
            formData.append('files', file);
        }

        showStatus('Uploading and analyzing files...');

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData,
            });

            const data = await response.json();

            if (data.error) {
                showStatus(data.error, 'error');
                return;
            }

            if (data.tracks && data.tracks.length > 0) {
                tracks.push(...data.tracks);
                renderTracks();
                updateCapacity();

                // Focus first new track
                const firstNewIndex = tracks.length - data.tracks.length;
                selectTrack(firstNewIndex);

                showStatus(`Added ${data.tracks.length} track(s)`);
            } else {
                showStatus('No valid audio files found', 'warning');
            }
        } catch (error) {
            showStatus('Upload failed: ' + error.message, 'error');
        }
    }

    // Render track list
    function renderTracks() {
        trackList.innerHTML = '';
        playButtonsContainer.innerHTML = '';
        deleteButtonsContainer.innerHTML = '';
        downloadButtonsContainer.innerHTML = '';

        tracks.forEach((track, index) => {
            // Create option in listbox
            const item = document.createElement('div');
            item.className = 'track-item';
            item.id = `track-option-${index}`;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
            item.dataset.index = index;
            item.dataset.id = track.id;

            item.innerHTML = `
                <span class="track-number">${index + 1}.</span>
                <span class="track-name">${escapeHtml(track.name)}</span>
                <span class="track-duration">${formatDuration(track.duration)}</span>
            `;

            item.addEventListener('click', () => selectTrack(index));
            trackList.appendChild(item);

            // Create play button
            const playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'track-play';
            playBtn.setAttribute('tabindex', '-1');
            playBtn.setAttribute('aria-hidden', 'true');
            playBtn.setAttribute('aria-label', `Play ${track.name}`);
            playBtn.title = 'Play track';
            playBtn.textContent = playingTrackId === track.id ? '■' : '▶';
            playBtn.dataset.trackId = track.id;

            playBtn.addEventListener('click', () => togglePlay(track.id, track.name));
            playButtonsContainer.appendChild(playBtn);

            // Create delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'track-delete';
            deleteBtn.setAttribute('tabindex', '-1');
            deleteBtn.setAttribute('aria-hidden', 'true');
            deleteBtn.setAttribute('aria-label', `Delete ${track.name}`);
            deleteBtn.title = 'Delete track';
            deleteBtn.textContent = 'x';
            deleteBtn.dataset.index = index;

            deleteBtn.addEventListener('click', () => deleteTrack(index));
            deleteButtonsContainer.appendChild(deleteBtn);

            // Create download button
            const downloadBtn = document.createElement('button');
            downloadBtn.type = 'button';
            downloadBtn.className = 'track-download';
            downloadBtn.setAttribute('tabindex', '-1');
            downloadBtn.setAttribute('aria-hidden', 'true');
            downloadBtn.setAttribute('aria-label', `Download ${track.name}`);
            downloadBtn.title = 'Download track';
            downloadBtn.textContent = '↓';
            downloadBtn.dataset.trackId = track.id;

            downloadBtn.addEventListener('click', () => downloadTrack(track.id));
            downloadButtonsContainer.appendChild(downloadBtn);
        });

        // Update UI state
        const hasTrack = tracks.length > 0;
        emptyMessage.hidden = hasTrack;
        trackCount.textContent = `(${tracks.length})`;
        randomizeBtn.disabled = tracks.length < 2 || isBurning;
        clearBtn.disabled = !hasTrack || isBurning;
        updateBurnButton();

        // Set aria-activedescendant to preserve selection
        if (selectedIndex >= 0 && selectedIndex < tracks.length) {
            trackList.setAttribute('aria-activedescendant', `track-option-${selectedIndex}`);
        } else {
            trackList.removeAttribute('aria-activedescendant');
        }
    }

    // Select track
    function selectTrack(index) {
        if (index < 0 || index >= tracks.length) return;

        selectedIndex = index;

        trackList.querySelectorAll('.track-item').forEach((item, i) => {
            item.setAttribute('aria-selected', i === index ? 'true' : 'false');
        });

        playButtonsContainer.querySelectorAll('.track-play').forEach((btn, i) => {
            const isSelected = i === index;
            btn.setAttribute('tabindex', isSelected ? '0' : '-1');
            btn.setAttribute('aria-hidden', isSelected ? 'false' : 'true');
        });

        deleteButtonsContainer.querySelectorAll('.track-delete').forEach((btn, i) => {
            const isSelected = i === index;
            btn.setAttribute('tabindex', isSelected ? '0' : '-1');
            btn.setAttribute('aria-hidden', isSelected ? 'false' : 'true');
        });

        downloadButtonsContainer.querySelectorAll('.track-download').forEach((btn, i) => {
            const isSelected = i === index;
            btn.setAttribute('tabindex', isSelected ? '0' : '-1');
            btn.setAttribute('aria-hidden', isSelected ? 'false' : 'true');
        });

        // Set aria-activedescendant on listbox
        trackList.setAttribute('aria-activedescendant', `track-option-${index}`);

        // Ensure listbox has focus (screen reader will announce active descendant)
        trackList.focus();
    }

    // Delete track
    async function deleteTrack(index) {
        if (isBurning) return;

        const track = tracks[index];

        // Stop playback if this track is playing
        if (playingTrackId === track.id) {
            stopPlayback();
        }

        try {
            await fetch(`/track/${track.id}`, { method: 'DELETE' });

            tracks.splice(index, 1);

            // Adjust selection
            if (selectedIndex >= tracks.length) {
                selectedIndex = tracks.length - 1;
            } else if (selectedIndex > index) {
                selectedIndex--;
            }

            renderTracks();
            updateCapacity();

            // Focus appropriate track
            if (tracks.length > 0) {
                const newIndex = Math.min(index, tracks.length - 1);
                selectTrack(newIndex);
            }

            showStatus(`Removed: ${track.name}`);
        } catch (error) {
            showStatus('Failed to delete track', 'error');
        }
    }

    // Download track
    function downloadTrack(trackId) {
        const link = document.createElement('a');
        link.href = `/audio/${trackId}?download=true`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // Toggle play/stop for a track
    async function togglePlay(trackId, trackName) {
        // If this track is playing, stop it
        if (playingTrackId === trackId) {
            stopPlayback();
            return;
        }

        // Stop any current playback
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer = null;
        }

        // Start playing this track
        playingTrackId = trackId;
        updatePlayButtons();

        audioPlayer = new Audio(`/audio/${trackId}`);

        audioPlayer.addEventListener('ended', () => {
            stopPlayback();
        });

        audioPlayer.addEventListener('error', () => {
            showStatus(`Failed to play: ${trackName}`, 'error');
            stopPlayback();
        });

        try {
            await audioPlayer.play();
            showStatus(`Playing: ${trackName}`);
        } catch (err) {
            showStatus(`Failed to play: ${trackName}`, 'error');
            stopPlayback();
        }
    }

    // Stop current playback
    function stopPlayback() {
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.src = '';
            audioPlayer = null;
        }
        playingTrackId = null;
        updatePlayButtons();
    }

    // Update play button states
    function updatePlayButtons() {
        playButtonsContainer.querySelectorAll('.track-play').forEach((btn) => {
            const isPlaying = btn.dataset.trackId === playingTrackId;
            btn.textContent = isPlaying ? '■' : '▶';
            btn.title = isPlaying ? 'Stop track' : 'Play track';
            btn.setAttribute('aria-label', isPlaying
                ? `Stop ${btn.getAttribute('aria-label').replace(/^(Play|Stop) /, '')}`
                : `Play ${btn.getAttribute('aria-label').replace(/^(Play|Stop) /, '')}`);
        });
    }

    // Move track
    async function moveTrack(fromIndex, toIndex) {
        if (toIndex < 0 || toIndex >= tracks.length) return;
        if (fromIndex === toIndex) return;

        const track = tracks.splice(fromIndex, 1)[0];
        tracks.splice(toIndex, 0, track);

        // Update server
        try {
            await fetch('/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: tracks.map(t => t.id) }),
            });
        } catch (error) {
            console.error('Reorder failed:', error);
        }

        selectedIndex = toIndex;
        renderTracks();
        selectTrack(toIndex);
    }

    // Keyboard navigation
    function setupKeyboardNav() {
        // When listbox receives focus, select first item if nothing selected
        trackList.addEventListener('focus', () => {
            if (tracks.length > 0 && selectedIndex < 0) {
                selectTrack(0);
            }
        });

        trackList.addEventListener('keydown', (e) => {
            if (isBurning) return;
            if (tracks.length === 0) return;

            const key = e.key;
            const alt = e.altKey;

            // Navigation without Alt
            if (!alt) {
                if (key === 'ArrowDown') {
                    e.preventDefault();
                    selectTrack(Math.min(selectedIndex + 1, tracks.length - 1));
                } else if (key === 'ArrowUp') {
                    e.preventDefault();
                    selectTrack(Math.max(selectedIndex - 1, 0));
                } else if (key === 'Home') {
                    e.preventDefault();
                    selectTrack(0);
                } else if (key === 'End') {
                    e.preventDefault();
                    selectTrack(tracks.length - 1);
                } else if (key === 'Delete' || key === 'Backspace') {
                    e.preventDefault();
                    if (selectedIndex >= 0) {
                        deleteTrack(selectedIndex);
                    }
                } else if (key === ' ') {
                    e.preventDefault();
                    if (selectedIndex >= 0) {
                        const track = tracks[selectedIndex];
                        togglePlay(track.id, track.name);
                    }
                }
                return;
            }

            // Track movement with Alt
            if (selectedIndex < 0) return;

            if (key === 'ArrowUp') {
                e.preventDefault();
                moveTrack(selectedIndex, selectedIndex - 1);
            } else if (key === 'ArrowDown') {
                e.preventDefault();
                moveTrack(selectedIndex, selectedIndex + 1);
            } else if (key === 'Home') {
                e.preventDefault();
                moveTrack(selectedIndex, 0);
            } else if (key === 'End') {
                e.preventDefault();
                moveTrack(selectedIndex, tracks.length - 1);
            }
        });
    }

    // Button setup
    function setupButtons() {
        randomizeBtn.addEventListener('click', async () => {
            if (isBurning || tracks.length < 2) return;

            try {
                const response = await fetch('/randomize', { method: 'POST' });
                const data = await response.json();

                if (data.tracks) {
                    tracks = data.tracks;
                    selectedIndex = -1;
                    renderTracks();
                    showStatus('Track order randomized');
                }
            } catch (error) {
                showStatus('Randomize failed', 'error');
            }
        });

        clearBtn.addEventListener('click', async () => {
            if (isBurning || tracks.length === 0) return;

            stopPlayback();

            try {
                await fetch('/clear', { method: 'POST' });
                tracks = [];
                selectedIndex = -1;
                renderTracks();
                updateCapacity();
                showStatus('All tracks cleared');
            } catch (error) {
                showStatus('Clear failed', 'error');
            }
        });

        burnBtn.addEventListener('click', startBurn);
    }

    // CD info check
    async function checkCdInfo() {
        if (isBurning) return;

        try {
            const response = await fetch('/cd-info');
            const data = await response.json();

            if (data.capacity !== null) {
                cdCapacity = data.capacity;
                hasDisc = true;
                discStatus.textContent = `Disc detected: ${formatDuration(cdCapacity)} capacity`;
                discStatus.className = 'disc-present';
            } else {
                cdCapacity = data.default_capacity;
                hasDisc = false;
                discStatus.textContent = 'No disc detected. Using default 80 min capacity.';
                discStatus.className = 'disc-absent';
            }

            capacityProgress.max = Math.round(cdCapacity / 60);
            updateCapacity();
            updateBurnButton();
        } catch (error) {
            console.error('CD info check failed:', error);
        }
    }

    // Update capacity display
    function updateCapacity() {
        const trackDuration = tracks.reduce((sum, t) => sum + t.duration, 0);
        // Add 2 seconds per gap (between tracks, so tracks - 1) when enabled
        const gapTime = trackGaps.checked && tracks.length > 1 ? (tracks.length - 1) * 2 : 0;
        const totalDuration = trackDuration + gapTime;
        const percent = cdCapacity > 0 ? Math.round((totalDuration / cdCapacity) * 100) : 0;
        const isOver = totalDuration > cdCapacity;

        capacityProgress.value = Math.round(Math.min(totalDuration, cdCapacity) / 60 * 100) / 100;
        capacityProgress.dataset.over = isOver ? 'true' : 'false';

        const capacityStr = `${formatDuration(totalDuration)} / ${formatDuration(cdCapacity)} (${percent}%)`;
        capacityText.textContent = capacityStr;

        // Update page title with capacity
        document.title = `Burping Slug's Retro CD Burner - ${capacityStr}`;

        if (isOver) {
            capacityText.style.color = 'var(--color-danger)';
        } else {
            capacityText.style.color = '';
        }

        updateBurnButton();
    }

    // Update burn button state
    function updateBurnButton() {
        const trackDuration = tracks.reduce((sum, t) => sum + t.duration, 0);
        const gapTime = trackGaps.checked && tracks.length > 1 ? (tracks.length - 1) * 2 : 0;
        const totalDuration = trackDuration + gapTime;
        const canBurn = tracks.length > 0 && totalDuration <= cdCapacity && !isBurning;
        burnBtn.disabled = !canBurn;

        if (tracks.length === 0) {
            burnBtn.title = 'Add tracks to burn';
        } else if (totalDuration > cdCapacity) {
            burnBtn.title = 'Total duration exceeds disc capacity';
        } else if (isBurning) {
            burnBtn.title = 'Burn in progress';
        } else {
            burnBtn.title = '';
        }
    }

    // Start burn process using Server-Sent Events
    function startBurn() {
        if (isBurning || tracks.length === 0) return;

        isBurning = true;
        renderTracks();
        updateBurnButton();

        progressContainer.hidden = false;
        burnProgress.value = 0;
        progressText.textContent = 'Starting burn process...';

        const url = `/burn?dummy=${dummyMode.checked}&gaps=${trackGaps.checked}`;
        const eventSource = new EventSource(url);

        eventSource.addEventListener('progress', (e) => {
            const data = JSON.parse(e.data);
            progressText.textContent = data.message;
            burnProgress.value = data.percent;

            // Announce to screen readers at intervals
            if (data.percent % 25 === 0) {
                showStatus(data.message);
            }
        });

        eventSource.addEventListener('complete', (e) => {
            const data = JSON.parse(e.data);
            eventSource.close();

            isBurning = false;
            progressContainer.hidden = true;
            renderTracks();

            if (data.success) {
                showStatus(data.message, 'success');
            } else {
                showStatus(data.message, 'error');
            }
        });

        eventSource.onerror = () => {
            eventSource.close();
            isBurning = false;
            progressContainer.hidden = true;
            renderTracks();
            showStatus('Connection lost during burn', 'error');
        };
    }

    // Show status message
    function showStatus(message, type = 'info') {
        statusDiv.textContent = message;
        statusDiv.className = type;
    }

    // Format duration as M:SS
    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // Escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Start
    init();
})();
