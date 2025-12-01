// State
const state = {
    media: [],
    tracks: {
        video: [], // { id, fileId, start, duration, offset }
        audio: []
    },
    playbackTime: 0,
    isPlaying: false,
    zoom: 10, // pixels per second
    selectedClipId: null
};

const historyStack = [];
const redoStack = [];
let isDraggingClip = false;
let dragClipId = null;
let dragStartX = 0;
let dragOriginalStartTime = 0;

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-upload');
const mediaList = document.getElementById('media-list');
const timelineTracks = document.getElementById('timeline-tracks');
const playhead = document.getElementById('playhead');
const mainVideo = document.getElementById('main-video');
const playPauseBtn = document.getElementById('play-pause-btn');
const timeDisplay = document.getElementById('time-display');
const exportBtn = document.getElementById('export-btn');

// Constants
const TRACK_HEIGHT = 50;
const audioPool = {}; // clipId -> AudioElement
let mainVideoSource = null; // Persistent MediaElementSource for mainVideo

// Initialization
function init() {
    setupDragAndDrop();
    setupTimelineInteraction();
    setupToolbar();
    setupExport();
    setupMobileUI();
    requestAnimationFrame(renderLoop);
}

function saveState() {
    // Deep copy state (excluding media objects which are large and constant mostly, but their list is small)
    // Actually, we need to save tracks mostly. Media list modifications (additions) are additive.
    // For simplicity, we deep clone the tracks.
    const snapshot = {
        tracks: JSON.parse(JSON.stringify(state.tracks)),
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    };
    historyStack.push(snapshot);
    redoStack.length = 0; // clear redo

    if (historyStack.length > 50) historyStack.shift(); // Limit history
}

function restoreState(snapshot) {
    state.tracks = JSON.parse(JSON.stringify(snapshot.tracks));
    state.selectedClipId = snapshot.selectedClipId;
    state.playbackTime = snapshot.playbackTime;
    state.zoom = snapshot.zoom;
    renderTimeline();
    seek(state.playbackTime);
}

function undo() {
    if (historyStack.length === 0) return;
    const currentSnapshot = {
        tracks: JSON.parse(JSON.stringify(state.tracks)),
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    };
    redoStack.push(currentSnapshot);

    const snapshot = historyStack.pop();
    restoreState(snapshot);
}

function redo() {
    if (redoStack.length === 0) return;
    const currentSnapshot = {
        tracks: JSON.parse(JSON.stringify(state.tracks)),
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    };
    historyStack.push(currentSnapshot);

    const snapshot = redoStack.pop();
    restoreState(snapshot);
}

function setupMobileUI() {
    const toggle = document.createElement('button');
    toggle.textContent = '📁 Media';
    toggle.className = 'mobile-media-toggle';
    toggle.style.position = 'absolute';
    toggle.style.top = '50px'; // Below top bar
    toggle.style.left = '10px';
    toggle.style.zIndex = '100';
    toggle.style.display = 'none'; // Hidden on desktop via CSS (or JS check)

    // Add to body
    document.body.appendChild(toggle);

    // Show on mobile
    if (window.innerWidth <= 768) {
        toggle.style.display = 'block';
    }

    toggle.addEventListener('click', () => {
        const lib = document.getElementById('media-library');
        if (lib.style.display === 'flex') {
            lib.style.display = 'none';
        } else {
            lib.style.display = 'flex';
            lib.style.position = 'absolute';
            lib.style.top = '40px';
            lib.style.left = '0';
            lib.style.bottom = '200px'; // Above timeline
            lib.style.width = '200px';
            lib.style.zIndex = '90';
        }
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth <= 768) {
            toggle.style.display = 'block';
        } else {
            toggle.style.display = 'none';
            document.getElementById('media-library').style.display = 'flex'; // Reset
            document.getElementById('media-library').style.position = '';
        }
    });
}

// Media Handling
function setupDragAndDrop() {
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFiles);

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#00d2ff';
    });

    dropZone.addEventListener('dragleave', (e) => {
        dropZone.style.borderColor = '#333';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#333';
        handleFiles({ target: { files: e.dataTransfer.files } });
    });
}

function handleFiles(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => {
        const url = URL.createObjectURL(file);
        const type = file.type.startsWith('video') ? 'video' : 'audio';
        const id = Date.now() + Math.random().toString(36).substr(2, 9);

        // Get duration
        const element = document.createElement(type === 'video' ? 'video' : 'audio');
        element.preload = 'metadata';
        element.onloadedmetadata = () => {
            const item = {
                id,
                file,
                url,
                type,
                name: file.name,
                duration: element.duration
            };
            state.media.push(item);
            addMediaToLibrary(item);
        };
        element.src = url;
    });
}

function addMediaToLibrary(item) {
    const div = document.createElement('div');
    div.className = 'media-item';
    div.textContent = item.name;
    div.draggable = true;
    div.dataset.id = item.id;

    // Drag support
    div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(item));
    });

    // Mobile/Click support (fallback for iOS)
    div.addEventListener('click', (e) => {
        // Simple visual feedback
        div.style.background = '#00d2ff';
        setTimeout(() => div.style.background = '#333', 200);

        // Add to timeline at current playhead position
        addClipToTimeline(item, state.playbackTime);
    });

    mediaList.appendChild(div);
}

// Timeline Handling
function setupTimelineInteraction() {
    timelineTracks.addEventListener('dragover', (e) => e.preventDefault());
    timelineTracks.addEventListener('drop', (e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if (!data) return;
        const item = JSON.parse(data);

        const rect = timelineTracks.getBoundingClientRect();
        const x = e.clientX - rect.left + timelineTracks.scrollLeft;
        const startTime = x / state.zoom;

        addClipToTimeline(item, startTime);
    });

    timelineTracks.addEventListener('mousedown', handleClipMouseDown);
    timelineTracks.addEventListener('touchstart', handleClipMouseDown, {passive: false});

    // We attach move/up to window to handle drags outside container
    window.addEventListener('mousemove', handleClipMouseMove);
    window.addEventListener('touchmove', handleClipMouseMove, {passive: false});
    window.addEventListener('mouseup', handleClipMouseUp);
    window.addEventListener('touchend', handleClipMouseUp);

    // Zoom interactions
    timelineTracks.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const zoomChange = e.deltaY > 0 ? 0.9 : 1.1;
            zoom(state.zoom * zoomChange, e.clientX);
        }
    });

    // Pinch Zoom (Mobile)
    let initialPinchDist = 0;
    timelineTracks.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
             initialPinchDist = Math.hypot(
                 e.touches[0].pageX - e.touches[1].pageX,
                 e.touches[0].pageY - e.touches[1].pageY
             );
        }
    }, {passive: false});

    timelineTracks.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && initialPinchDist > 0) {
            e.preventDefault();
            const dist = Math.hypot(
                 e.touches[0].pageX - e.touches[1].pageX,
                 e.touches[0].pageY - e.touches[1].pageY
            );
            const zoomChange = dist / initialPinchDist;
            // Dampen
            const newZoom = state.zoom * (zoomChange > 1 ? 1.02 : 0.98);
            zoom(newZoom, (e.touches[0].pageX + e.touches[1].pageX)/2);
            initialPinchDist = dist;
        }
    }, {passive: false});

    // Click / Seek
    timelineTracks.addEventListener('click', (e) => {
        // Prevent seeking if we just finished dragging
        if (isDraggingClip) return;

        if (e.target.closest('.clip')) {
            selectClip(e.target.closest('.clip').dataset.clipId);
        } else {
            selectClip(null);
            const rect = timelineTracks.getBoundingClientRect();
            const x = e.clientX - rect.left + timelineTracks.scrollLeft;
            seek(x / state.zoom);
        }
    });
}

function handleClipMouseDown(e) {
    const clipEl = e.target.closest('.clip');
    if (!clipEl) return;

    // If dragging scrollbar (mobile), ignore?
    // Start Drag
    isDraggingClip = true;
    dragClipId = clipEl.dataset.clipId;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    dragStartX = clientX;

    // Find clip model
    const type = clipEl.dataset.type;
    const clip = state.tracks[type].find(c => c.id === dragClipId);
    dragOriginalStartTime = clip.startTime;

    selectClip(dragClipId);
}

function handleClipMouseMove(e) {
    if (!isDraggingClip || !dragClipId) return;
    e.preventDefault();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const deltaX = clientX - dragStartX;
    const deltaTime = deltaX / state.zoom;

    // Update clip position
    let type = 'video';
    let clip = state.tracks.video.find(c => c.id === dragClipId);
    if (!clip) {
        type = 'audio';
        clip = state.tracks.audio.find(c => c.id === dragClipId);
    }

    if (clip) {
        clip.startTime = Math.max(0, dragOriginalStartTime + deltaTime);
        // Visual update only? Or full render?
        // Full render is safer for keeping UI in sync, though heavier.
        // Optimization: just update style left
        const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
        if (el) {
            el.style.left = (clip.startTime * state.zoom) + 'px';
        }
    }
}

function handleClipMouseUp(e) {
    if (isDraggingClip) {
        isDraggingClip = false;
        // Finalize state (render ruler updates, overlap checks etc)
        renderTimeline();
    }
}

function zoom(newZoom, centerClientX) {
    // Zoom around center
    const rect = timelineTracks.getBoundingClientRect();
    const mouseX = (centerClientX || (rect.left + rect.width/2)) - rect.left;
    const timeAtMouse = (mouseX + timelineTracks.scrollLeft) / state.zoom;

    const oldZoom = state.zoom;
    state.zoom = Math.max(1, Math.min(200, newZoom)); // Clamp

    // Re-render visuals if zoom changed significantly (e.g., > 20%) to fix stretching
    if (Math.abs(state.zoom - oldZoom) / oldZoom > 0.2) {
        document.querySelectorAll('.track').forEach(t => t.innerHTML = '');

        // Performance: Clear queue if zooming, old thumbs are likely wrong resolution/density
        thumbQueue.length = 0;
    }

    renderTimeline();

    const newScroll = (timeAtMouse * state.zoom) - mouseX;
    timelineTracks.scrollLeft = Math.max(0, newScroll);
}

function addClipToTimeline(mediaItem, startTime) {
    saveState();
    const clipId = 'clip_' + Date.now();
    const clip = {
        id: clipId,
        mediaId: mediaItem.id,
        startTime: Math.max(0, startTime),
        duration: mediaItem.duration,
        offset: 0, // content offset
        type: mediaItem.type,
        muted: false
    };

    // Determine track
    const trackName = mediaItem.type; // 'video' or 'audio'
    state.tracks[trackName].push(clip);
    renderTimeline();
}

function renderTimeline() {
    // Smart Render: Sync DOM with State instead of wipe/recreate

    ['video', 'audio'].forEach(type => {
        const trackEl = document.querySelector(`.track[data-type="${type}"]`);
        const existingEls = Array.from(trackEl.children);
        const clips = state.tracks[type];

        // 1. Remove DOM elements for deleted clips
        existingEls.forEach(el => {
            const id = el.dataset.clipId;
            if (!clips.find(c => c.id === id)) {
                el.remove();
            }
        });

        // 2. Add or Update clips
        clips.forEach(clip => {
            let el = trackEl.querySelector(`.clip[data-clip-id="${clip.id}"]`);
            const width = clip.duration * state.zoom;
            const left = clip.startTime * state.zoom;

            if (!el) {
                // Create New
                el = document.createElement('div');
                el.className = 'clip';
                el.dataset.clipId = clip.id;
                el.dataset.type = type;
                // Store stats for smart update checks
                el.dataset.renderedDuration = clip.duration;
                el.dataset.renderedOffset = clip.offset;

                // Content
                const media = state.media.find(m => m.id === clip.mediaId);

                const label = document.createElement('span');
                label.className = 'clip-label';
                label.textContent = media ? media.name : 'Unknown';
                el.appendChild(label);

                if (media) {
                    if (type === 'audio') {
                        drawWaveform(media, clip, el);
                    } else if (type === 'video') {
                        drawVideoThumbnails(media, clip, el);
                    }
                }

                trackEl.appendChild(el);
            } else {
                // Check if internal Visuals need Regen (e.g. Split or Resize)
                // If duration or offset changed, the bitmap must be redrawn or it stretches incorrect data
                const oldDuration = parseFloat(el.dataset.renderedDuration);
                const oldOffset = parseFloat(el.dataset.renderedOffset);

                // Tolerance for float comparison
                if (Math.abs(oldDuration - clip.duration) > 0.01 || Math.abs(oldOffset - clip.offset) > 0.01) {
                    // Update stats
                    el.dataset.renderedDuration = clip.duration;
                    el.dataset.renderedOffset = clip.offset;

                    // Clear and Re-render visuals
                    el.innerHTML = '';

                    const media = state.media.find(m => m.id === clip.mediaId);
                    const label = document.createElement('span');
                    label.className = 'clip-label';
                    label.textContent = media ? media.name : 'Unknown';
                    el.appendChild(label);

                    if (media) {
                        if (type === 'audio') {
                            drawWaveform(media, clip, el);
                        } else if (type === 'video') {
                            drawVideoThumbnails(media, clip, el);
                        }
                    }
                }
            }

            // Update Visuals
            el.style.left = left + 'px';
            el.style.width = width + 'px';

            if (state.selectedClipId === clip.id) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });
    });

    // Update container width
    const maxTime = Math.max(
        ...state.tracks.video.map(c => c.startTime + c.duration),
        ...state.tracks.audio.map(c => c.startTime + c.duration),
        10 // min 10 seconds
    );
    timelineTracks.style.width = (maxTime * state.zoom + 500) + 'px';

    renderRuler(maxTime + 10);
}

function renderRuler(duration) {
    const ruler = document.getElementById('time-ruler');
    ruler.style.width = timelineTracks.style.width;
    ruler.innerHTML = ''; // Clear

    // Determine tick interval
    // If zoom is high (100px/s), show every second.
    // If zoom is low (10px/s), show every 10 seconds.
    let interval = 1;
    if (state.zoom < 20) interval = 5;
    if (state.zoom < 5) interval = 10;

    const stepPx = interval * state.zoom;

    for (let t = 0; t <= duration; t += interval) {
        const tick = document.createElement('div');
        tick.className = 'ruler-tick';
        tick.style.left = (t * state.zoom) + 'px';

        const label = document.createElement('span');
        const m = Math.floor(t / 60);
        const s = t % 60;
        label.textContent = `${m}:${s.toString().padStart(2, '0')}`;

        tick.appendChild(label);
        ruler.appendChild(tick);
    }
}

// Visuals Cache
const waveformCache = {}; // mediaId -> AudioBuffer
const thumbnailCache = {}; // mediaId_offset_zoom -> DataURL

// Shared Video Element for Thumbnail Generation
let sharedThumbVideo = null;

async function drawWaveform(media, clip, container) {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

    let buffer = waveformCache[media.id];

    // Fetch if not cached
    if (!buffer) {
        try {
            const response = await fetch(media.url);
            const arrayBuffer = await response.arrayBuffer();
            buffer = await audioContext.decodeAudioData(arrayBuffer);
            waveformCache[media.id] = buffer;
        } catch (e) {
            console.error("Error loading waveform", e);
            return;
        }
    }

    // Draw
    const canvas = document.createElement('canvas');
    canvas.className = 'clip-waveform';
    const width = clip.duration * state.zoom;
    const height = TRACK_HEIGHT;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    const data = buffer.getChannelData(0);
    // const step = Math.ceil(data.length / width); // simplified sampling
    // Actually we need to respect clip.offset

    const startSample = Math.floor(clip.offset * buffer.sampleRate);
    const endSample = Math.floor((clip.offset + clip.duration) * buffer.sampleRate);
    const totalSamples = endSample - startSample;
    const samplesPerPixel = Math.floor(totalSamples / width);

    ctx.fillStyle = '#1e1e2f'; // bg matching theme slightly
    ctx.strokeStyle = '#000'; // dark wave on bright clip
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
        const index = startSample + (x * samplesPerPixel);
        if (index >= buffer.length) break;

        // Find max amplitude in this bucket
        let max = 0;
        // Optimization: Don't scan entire bucket if it's huge, step through it
        const bucketStep = Math.ceil(samplesPerPixel / 10);
        for (let j = 0; j < samplesPerPixel; j += bucketStep) {
            if (index + j < buffer.length) {
                 const val = Math.abs(data[index + j]);
                 if (val > max) max = val;
            }
        }

        const h = max * height;
        const y = (height - h) / 2;

        ctx.moveTo(x, y);
        ctx.lineTo(x, y + h);
    }
    ctx.stroke();

    // Append behind text
    container.insertBefore(canvas, container.firstChild);
}

function drawVideoThumbnails(media, clip, container) {
    // Generate filmstrip
    // We want a thumbnail every ~150px or so to save performance
    const clipWidth = clip.duration * state.zoom;
    const thumbIntervalPx = 150;
    const numThumbs = Math.ceil(clipWidth / thumbIntervalPx);
    const thumbWidth = clipWidth / numThumbs;

    const strip = document.createElement('div');
    strip.className = 'clip-filmstrip';
    container.insertBefore(strip, container.firstChild);

    // Use shared video element to avoid memory explosion
    if (!sharedThumbVideo) {
        sharedThumbVideo = document.createElement('video');
        sharedThumbVideo.muted = true;
        sharedThumbVideo.style.display = 'none';
        document.body.appendChild(sharedThumbVideo);
    }

    // Performance: Only render thumbnails if visible in viewport
    // Calculate clip's left and right in container
    // We don't have exact DOM rects here easily without querying, but we know logical position
    const containerScroll = timelineTracks.parentElement.scrollLeft;
    const containerWidth = timelineTracks.parentElement.clientWidth;
    const clipLeft = clip.startTime * state.zoom;
    const clipRight = (clip.startTime + clip.duration) * state.zoom;

    // Simple check: is clip visible?
    if (clipRight < containerScroll || clipLeft > containerScroll + containerWidth) {
        // Clip not visible, skip generating thumbnails
        return;
    }

    for (let i = 0; i < numThumbs; i++) {
        const thumbOffset = i * thumbWidth;
        const thumbAbsLeft = clipLeft + thumbOffset;

        // Visibility Check Per Thumbnail (Optimization)
        // Only generate/append if this specific thumbnail segment is visible
        if (thumbAbsLeft + thumbWidth < containerScroll || thumbAbsLeft > containerScroll + containerWidth) {
            continue;
        }

        const thumbTime = clip.offset + (i * (clip.duration / numThumbs));
        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'video-thumb';
        thumbDiv.style.width = thumbWidth + 'px';
        // Absolute position within strip if we skipped some? No, strip is flex.
        // If we skip, flex layout breaks. We must position absolutely or fill gaps.
        // Easier: Use absolute positioning for thumbs inside strip.
        thumbDiv.style.position = 'absolute';
        thumbDiv.style.left = thumbOffset + 'px';
        thumbDiv.style.height = '100%';

        strip.appendChild(thumbDiv);

        // Check cache first
        const cacheKey = `${media.id}_${Math.floor(thumbTime * 10)}`; // Cache by 0.1s precision
        if (thumbnailCache[cacheKey]) {
            thumbDiv.style.backgroundImage = `url(${thumbnailCache[cacheKey]})`;
        } else {
             // Request generation
             captureThumbnail(media.url, thumbTime, cacheKey).then(url => {
                if (url) thumbDiv.style.backgroundImage = `url(${url})`;
            });
        }
    }
}

// Queue system for thumbnail generation to prevent locking UI
const thumbQueue = [];
let isProcessingThumbs = false;

function captureThumbnail(url, time, cacheKey) {
    return new Promise((resolve) => {
        thumbQueue.push({ url, time, cacheKey, resolve });
        processThumbQueue();
    });
}

function processThumbQueue() {
    // 1. Performance Guard: Don't process thumbnails while playing video
    if (state.isPlaying) {
        // Retry later
        setTimeout(processThumbQueue, 500);
        return;
    }

    if (isProcessingThumbs || thumbQueue.length === 0) return;
    isProcessingThumbs = true;

    const task = thumbQueue.shift();

    // 2. Queue Optimization: If queue gets too huge (>50), drop old frames to catch up
    if (thumbQueue.length > 50) {
        // Keep the last 20 (most likely to be visible/recent)
        thumbQueue.splice(0, thumbQueue.length - 20);
    }

    if (sharedThumbVideo.src !== task.url) {
        sharedThumbVideo.src = task.url;
    }

    // Handle seek
    sharedThumbVideo.currentTime = task.time;

    const onSeek = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 80; // Reduced res for better performance (was 160)
        canvas.height = 45;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(sharedThumbVideo, 0, 0, canvas.width, canvas.height);
        const dataURL = canvas.toDataURL();

        thumbnailCache[task.cacheKey] = dataURL;
        task.resolve(dataURL);

        sharedThumbVideo.removeEventListener('seeked', onSeek);
        isProcessingThumbs = false;

        // Next
        if (thumbQueue.length > 0) {
            // Small delay to let UI breathe
            setTimeout(processThumbQueue, 10); // 10ms
        }
    };

    // 3. Error Handling for seek failure
    const onError = () => {
        sharedThumbVideo.removeEventListener('seeked', onSeek);
        sharedThumbVideo.removeEventListener('error', onError);
        isProcessingThumbs = false;
        task.resolve(null); // Resolve with nothing
        setTimeout(processThumbQueue, 10);
    };

    sharedThumbVideo.addEventListener('seeked', onSeek, { once: true });
    sharedThumbVideo.addEventListener('error', onError, { once: true });
}

function selectClip(id) {
    state.selectedClipId = id;
    renderTimeline(); // re-render to show selection
}

// Playback Engine
function seek(time) {
    state.playbackTime = Math.max(0, time);
    updatePlayhead();
    syncVideo();
}

function updatePlayhead() {
    playhead.style.left = (state.playbackTime * state.zoom) + 'px';
    const minutes = Math.floor(state.playbackTime / 60);
    const seconds = Math.floor(state.playbackTime % 60);
    timeDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function syncVideo() {
    // 1. Sync Video Track
    const clip = state.tracks.video.find(c =>
        state.playbackTime >= c.startTime &&
        state.playbackTime < c.startTime + c.duration
    );

    if (clip) {
        const media = state.media.find(m => m.id === clip.mediaId);
        if (mainVideo.src !== media.url) {
            mainVideo.src = media.url;
        }

        const clipTime = state.playbackTime - clip.startTime + clip.offset;
        // Only update time if significant difference
        if (Math.abs(mainVideo.currentTime - clipTime) > 0.3) {
            mainVideo.currentTime = clipTime;
        }

        mainVideo.muted = clip.muted;

        if (state.isPlaying && mainVideo.paused) {
            mainVideo.play().catch(e => {});
        } else if (!state.isPlaying && !mainVideo.paused) {
            mainVideo.pause();
        }

        mainVideo.style.opacity = 1;
    } else {
        mainVideo.style.opacity = 0;
        mainVideo.pause();
    }

    // 2. Sync Audio Track
    const activeAudioClips = state.tracks.audio.filter(c =>
        state.playbackTime >= c.startTime &&
        state.playbackTime < c.startTime + c.duration
    );

    // Stop/cleanup audio not in activeClips
    for (const id in audioPool) {
        if (!activeAudioClips.find(c => c.id === id)) {
            audioPool[id].pause();
            delete audioPool[id];
        }
    }

    // Start/Sync active clips
    activeAudioClips.forEach(clip => {
        let audio = audioPool[clip.id];
        const media = state.media.find(m => m.id === clip.mediaId);

        if (!audio) {
            audio = new Audio(media.url);
            // If exporting, connect to destination
            if (window.exportAudioDestination) {
                // We need to create a source node. Note: MediaElementSource can only be created once per element.
                // Since we create new Audio elements, this is fine.
                // However, we need the context from the destination.
                const ctx = window.exportAudioDestination.context;
                const src = ctx.createMediaElementSource(audio);
                src.connect(window.exportAudioDestination);
            }
            audioPool[clip.id] = audio;
        }

        // Sync time
        const clipTime = state.playbackTime - clip.startTime + clip.offset;
        if (Math.abs(audio.currentTime - clipTime) > 0.3) {
            audio.currentTime = clipTime;
        }

        if (state.isPlaying && audio.paused) audio.play().catch(e => {});
        else if (!state.isPlaying && !audio.paused) audio.pause();
    });
}

// Playback Loop
let lastTime = 0;
function renderLoop(timestamp) {
    if (state.isPlaying) {
        if (!lastTime) lastTime = timestamp;
        const delta = (timestamp - lastTime) / 1000;
        state.playbackTime += delta;
        updatePlayhead();
        syncVideo();

        // Auto scroll timeline if playhead moves out of view
        const playheadPos = state.playbackTime * state.zoom;
        const containerWidth = timelineTracks.parentElement.offsetWidth;
        const scrollLeft = timelineTracks.parentElement.scrollLeft;

        if (playheadPos > scrollLeft + containerWidth - 50) {
            timelineTracks.parentElement.scrollLeft = playheadPos - 50;
        }
    }
    lastTime = timestamp;
    requestAnimationFrame(renderLoop);
}

playPauseBtn.addEventListener('click', togglePlay);

function togglePlay() {
    state.isPlaying = !state.isPlaying;

    // Update Icon
    const playIcon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    const pauseIcon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
    playPauseBtn.innerHTML = state.isPlaying ? pauseIcon : playIcon;

    if (!state.isPlaying) {
        mainVideo.pause();
        // Pause all audio
        Object.values(audioPool).forEach(a => a.pause());
    } else {
        // Resume handled in loop
        lastTime = 0;
    }
}

// Toolbar
function setupToolbar() {
    document.getElementById('tool-undo').addEventListener('click', undo);
    document.getElementById('tool-redo').addEventListener('click', redo);

    document.getElementById('tool-zoom-in').addEventListener('click', () => {
        state.zoom = Math.min(100, state.zoom * 1.5);
        renderTimeline();
        seek(state.playbackTime); // Re-center
    });

    document.getElementById('tool-zoom-out').addEventListener('click', () => {
        state.zoom = Math.max(2, state.zoom / 1.5);
        renderTimeline();
        seek(state.playbackTime);
    });

    document.getElementById('tool-delete').addEventListener('click', () => {
        if (state.selectedClipId) {
            saveState();
            state.tracks.video = state.tracks.video.filter(c => c.id !== state.selectedClipId);
            state.tracks.audio = state.tracks.audio.filter(c => c.id !== state.selectedClipId);
            state.selectedClipId = null;
            renderTimeline();
        }
    });

    document.getElementById('tool-split').addEventListener('click', () => {
         if (state.selectedClipId) {
            // Find the clip
            let trackType = 'video';
            let clip = state.tracks.video.find(c => c.id === state.selectedClipId);
            if (!clip) {
                trackType = 'audio';
                clip = state.tracks.audio.find(c => c.id === state.selectedClipId);
            }

            if (clip) {
                const relativeTime = state.playbackTime - clip.startTime;
                if (relativeTime > 0 && relativeTime < clip.duration) {
                    saveState();
                    // Create new clip for the second half
                    const newClip = {
                        ...clip,
                        id: 'clip_' + Date.now(),
                        startTime: state.playbackTime,
                        duration: clip.duration - relativeTime,
                        offset: clip.offset + relativeTime
                    };

                    // Update original clip
                    clip.duration = relativeTime;

                    state.tracks[trackType].push(newClip);
                    renderTimeline();
                }
            }
        }
    });

    // Add Media Button Logic (Directly to Timeline)
    document.getElementById('tool-add-media').addEventListener('click', () => {
        // Reuse the file input, but we might want slightly different behavior (append to timeline vs just add to library)
        // For simplicity, we trigger the input, and the 'change' listener calls 'handleFiles'.
        // We modify 'handleFiles' to check a flag or we add a new listener.
        // Let's create a dedicated input for this to ensure "Add to Timeline" behavior.

        let input = document.getElementById('direct-file-upload');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'direct-file-upload';
            input.multiple = true;
            input.accept = 'video/*,audio/*';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.addEventListener('change', (e) => {
                const files = Array.from(e.target.files);
                files.forEach(file => {
                    const url = URL.createObjectURL(file);
                    const type = file.type.startsWith('video') ? 'video' : 'audio';
                    const id = Date.now() + Math.random().toString(36).substr(2, 9);

                    const element = document.createElement(type === 'video' ? 'video' : 'audio');
                    element.preload = 'metadata';
                    element.onloadedmetadata = () => {
                        const item = {
                            id,
                            file,
                            url,
                            type,
                            name: file.name,
                            duration: element.duration
                        };
                        state.media.push(item);
                        addMediaToLibrary(item); // Keep library synced

                        // Append to end of timeline
                        const trackClips = state.tracks[type];
                        const lastClip = trackClips.length > 0
                            ? trackClips.reduce((prev, current) => (prev.startTime + prev.duration > current.startTime + current.duration) ? prev : current)
                            : null;

                        const startTime = lastClip ? (lastClip.startTime + lastClip.duration) : 0;
                        addClipToTimeline(item, startTime);
                    };
                    element.src = url;
                });
                // Reset value so change triggers again if same file selected
                input.value = '';
            });
        }

        input.click();
    });

    document.getElementById('tool-record').addEventListener('click', () => {
        document.getElementById('record-overlay').classList.remove('hidden');
        startRecording();
    });

    document.getElementById('cancel-record-btn').addEventListener('click', () => {
        stopRecording(false);
        document.getElementById('record-overlay').classList.add('hidden');
    });

    document.getElementById('stop-record-btn').addEventListener('click', () => {
        stopRecording(true);
        document.getElementById('record-overlay').classList.add('hidden');
    });

    document.getElementById('tool-extract-audio').addEventListener('click', extractAudio);

    document.getElementById('tool-silence').addEventListener('click', removeSilence);
}

// --- Recording Feature ---
let mediaRecorder;
let audioChunks = [];
let audioContext;
let analyser;
let recordingStream;
let animationId;

function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            recordingStream = stream;

            // Check for supported MIME types (iOS compatibility)
            const mimeTypes = [
                'audio/mp4',
                'audio/aac',
                'audio/webm;codecs=opus',
                'audio/webm'
            ];

            let options = {};
            for (const type of mimeTypes) {
                if (MediaRecorder.isTypeSupported(type)) {
                    options = { mimeType: type };
                    break;
                }
            }

            try {
                mediaRecorder = new MediaRecorder(stream, options);
            } catch (e) {
                console.warn('Failed with mime options, trying default', e);
                mediaRecorder = new MediaRecorder(stream);
            }

            audioChunks = [];

            mediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.start();

            // Visualize
            if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            visualizeRecording();
        })
        .catch(err => {
            console.error('Error accessing microphone:', err);
            alert('Could not access microphone. Please check permissions and ensure you are using HTTPS or localhost.');
        });
}

function visualizeRecording() {
    const canvas = document.getElementById('waveform-canvas');
    const ctx = canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
        animationId = requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(dataArray);

        ctx.fillStyle = '#252535';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00d2ff';
        ctx.beginPath();

        const sliceWidth = canvas.width * 1.0 / bufferLength;
        let x = 0;

        for(let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * canvas.height / 2;

            if(i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height/2);
        ctx.stroke();
    }
    draw();
}

function stopRecording(save) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.onstop = () => {
            if (save) {
                const blob = new Blob(audioChunks, { type: 'audio/webm' }); // or mp3/wav
                const url = URL.createObjectURL(blob);
                const id = 'rec_' + Date.now();
                const item = {
                    id: id,
                    file: new File([blob], "Recording " + new Date().toLocaleTimeString(), { type: "audio/webm" }),
                    url: url,
                    type: 'audio',
                    name: "Voice " + new Date().toLocaleTimeString(),
                    duration: 0 // Will need to get duration
                };

                // Create audio element to get duration
                const audio = new Audio(url);
                audio.onloadedmetadata = () => {
                    item.duration = audio.duration;
                     if (item.duration === Infinity) {
                         // Fallback for Chrome bug with WebM duration
                         audio.currentTime = 1e101;
                         audio.ontimeupdate = function() {
                             this.ontimeupdate = ()=>{};
                             audio.currentTime = 0;
                             item.duration = audio.duration;
                             state.media.push(item);
                             addMediaToLibrary(item);
                             addClipToTimeline(item, state.playbackTime);
                         };
                     } else {
                        state.media.push(item);
                        addMediaToLibrary(item);
                        addClipToTimeline(item, state.playbackTime);
                     }
                };
            }

            if (recordingStream) {
                recordingStream.getTracks().forEach(track => track.stop());
            }
            cancelAnimationFrame(animationId);
        };
    }
}

// --- Extract Audio Feature ---
function extractAudio() {
    if (!state.selectedClipId) return alert('Select a video clip first');

    const clip = state.tracks.video.find(c => c.id === state.selectedClipId);
    if (!clip) return alert('Selected clip is not a video');

    // Create a new audio clip referencing the same media
    const newAudioClip = {
        ...clip,
        id: 'extracted_' + Date.now(),
        type: 'audio',
        muted: false
    };

    state.tracks.audio.push(newAudioClip);

    // Mute original video clip
    clip.muted = true;

    renderTimeline();
    alert('Audio extracted to audio track. The video clip has been muted.');
}

// --- Export Feature ---
function setupExport() {
    exportBtn.addEventListener('click', async () => {
        const confirmExport = confirm("Start Export? The video will play in real-time to record.");
        if (!confirmExport) return;

        state.isPlaying = false;
        seek(0);

        // Create canvas for recording
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');

        // Setup Audio Context for mixing
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();

        // Connect Main Video Audio safely
        if (!mainVideoSource) {
            try {
                mainVideoSource = audioCtx.createMediaElementSource(mainVideo);
            } catch (e) {
                console.warn("Could not create media element source", e);
                // It might already be attached to another context if user clicked export before.
                // Since we create a new audioCtx each time, this is problematic.
                // FIX: Reuse audio context or accept that we might lose audio if we can't reconnect.
                // In a real app, we'd maintain one AudioContext globally.
            }
        }

        if (mainVideoSource) {
            // Disconnect from previous destinations if any?
            // Since we made a NEW audioCtx, mainVideoSource (created with OLD context) won't work with NEW context.
            // Web Audio API rule: Nodes must belong to the same context.
            // So we MUST use a single global AudioContext for the app.
        }

        // REVISED STRATEGY: Use global AudioContext
        if (!window.globalAudioCtx) {
             window.globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const gCtx = window.globalAudioCtx;

        if (!mainVideoSource) {
             mainVideoSource = gCtx.createMediaElementSource(mainVideo);
        }

        // Create destination on the GLOBAL context
        const globalDest = gCtx.createMediaStreamDestination();

        // Connect video
        mainVideoSource.connect(globalDest);
        mainVideoSource.connect(gCtx.destination); // Monitor

        window.exportAudioDestination = globalDest;

        // Wait for resume
        if (gCtx.state === 'suspended') await gCtx.resume();

        const stream = canvas.captureStream(30);
        // Add audio tracks
        globalDest.stream.getAudioTracks().forEach(track => stream.addTrack(track));

        // Find supported Mime Type (iOS Safari Fix)
        const mimeTypes = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
            'video/mp4;codecs=avc1', // Safari 14.1+
            'video/mp4'
        ];

        let selectedMimeType = '';
        for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                selectedMimeType = type;
                break;
            }
        }

        // Fallback: let browser choose default
        const options = selectedMimeType ? { mimeType: selectedMimeType } : undefined;
        console.log('Exporting with MIME:', selectedMimeType || 'default');

        let recorder;
        try {
            recorder = new MediaRecorder(stream, options);
        } catch (e) {
             console.error('MediaRecorder error:', e);
             alert('Error initializing recorder. Your browser might not support this format.');
             state.isPlaying = false;
             return;
        }

        const chunks = [];

        recorder.ondataavailable = e => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
             // Determine extension based on type
             const ext = (selectedMimeType && selectedMimeType.includes('mp4')) ? 'mp4' : 'webm';
             const blob = new Blob(chunks, { type: selectedMimeType || 'video/webm' });
             const url = URL.createObjectURL(blob);
             const a = document.createElement('a');
             a.href = url;
             a.download = `uhcut-export.${ext}`;
             a.click();

             // Cleanup
             window.exportAudioDestination = null;
             state.isPlaying = false;
             alert('Export Complete!');
        };

        recorder.start();
        state.isPlaying = true;

        // Render Loop for Export
        const duration = Math.max(
            ...state.tracks.video.map(c => c.startTime + c.duration),
            ...state.tracks.audio.map(c => c.startTime + c.duration)
        );

        const startTime = Date.now();

        function exportLoop() {
             if (!state.isPlaying || state.playbackTime >= duration) {
                 recorder.stop();
                 return;
             }

             // Draw current video frame to canvas
             ctx.fillStyle = 'black';
             ctx.fillRect(0, 0, canvas.width, canvas.height);

             if (mainVideo.style.opacity !== '0') {
                 // Scale to fit
                 const scale = Math.min(canvas.width / mainVideo.videoWidth, canvas.height / mainVideo.videoHeight);
                 const w = mainVideo.videoWidth * scale;
                 const h = mainVideo.videoHeight * scale;
                 const x = (canvas.width - w) / 2;
                 const y = (canvas.height - h) / 2;
                 ctx.drawImage(mainVideo, x, y, w, h);
             }

             requestAnimationFrame(exportLoop);
        }

        exportLoop();
    });
}

// --- Silence Removal Feature ---
async function removeSilence() {
    if (!state.selectedClipId) return alert('Select a clip to remove silence from');

    let trackType = 'video';
    let clip = state.tracks.video.find(c => c.id === state.selectedClipId);
    if (!clip) {
        trackType = 'audio';
        clip = state.tracks.audio.find(c => c.id === state.selectedClipId);
    }

    if (!clip) return;

    const media = state.media.find(m => m.id === clip.mediaId);
    if (!media) return;

    // We need to fetch the file data and decode it
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();

    try {
        const response = await fetch(media.url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        // Analyze channel data (Check ALL channels for stereo safety)
        const channels = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            channels.push(audioBuffer.getChannelData(c));
        }

        const sampleRate = audioBuffer.sampleRate;
        const length = channels[0].length;

        // --- REVIEW: Silence Detection Logic ---
        // Threshold: Amplitude below this is considered silence.
        const threshold = 0.005;
        const minSilenceDuration = 0.5; // seconds

        const chunks = [];
        let isSilent = true;
        let lastChangeIndex = 0;

        for (let i = 0; i < length; i++) {
            // Get max amplitude across all channels
            let amplitude = 0;
            for (let c = 0; c < channels.length; c++) {
                const val = Math.abs(channels[c][i]);
                if (val > amplitude) amplitude = val;
            }

            if (amplitude > threshold) {
                if (isSilent) {
                    // Silence ended
                    isSilent = false;
                    lastChangeIndex = i;
                }
            } else {
                if (!isSilent) {
                    // Speech ended
                    // Add speech chunk
                    const start = lastChangeIndex / sampleRate;
                    const end = i / sampleRate;
                    chunks.push({ start, end });

                    isSilent = true;
                    lastChangeIndex = i;
                }
            }
        }
        // Handle last chunk
        if (!isSilent) {
             chunks.push({ start: lastChangeIndex / sampleRate, end: length / sampleRate });
        }

        if (chunks.length === 0) return alert('No speech detected or volume too low.');

        // Process Speech Chunks
        const visibleChunks = chunks.filter(chunk => {
             return chunk.end > clip.offset && chunk.start < (clip.offset + clip.duration);
        });

        if (visibleChunks.length === 0) {
            return alert('No speech detected in this clip segment (it appears silent). Clip preserved.');
        }

        // --- TWO STEP UNDO LOGIC: 1. Split, 2. Delete Silence ---

        // Step 1: Split into Speech AND Silence segments
        // We need to invert the chunks to find silence gaps within the clip duration
        const allSegments = [];
        let cursor = clip.offset;
        const endOfClip = clip.offset + clip.duration;

        visibleChunks.forEach(chunk => {
            // Gap before speech?
            const gapStart = cursor;
            const gapEnd = Math.max(cursor, chunk.start);
            if (gapEnd > gapStart) {
                allSegments.push({ start: gapStart, end: gapEnd, type: 'silence' });
            }

            // Speech segment
            const speechStart = Math.max(cursor, chunk.start);
            const speechEnd = Math.min(endOfClip, chunk.end);
            if (speechEnd > speechStart) {
                allSegments.push({ start: speechStart, end: speechEnd, type: 'speech' });
            }

            cursor = speechEnd;
        });

        // Tail gap?
        if (cursor < endOfClip) {
            allSegments.push({ start: cursor, end: endOfClip, type: 'silence' });
        }

        // Apply Step 1: Replace original clip with split parts (Speech + Silence)
        saveState(); // Save state BEFORE splitting

        // Remove original
        state.tracks[trackType] = state.tracks[trackType].filter(c => c.id !== clip.id);

        // Add all segments
        let currentTimelinePos = clip.startTime;
        const newClips = [];

        allSegments.forEach(seg => {
            const duration = seg.end - seg.start;
            if (duration > 0.05) { // Min clip length
                const newClip = {
                    id: 'split_' + Date.now() + Math.random(),
                    mediaId: clip.mediaId,
                    startTime: currentTimelinePos,
                    duration: duration,
                    offset: seg.start,
                    type: clip.type,
                    muted: clip.muted,
                    isSilence: (seg.type === 'silence') // Tag it
                };
                state.tracks[trackType].push(newClip);
                newClips.push(newClip);
                currentTimelinePos += duration;
            }
        });

        renderTimeline();

        // Step 2: Delete Silence Clips
        // We do this immediately, but by saving state *again*, we allow the user to undo *just* the deletion.

        // Allow the UI to update first? No, synchronous is fine for history stack.
        saveState(); // Save state WITH splits (before deleting silence)

        // Filter out silence clips we just added
        state.tracks[trackType] = state.tracks[trackType].filter(c => !c.isSilence);

        // We also need to shift the remaining clips to close the gaps!
        // "remove silence... delete no voice part clips" usually implies ripple delete (closing gaps).
        // My previous logic did this by appending to `currentTimelinePos`.
        // Here, if I just delete them, there will be holes.
        // I need to reposition the remaining clips.

        // Let's recalculate positions for the track
        // Actually, to support undoing to the "split" state (where gaps exist),
        // the "split" state should have clips contiguous.
        // The "delete" state should have clips contiguous (rippled).

        // Re-implement Step 2 logic:
        const remainingClips = newClips.filter(c => !c.isSilence);
        let ripplePos = clip.startTime;

        // Update positions of the KEPT clips
        remainingClips.forEach(c => {
            c.startTime = ripplePos;
            ripplePos += c.duration;
        });

        renderTimeline();

    } catch (e) {
        console.error('Error analyzing audio:', e);
        alert('Could not process audio for silence removal. ' + e.message);
    }
}


init();
