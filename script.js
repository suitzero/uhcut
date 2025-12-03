// State
const state = {
    media: [],
    tracks: {
        video: [], // { id, mediaId, startTime, duration, offset, type, muted }
        audio: []
    },
    playbackTime: 0,
    isPlaying: false,
    zoom: 20, // pixels per second (default higher for visibility)
    selectedClipId: null
};

// History for Undo/Redo
const historyStack = [];
const redoStack = [];

// DOM Elements
const elements = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-upload'),
    mediaList: document.getElementById('media-list'),
    timelineTracks: document.getElementById('timeline-tracks'),
    timelineRuler: document.getElementById('time-ruler'),
    playhead: document.getElementById('playhead'),
    mainVideo: document.getElementById('main-video'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    timeDisplay: document.getElementById('time-display'),
    exportBtn: document.getElementById('export-btn'),
    recordOverlay: document.getElementById('record-overlay')
};

// Global Audio Context (Singleton)
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioPool = {}; // clipId -> AudioElement

// Constants
const TRACK_HEIGHT = 50;

// Initialization
function init() {
    setupDragAndDrop();
    setupTimelineInteraction();
    setupToolbar();
    setupExport();
    setupMobileUI();

    // Start Render Loop
    requestAnimationFrame(renderLoop);

    // Initial Render
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

    // Dedup: Don't save if identical to last
    if (historyStack.length > 0 && historyStack[historyStack.length - 1] === snapshot) return;

    historyStack.push(snapshot);
    redoStack.length = 0; // Clear redo on new action
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

function setupMobileUI() {
    // Media Library Toggle for Mobile
    const toggle = document.createElement('button');
    toggle.textContent = '📁';
    toggle.className = 'mobile-media-toggle';
    toggle.style.cssText = 'position: absolute; top: 50px; left: 10px; z-index: 100; display: none; padding: 8px; border-radius: 50%; background: #333; color: white; border: 1px solid #555;';

    document.body.appendChild(toggle);

    const checkMobile = () => {
        const isMobile = window.innerWidth <= 768;
        toggle.style.display = isMobile ? 'block' : 'none';
        if (!isMobile) {
            document.getElementById('media-library').style.display = 'flex';
        } else {
             document.getElementById('media-library').style.display = 'none';
        }
    };

    toggle.addEventListener('click', () => {
        const lib = document.getElementById('media-library');
        lib.style.display = lib.style.display === 'flex' ? 'none' : 'flex';
        if (lib.style.display === 'flex') {
            lib.style.cssText = 'display: flex; position: absolute; top: 90px; left: 0; width: 200px; bottom: 250px; z-index: 90; background: #1e1e2f; border-right: 1px solid #333;';
        }
    });

    window.addEventListener('resize', checkMobile);
    checkMobile();
}

function setupDragAndDrop() {
    const { dropZone, fileInput } = elements;

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFiles);

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#00d2ff';
    });

    dropZone.addEventListener('dragleave', () => {
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
    files.forEach(processFile);
}

function processFile(file) {
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
            duration: element.duration || 0
        };
        state.media.push(item);
        addToMediaLibrary(item);
    };
    element.src = url;
}

function addToMediaLibrary(item) {
    const div = document.createElement('div');
    div.className = 'media-item';
    div.textContent = item.name;
    div.draggable = true;
    div.dataset.mediaId = item.id;

    div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/json', JSON.stringify(item));
    });

    // Click to add (Mobile friendly)
    div.addEventListener('click', () => {
        // Find end of timeline
        const maxTime = Math.max(
            ...state.tracks.video.map(c => c.startTime + c.duration),
            ...state.tracks.audio.map(c => c.startTime + c.duration),
            0
        );
        addClipToTimeline(item, state.playbackTime); // Insert at playhead or end? Playhead is better.
    });

    elements.mediaList.appendChild(div);
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

    state.tracks[mediaItem.type].push(clip);
    renderTimeline();
}

let isDragging = false;
let dragClipId = null;
let dragStartX = 0;
let dragOriginalStart = 0;

function setupTimelineInteraction() {
    const { timelineTracks } = elements;

    timelineTracks.addEventListener('dragover', (e) => e.preventDefault());
    timelineTracks.addEventListener('drop', (e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData('application/json');
        if (!data) return;

        try {
            const item = JSON.parse(data);
            const rect = timelineTracks.getBoundingClientRect();
            const x = e.clientX - rect.left + timelineTracks.scrollLeft;
            const startTime = x / state.zoom;
            addClipToTimeline(item, startTime);
        } catch (err) {
            console.error(err);
        }
    });

    timelineTracks.addEventListener('mousedown', handleMouseDown);
    timelineTracks.addEventListener('touchstart', handleMouseDown, {passive: false});

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleMouseMove, {passive: false});

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchend', handleMouseUp);

    // Zoom via Wheel
    timelineTracks.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const zoomChange = e.deltaY > 0 ? 0.9 : 1.1;
            setZoom(state.zoom * zoomChange, e.clientX);
        }
    });

    // Click to seek or select
    timelineTracks.addEventListener('click', (e) => {
        if (isDragging) return;

        const clipEl = e.target.closest('.clip');
        if (clipEl) {
            state.selectedClipId = clipEl.dataset.clipId;
        } else {
            state.selectedClipId = null;
            // Seek
            const rect = timelineTracks.getBoundingClientRect();
            const x = e.clientX - rect.left + timelineTracks.scrollLeft;
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

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    dragStartX = clientX;

    // Find Clip
    const clip = findClip(dragClipId);
    if (clip) {
        dragOriginalStart = clip.startTime;
        state.selectedClipId = dragClipId;
        renderTimeline(); // Highlight selection
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

        // Optimistic UI update (avoid full render for performance)
        const el = document.querySelector(`.clip[data-clip-id="${dragClipId}"]`);
        if (el) el.style.left = (clip.startTime * state.zoom) + 'px';
    }
}

function handleMouseUp() {
    if (isDragging) {
        isDragging = false;
        dragClipId = null;
        renderTimeline(); // Full render to snap/clean up
        saveState();
    }
}

function findClip(id) {
    return state.tracks.video.find(c => c.id === id) || state.tracks.audio.find(c => c.id === id);
}

function setZoom(newZoom, mouseX) {
    const oldZoom = state.zoom;
    state.zoom = Math.max(1, Math.min(200, newZoom));

    // Adjust scroll to keep mouse focused
    const rect = elements.timelineTracks.getBoundingClientRect();
    const trackX = (mouseX || (rect.left + rect.width/2)) - rect.left;
    const timeAtMouse = (trackX + elements.timelineTracks.scrollLeft) / oldZoom;

    renderTimeline();

    const newScroll = (timeAtMouse * state.zoom) - trackX;
    elements.timelineTracks.scrollLeft = Math.max(0, newScroll);
}

// --- Rendering ---

function renderTimeline() {
    const { timelineTracks } = elements;

    // Render Tracks
    ['video', 'audio'].forEach(type => {
        let trackEl = timelineTracks.querySelector(`.track[data-type="${type}"]`);
        if (!trackEl) {
            trackEl = document.createElement('div');
            trackEl.className = 'track';
            trackEl.dataset.type = type;
            timelineTracks.appendChild(trackEl);
        }

        const clips = state.tracks[type];

        // Simple Reconciliation:
        // 1. Mark all existing as 'stale'
        Array.from(trackEl.children).forEach(el => el.dataset.stale = 'true');

        clips.forEach(clip => {
            let el = trackEl.querySelector(`.clip[data-clip-id="${clip.id}"]`);
            const width = Math.max(2, clip.duration * state.zoom); // Min width 2px
            const left = clip.startTime * state.zoom;

            if (!el) {
                // Create
                el = document.createElement('div');
                el.className = 'clip';
                el.dataset.clipId = clip.id;
                el.dataset.type = type;
                trackEl.appendChild(el);

                // Content
                renderClipContent(el, clip, type);
            } else {
                el.dataset.stale = 'false';
                // Update Content if needed (Check simple hash of props)
                const prevProps = el.dataset.props;
                const newProps = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}`;

                if (prevProps !== newProps) {
                    renderClipContent(el, clip, type);
                }
            }

            // Update Position
            el.style.left = left + 'px';
            el.style.width = width + 'px';
            el.dataset.props = `${clip.mediaId}_${clip.offset.toFixed(3)}_${clip.duration.toFixed(3)}_${state.zoom.toFixed(1)}`;

            // Selection
            if (state.selectedClipId === clip.id) el.classList.add('selected');
            else el.classList.remove('selected');
        });

        // Remove stale
        Array.from(trackEl.children).forEach(el => {
            if (el.dataset.stale === 'true') el.remove();
        });
    });

    // Update Width & Ruler
    const maxTime = Math.max(
        ...state.tracks.video.map(c => c.startTime + c.duration),
        ...state.tracks.audio.map(c => c.startTime + c.duration),
        20
    );
    timelineTracks.style.width = (maxTime * state.zoom + 500) + 'px';
    renderRuler(maxTime + 10);
}

function renderClipContent(el, clip, type) {
    el.innerHTML = ''; // Clear

    const media = state.media.find(m => m.id === clip.mediaId);
    if (!media) {
        el.textContent = 'Missing Media';
        return;
    }

    const label = document.createElement('span');
    label.className = 'clip-label';
    label.textContent = media.name;
    el.appendChild(label);

    if (type === 'audio') {
        drawWaveform(el, clip, media);
    } else if (type === 'video') {
        drawThumbnails(el, clip, media);
    }
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
        } catch (e) {
            console.error("Waveform error", e);
            return;
        }
    }

    const canvas = document.createElement('canvas');
    const width = Math.ceil(clip.duration * state.zoom);
    const height = TRACK_HEIGHT;
    canvas.width = width;
    canvas.height = height;
    canvas.className = 'clip-waveform';

    const ctx = canvas.getContext('2d');
    const data = buffer.getChannelData(0);

    // Calculate sample range based on offset
    const startSample = Math.floor(clip.offset * buffer.sampleRate);
    const endSample = Math.floor((clip.offset + clip.duration) * buffer.sampleRate);
    const totalSamples = endSample - startSample;
    const samplesPerPixel = Math.floor(totalSamples / width);

    ctx.strokeStyle = '#000';
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
        const start = startSample + (x * samplesPerPixel);
        let max = 0;
        // Sub-sample optimization
        const step = Math.max(1, Math.floor(samplesPerPixel / 10));

        for (let i = 0; i < samplesPerPixel; i += step) {
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

// Global Thumbnail Generator (Hidden)
let thumbVideo = null;
const thumbQueue = [];
let isProcessingThumbs = false;

function drawThumbnails(container, clip, media) {
    const strip = document.createElement('div');
    strip.className = 'clip-filmstrip';
    container.insertBefore(strip, container.firstChild);

    const clipWidth = clip.duration * state.zoom;
    const thumbWidth = 100; // Fixed width per thumb for consistency
    const numThumbs = Math.ceil(clipWidth / thumbWidth);

    for (let i = 0; i < numThumbs; i++) {
        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'video-thumb';
        thumbDiv.style.width = thumbWidth + 'px';
        thumbDiv.style.left = (i * thumbWidth) + 'px';
        thumbDiv.style.position = 'absolute';
        thumbDiv.style.height = '100%';
        strip.appendChild(thumbDiv);

        // Calculate Time
        const relativeTime = (i * thumbWidth) / state.zoom;
        const time = clip.offset + relativeTime;

        if (time < media.duration) {
            queueThumbnail(media.url, time, thumbDiv);
        }
    }
}

function queueThumbnail(url, time, el) {
    // Unique key for cache
    const key = `${url}_${time.toFixed(1)}`;

    // Check global simple cache (could be memory intensive, but browsers handle img caching well)
    // Actually, we use a custom cache if we want, but let's just queue generation.

    thumbQueue.push({ url, time, el });
    processThumbQueue();
}

function processThumbQueue() {
    if (isProcessingThumbs || thumbQueue.length === 0 || state.isPlaying) return;

    // Throttling: if queue is huge, clear old ones (user scrolled/zoomed)
    if (thumbQueue.length > 30) {
        thumbQueue.splice(0, thumbQueue.length - 10);
    }

    isProcessingThumbs = true;
    const task = thumbQueue.shift();

    if (!thumbVideo) {
        thumbVideo = document.createElement('video');
        thumbVideo.muted = true;
        thumbVideo.style.display = 'none';
        document.body.appendChild(thumbVideo);
    }

    if (thumbVideo.src !== task.url) thumbVideo.src = task.url;
    thumbVideo.currentTime = task.time;

    const onSeek = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d').drawImage(thumbVideo, 0, 0, canvas.width, canvas.height);

        task.el.style.backgroundImage = `url(${canvas.toDataURL()})`;

        isProcessingThumbs = false;
        // Schedule next
        setTimeout(processThumbQueue, 50);
    };

    const onError = () => {
        isProcessingThumbs = false;
        setTimeout(processThumbQueue, 50);
    };

    thumbVideo.addEventListener('seeked', onSeek, { once: true });
    thumbVideo.addEventListener('error', onError, { once: true });
}

function renderRuler(duration) {
    const { timelineRuler } = elements;
    timelineRuler.innerHTML = '';
    timelineRuler.style.width = elements.timelineTracks.style.width;

    // Decide interval based on zoom
    let interval = 1; // seconds
    if (state.zoom < 20) interval = 5;
    if (state.zoom < 5) interval = 10;
    if (state.zoom < 1) interval = 30;

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
    // Sync Video
    const videoClip = state.tracks.video.find(c =>
        state.playbackTime >= c.startTime &&
        state.playbackTime < c.startTime + c.duration
    );

    const v = elements.mainVideo;

    if (videoClip) {
        const media = state.media.find(m => m.id === videoClip.mediaId);
        if (v.src !== media.url) v.src = media.url;

        const clipTime = state.playbackTime - videoClip.startTime + videoClip.offset;

        // Tolerance drift check
        if (Math.abs(v.currentTime - clipTime) > 0.3) {
            v.currentTime = clipTime;
        }

        v.muted = videoClip.muted;
        v.style.opacity = 1;

        if (state.isPlaying && v.paused) v.play().catch(()=>{});
        if (!state.isPlaying && !v.paused) v.pause();

    } else {
        v.style.opacity = 0;
        v.pause();
    }

    // Sync Audio
    const audioClips = state.tracks.audio.filter(c =>
        state.playbackTime >= c.startTime &&
        state.playbackTime < c.startTime + c.duration
    );

    // Cleanup unused audio
    Object.keys(audioPool).forEach(id => {
        if (!audioClips.find(c => c.id === id)) {
            audioPool[id].pause();
            delete audioPool[id];
        }
    });

    audioClips.forEach(clip => {
        let a = audioPool[clip.id];
        if (!a) {
            const media = state.media.find(m => m.id === clip.mediaId);
            a = new Audio(media.url);
            audioPool[clip.id] = a;
        }

        const clipTime = state.playbackTime - clip.startTime + clip.offset;
        if (Math.abs(a.currentTime - clipTime) > 0.3) {
            a.currentTime = clipTime;
        }

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

        // Scroll follow
        const playheadPx = state.playbackTime * state.zoom;
        const scrollLeft = elements.timelineTracks.scrollLeft;
        const width = elements.timelineTracks.clientWidth;

        if (playheadPx > scrollLeft + width - 100) {
            elements.timelineTracks.scrollLeft = playheadPx - 100;
        }
    } else {
        state.lastFrameTime = 0;
    }
    requestAnimationFrame(renderLoop);
}

// --- Toolbar & Tools ---

function setupToolbar() {
    const btn = (id, fn) => document.getElementById(id).addEventListener('click', fn);

    btn('play-pause-btn', () => {
        state.isPlaying = !state.isPlaying;
        elements.playPauseBtn.innerHTML = state.isPlaying ?
            '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>' :
            '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

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
            state.tracks.audio = state.tracks.audio.filter(c => c.id !== state.selectedClipId);
            state.selectedClipId = null;
            renderTimeline();
        }
    });

    btn('tool-split', () => {
        if (!state.selectedClipId) return;

        // Find clip
        let type = 'video';
        let clip = state.tracks.video.find(c => c.id === state.selectedClipId);
        if (!clip) {
            type = 'audio';
            clip = state.tracks.audio.find(c => c.id === state.selectedClipId);
        }

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

                state.tracks[type].push(newClip);
                renderTimeline();
            }
        }
    });

    btn('tool-add-media', () => {
        elements.fileInput.click();
    });

    // Recording
    btn('tool-record', () => {
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


// --- Recording ---

let mediaRecorder;
let chunks = [];
let recordingStream;

function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        recordingStream = stream;
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.start();

        // Visualize
        visualizeMic(stream);
    });
}

function stopRecording(save) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.onstop = () => {
            if (save) {
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const file = new File([blob], `Rec_${Date.now()}.webm`, { type: 'audio/webm' });
                processFile(file); // Adds to media library
                // We should technically wait for it to load to add to timeline
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

// --- Features ---

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
    state.tracks.audio.push(audioClip);
    clip.muted = true; // Mute video

    renderTimeline();
}

async function removeSilenceTool() {
    if (!state.selectedClipId) return alert('Select a clip');

    let type = 'video';
    let clip = state.tracks.video.find(c => c.id === state.selectedClipId);
    if (!clip) {
        type = 'audio';
        clip = state.tracks.audio.find(c => c.id === state.selectedClipId);
    }

    const media = state.media.find(m => m.id === clip.mediaId);

    // Load Audio
    let buffer = waveformCache[media.id];
    if (!buffer) {
        const r = await fetch(media.url);
        const ab = await r.arrayBuffer();
        buffer = await audioCtx.decodeAudioData(ab);
        waveformCache[media.id] = buffer;
    }

    // Analyze Logic
    // 1. Map samples to timeline time
    const startSample = Math.floor(clip.offset * buffer.sampleRate);
    const endSample = Math.floor((clip.offset + clip.duration) * buffer.sampleRate);
    const data = buffer.getChannelData(0); // Mono check for simplicity, or check max of channels

    const threshold = 0.01; // Amplitude threshold
    const minSilenceDur = 0.3; // Seconds
    const minSpeechDur = 0.2; // Seconds

    const ranges = []; // {start, end, type: 'speech'|'silence'}
    let isSpeech = false;
    let rangeStart = startSample;

    // Scan
    for (let i = startSample; i < endSample; i += 100) { // Step 100 samples ~2ms
        const val = Math.abs(data[i]);
        if (val > threshold && !isSpeech) {
            // Silence -> Speech
            ranges.push({ start: rangeStart, end: i, type: 'silence' });
            rangeStart = i;
            isSpeech = true;
        } else if (val <= threshold && isSpeech) {
            // Speech -> Silence? Wait to confirm it's not just a pause
            // Look ahead
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

    // Filter & Process
    const speechSegments = ranges.filter(r => r.type === 'speech' && (r.end - r.start)/buffer.sampleRate > minSpeechDur);

    if (speechSegments.length === 0) return alert('No speech detected.');

    saveState();

    // Remove original clip
    state.tracks[type] = state.tracks[type].filter(c => c.id !== clip.id);

    // Add new clips
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
            muted: clip.muted
        };
        state.tracks[type].push(newClip);

        insertTime += segDuration; // Collapse gap
    });

    renderTimeline();
}

function setupExport() {
    elements.exportBtn.addEventListener('click', () => {
        alert("Export started (simplified). Playing video...");
        state.isPlaying = false;
        seek(0);

        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const dest = audioCtx.createMediaStreamDestination();

        // Connect Main Video to Dest
        try {
             const src = audioCtx.createMediaElementSource(elements.mainVideo);
             src.connect(dest);
             src.connect(audioCtx.destination);
        } catch(e) {
            // Already connected
        }

        const stream = canvas.captureStream(30);
        if (dest.stream.getAudioTracks().length > 0) {
            stream.addTrack(dest.stream.getAudioTracks()[0]);
        }

        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(chunks, {type: 'video/webm'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'export.webm';
            a.click();
        };

        recorder.start();
        state.isPlaying = true;

        // Loop
        const maxTime = Math.max(...state.tracks.video.map(c=>c.startTime+c.duration));

        function recLoop() {
            if (!state.isPlaying || state.playbackTime >= maxTime) {
                recorder.stop();
                state.isPlaying = false;
                return;
            }

            ctx.drawImage(elements.mainVideo, 0, 0, canvas.width, canvas.height);
            requestAnimationFrame(recLoop);
        }
        recLoop();
    });
}

init();
