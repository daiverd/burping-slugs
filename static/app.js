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

    // State
    let tracks = [];
    let selectedIndex = -1;
    let cdCapacity = 80 * 60; // Default 80 minutes in seconds
    let hasDisc = false;
    let isBurning = false;

    // Initialize
    function init() {
        setupDropzone();
        setupFileInput();
        setupKeyboardNav();
        setupButtons();
        checkCdInfo();

        // Check CD info periodically
        setInterval(checkCdInfo, 5000);

        // Update capacity when gap setting changes
        trackGaps.addEventListener('change', updateCapacity);
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

        // Paste handler
        document.addEventListener('paste', (e) => {
            if (isBurning) return;
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
                uploadFiles(files);
            }
        });
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

        tracks.forEach((track, index) => {
            const li = document.createElement('li');
            li.className = 'track-item';
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
            li.setAttribute('tabindex', '-1');
            li.dataset.index = index;
            li.dataset.id = track.id;

            li.innerHTML = `
                <span class="track-number">${index + 1}.</span>
                <span class="track-name">${escapeHtml(track.name)}</span>
                <span class="track-duration">${formatDuration(track.duration)}</span>
                <button type="button" class="track-delete" tabindex="-1" aria-label="Delete ${escapeHtml(track.name)}" title="Delete track">x</button>
            `;

            li.addEventListener('click', (e) => {
                if (!e.target.classList.contains('track-delete')) {
                    selectTrack(index);
                }
            });

            li.querySelector('.track-delete').addEventListener('click', () => {
                deleteTrack(index);
            });

            trackList.appendChild(li);
        });

        // Update UI state
        const hasTrack = tracks.length > 0;
        emptyMessage.hidden = hasTrack;
        trackCount.textContent = `(${tracks.length})`;
        randomizeBtn.disabled = tracks.length < 2 || isBurning;
        clearBtn.disabled = !hasTrack || isBurning;
        updateBurnButton();
    }

    // Select track
    function selectTrack(index) {
        if (index < 0 || index >= tracks.length) return;

        selectedIndex = index;

        trackList.querySelectorAll('.track-item').forEach((item, i) => {
            const isSelected = i === index;
            item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            // Roving tabindex for delete buttons - only selected track's button is tabbable
            const deleteBtn = item.querySelector('.track-delete');
            if (deleteBtn) {
                deleteBtn.setAttribute('tabindex', isSelected ? '0' : '-1');
            }
        });

        // Focus the selected item
        const selectedItem = trackList.querySelector(`[data-index="${index}"]`);
        if (selectedItem) {
            selectedItem.focus();
        }
    }

    // Delete track
    async function deleteTrack(index) {
        if (isBurning) return;

        const track = tracks[index];

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

            capacityProgress.max = cdCapacity;
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

        capacityProgress.value = Math.min(totalDuration, cdCapacity);
        capacityProgress.dataset.over = isOver ? 'true' : 'false';

        capacityText.textContent = `${formatDuration(totalDuration)} / ${formatDuration(cdCapacity)} (${percent}%)`;

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
