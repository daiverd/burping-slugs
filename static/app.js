/* Audio CD Burner - Frontend Logic */

(function () {
    'use strict';

    // DOM elements
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const browseBtn = document.getElementById('browse-btn');
    const browseFolderBtn = document.getElementById('browse-folder-btn');
    const trackTree = document.getElementById('track-tree');
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
    const trackGapsLabel = document.getElementById('track-gaps-label');
    const playButtonsContainer = document.getElementById('track-play-buttons');
    const deleteButtonsContainer = document.getElementById('track-delete-buttons');
    const downloadButtonsContainer = document.getElementById('track-download-buttons');

    // State
    let tracks = [];
    let selectedId = null; // track id or 'folder:path' for folders
    let collapsedFolders = new Set(); // folder paths that are collapsed
    let cdCapacity = 80 * 60; // Default 80 minutes in seconds
    let dataCapacity = 700; // Default 700 MB
    let hasDisc = false;
    let isBurning = false;
    let isDownloading = false;
    let activeDownloads = new Map(); // job_id -> {url, status, progress, message}
    let cdType = 'audio'; // 'audio' or 'mp3'

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
        setupCdTypeToggle();
        loadTracks();
        checkCdInfo();

        // Check CD info periodically
        setInterval(checkCdInfo, 5000);

        // Update capacity when gap setting changes
        trackGaps.addEventListener('change', updateCapacity);
    }

    // Setup CD type radio button toggle
    function setupCdTypeToggle() {
        const radios = document.querySelectorAll('input[name="cd-type"]');
        radios.forEach(radio => {
            radio.addEventListener('change', async (e) => {
                cdType = e.target.value;
                updateCapacity();
                // Hide track gaps option for MP3 CD (not applicable)
                trackGapsLabel.style.display = cdType === 'mp3' ? 'none' : '';
                // Save to server
                try {
                    await fetch('/cd-type', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cd_type: cdType }),
                    });
                } catch (error) {
                    console.error('Failed to save CD type:', error);
                }
            });
        });
    }

    // Load existing tracks from server on page load
    async function loadTracks() {
        try {
            const response = await fetch('/tracks');
            const data = await response.json();
            if (data.tracks) {
                // Store full track info including folder and size
                tracks = data.tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    duration: t.duration,
                    folder: t.folder || '',
                    size: t.size || 0,
                }));
                renderTracks();
            }
            // Load CD type from server
            if (data.cd_type) {
                cdType = data.cd_type;
                const radio = document.querySelector(`input[name="cd-type"][value="${cdType}"]`);
                if (radio) {
                    radio.checked = true;
                }
                // Hide/show track gaps based on type
                trackGapsLabel.style.display = cdType === 'mp3' ? 'none' : '';
            }
            updateCapacity();
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

        dropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');

            // Check for folder drops using DataTransferItem API
            if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                const files = await getFilesFromDataTransfer(e.dataTransfer.items);
                if (files.length > 0) {
                    uploadFilesWithPaths(files);
                    return;
                }
            }

            // Fallback for simple file drops
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

        browseFolderBtn.addEventListener('click', () => {
            folderInput.click();
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                uploadFiles(fileInput.files);
                fileInput.value = ''; // Reset for re-upload
            }
        });

        folderInput.addEventListener('change', () => {
            if (folderInput.files.length > 0) {
                // Folder input already has webkitRelativePath set
                uploadFilesWithPaths(Array.from(folderInput.files).map(f => ({
                    file: f,
                    path: f.webkitRelativePath || f.name
                })));
                folderInput.value = ''; // Reset for re-upload
            }
        });
    }

    // Get files from DataTransfer items (supports folders)
    async function getFilesFromDataTransfer(items) {
        const files = [];

        async function readEntry(entry, path = '') {
            if (entry.isFile) {
                return new Promise((resolve) => {
                    entry.file((file) => {
                        files.push({
                            file: file,
                            path: path + file.name
                        });
                        resolve();
                    }, () => resolve()); // Ignore errors
                });
            } else if (entry.isDirectory) {
                const dirReader = entry.createReader();
                const entries = await new Promise((resolve) => {
                    const allEntries = [];
                    const readBatch = () => {
                        dirReader.readEntries((batch) => {
                            if (batch.length === 0) {
                                resolve(allEntries);
                            } else {
                                allEntries.push(...batch);
                                readBatch();
                            }
                        }, () => resolve(allEntries));
                    };
                    readBatch();
                });
                const folderPath = path + entry.name + '/';
                await Promise.all(entries.map(e => readEntry(e, folderPath)));
            }
        }

        const entries = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.webkitGetAsEntry) {
                const entry = item.webkitGetAsEntry();
                if (entry) {
                    entries.push(entry);
                }
            }
        }

        await Promise.all(entries.map(e => readEntry(e, '')));
        return files;
    }

    // Upload files with path information (for folder uploads)
    async function uploadFilesWithPaths(filesWithPaths) {
        if (isBurning) {
            showStatus('Cannot add tracks while burning', 'warning');
            return;
        }

        const formData = new FormData();
        const paths = [];

        for (const { file, path } of filesWithPaths) {
            formData.append('files', file);
            paths.push(path);
        }

        formData.append('paths', JSON.stringify(paths));

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
                const newTracks = data.tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    duration: t.duration,
                    folder: t.folder || '',
                    size: t.size || 0,
                }));
                tracks.push(...newTracks);
                renderTracks();
                updateCapacity();

                selectItem(newTracks[0].id);

                showStatus(`Added ${newTracks.length} track(s)`);
            } else {
                showStatus('No valid audio files found', 'warning');
            }
        } catch (error) {
            showStatus('Upload failed: ' + error.message, 'error');
        }
    }

    // Upload files to server
    async function uploadFiles(files) {
        if (isBurning) {
            showStatus('Cannot add tracks while burning', 'warning');
            return;
        }

        const formData = new FormData();
        const paths = [];

        for (const file of files) {
            formData.append('files', file);
            // Capture relative path for folder structure
            const relativePath = file.webkitRelativePath || file.name;
            paths.push(relativePath);
        }

        // Send paths as JSON for folder support
        formData.append('paths', JSON.stringify(paths));

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
                // Map to include folder and size
                const newTracks = data.tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    duration: t.duration,
                    folder: t.folder || '',
                    size: t.size || 0,
                }));
                tracks.push(...newTracks);
                renderTracks();
                updateCapacity();

                // Focus first new track
                selectItem(newTracks[0].id);

                showStatus(`Added ${newTracks.length} track(s)`);
            } else {
                showStatus('No valid audio files found', 'warning');
            }
        } catch (error) {
            showStatus('Upload failed: ' + error.message, 'error');
        }
    }

    // Build tree structure from flat track list
    function buildTree() {
        const tree = {
            rootTracks: [],  // tracks without folder
            folders: new Map(),  // folder path -> { tracks: [], subfolders: Map }
        };

        tracks.forEach((track, index) => {
            const trackWithIndex = { ...track, index };
            if (!track.folder) {
                tree.rootTracks.push(trackWithIndex);
            } else {
                // Get or create folder entry
                if (!tree.folders.has(track.folder)) {
                    tree.folders.set(track.folder, { tracks: [], path: track.folder });
                }
                tree.folders.get(track.folder).tracks.push(trackWithIndex);
            }
        });

        return tree;
    }

    // Render track tree and buttons (flattened for grid alignment)
    function renderTracks() {
        trackTree.innerHTML = '';
        playButtonsContainer.innerHTML = '';
        deleteButtonsContainer.innerHTML = '';
        downloadButtonsContainer.innerHTML = '';

        const tree = buildTree();

        // Get folder order (order of first track appearance)
        const folderOrder = [];
        tracks.forEach(t => {
            if (t.folder && !folderOrder.includes(t.folder)) {
                folderOrder.push(t.folder);
            }
        });

        const rootSetSize = folderOrder.length + tree.rootTracks.length;
        let rootPos = 0;

        // Render folders (flattened - each item is direct child for grid alignment)
        folderOrder.forEach(folderPath => {
            rootPos++;
            const folder = tree.folders.get(folderPath);
            const isCollapsed = collapsedFolders.has(folderPath);

            // Folder header (direct child of tree)
            const header = createFolderHeader(folder, 1, rootPos, rootSetSize);
            trackTree.appendChild(header);
            addFolderButtons(folder);

            // Folder tracks (direct children of tree, indented via CSS)
            folder.tracks.forEach((track, idx) => {
                const trackEl = createTrackElement(track, 2, idx + 1, folder.tracks.length);
                trackEl.classList.add('in-folder');
                if (isCollapsed) {
                    trackEl.classList.add('collapsed-child');
                }
                trackTree.appendChild(trackEl);
                addTrackButtons(track, isCollapsed);
            });
        });

        // Render root-level tracks
        tree.rootTracks.forEach(track => {
            rootPos++;
            const trackEl = createTrackElement(track, 1, rootPos, rootSetSize);
            trackTree.appendChild(trackEl);
            addTrackButtons(track, false);
        });

        // Update aria-activedescendant
        updateAriaActiveDescendant();

        // Update UI state
        const hasTrack = tracks.length > 0;
        emptyMessage.hidden = hasTrack;
        trackCount.textContent = `(${tracks.length})`;
        randomizeBtn.disabled = tracks.length < 2 || isBurning;
        clearBtn.disabled = !hasTrack || isBurning;
        updateBurnButton();
    }

    // Create folder header element
    function createFolderHeader(folder, level, posInSet, setSize) {
        const isCollapsed = collapsedFolders.has(folder.path);
        const folderId = `folder:${folder.path}`;
        const isSelected = selectedId === folderId;
        const totalDuration = folder.tracks.reduce((sum, t) => sum + t.duration, 0);

        const header = document.createElement('div');
        header.className = 'tree-folder-header';
        header.id = `treeitem-folder-${folder.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
        header.setAttribute('role', 'treeitem');
        header.setAttribute('aria-expanded', String(!isCollapsed));
        header.setAttribute('aria-selected', String(isSelected));
        header.setAttribute('aria-level', String(level));
        header.setAttribute('aria-setsize', String(setSize));
        header.setAttribute('aria-posinset', String(posInSet));
        header.setAttribute('aria-label', `${folder.path}, ${folder.tracks.length} tracks, ${formatDuration(totalDuration)}`);
        header.dataset.id = folderId;

        header.innerHTML = `
            <span class="folder-icon" aria-hidden="true">${isCollapsed ? '▶' : '▼'}</span>
            <span class="folder-name">${escapeHtml(folder.path)}</span>
            <span class="folder-count">(${folder.tracks.length})</span>
            <span class="folder-duration">${formatDuration(totalDuration)}</span>
        `;

        header.addEventListener('click', () => selectItem(folderId));
        header.addEventListener('dblclick', () => toggleFolder(folder.path));

        return header;
    }

    // Create track element
    function createTrackElement(track, level, posInSet, setSize) {
        const isSelected = selectedId === track.id;

        const item = document.createElement('div');
        item.className = 'tree-track';
        item.id = `treeitem-track-${track.id}`;
        item.setAttribute('role', 'treeitem');
        item.setAttribute('aria-selected', String(isSelected));
        item.setAttribute('aria-level', String(level));
        item.setAttribute('aria-setsize', String(setSize));
        item.setAttribute('aria-posinset', String(posInSet));
        item.setAttribute('aria-label', `${track.index + 1}. ${track.name}, ${formatDuration(track.duration)}`);
        item.dataset.id = track.id;
        item.dataset.index = track.index;

        item.innerHTML = `
            <span class="track-number">${track.index + 1}.</span>
            <span class="track-name">${escapeHtml(track.name)}</span>
            <span class="track-duration">${formatDuration(track.duration)}</span>
        `;

        item.addEventListener('click', () => selectItem(track.id));

        return item;
    }

    // Add folder buttons to separate containers
    function addFolderButtons(folder) {
        const folderId = `folder:${folder.path}`;
        const isSelected = selectedId === folderId;
        const tabIdx = isSelected ? '0' : '-1';
        const ariaHid = isSelected ? 'false' : 'true';

        // Play - spacer
        const playSpacer = document.createElement('div');
        playSpacer.className = 'btn-spacer';
        playSpacer.dataset.id = folderId;
        playButtonsContainer.appendChild(playSpacer);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'tree-delete';
        delBtn.tabIndex = tabIdx;
        delBtn.setAttribute('aria-hidden', ariaHid);
        delBtn.setAttribute('aria-label', `Delete folder ${folder.path}`);
        delBtn.textContent = '×';
        delBtn.dataset.id = folderId;
        delBtn.addEventListener('click', () => deleteFolder(folder.path));
        deleteButtonsContainer.appendChild(delBtn);

        // Download - spacer
        const dlSpacer = document.createElement('div');
        dlSpacer.className = 'btn-spacer';
        dlSpacer.dataset.id = folderId;
        downloadButtonsContainer.appendChild(dlSpacer);
    }

    // Add track buttons to separate containers
    function addTrackButtons(track, inCollapsedFolder) {
        const isSelected = selectedId === track.id;
        const isPlaying = playingTrackId === track.id;
        const tabIdx = isSelected ? '0' : '-1';
        const ariaHid = isSelected ? 'false' : 'true';
        const hiddenClass = inCollapsedFolder ? ' hidden' : '';

        // Play button
        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'tree-play' + hiddenClass;
        playBtn.tabIndex = tabIdx;
        playBtn.setAttribute('aria-hidden', ariaHid);
        playBtn.setAttribute('aria-label', `${isPlaying ? 'Stop' : 'Play'} ${track.name}`);
        playBtn.textContent = isPlaying ? '■' : '▶';
        playBtn.dataset.id = track.id;
        playBtn.addEventListener('click', () => togglePlay(track.id, track.name));
        playButtonsContainer.appendChild(playBtn);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'tree-delete' + hiddenClass;
        delBtn.tabIndex = tabIdx;
        delBtn.setAttribute('aria-hidden', ariaHid);
        delBtn.setAttribute('aria-label', `Delete ${track.name}`);
        delBtn.textContent = '×';
        delBtn.dataset.id = track.id;
        delBtn.addEventListener('click', () => deleteTrackById(track.id));
        deleteButtonsContainer.appendChild(delBtn);

        // Download button
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'tree-download' + hiddenClass;
        dlBtn.tabIndex = tabIdx;
        dlBtn.setAttribute('aria-hidden', ariaHid);
        dlBtn.setAttribute('aria-label', `Download ${track.name}`);
        dlBtn.textContent = '↓';
        dlBtn.dataset.id = track.id;
        dlBtn.addEventListener('click', () => downloadTrack(track.id));
        downloadButtonsContainer.appendChild(dlBtn);
    }

    // Update aria-activedescendant on tree
    function updateAriaActiveDescendant() {
        if (selectedId) {
            const selectedEl = trackTree.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
            if (selectedEl && selectedEl.id) {
                trackTree.setAttribute('aria-activedescendant', selectedEl.id);
            } else {
                trackTree.removeAttribute('aria-activedescendant');
            }
        } else {
            trackTree.removeAttribute('aria-activedescendant');
        }
    }

    // Toggle folder collapse state
    function toggleFolder(folderPath) {
        if (collapsedFolders.has(folderPath)) {
            collapsedFolders.delete(folderPath);
        } else {
            collapsedFolders.add(folderPath);
        }
        renderTracks();
    }

    // Select an item (track or folder)
    function selectItem(id) {
        selectedId = id;

        // Update all treeitems
        trackTree.querySelectorAll('[role="treeitem"]').forEach(item => {
            const isSelected = item.dataset.id === id;
            item.setAttribute('aria-selected', String(isSelected));
        });

        // Update aria-activedescendant
        updateAriaActiveDescendant();

        // Update all buttons in separate containers
        [playButtonsContainer, deleteButtonsContainer, downloadButtonsContainer].forEach(container => {
            container.querySelectorAll('button, .btn-spacer').forEach(el => {
                const isSelected = el.dataset.id === id;
                if (el.tagName === 'BUTTON') {
                    el.tabIndex = isSelected ? 0 : -1;
                    el.setAttribute('aria-hidden', isSelected ? 'false' : 'true');
                }
            });
        });

        trackTree.focus();
    }

    // Select track by index (for compatibility)
    function selectTrack(index) {
        if (index < 0 || index >= tracks.length) return;
        selectItem(tracks[index].id);
    }

    // Get currently selected track index
    function getSelectedTrackIndex() {
        if (!selectedId || selectedId.startsWith('folder:')) return -1;
        return tracks.findIndex(t => t.id === selectedId);
    }

    // Delete track by ID
    async function deleteTrackById(trackId) {
        if (isBurning) return;

        const index = tracks.findIndex(t => t.id === trackId);
        if (index === -1) return;

        const track = tracks[index];

        // Stop playback if this track is playing
        if (playingTrackId === track.id) {
            stopPlayback();
        }

        try {
            await fetch(`/track/${track.id}`, { method: 'DELETE' });

            tracks.splice(index, 1);
            renderTracks();
            updateCapacity();

            showStatus(`Removed: ${track.name}`);
        } catch (error) {
            showStatus('Failed to delete track', 'error');
        }
    }

    // Delete all tracks in a folder
    async function deleteFolder(folderPath) {
        if (isBurning) return;

        const folderTracks = tracks.filter(t => t.folder === folderPath);
        if (folderTracks.length === 0) return;

        // Stop playback if any track in folder is playing
        if (folderTracks.some(t => t.id === playingTrackId)) {
            stopPlayback();
        }

        try {
            // Delete all tracks in folder
            await Promise.all(folderTracks.map(t =>
                fetch(`/track/${t.id}`, { method: 'DELETE' })
            ));

            // Remove from local state
            tracks = tracks.filter(t => t.folder !== folderPath);
            collapsedFolders.delete(folderPath);
            selectedId = null;

            renderTracks();
            updateCapacity();

            showStatus(`Removed folder: ${folderPath} (${folderTracks.length} tracks)`);
        } catch (error) {
            showStatus('Failed to delete folder', 'error');
        }
    }

    // Delete track (legacy index-based, for keyboard nav)
    async function deleteTrack(index) {
        if (index < 0 || index >= tracks.length) return;
        await deleteTrackById(tracks[index].id);
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
        playButtonsContainer.querySelectorAll('.tree-play').forEach((playBtn) => {
            const trackId = playBtn.dataset.id;
            const track = tracks.find(t => t.id === trackId);
            const isPlaying = trackId === playingTrackId;

            playBtn.textContent = isPlaying ? '■' : '▶';
            playBtn.setAttribute('aria-label', `${isPlaying ? 'Stop' : 'Play'} ${track ? track.name : ''}`);
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

        renderTracks();
        selectItem(track.id);
    }

    // Get list of visible tree item IDs in order
    function getVisibleItemIds() {
        const ids = [];
        trackTree.querySelectorAll('[role="treeitem"]').forEach(item => {
            // Skip collapsed children
            if (item.classList.contains('collapsed-child')) {
                return;
            }
            ids.push(item.dataset.id);
        });
        return ids;
    }

    // Keyboard navigation
    function setupKeyboardNav() {
        // When tree receives focus, select first item if nothing selected
        trackTree.addEventListener('focus', () => {
            if (tracks.length > 0 && !selectedId) {
                const ids = getVisibleItemIds();
                if (ids.length > 0) selectItem(ids[0]);
            }
        });

        trackTree.addEventListener('keydown', (e) => {
            if (isBurning) return;
            if (tracks.length === 0) return;

            // Don't interfere with system shortcuts (Ctrl+V, Ctrl+C, etc.)
            if (e.ctrlKey || e.metaKey) return;

            const key = e.key;
            const alt = e.altKey;
            const ids = getVisibleItemIds();
            const currentIdx = ids.indexOf(selectedId);

            // Navigation without Alt
            if (!alt) {
                if (key === 'ArrowDown') {
                    e.preventDefault();
                    if (currentIdx < ids.length - 1) {
                        selectItem(ids[currentIdx + 1]);
                    }
                } else if (key === 'ArrowUp') {
                    e.preventDefault();
                    if (currentIdx > 0) {
                        selectItem(ids[currentIdx - 1]);
                    }
                } else if (key === 'Home') {
                    e.preventDefault();
                    if (ids.length > 0) selectItem(ids[0]);
                } else if (key === 'End') {
                    e.preventDefault();
                    if (ids.length > 0) selectItem(ids[ids.length - 1]);
                } else if (key === 'Delete' || key === 'Backspace') {
                    e.preventDefault();
                    if (selectedId) {
                        if (selectedId.startsWith('folder:')) {
                            deleteFolder(selectedId.replace('folder:', ''));
                        } else {
                            deleteTrackById(selectedId);
                        }
                    }
                } else if (key === ' ') {
                    e.preventDefault();
                    const trackIdx = getSelectedTrackIndex();
                    if (trackIdx >= 0) {
                        const track = tracks[trackIdx];
                        togglePlay(track.id, track.name);
                    }
                } else if (key === 'Enter' || key === 'ArrowRight') {
                    e.preventDefault();
                    // Expand folder
                    if (selectedId && selectedId.startsWith('folder:')) {
                        const folderPath = selectedId.replace('folder:', '');
                        if (collapsedFolders.has(folderPath)) {
                            collapsedFolders.delete(folderPath);
                            renderTracks();
                            selectItem(selectedId);
                        }
                    }
                } else if (key === 'ArrowLeft') {
                    e.preventDefault();
                    // Collapse folder or go to parent folder
                    if (selectedId && selectedId.startsWith('folder:')) {
                        const folderPath = selectedId.replace('folder:', '');
                        if (!collapsedFolders.has(folderPath)) {
                            collapsedFolders.add(folderPath);
                            renderTracks();
                            selectItem(selectedId);
                        }
                    } else if (selectedId) {
                        // Track selected - go to parent folder
                        const track = tracks.find(t => t.id === selectedId);
                        if (track && track.folder) {
                            selectItem(`folder:${track.folder}`);
                        }
                    }
                }
                return;
            }

            // Track movement with Alt
            const trackIdx = getSelectedTrackIndex();
            if (trackIdx < 0) return;

            if (key === 'ArrowUp') {
                e.preventDefault();
                moveTrack(trackIdx, trackIdx - 1);
            } else if (key === 'ArrowDown') {
                e.preventDefault();
                moveTrack(trackIdx, trackIdx + 1);
            } else if (key === 'Home') {
                e.preventDefault();
                moveTrack(trackIdx, 0);
            } else if (key === 'End') {
                e.preventDefault();
                moveTrack(trackIdx, tracks.length - 1);
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
                    tracks = data.tracks.map(t => ({
                        id: t.id,
                        name: t.name,
                        duration: t.duration,
                        folder: t.folder || '',
                        size: t.size || 0,
                    }));
                    selectedId = null;
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
                selectedId = null;
                collapsedFolders.clear();
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
            } else {
                cdCapacity = data.default_capacity;
                hasDisc = false;
            }

            if (data.data_capacity !== null) {
                dataCapacity = data.data_capacity;
            } else {
                dataCapacity = data.default_data_capacity;
            }

            updateDiscStatus();
            updateCapacity();
            updateBurnButton();
        } catch (error) {
            console.error('CD info check failed:', error);
        }
    }

    // Update disc status display based on CD type
    function updateDiscStatus() {
        if (cdType === 'mp3') {
            if (hasDisc) {
                discStatus.textContent = `Disc detected: ${dataCapacity} MB capacity`;
                discStatus.className = 'disc-present';
            } else {
                discStatus.textContent = 'No disc detected. Using default 700 MB capacity.';
                discStatus.className = 'disc-absent';
            }
        } else {
            if (hasDisc) {
                discStatus.textContent = `Disc detected: ${formatDuration(cdCapacity)} capacity`;
                discStatus.className = 'disc-present';
            } else {
                discStatus.textContent = 'No disc detected. Using default 80 min capacity.';
                discStatus.className = 'disc-absent';
            }
        }
    }

    // Update capacity display
    function updateCapacity() {
        updateDiscStatus();

        if (cdType === 'mp3') {
            updateCapacityMp3();
        } else {
            updateCapacityAudio();
        }

        updateBurnButton();
    }

    // Update capacity display for Audio CD mode (time-based)
    function updateCapacityAudio() {
        const trackDuration = tracks.reduce((sum, t) => sum + t.duration, 0);
        // Add 2 seconds per gap (between tracks, so tracks - 1) when enabled
        const gapTime = trackGaps.checked && tracks.length > 1 ? (tracks.length - 1) * 2 : 0;
        const totalDuration = trackDuration + gapTime;
        const percent = cdCapacity > 0 ? Math.round((totalDuration / cdCapacity) * 100) : 0;
        const isOver = totalDuration > cdCapacity;

        capacityProgress.max = Math.round(cdCapacity / 60);
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
    }

    // Update capacity display for MP3 CD mode (size-based)
    function updateCapacityMp3() {
        // Sum file sizes in bytes, convert to MB
        const totalBytes = tracks.reduce((sum, t) => sum + (t.size || 0), 0);
        const totalMB = Math.round(totalBytes / (1024 * 1024));
        const percent = dataCapacity > 0 ? Math.round((totalMB / dataCapacity) * 100) : 0;
        const isOver = totalMB > dataCapacity;

        capacityProgress.max = dataCapacity;
        capacityProgress.value = Math.min(totalMB, dataCapacity);
        capacityProgress.dataset.over = isOver ? 'true' : 'false';

        const capacityStr = `${totalMB} MB / ${dataCapacity} MB (${percent}%)`;
        capacityText.textContent = capacityStr;

        // Update page title with capacity
        document.title = `Burping Slug's Retro CD Burner - ${capacityStr}`;

        if (isOver) {
            capacityText.style.color = 'var(--color-danger)';
        } else {
            capacityText.style.color = '';
        }
    }

    // Update burn button state
    function updateBurnButton() {
        let canBurn = false;
        let reason = '';

        if (tracks.length === 0) {
            reason = 'Add tracks to burn';
        } else if (isBurning) {
            reason = 'Burn in progress';
        } else if (cdType === 'mp3') {
            // MP3 mode: check size
            const totalBytes = tracks.reduce((sum, t) => sum + (t.size || 0), 0);
            const totalMB = Math.round(totalBytes / (1024 * 1024));
            if (totalMB > dataCapacity) {
                reason = 'Total size exceeds disc capacity';
            } else {
                canBurn = true;
            }
        } else {
            // Audio mode: check duration
            const trackDuration = tracks.reduce((sum, t) => sum + t.duration, 0);
            const gapTime = trackGaps.checked && tracks.length > 1 ? (tracks.length - 1) * 2 : 0;
            const totalDuration = trackDuration + gapTime;
            if (totalDuration > cdCapacity) {
                reason = 'Total duration exceeds disc capacity';
            } else {
                canBurn = true;
            }
        }

        burnBtn.disabled = !canBurn;
        burnBtn.title = reason;
    }

    // Start burn process using Server-Sent Events
    function startBurn() {
        if (isBurning || tracks.length === 0) return;

        isBurning = true;
        renderTracks();
        updateBurnButton();

        statusDiv.textContent = '';  // Clear status to avoid duplication
        progressContainer.hidden = false;
        burnProgress.value = 0;
        progressText.textContent = 'Starting burn process...';

        const url = `/burn?dummy=${dummyMode.checked}&gaps=${trackGaps.checked}&cd_type=${cdType}`;
        const eventSource = new EventSource(url);

        eventSource.addEventListener('progress', (e) => {
            const data = JSON.parse(e.data);
            progressText.textContent = data.message;
            burnProgress.value = data.percent;
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
