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
    cancelExportBtn: document.getElementById('cancel-export-btn')
};

// Global Audio Context (Singleton)
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioPool = {}; // clipId -> AudioElement

// Constants
const TRACK_HEIGHT = 50;

// Initialization
function init() {
    setupFileInput();
    setupTimelineInteraction();
    setupToolbar();
    setupKeyboardShortcuts();
    setupExport();

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
    const type = file.type.startsWith('video') ? 'video' : 'audio';
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
            duration: element.duration || 0
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
        muted: false
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
let dragOriginalStart = 0;

function setupTimelineInteraction() {
    const { timelineTracks, timelineContainer } = elements;

    // Drop listener needs to account for container scroll
    timelineTracks.addEventListener('dragover', (e) => e.preventDefault());
    timelineTracks.addEventListener('drop', (e) => {
        e.preventDefault();

        // Calculate X relative to the tracks container (absolute timeline px)
        const rect = timelineTracks.getBoundingClientRect();
        // Since timelineTracks is inside the scrollable area, rect.left moves.
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

    const clip = findClip(dragClipId);
    if (clip) {
        dragOriginalStart = clip.startTime;
        state.selectedClipId = dragClipId;
        renderTimeline();
    }
}

function handleMouseMove(e) {
    if (!isDragging || !dragClipId) return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const deltaPx = clientX - dragStartX;
    const deltaSec = deltaPx / state.zoom;

    const clip = findClip(dragClipId);
    if (clip) {
        clip.startTime = Math.max(0, dragOriginalStart + deltaSec);
        const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
        if (el) el.style.left = (clip.startTime * state.zoom) + 'px';
    }
}

function handleMouseUp() {
    if (isDragging) {
        isDragging = false;
        dragClipId = null;
        renderTimeline();
        saveState();
    }
}

function findClip(id) {
    let c = state.tracks.video.find(c => c.id === id);
    if (c) return c;
    for (const track of state.tracks.audio) {
        c = track.find(k => k.id === id);
        if (c) return c;
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

    // New Scroll: The point 'timeAtMouse' should be at 'mouseXInContainer' relative to container
    // timeAtMouse * newZoom is the new pixel pos on track.
    // We want: NewPixelPos - NewScroll = mouseXInContainer (minus padding offset if relevant, but scrollLeft includes padding area usually? no).
    // Let's assume container scrollLeft=0 means track Left is at 20px (due to padding).
    // So visual pos = trackPixel + 20 - scrollLeft.
    // We want: trackPixel + 20 - scrollLeft = mouseXInContainer.
    // => scrollLeft = trackPixel + 20 - mouseXInContainer.

    const newPixelPos = timeAtMouse * state.zoom;
    // 20 is padding-left. We can read it dynamically or hardcode since we set it.
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

        if (!el) {
            el = document.createElement('div');
            el.className = 'clip';
            el.dataset.clipId = clip.id;
            el.dataset.type = type;
            trackEl.appendChild(el);
            renderClipContent(el, clip, type);
        } else {
            el.dataset.stale = 'false';
            const prevProps = el.dataset.props;
            const newProps = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}`;
            if (prevProps !== newProps) renderClipContent(el, clip, type);
        }

        el.style.left = left + 'px';
        el.style.width = width + 'px';
        el.dataset.props = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}`;

        if (state.selectedClipId === clip.id) el.classList.add('selected');
        else el.classList.remove('selected');
    });

    Array.from(trackEl.children).forEach(el => {
        if (el.dataset.stale === 'true') el.remove();
    });
}

function renderClipContent(el, clip, type) {
    el.innerHTML = '';
    const media = state.media.find(m => m.id === clip.mediaId);
    if (!media) {
        el.textContent = 'Missing';
        return;
    }

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = media.name;
    el.appendChild(label);

    if (type === 'audio') drawWaveform(el, clip, media);
    else if (type === 'video') drawThumbnails(el, clip, media);
}

const waveformCache = {};

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
        if (time < media.duration) queueThumbnail(media.url, time, thumbDiv);
    }
}

function queueThumbnail(url, time, el) {
    thumbQueue.push({ url, time, el });
    processThumbQueue();
}

function processThumbQueue() {
    if (isProcessingThumbs || thumbQueue.length === 0 || state.isPlaying) return;

    if (thumbQueue.length > 30) thumbQueue.splice(0, thumbQueue.length - 10);

    isProcessingThumbs = true;
    const task = thumbQueue.shift();

    if (!thumbVideo) {
        thumbVideo = document.createElement('video');
        thumbVideo.muted = true;
        thumbVideo.style.display = 'none';
        // IMPORTANT: Must be in DOM to work reliably in some browsers
        document.body.appendChild(thumbVideo);
    }

    const onSeek = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d').drawImage(thumbVideo, 0, 0, canvas.width, canvas.height);
        task.el.style.backgroundImage = `url(${canvas.toDataURL()})`;

        isProcessingThumbs = false;
        setTimeout(processThumbQueue, 20); // Small delay to yield UI
    };

    const onError = () => {
        isProcessingThumbs = false;
        setTimeout(processThumbQueue, 20);
    };

    thumbVideo.addEventListener('seeked', onSeek, { once: true });
    thumbVideo.addEventListener('error', onError, { once: true });

    if (thumbVideo.src !== task.url) thumbVideo.src = task.url;

    // Safety check for ready state
    if (thumbVideo.readyState >= 2 && thumbVideo.src === task.url && Math.abs(thumbVideo.currentTime - task.time) < 0.1) {
         onSeek(); // Already there
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
        v.muted = videoClip.muted;
        v.style.opacity = 1;
        if (state.isPlaying && v.paused) v.play().catch(()=>{});
        if (!state.isPlaying && !v.paused) v.pause();
    } else {
        v.style.opacity = 0;
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

    Object.keys(audioPool).forEach(id => {
        if (!activeClips.find(c => c.id === id)) {
            audioPool[id].pause();
            delete audioPool[id];
        }
    });

    activeClips.forEach(clip => {
        let a = audioPool[clip.id];
        if (!a) {
            const media = state.media.find(m => m.id === clip.mediaId);
            a = new Audio(media.url);
            audioPool[clip.id] = a;
        }
        const clipTime = state.playbackTime - clip.startTime + clip.offset;
        if (Math.abs(a.currentTime - clipTime) > 0.3) a.currentTime = clipTime;
        if (state.isPlaying && a.paused) a.play().catch(()=>{});
        if (!state.isPlaying && !a.paused) a.pause();
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
        elements.recordOverlay.classList.remove('hidden');
        startRecording();
    });

    document.getElementById('cancel-record-btn').addEventListener('click', () => {
        stopRecording(false);
        elements.recordOverlay.classList.add('hidden');
    });
    document.getElementById('stop-record-btn').addEventListener('click', () => {
        stopRecording(true);
        elements.recordOverlay.classList.add('hidden');
    });

    btn('tool-extract-audio', extractAudio);
    btn('tool-silence', removeSilenceTool);
}

function startRecording() {
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
        visualizeMic(stream);
    });
}

function stopRecording(save) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = () => {
            if (save) {
                const mime = mediaRecorder.mimeType;
                const ext = mime.includes('mp4') ? 'mp4' : (mime.includes('aac') ? 'aac' : 'webm');
                const blob = new Blob(chunks, { type: mime });
                const file = new File([blob], `Rec_${Date.now()}.${ext}`, { type: mime });
                processFile(file);
            }
            if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
        };
        mediaRecorder.stop();
    }
}

function visualizeMic(stream) {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Ensure context is running
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    function draw() {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
        requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(data);

        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#00ffcc';
        ctx.beginPath();

        const slice = canvas.width / data.length;
        let x = 0;
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0;
            const y = v * canvas.height / 2;
            if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            x += slice;
        }
        ctx.stroke();
    }
    draw();
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

    // Dynamic Threshold
    let maxVal = 0;
    // Scan segment to find max amplitude (step 100 for speed)
    for (let i = startSample; i < endSample; i += 100) {
        const v = Math.abs(data[i]);
        if (v > maxVal) maxVal = v;
    }

    const threshold = Math.max(0.01, maxVal * 0.15); // 15% of peak
    const minSilenceDur = 0.15;
    const minSpeechDur = 0.15; // Kept consistent or should be 0.15? User said "minSilenceDur to 0.15" but didn't specify speech. I'll stick to 0.15 for robustness.

    const ranges = [];
    let isSpeech = false;
    let rangeStart = startSample;

    for (let i = startSample; i < endSample; i += 100) {
        const val = Math.abs(data[i]);
        if (val > threshold && !isSpeech) {
            ranges.push({ start: rangeStart, end: i, type: 'silence' });
            rangeStart = i;
            isSpeech = true;
        } else if (val <= threshold && isSpeech) {
            let futureSpeech = false;
            for (let j = 1; j < (minSilenceDur * buffer.sampleRate) / 100 && (i+j*100) < endSample; j++) {
                 if (Math.abs(data[i+j*100]) > threshold) {
                     futureSpeech = true;
                     break;
                 }
            }
            if (!futureSpeech) {
                ranges.push({ start: rangeStart, end: i, type: 'speech' });
                rangeStart = i;
                isSpeech = false;
            }
        }
    }
    ranges.push({ start: rangeStart, end: endSample, type: isSpeech ? 'speech' : 'silence' });

    const speechSegments = ranges.filter(r => r.type === 'speech' && (r.end - r.start)/buffer.sampleRate > minSpeechDur);

    if (speechSegments.length === 0) return alert('No speech detected (threshold: ' + threshold.toFixed(4) + ')');

    saveState();

    // Remove original clip
    state.tracks.video = state.tracks.video.filter(c => c.id !== clip.id);
    state.tracks.audio.forEach(t => {
        const idx = t.findIndex(c => c.id === clip.id);
        if (idx !== -1) t.splice(idx, 1);
    });

    let insertTime = clip.startTime;

    // Determine where to add new clips (original track?)
    // We need to know which track it came from.
    // For simplicity, video clips go to video track, audio clips to audio track 1 (or we search).
    // Let's assume video stays video.

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
            muted: clip.muted
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

        state.isPlaying = false;
        seek(0);

        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const dest = audioCtx.createMediaStreamDestination();

        // Main video audio
        try {
             const src = audioCtx.createMediaElementSource(elements.mainVideo);
             src.connect(dest);
             src.connect(audioCtx.destination);
        } catch(e) {}

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
            elements.exportProgress.textContent = 'Finalizing...';
            const blob = new Blob(chunks, { type: selectedType || 'video/webm' });
            const ext = (selectedType && selectedType.includes('mp4')) ? 'mp4' : 'webm';
            const filename = `uhcut-export.${ext}`;

            // Try Share API (Mobile Friendly)
            if (navigator.share && navigator.canShare) {
                try {
                    const file = new File([blob], filename, { type: selectedType || 'video/webm' });
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({
                            files: [file],
                            title: 'UhCut Export',
                            text: 'Here is my video!'
                        });
                        elements.exportOverlay.classList.add('hidden');
                        return; // Done
                    }
                } catch (e) {
                    console.warn("Share failed/cancelled, falling back to download", e);
                }
            }

            // Fallback Download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();

            setTimeout(() => elements.exportOverlay.classList.add('hidden'), 1000);
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

            ctx.drawImage(elements.mainVideo, 0, 0, canvas.width, canvas.height);
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
