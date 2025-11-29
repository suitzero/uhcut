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

    timelineTracks.addEventListener('click', (e) => {
        if (e.target.classList.contains('clip')) {
            selectClip(e.target.dataset.clipId);
        } else {
            selectClip(null);
        }

        // Move playhead if clicked on background
        if (!e.target.classList.contains('clip')) {
            const rect = timelineTracks.getBoundingClientRect();
            const x = e.clientX - rect.left + timelineTracks.scrollLeft;
            seek(x / state.zoom);
        }
    });
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
    // Clear tracks
    document.querySelectorAll('.track').forEach(t => t.innerHTML = '');

    // Render clips
    ['video', 'audio'].forEach(type => {
        const trackEl = document.querySelector(`.track[data-type="${type}"]`);
        state.tracks[type].forEach(clip => {
            const el = document.createElement('div');
            el.className = 'clip';
            if (state.selectedClipId === clip.id) el.classList.add('selected');
            el.dataset.clipId = clip.id;
            el.dataset.type = type;

            // Positioning
            el.style.left = (clip.startTime * state.zoom) + 'px';
            el.style.width = (clip.duration * state.zoom) + 'px';

            // Content
            const media = state.media.find(m => m.id === clip.mediaId);
            // el.textContent = media ? media.name : 'Unknown';
            // Use inner structure for advanced visuals

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
        });
    });

    // Update container width
    const maxTime = Math.max(
        ...state.tracks.video.map(c => c.startTime + c.duration),
        ...state.tracks.audio.map(c => c.startTime + c.duration),
        10 // min 10 seconds
    );
    timelineTracks.style.width = (maxTime * state.zoom + 500) + 'px';
    document.getElementById('time-ruler').style.width = timelineTracks.style.width;
}

// Visuals Cache
const waveformCache = {}; // mediaId -> AudioBuffer
const thumbnailCache = {}; // mediaId_offset -> DataURL

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
    const step = Math.ceil(data.length / width); // simplified sampling
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
        for (let j = 0; j < samplesPerPixel; j++) {
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
    // We want a thumbnail every ~100px or so
    const clipWidth = clip.duration * state.zoom;
    const numThumbs = Math.ceil(clipWidth / 100);
    const thumbWidth = clipWidth / numThumbs;

    const strip = document.createElement('div');
    strip.className = 'clip-filmstrip';
    container.insertBefore(strip, container.firstChild);

    const video = document.createElement('video');
    video.src = media.url;
    video.currentTime = clip.offset; // Start

    // This is asynchronous and tricky to do perfectly without heavy performance hit.
    // Simplified approach: just show 3 thumbnails (start, middle, end) if possible, or tiled

    // Actually, let's create simple divs
    for (let i = 0; i < numThumbs; i++) {
        const thumbTime = clip.offset + (i * (clip.duration / numThumbs));
        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'video-thumb';
        thumbDiv.style.width = thumbWidth + 'px';

        // We need to capture frame.
        // We can't easily sync wait for video seek in a loop.
        // Optimization: Create a unique ID for this thumb request
        captureThumbnail(video, thumbTime).then(url => {
            thumbDiv.style.backgroundImage = `url(${url})`;
        });

        strip.appendChild(thumbDiv);
    }
}

async function captureThumbnail(videoElement, time) {
    // Clone video to not mess with playback? No, we create a new element in drawVideoThumbnails
    // But we need to wait for seek.

    return new Promise((resolve) => {
        const v = document.createElement('video');
        v.src = videoElement.src;
        v.currentTime = time;
        v.muted = true;
        v.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 160; // low res
            canvas.height = 90;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL());
        };
        // Trigger load
        v.load();
    });
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

playPauseBtn.addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    playPauseBtn.textContent = state.isPlaying ? 'Pause' : 'Play';
    lastTime = 0; // reset delta

    // Also handle audio elements if we add them later
});

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
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => {
                audioChunks.push(e.data);
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
        .catch(err => console.error('Error accessing microphone:', err));
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

        // Analyze channel data
        const rawData = audioBuffer.getChannelData(0); // Use first channel
        const sampleRate = audioBuffer.sampleRate;
        const threshold = 0.02; // Silence threshold (0-1)
        const minSilenceDuration = 0.5; // seconds

        const chunks = [];
        let isSilent = true;
        let lastChangeIndex = 0;

        for (let i = 0; i < rawData.length; i++) {
            const amplitude = Math.abs(rawData[i]);
            if (amplitude > threshold) {
                if (isSilent) {
                    // Silence ended
                    const silenceDuration = (i - lastChangeIndex) / sampleRate;
                    if (silenceDuration > minSilenceDuration) {
                         // Record silence block if needed, but we want to record SPEECH blocks
                    }
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
             chunks.push({ start: lastChangeIndex / sampleRate, end: rawData.length / sampleRate });
        }

        if (chunks.length === 0) return alert('No speech detected or volume too low.');

        // Replace the original clip with multiple clips
        // Filter chunks that are within the clip's visible range (offset to offset + duration)
        const validChunks = chunks.filter(chunk => {
             return chunk.end > clip.offset && chunk.start < (clip.offset + clip.duration);
        });

        saveState(); // Support Undo for this massive change

        // Remove original clip
        state.tracks[trackType] = state.tracks[trackType].filter(c => c.id !== clip.id);

        // Add new clips
        // Note: The chunks are intervals of SPEECH.
        // We want to place these chunks on the timeline such that the SILENCE is skipped.
        // The original logic was:
        // currentTimelinePos starts at clip.startTime.
        // For each chunk, we add a clip of that duration, then increment currentTimelinePos.
        // This effectively "collapses" the silence, which is what the user wants ("remove silence... remove the audio clip itself" implies shortening/editing).

        let currentTimelinePos = clip.startTime;

        validChunks.forEach(chunk => {
            // Clip chunk to the original clip boundaries (offset perspective)
            const chunkStart = Math.max(chunk.start, clip.offset);
            const chunkEnd = Math.min(chunk.end, clip.offset + clip.duration);
            const duration = chunkEnd - chunkStart;

            if (duration > 0.1) { // Min clip length
                const newClip = {
                    id: 'chunk_' + Date.now() + Math.random(),
                    mediaId: clip.mediaId,
                    startTime: currentTimelinePos,
                    duration: duration,
                    offset: chunkStart,
                    type: clip.type,
                    muted: clip.muted
                };
                state.tracks[trackType].push(newClip);
                currentTimelinePos += duration;
            }
        });

        renderTimeline();

    } catch (e) {
        console.error('Error analyzing audio:', e);
        alert('Could not process audio for silence removal. ' + e.message);
    }
}


init();
