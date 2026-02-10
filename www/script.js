// State
const state = {
    media: [],
    tracks: {
        video: [], // { id, mediaId, startTime, duration, offset, type, muted }
        audio: [[], []] // Two audio channels/tracks
    },
    playbackTime: 0,
    isPlaying: false,
    zoom: 20,
    selectedClipId: null
};

// History for Undo/Redo
const historyStack = [];
const redoStack = [];

// DOM Elements
const elements = {
    fileInput: document.getElementById('file-upload'),
    timelineContainer: document.querySelector('.timeline-container'),
    timelineTracks: document.getElementById('timeline-tracks'),
    timelineRuler: document.getElementById('time-ruler'),
    playhead: document.getElementById('playhead'),
    mainVideo: document.getElementById('main-video'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    timeDisplay: document.getElementById('time-display'),
    exportBtn: document.getElementById('export-btn'),
    recordOverlay: document.getElementById('record-overlay'),
    exportOverlay: document.getElementById('export-overlay'),
    exportProgress: document.getElementById('export-progress-text'),
    cancelExportBtn: document.getElementById('cancel-export-btn'),
    saveExportBtn: document.getElementById('save-export-btn')
};

// Global Audio Context (Singleton)
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);
const exportDest = audioCtx.createMediaStreamDestination();
masterGain.connect(exportDest);

const audioPool = {}; // clipId -> { audio, source, gain }
let mainVideoSource = null;
let mainVideoGain = null;

// Constants
const TRACK_HEIGHT = 50;

// Initialization
function init() {
    setupFileInput();
    setupTimelineInteraction();
    setupToolbar();
    setupKeyboardShortcuts();
    setupExport();
    setupVolumeControl();

    requestAnimationFrame(renderLoop);
    renderTimeline();
}

// --- State Management ---

function saveState() {
    const snapshot = JSON.stringify({
        tracks: state.tracks,
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    });

    if (historyStack.length > 0 && historyStack[historyStack.length - 1] === snapshot) return;

    historyStack.push(snapshot);
    redoStack.length = 0;
    if (historyStack.length > 50) historyStack.shift();
}

function restoreState(json) {
    const snapshot = JSON.parse(json);
    state.tracks = snapshot.tracks;
    state.selectedClipId = snapshot.selectedClipId;
    state.playbackTime = snapshot.playbackTime;
    state.zoom = snapshot.zoom;

    renderTimeline();
    seek(state.playbackTime);
}

function undo() {
    if (historyStack.length === 0) return;
    redoStack.push(JSON.stringify({
        tracks: state.tracks,
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    }));
    restoreState(historyStack.pop());
}

function redo() {
    if (redoStack.length === 0) return;
    historyStack.push(JSON.stringify({
        tracks: state.tracks,
        selectedClipId: state.selectedClipId,
        playbackTime: state.playbackTime,
        zoom: state.zoom
    }));
    restoreState(redoStack.pop());
}

// --- UI & Interaction ---

function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.code === 'Space') {
            e.preventDefault();
            document.getElementById('play-pause-btn').click();
        }

        if (e.code === 'Delete') {
            document.getElementById('tool-delete').click();
        }

        if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyZ') {
                if (e.shiftKey) redo();
                else undo();
                e.preventDefault();
            }
            if (e.code === 'KeyY') {
                redo();
                e.preventDefault();
            }
        }
    });
}

function setupFileInput() {
    elements.fileInput.addEventListener('change', handleFiles);
}

function handleFiles(e) {
    const files = Array.from(e.target.files);
    files.forEach(f => processFile(f));
}

function processFile(file, startTime = null) {
    const url = URL.createObjectURL(file);
    // Handle m4a which might be audio/mp4 or just file extension
    let type = 'audio';
    if (file.type.startsWith('video')) {
        type = 'video';
    } else if (file.name.toLowerCase().endsWith('.m4a') || file.type.startsWith('audio')) {
        type = 'audio';
    }

    const id = Date.now() + Math.random().toString(36).substr(2, 9);

    const element = document.createElement(type === 'video' ? 'video' : 'audio');
    element.preload = 'metadata';

    element.onerror = (e) => {
        console.error(e);
        alert("Failed to load media: " + file.name + ". Format may not be supported.");
    };

    element.onloadedmetadata = () => {
        const item = {
            id,
            file,
            url,
            type,
            name: file.name,
            duration: element.duration || 0,
            videoWidth: type === 'video' ? (element.videoWidth || 0) : 0,
            videoHeight: type === 'video' ? (element.videoHeight || 0) : 0
        };
        state.media.push(item);

        if (startTime !== null) {
             addClipToTimeline(item, startTime);
        } else {
             addToTimelineSmart(item);
        }
    };
    element.src = url;
}

function addToTimelineSmart(item) {
    saveState();

    const clip = {
        id: 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5),
        mediaId: item.id,
        duration: item.duration,
        offset: 0,
        type: item.type,
        muted: false,
        volume: 1.0,
        startTime: 0
    };

    if (item.type === 'video') {
        const lastClip = state.tracks.video.length > 0
            ? state.tracks.video.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b))
            : null;
        clip.startTime = lastClip ? (lastClip.startTime + lastClip.duration) : 0;
        state.tracks.video.push(clip);
    } else {
        let added = false;
        for (let i = 0; i < state.tracks.audio.length; i++) {
            const trackClips = state.tracks.audio[i];
            const lastClip = trackClips.length > 0
                 ? trackClips.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b))
                 : null;
            const potentialStart = lastClip ? (lastClip.startTime + lastClip.duration) : 0;

            clip.startTime = potentialStart;
            trackClips.push(clip);
            added = true;
            break;
        }
        if (!added) {
             state.tracks.audio[0].push(clip);
        }
    }

    renderTimeline();
}

// --- Timeline Logic ---

function addClipToTimeline(mediaItem, startTime) {
    saveState();
    const clip = {
        id: 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5),
        mediaId: mediaItem.id,
        startTime: Math.max(0, startTime),
        duration: mediaItem.duration,
        offset: 0,
        type: mediaItem.type,
        muted: false,
        volume: 1.0
    };

    if (mediaItem.type === 'video') {
        state.tracks.video.push(clip);
    } else {
        let targetTrackIndex = 0;
        let hasCollision = checkCollision(state.tracks.audio[0], clip);

        if (hasCollision && state.tracks.audio[1]) {
            targetTrackIndex = 1;
            if (checkCollision(state.tracks.audio[1], clip)) {
                // Collision on both tracks
            }
        }
        state.tracks.audio[targetTrackIndex].push(clip);
    }

    renderTimeline();
}

function checkCollision(trackClips, newClip) {
    return trackClips.some(c =>
        c.id !== newClip.id &&
        !(newClip.startTime >= c.startTime + c.duration || newClip.startTime + newClip.duration <= c.startTime)
    );
}

let isDragging = false;
let dragClipId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginalStart = 0;

function setupTimelineInteraction() {
    const { timelineTracks, timelineContainer } = elements;

    // Drop listener needs to account for container scroll
    timelineTracks.addEventListener('dragover', (e) => e.preventDefault());
    timelineTracks.addEventListener('drop', (e) => {
        e.preventDefault();

        const rect = timelineTracks.getBoundingClientRect();
        // e.clientX - rect.left gives the pixel offset inside the track.
        const x = e.clientX - rect.left;
        const startTime = x / state.zoom;

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            files.forEach(f => processFile(f, startTime));
        }
    });

    timelineTracks.addEventListener('mousedown', handleMouseDown);
    timelineTracks.addEventListener('touchstart', handleMouseDown, {passive: false});
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleMouseMove, {passive: false});
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchend', handleMouseUp);

    timelineTracks.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const zoomChange = e.deltaY > 0 ? 0.9 : 1.1;
            setZoom(state.zoom * zoomChange, e.clientX);
        }
    });

    timelineTracks.addEventListener('click', (e) => {
        if (isDragging) return;
        const clipEl = e.target.closest('.clip');
        if (clipEl) {
            state.selectedClipId = clipEl.dataset.clipId;
        } else {
            state.selectedClipId = null;
            // Seek
            const rect = timelineTracks.getBoundingClientRect();
            const x = e.clientX - rect.left;
            seek(x / state.zoom);
        }
        renderTimeline();
    });
}

function handleMouseDown(e) {
    const clipEl = e.target.closest('.clip');
    if (!clipEl) return;

    isDragging = true;
    dragClipId = clipEl.dataset.clipId;
    dragStartX = e.touches ? e.touches[0].clientX : e.clientX;
    dragStartY = e.touches ? e.touches[0].clientY : e.clientY;

    const loc = findClipLocation(dragClipId);
    if (loc) {
        dragOriginalStart = loc.clip.startTime;
        state.selectedClipId = dragClipId;
        renderTimeline();

        // Bring to front
        const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
        if(el) el.style.zIndex = 100;
    }
}

function handleMouseMove(e) {
    if (!isDragging || !dragClipId) return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const deltaPx = clientX - dragStartX;
    const deltaY = clientY - dragStartY;

    const deltaSec = deltaPx / state.zoom;

    const loc = findClipLocation(dragClipId);
    if (loc) {
        loc.clip.startTime = Math.max(0, dragOriginalStart + deltaSec);
        const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
        if (el) {
            el.style.left = (loc.clip.startTime * state.zoom) + 'px';
            // Vertical movement visual
            if (loc.type === 'audio') {
                 el.style.transform = `translateY(${deltaY}px)`;
            }
        }
    }
}

function handleMouseUp(e) {
    if (isDragging) {
        // Check for track change
        const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
        const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;

        const loc = findClipLocation(dragClipId);
        if (loc && loc.type === 'audio') {
            // Find track under mouse
            // We need to hide the dragged element momentarily to find what's underneath?
            // Or use elementsFromPoint?
            const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
            if(el) el.style.display = 'none';

            const elementBelow = document.elementFromPoint(clientX, clientY);
            if(el) el.style.display = ''; // Restore

            const trackEl = elementBelow ? elementBelow.closest('.track') : null;
            if (trackEl && trackEl.dataset.type === 'audio') {
                const targetIndex = parseInt(trackEl.dataset.trackId.split('-')[1]);
                if (!isNaN(targetIndex) && targetIndex !== loc.index) {
                     // Move Clip
                     loc.array.splice(loc.array.indexOf(loc.clip), 1);
                     if (!state.tracks.audio[targetIndex]) state.tracks.audio[targetIndex] = [];
                     state.tracks.audio[targetIndex].push(loc.clip);
                }
            }
        }

        isDragging = false;
        dragClipId = null;
        renderTimeline();
        saveState();
    }
}

function findClip(id) {
    const loc = findClipLocation(id);
    return loc ? loc.clip : null;
}

function findClipLocation(id) {
    let c = state.tracks.video.find(c => c.id === id);
    if (c) return { clip: c, type: 'video', index: 0, array: state.tracks.video };

    for (let i = 0; i < state.tracks.audio.length; i++) {
        c = state.tracks.audio[i].find(k => k.id === id);
        if (c) return { clip: c, type: 'audio', index: i, array: state.tracks.audio[i] };
    }
    return null;
}

function setZoom(newZoom, mouseX) {
    const oldZoom = state.zoom;
    state.zoom = Math.max(1, Math.min(200, newZoom));

    // Zoom around mouse
    const rect = elements.timelineTracks.getBoundingClientRect();
    const trackX = (mouseX || (rect.left + rect.width/2)) - rect.left;
    const timeAtMouse = trackX / oldZoom;

    // Viewport-relative mouse X (for restoring scroll position)
    const containerRect = elements.timelineContainer.getBoundingClientRect();
    const mouseXInContainer = (mouseX || (containerRect.left + containerRect.width/2)) - containerRect.left;

    renderTimeline();

    const newPixelPos = timeAtMouse * state.zoom;
    // 20 is padding-left.
    const padding = 20;
    const newScroll = newPixelPos + padding - mouseXInContainer;

    elements.timelineContainer.scrollLeft = Math.max(0, newScroll);
}

// --- Rendering ---

function renderTimeline() {
    const { timelineTracks } = elements;

    // Render Video Track
    renderTrack(state.tracks.video, 'video', 0);

    // Render Audio Tracks
    state.tracks.audio.forEach((trackClips, index) => {
        renderTrack(trackClips, 'audio', index);
    });

    // Calculate max time
    let maxTime = 0;
    const checkMax = (arr) => {
        if (arr.length) maxTime = Math.max(maxTime, ...arr.map(c => c.startTime + c.duration));
    };
    checkMax(state.tracks.video);
    state.tracks.audio.forEach(checkMax);
    maxTime = Math.max(maxTime, 20);

    timelineTracks.style.width = (maxTime * state.zoom + 500) + 'px';
    renderRuler(maxTime + 10);

    // Update Toolbar Visibility
    const stabBtn = document.getElementById('tool-stabilize');
    if (stabBtn) {
        if (state.selectedClipId) {
            const clip = findClip(state.selectedClipId);
            stabBtn.style.display = (clip && clip.type === 'video') ? 'flex' : 'none';
        } else {
            stabBtn.style.display = 'none';
        }
    }
}

function renderTrack(clips, type, index) {
    const { timelineTracks } = elements;
    const trackId = `${type}-${index}`;
    let trackEl = timelineTracks.querySelector(`.track[data-track-id="${trackId}"]`);

    if (!trackEl) {
        trackEl = document.createElement('div');
        trackEl.className = 'track';
        trackEl.dataset.type = type;
        trackEl.dataset.trackId = trackId;
        timelineTracks.appendChild(trackEl);
    }

    Array.from(trackEl.children).forEach(el => el.dataset.stale = 'true');

    clips.forEach(clip => {
        let el = trackEl.querySelector(`.clip[data-clip-id="${clip.id}"]`);
        const width = Math.max(2, clip.duration * state.zoom);
        const left = clip.startTime * state.zoom;

        const clipMedia = state.media.find(m => m.id === clip.mediaId);
        const isRecordingClip = clipMedia && clipMedia._recording;

        if (!el) {
            el = document.createElement('div');
            el.className = 'clip';
            el.dataset.clipId = clip.id;
            el.dataset.type = type;
            trackEl.appendChild(el);
            if (!isRecordingClip) renderClipContent(el, clip, type);
        } else {
            el.dataset.stale = 'false';
            if (!isRecordingClip) {
                const prevProps = el.dataset.props;
                const newProps = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}_${!!clip.stabilized}`;
                if (prevProps !== newProps) renderClipContent(el, clip, type);
            }
        }

        el.style.left = left + 'px';
        el.style.width = width + 'px';
        el.dataset.props = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}_${!!clip.stabilized}`;

        if (state.selectedClipId === clip.id) el.classList.add('selected');
        else el.classList.remove('selected');
    });

    Array.from(trackEl.children).forEach(el => {
        if (el.dataset.stale === 'true') el.remove();
    });
}

function renderClipContent(el, clip, type) {
    const media = state.media.find(m => m.id === clip.mediaId);
    if (!media) {
        el.innerHTML = '';
        el.textContent = 'Missing';
        return;
    }
    // Don't re-render recording clips - they manage their own content
    if (media._recording) return;
    el.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = media.name;
    el.appendChild(label);

    if (type === 'audio') drawWaveform(el, clip, media);
    else if (type === 'video') drawThumbnails(el, clip, media);

    if (clip.stabilized) {
        const badge = document.createElement('div');
        badge.textContent = '⚡';
        badge.style.position = 'absolute';
        badge.style.bottom = '2px';
        badge.style.right = '2px';
        badge.style.fontSize = '12px';
        badge.style.color = '#00d2ff';
        badge.style.textShadow = '0 1px 2px #000';
        badge.style.fontWeight = 'bold';
        badge.style.zIndex = '5';
        el.appendChild(badge);
    }
}

const waveformCache = {};
const thumbCache = {};

async function drawWaveform(container, clip, media) {
    let buffer = waveformCache[media.id];
    if (!buffer) {
        try {
            const resp = await fetch(media.url);
            const ab = await resp.arrayBuffer();
            buffer = await audioCtx.decodeAudioData(ab);
            waveformCache[media.id] = buffer;
        } catch (e) { return; }
    }

    const canvas = document.createElement('canvas');
    const width = Math.ceil(clip.duration * state.zoom);
    const height = TRACK_HEIGHT;
    canvas.width = width;
    canvas.height = height;
    canvas.className = 'clip-waveform';

    const ctx = canvas.getContext('2d');
    const data = buffer.getChannelData(0);
    const startSample = Math.floor(clip.offset * buffer.sampleRate);
    const samplesPerPixel = Math.floor((clip.duration * buffer.sampleRate) / width);

    ctx.strokeStyle = '#000';
    ctx.beginPath();

    const step = Math.max(1, Math.floor(samplesPerPixel / 10));
    for (let x = 0; x < width; x++) {
        const start = startSample + (x * samplesPerPixel);
        let max = 0;
        for (let i = 0; i < samplesPerPixel; i+=step) {
             const idx = start + i;
             if (idx < buffer.length) {
                 const val = Math.abs(data[idx]);
                 if (val > max) max = val;
             }
        }
        const h = max * height;
        ctx.moveTo(x, (height - h) / 2);
        ctx.lineTo(x, (height + h) / 2);
    }
    ctx.stroke();
    container.insertBefore(canvas, container.firstChild);
}

// Global Thumbnail Generator
let thumbVideo = null;
const thumbQueue = [];
let isProcessingThumbs = false;

// Inline Recording State
let isRecording = false;
let recordingClipId = null;
let recordingMediaId = null;
let recordingStartPlaybackTime = 0;
let recordingAnalyser = null;
let recordingSource = null;
let recordingAnimFrame = null;
let recordingWaveformData = [];

function drawThumbnails(container, clip, media) {
    const strip = document.createElement('div');
    strip.className = 'clip-filmstrip';
    container.insertBefore(strip, container.firstChild);

    const clipWidth = clip.duration * state.zoom;
    const thumbWidth = 100;
    const numThumbs = Math.ceil(clipWidth / thumbWidth);

    for (let i = 0; i < numThumbs; i++) {
        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'video-thumb';
        thumbDiv.style.width = thumbWidth + 'px';
        thumbDiv.style.left = (i * thumbWidth) + 'px';
        thumbDiv.style.position = 'absolute';
        thumbDiv.style.height = '100%';
        strip.appendChild(thumbDiv);

        const relativeTime = (i * thumbWidth) / state.zoom;
        const time = clip.offset + relativeTime;
        if (time < media.duration) {
            const cacheKey = media.url + '_' + (Math.round(time * 2) / 2).toFixed(1);
            if (thumbCache[cacheKey]) {
                thumbDiv.style.backgroundImage = `url(${thumbCache[cacheKey]})`;
            } else {
                queueThumbnail(media.url, time, thumbDiv, cacheKey);
            }
        }
    }
}

function queueThumbnail(url, time, el, cacheKey) {
    thumbQueue.push({ url, time, el, cacheKey });
    processThumbQueue();
}

function processThumbQueue() {
    if (isProcessingThumbs || thumbQueue.length === 0) return;

    isProcessingThumbs = true;
    const task = thumbQueue.shift();

    // Check if element is still in DOM (clip may have been removed)
    if (!task.el.parentNode) {
        isProcessingThumbs = false;
        if (thumbQueue.length > 0) setTimeout(processThumbQueue, 5);
        return;
    }

    // Serve from cache if available
    if (task.cacheKey && thumbCache[task.cacheKey]) {
        task.el.style.backgroundImage = `url(${thumbCache[task.cacheKey]})`;
        isProcessingThumbs = false;
        if (thumbQueue.length > 0) setTimeout(processThumbQueue, 5);
        return;
    }

    // During playback, skip video seek operations (serve cached only)
    if (state.isPlaying) {
        isProcessingThumbs = false;
        return;
    }

    if (!thumbVideo) {
        thumbVideo = document.createElement('video');
        thumbVideo.muted = true;
        thumbVideo.preload = 'auto';
        thumbVideo.style.display = 'none';
        document.body.appendChild(thumbVideo);
    }

    const onSeek = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d').drawImage(thumbVideo, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL();
        task.el.style.backgroundImage = `url(${dataUrl})`;
        if (task.cacheKey) thumbCache[task.cacheKey] = dataUrl;

        isProcessingThumbs = false;
        setTimeout(processThumbQueue, 20);
    };

    const onError = () => {
        isProcessingThumbs = false;
        setTimeout(processThumbQueue, 20);
    };

    thumbVideo.addEventListener('seeked', onSeek, { once: true });
    thumbVideo.addEventListener('error', onError, { once: true });

    if (thumbVideo.src !== task.url) thumbVideo.src = task.url;

    if (thumbVideo.readyState >= 2 && thumbVideo.src === task.url && Math.abs(thumbVideo.currentTime - task.time) < 0.1) {
         onSeek();
    } else {
         thumbVideo.currentTime = task.time;
    }
}

function renderRuler(duration) {
    const { timelineRuler } = elements;
    timelineRuler.innerHTML = '';
    timelineRuler.style.width = elements.timelineTracks.style.width;

    // Min pixels between ticks
    const minPx = 60;
    let interval = 1;
    while (interval * state.zoom < minPx) {
        if (interval < 1) interval = 1;
        else if (interval < 2) interval = 2;
        else if (interval < 5) interval = 5;
        else if (interval < 10) interval = 10;
        else if (interval < 30) interval = 30;
        else if (interval < 60) interval = 60;
        else interval += 60;
    }

    for (let t = 0; t <= duration; t += interval) {
        const tick = document.createElement('div');
        tick.className = 'ruler-tick';
        tick.style.left = (t * state.zoom) + 'px';
        const m = Math.floor(t / 60);
        const s = t % 60;
        const span = document.createElement('span');
        span.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        tick.appendChild(span);
        timelineRuler.appendChild(tick);
    }
}

// --- Playback Engine ---

function seek(time) {
    state.playbackTime = Math.max(0, time);
    updatePlayhead();
    syncMedia();
}

function updatePlayhead() {
    const px = state.playbackTime * state.zoom;
    elements.playhead.style.left = px + 'px';
    const m = Math.floor(state.playbackTime / 60);
    const s = Math.floor(state.playbackTime % 60);
    const ms = Math.floor((state.playbackTime % 1) * 100);
    elements.timeDisplay.textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}

function syncMedia() {
    // Setup Main Video Audio Graph
    if (!mainVideoSource && elements.mainVideo) {
        try {
            mainVideoSource = audioCtx.createMediaElementSource(elements.mainVideo);
            mainVideoGain = audioCtx.createGain();
            mainVideoSource.connect(mainVideoGain);
            mainVideoGain.connect(masterGain);
        } catch(e) { /* ignore already connected */ }
    }

    const v = elements.mainVideo;
    const videoClip = state.tracks.video.find(c =>
        state.playbackTime >= c.startTime &&
        state.playbackTime < c.startTime + c.duration
    );

    if (videoClip) {
        const media = state.media.find(m => m.id === videoClip.mediaId);
        if (v.src !== media.url) v.src = media.url;
        const clipTime = state.playbackTime - videoClip.startTime + videoClip.offset;
        if (Math.abs(v.currentTime - clipTime) > 0.3) v.currentTime = clipTime;

        // Volume Control
        if (mainVideoGain) {
            const vol = videoClip.muted ? 0 : (videoClip.volume !== undefined ? videoClip.volume : 1.0);
            mainVideoGain.gain.value = vol;
        }
        // Keep element unmuted so it feeds the source, but we control output via gain
        v.muted = false;

        v.style.opacity = 1;
        v.style.transform = videoClip.stabilized ? 'scale(1.1)' : 'scale(1)';

        if (state.isPlaying && v.paused) v.play().catch(()=>{});
        if (!state.isPlaying && !v.paused) v.pause();
    } else {
        v.style.opacity = 0;
        if (mainVideoGain) mainVideoGain.gain.value = 0;
        v.pause();
    }

    // Collect active audio clips from ALL tracks
    let activeClips = [];
    state.tracks.audio.forEach(track => {
        track.forEach(c => {
             if (state.playbackTime >= c.startTime && state.playbackTime < c.startTime + c.duration) {
                 activeClips.push(c);
             }
        });
    });

    // Cleanup inactive
    Object.keys(audioPool).forEach(id => {
        if (!activeClips.find(c => c.id === id)) {
            const poolItem = audioPool[id];
            poolItem.audio.pause();
            // Disconnect to save resources?
            // poolItem.source.disconnect();
            // poolItem.gain.disconnect();
            // No, keep connected for reuse or let GC handle if we delete?
            // If we delete, we lose the source node which is bound to the element.
            // Actually, we create new Audio() each time we add to pool.
            // So we should disconnect nodes.
            if (poolItem.gain) poolItem.gain.disconnect();
            if (poolItem.source) poolItem.source.disconnect();
            delete audioPool[id];
        }
    });

    activeClips.forEach(clip => {
        let item = audioPool[clip.id];
        if (!item) {
            const media = state.media.find(m => m.id === clip.mediaId);
            const a = new Audio(media.url);
            a.crossOrigin = 'anonymous'; // Safer

            const source = audioCtx.createMediaElementSource(a);
            const gain = audioCtx.createGain();
            source.connect(gain);
            gain.connect(masterGain);

            item = { audio: a, source: source, gain: gain };
            audioPool[clip.id] = item;
        }

        const clipTime = state.playbackTime - clip.startTime + clip.offset;
        if (Math.abs(item.audio.currentTime - clipTime) > 0.3) item.audio.currentTime = clipTime;

        const vol = clip.muted ? 0 : (clip.volume !== undefined ? clip.volume : 1.0);
        item.gain.gain.value = vol;

        if (state.isPlaying && item.audio.paused) item.audio.play().catch(()=>{});
        if (!state.isPlaying && !item.audio.paused) item.audio.pause();
    });
}

function renderLoop(timestamp) {
    if (state.isPlaying) {
        if (!state.lastFrameTime) state.lastFrameTime = timestamp;
        const dt = (timestamp - state.lastFrameTime) / 1000;
        state.lastFrameTime = timestamp;

        state.playbackTime += dt;
        updatePlayhead();
        syncMedia();

        const playheadPx = state.playbackTime * state.zoom;
        const scrollLeft = elements.timelineContainer.scrollLeft;
        const width = elements.timelineContainer.clientWidth;
        if (playheadPx > scrollLeft + width - 100) elements.timelineContainer.scrollLeft = playheadPx - 100;
    } else {
        state.lastFrameTime = 0;
    }
    requestAnimationFrame(renderLoop);
}

// --- Tools ---

function setupToolbar() {
    const btn = (id, fn) => document.getElementById(id).addEventListener('click', fn);

    btn('play-pause-btn', () => {
        state.isPlaying = !state.isPlaying;

        const playIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        const pauseIcon = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
        elements.playPauseBtn.innerHTML = state.isPlaying ? pauseIcon : playIcon;

        if (!state.isPlaying) {
             elements.mainVideo.pause();
             Object.values(audioPool).forEach(a => a.pause());
        }
    });

    btn('tool-undo', undo);
    btn('tool-redo', redo);
    btn('tool-zoom-in', () => setZoom(state.zoom * 1.5));
    btn('tool-zoom-out', () => setZoom(state.zoom / 1.5));

    btn('tool-delete', () => {
        if (state.selectedClipId) {
            saveState();
            state.tracks.video = state.tracks.video.filter(c => c.id !== state.selectedClipId);
            state.tracks.audio = state.tracks.audio.map(track => track.filter(c => c.id !== state.selectedClipId));
            state.selectedClipId = null;
            renderTimeline();
        }
    });

    btn('tool-split', () => {
        if (!state.selectedClipId) return;
        const clip = findClip(state.selectedClipId);
        if (clip) {
            const relTime = state.playbackTime - clip.startTime;
            if (relTime > 0.05 && relTime < clip.duration - 0.05) {
                saveState();
                const newClip = {
                    ...clip,
                    id: 'clip_' + Date.now(),
                    startTime: state.playbackTime,
                    duration: clip.duration - relTime,
                    offset: clip.offset + relTime
                };
                clip.duration = relTime;

                if (state.tracks.video.includes(clip)) {
                    state.tracks.video.push(newClip);
                } else {
                    for (const track of state.tracks.audio) {
                        if (track.includes(clip)) {
                            track.push(newClip);
                            break;
                        }
                    }
                }
                renderTimeline();
            }
        }
    });

    btn('tool-add-media', () => elements.fileInput.click());

    btn('tool-record', () => {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (isRecording) {
            stopInlineRecording();
        } else {
            startInlineRecording();
        }
    });

    btn('tool-extract-audio', extractAudio);
    btn('tool-silence', removeSilenceTool);
    btn('tool-stabilize', stabilizeClip);
    btn('tool-volume', () => {
        if (state.selectedClipId) {
            const clip = findClip(state.selectedClipId);
            if (clip) {
                const vol = clip.volume !== undefined ? clip.volume : 1.0;
                document.getElementById('volume-slider').value = vol;
                document.getElementById('volume-value').textContent = Math.round(vol * 100) + '%';
                document.getElementById('volume-overlay').classList.remove('hidden');
            }
        } else {
            alert('Select a clip first');
        }
    });
    btn('tool-export-audio-file', exportAudioFile);
}

function setupVolumeControl() {
    const slider = document.getElementById('volume-slider');
    const valDisplay = document.getElementById('volume-value');
    const closeBtn = document.getElementById('close-volume-btn');
    const overlay = document.getElementById('volume-overlay');

    slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valDisplay.textContent = Math.round(val * 100) + '%';
        if (state.selectedClipId) {
            const clip = findClip(state.selectedClipId);
            if (clip) {
                clip.volume = val;
                // Immediate feedback
                syncMedia();
            }
        }
    });

    closeBtn.addEventListener('click', () => {
        overlay.classList.add('hidden');
        saveState();
    });
}

function exportAudioFile() {
    elements.exportOverlay.classList.remove('hidden');
    elements.exportProgress.textContent = 'Preparing Audio...';
    elements.saveExportBtn.style.display = 'none';
    elements.cancelExportBtn.style.display = 'inline-block';

    state.isPlaying = false;
    seek(0);

    const dest = exportDest; // Use the global export destination

    // Check support
    let mimeType = 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/mp4;codecs=aac')) mimeType = 'audio/mp4;codecs=aac';
    else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
    else if (MediaRecorder.isTypeSupported('audio/aac')) mimeType = 'audio/aac';

    const recorder = new MediaRecorder(dest.stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);

    let maxTime = 0;
    state.tracks.video.forEach(c => maxTime = Math.max(maxTime, c.startTime+c.duration));
    state.tracks.audio.forEach(t => t.forEach(c => maxTime = Math.max(maxTime, c.startTime+c.duration)));
    if (maxTime === 0) maxTime = 1;

    recorder.onstop = () => {
        elements.exportProgress.textContent = 'Audio Ready!';
        const blob = new Blob(chunks, { type: mimeType });
        elements.cancelExportBtn.style.display = 'none';
        elements.saveExportBtn.style.display = 'inline-block';

        elements.saveExportBtn.onclick = () => {
            const ext = mimeType.includes('mp4') || mimeType.includes('aac') ? 'm4a' : 'weba';
            const filename = `uhcut-audio.${ext}`;
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();

            setTimeout(() => elements.exportOverlay.classList.add('hidden'), 2000);
        };
    };

    recorder.start();
    state.isPlaying = true;

    function recLoop() {
        if (!state.isPlaying || state.playbackTime >= maxTime) {
            recorder.stop();
            state.isPlaying = false;
            return;
        }
        const pct = Math.floor((state.playbackTime / maxTime) * 100);
        elements.exportProgress.textContent = `${pct}%`;
        requestAnimationFrame(recLoop);
    }
    recLoop();

    elements.cancelExportBtn.onclick = () => {
        recorder.stop();
        state.isPlaying = false;
        elements.exportOverlay.classList.add('hidden');
    };
}

function stabilizeClip() {
    if (!state.selectedClipId) return;
    const clip = findClip(state.selectedClipId);
    if (!clip || clip.type !== 'video') return alert('Select a video clip');

    elements.exportOverlay.classList.remove('hidden');
    elements.exportProgress.textContent = 'Stabilizing...';
    elements.saveExportBtn.style.display = 'none';
    elements.cancelExportBtn.style.display = 'none';

    setTimeout(() => {
        saveState();
        clip.stabilized = true;
        elements.exportOverlay.classList.add('hidden');
        renderTimeline();
        syncMedia();
    }, 1500);
}

function startInlineRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        recordingStream = stream;

        // iOS Mime Check
        const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
        let options = undefined;
        for (const t of types) {
            if (MediaRecorder.isTypeSupported(t)) {
                options = { mimeType: t };
                break;
            }
        }

        mediaRecorder = new MediaRecorder(stream, options);
        chunks = [];
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.start();

        isRecording = true;
        recordingStartPlaybackTime = state.playbackTime;
        recordingWaveformData = [];

        const mediaId = 'rec_' + Date.now();
        const clipId = 'clip_rec_' + Date.now();
        recordingClipId = clipId;
        recordingMediaId = mediaId;

        // Create placeholder media entry
        state.media.push({
            id: mediaId,
            file: null,
            url: null,
            type: 'audio',
            name: 'Recording...',
            duration: 0,
            _recording: true
        });

        saveState();

        // Create clip on audio track 0
        state.tracks.audio[0].push({
            id: clipId,
            mediaId: mediaId,
            startTime: recordingStartPlaybackTime,
            duration: 0.1,
            offset: 0,
            type: 'audio',
            muted: false
        });

        // Start playback if not already playing
        if (!state.isPlaying) {
            document.getElementById('play-pause-btn').click();
        }

        // Setup analyser for live waveform
        if (audioCtx.state === 'suspended') audioCtx.resume();
        recordingSource = audioCtx.createMediaStreamSource(stream);
        recordingAnalyser = audioCtx.createAnalyser();
        recordingAnalyser.fftSize = 256;
        recordingSource.connect(recordingAnalyser);

        // Visual feedback on mic button
        const recBtn = document.getElementById('tool-record');
        recBtn.classList.add('recording');

        renderTimeline();
        updateRecordingClip();
    });
}

function updateRecordingClip() {
    if (!isRecording) return;

    const clip = findClip(recordingClipId);
    if (!clip) { isRecording = false; return; }

    // Update duration based on playback time
    const elapsed = state.playbackTime - recordingStartPlaybackTime;
    clip.duration = Math.max(0.1, elapsed);

    // Update media duration
    const media = state.media.find(m => m.id === recordingMediaId);
    if (media) media.duration = clip.duration;

    // Collect waveform peak sample
    if (recordingAnalyser) {
        const data = new Uint8Array(recordingAnalyser.frequencyBinCount);
        recordingAnalyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i] / 128.0 - 1.0);
            if (v > peak) peak = v;
        }
        recordingWaveformData.push(peak);
    }

    // Update the clip element directly (no full re-render)
    const clipEl = document.querySelector(`.clip[data-clip-id="${recordingClipId}"]`);
    if (clipEl) {
        const width = Math.max(2, clip.duration * state.zoom);
        clipEl.style.width = width + 'px';
        clipEl.style.left = (clip.startTime * state.zoom) + 'px';

        // Create or update recording waveform canvas
        let canvas = clipEl.querySelector('.recording-waveform');
        if (!canvas) {
            clipEl.innerHTML = '';
            const label = document.createElement('span');
            label.className = 'clip-label';
            label.textContent = 'Recording...';
            label.style.color = '#ff4444';
            clipEl.appendChild(label);

            canvas = document.createElement('canvas');
            canvas.className = 'recording-waveform clip-waveform';
            clipEl.appendChild(canvas);
        }

        const cw = Math.max(1, Math.ceil(width));
        if (canvas.width !== cw) canvas.width = cw;
        canvas.height = TRACK_HEIGHT;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 1;
        ctx.beginPath();

        const totalSamples = recordingWaveformData.length;
        for (let x = 0; x < canvas.width; x++) {
            const idx = Math.floor(x * totalSamples / canvas.width);
            const peak = recordingWaveformData[idx] || 0;
            const h = peak * canvas.height;
            ctx.moveTo(x, (canvas.height - h) / 2);
            ctx.lineTo(x, (canvas.height + h) / 2);
        }
        ctx.stroke();
    }

    recordingAnimFrame = requestAnimationFrame(updateRecordingClip);
}

function stopInlineRecording() {
    isRecording = false;
    if (recordingAnimFrame) cancelAnimationFrame(recordingAnimFrame);

    // Reset mic button
    const recBtn = document.getElementById('tool-record');
    recBtn.classList.remove('recording');

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = () => {
            const mime = mediaRecorder.mimeType;
            const ext = mime.includes('mp4') ? 'mp4' : (mime.includes('aac') ? 'aac' : 'webm');
            const blob = new Blob(chunks, { type: mime });
            const url = URL.createObjectURL(blob);

            // Finalize the media entry
            const media = state.media.find(m => m.id === recordingMediaId);
            const clip = findClip(recordingClipId);
            if (media && clip) {
                media.file = new File([blob], `Rec_${Date.now()}.${ext}`, { type: mime });
                media.url = url;
                media.name = `Rec_${new Date().toLocaleTimeString()}`;
                media.duration = clip.duration;
                delete media._recording;
            }

            if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());

            recordingClipId = null;
            recordingMediaId = null;
            recordingAnalyser = null;
            recordingSource = null;
            recordingWaveformData = [];

            renderTimeline();
        };
        mediaRecorder.stop();
    }

    // Pause playback
    if (state.isPlaying) {
        document.getElementById('play-pause-btn').click();
    }
}

function extractAudio() {
    if (!state.selectedClipId) return alert('Select video clip');
    const clip = state.tracks.video.find(c => c.id === state.selectedClipId);
    if (!clip) return alert('Not a video clip');

    saveState();

    const audioClip = {
        ...clip,
        id: 'audio_' + Date.now(),
        type: 'audio',
        muted: false
    };
    state.tracks.audio[0].push(audioClip); // Add to Track 1
    clip.muted = true;
    renderTimeline();
}

async function removeSilenceTool() {
    if (!state.selectedClipId) return alert('Select a clip');
    const clip = findClip(state.selectedClipId);
    if (!clip) return;

    const media = state.media.find(m => m.id === clip.mediaId);
    let buffer = waveformCache[media.id];
    if (!buffer) {
        const r = await fetch(media.url);
        const ab = await r.arrayBuffer();
        buffer = await audioCtx.decodeAudioData(ab);
        waveformCache[media.id] = buffer;
    }

    const startSample = Math.floor(clip.offset * buffer.sampleRate);
    const endSample = Math.floor((clip.offset + clip.duration) * buffer.sampleRate);
    const data = buffer.getChannelData(0);

    // Dynamic Threshold Calculation
    let maxVal = 0;
    for (let i = startSample; i < endSample; i += 100) {
        const v = Math.abs(data[i]);
        if (v > maxVal) maxVal = v;
    }

    const threshold = Math.max(0.01, maxVal * 0.03); // 3% or 0.01 floor
    const padding = 0.25; // 0.25s padding
    const paddingSamples = Math.floor(padding * buffer.sampleRate);
    const minSpeechDur = 0.1;

    const regions = [];
    let currentRegion = null;

    // Scan with 20ms window
    const windowSize = Math.floor(buffer.sampleRate * 0.02);

    for(let i=startSample; i<endSample; i+=windowSize) {
        let localMax = 0;
        // Check peak in window
        for(let j=0; j<windowSize && (i+j)<endSample; j+=10) {
             const v = Math.abs(data[i+j]);
             if(v > localMax) localMax = v;
        }

        if(localMax > threshold) {
            // Speech detected
            const start = Math.max(startSample, i - paddingSamples);
            const end = Math.min(endSample, i + windowSize + paddingSamples);

            if(!currentRegion) {
                currentRegion = { start, end };
                regions.push(currentRegion);
            } else {
                if(start <= currentRegion.end) {
                    currentRegion.end = Math.max(currentRegion.end, end);
                } else {
                    currentRegion = { start, end };
                    regions.push(currentRegion);
                }
            }
        }
    }

    const speechSegments = regions.filter(r => (r.end - r.start)/buffer.sampleRate > minSpeechDur);

    if (speechSegments.length === 0) return alert('No speech detected (threshold: ' + threshold.toFixed(4) + ')');

    saveState();

    // Remove original clip
    state.tracks.video = state.tracks.video.filter(c => c.id !== clip.id);
    state.tracks.audio.forEach(t => {
        const idx = t.findIndex(c => c.id === clip.id);
        if (idx !== -1) t.splice(idx, 1);
    });

    let insertTime = clip.startTime;

    speechSegments.forEach(seg => {
        const segDuration = (seg.end - seg.start) / buffer.sampleRate;
        const segOffset = seg.start / buffer.sampleRate;

        const newClip = {
            id: 'auto_' + Date.now() + Math.random(),
            mediaId: clip.mediaId,
            startTime: insertTime,
            duration: segDuration,
            offset: segOffset,
            type: clip.type,
            muted: clip.muted,
            volume: clip.volume || 1.0
        };

        if (clip.type === 'video') {
            state.tracks.video.push(newClip);
        } else {
             state.tracks.audio[0].push(newClip);
        }

        insertTime += segDuration;
    });

    renderTimeline();
}

function setupExport() {
    elements.exportBtn.addEventListener('click', async () => {
        elements.exportOverlay.classList.remove('hidden');
        elements.exportProgress.textContent = 'Preparing...';
        elements.saveExportBtn.style.display = 'none';
        elements.cancelExportBtn.style.display = 'inline-block';

        state.isPlaying = false;
        seek(0);

        // Determine export dimensions from source video (preserve portrait/landscape)
        let exportWidth = 1280;
        let exportHeight = 720;
        const firstVideoClip = state.tracks.video[0];
        if (firstVideoClip) {
            const firstMedia = state.media.find(m => m.id === firstVideoClip.mediaId);
            if (firstMedia && firstMedia.videoWidth && firstMedia.videoHeight) {
                exportWidth = firstMedia.videoWidth;
                exportHeight = firstMedia.videoHeight;
                // Cap at 1920 on the longer side
                const maxDim = 1920;
                if (exportWidth > maxDim || exportHeight > maxDim) {
                    const scale = maxDim / Math.max(exportWidth, exportHeight);
                    exportWidth = Math.round(exportWidth * scale);
                    exportHeight = Math.round(exportHeight * scale);
                }
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = exportWidth;
        canvas.height = exportHeight;
        const ctx = canvas.getContext('2d');

        // Use Global Export Dest (already connected to masterGain)
        const dest = exportDest;

        const stream = canvas.captureStream(30);
        if (dest.stream.getAudioTracks().length > 0) {
            stream.addTrack(dest.stream.getAudioTracks()[0]);
        }

        // Supported export types
        const exportTypes = [
            'video/mp4;codecs=avc1',
            'video/mp4',
            'video/webm;codecs=vp9',
            'video/webm'
        ];
        let selectedType = '';
        for (const t of exportTypes) {
            if (MediaRecorder.isTypeSupported(t)) { selectedType = t; break; }
        }

        const recorder = new MediaRecorder(stream, selectedType ? { mimeType: selectedType } : undefined);
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);

        // Max time
        let maxTime = 0;
        state.tracks.video.forEach(c => maxTime = Math.max(maxTime, c.startTime+c.duration));
        state.tracks.audio.forEach(t => t.forEach(c => maxTime = Math.max(maxTime, c.startTime+c.duration)));
        if (maxTime === 0) maxTime = 1;

        recorder.onstop = async () => {
            elements.exportProgress.textContent = 'Ready!';

            const blob = new Blob(chunks, { type: selectedType || 'video/webm' });
            if (blob.size === 0) {
                elements.exportProgress.textContent = 'Error: Recording Failed (Empty)';
                return;
            }

            elements.cancelExportBtn.style.display = 'none';
            elements.saveExportBtn.style.display = 'inline-block';

            elements.saveExportBtn.onclick = async () => {
                const ext = (selectedType && selectedType.includes('mp4')) ? 'mp4' : 'webm';
                const filename = `uhcut-export.${ext}`;
                const file = new File([blob], filename, { type: selectedType || 'video/webm' });

                // Try Share API
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({
                            files: [file],
                            title: 'UhCut Export',
                            text: 'Created with UhCut'
                        });
                        elements.exportOverlay.classList.add('hidden');
                        return;
                    } catch (e) {
                        console.warn("Share failed/cancelled", e);
                    }
                }

                // Fallback
                const url = URL.createObjectURL(blob);
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

                if (isIOS) {
                    window.open(url, '_blank');
                } else {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                }

                setTimeout(() => elements.exportOverlay.classList.add('hidden'), 2000);
            };
        };

        recorder.start();
        state.isPlaying = true;

        function recLoop() {
            if (!state.isPlaying || state.playbackTime >= maxTime) {
                recorder.stop();
                state.isPlaying = false;
                return;
            }

            // Progress
            const pct = Math.floor((state.playbackTime / maxTime) * 100);
            elements.exportProgress.textContent = `${pct}%`;

            // Handle Stabilization Crop
            const currentClip = state.tracks.video.find(c =>
                state.playbackTime >= c.startTime &&
                state.playbackTime < c.startTime + c.duration
            );

            if (currentClip && currentClip.stabilized) {
                const vw = elements.mainVideo.videoWidth;
                const vh = elements.mainVideo.videoHeight;
                if (vw && vh) {
                    const sw = vw / 1.1;
                    const sh = vh / 1.1;
                    const sx = (vw - sw) / 2;
                    const sy = (vh - sh) / 2;
                    ctx.drawImage(elements.mainVideo, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
                } else {
                    ctx.drawImage(elements.mainVideo, 0, 0, canvas.width, canvas.height);
                }
            } else {
                ctx.drawImage(elements.mainVideo, 0, 0, canvas.width, canvas.height);
            }
            requestAnimationFrame(recLoop);
        }
        recLoop();

        elements.cancelExportBtn.onclick = () => {
            recorder.stop();
            state.isPlaying = false;
            elements.exportOverlay.classList.add('hidden');
        };
    });
}

init();
