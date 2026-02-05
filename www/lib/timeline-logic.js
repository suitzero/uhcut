// Pure logic functions extracted from script.js for testability
// These have no DOM dependencies

/**
 * Check if a new clip collides with any existing clip on a track
 */
export function checkCollision(trackClips, newClip) {
    return trackClips.some(c =>
        c.id !== newClip.id &&
        !(newClip.startTime >= c.startTime + c.duration || newClip.startTime + newClip.duration <= c.startTime)
    );
}

/**
 * Find a clip by ID across all tracks
 */
export function findClipInTracks(tracks, id) {
    let c = tracks.video.find(c => c.id === id);
    if (c) return c;
    for (const track of tracks.audio) {
        c = track.find(k => k.id === id);
        if (c) return c;
    }
    return null;
}

/**
 * Calculate the total duration of all tracks (max end time)
 */
export function calculateMaxTime(tracks) {
    let maxTime = 0;
    const checkMax = (arr) => {
        if (arr.length) maxTime = Math.max(maxTime, ...arr.map(c => c.startTime + c.duration));
    };
    checkMax(tracks.video);
    tracks.audio.forEach(checkMax);
    return Math.max(maxTime, 0);
}

/**
 * Calculate ruler tick interval based on zoom level
 */
export function calculateRulerInterval(zoom) {
    const minPx = 60;
    let interval = 1;
    while (interval * zoom < minPx) {
        if (interval < 1) interval = 1;
        else if (interval < 2) interval = 2;
        else if (interval < 5) interval = 5;
        else if (interval < 10) interval = 10;
        else if (interval < 30) interval = 30;
        else if (interval < 60) interval = 60;
        else interval += 60;
    }
    return interval;
}

/**
 * Format time as MM:SS.ms
 */
export function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/**
 * Find the active video clip at a given playback time
 */
export function findActiveClip(clips, playbackTime) {
    return clips.find(c =>
        playbackTime >= c.startTime &&
        playbackTime < c.startTime + c.duration
    ) || null;
}

/**
 * Find all active audio clips across all audio tracks at a given time
 */
export function findActiveAudioClips(audioTracks, playbackTime) {
    const active = [];
    audioTracks.forEach(track => {
        track.forEach(c => {
            if (playbackTime >= c.startTime && playbackTime < c.startTime + c.duration) {
                active.push(c);
            }
        });
    });
    return active;
}

/**
 * Calculate the clip-relative time for a given playback time
 */
export function clipRelativeTime(clip, playbackTime) {
    return playbackTime - clip.startTime + clip.offset;
}

/**
 * Split a clip at a given playback time, returns [original, newClip] or null if invalid
 */
export function splitClipAt(clip, playbackTime) {
    const relTime = playbackTime - clip.startTime;
    if (relTime <= 0.05 || relTime >= clip.duration - 0.05) return null;

    const newClip = {
        ...clip,
        id: 'clip_' + Date.now(),
        startTime: playbackTime,
        duration: clip.duration - relTime,
        offset: clip.offset + relTime
    };

    const originalDuration = relTime;

    return { originalDuration, newClip };
}

/**
 * Detect speech segments from audio amplitude data
 */
export function detectSpeechSegments(data, startSample, endSample, sampleRate, options = {}) {
    const {
        thresholdRatio = 0.15,
        minSilenceDur = 0.15,
        minSpeechDur = 0.15,
        scanStep = 100
    } = options;

    // Find peak amplitude
    let maxVal = 0;
    for (let i = startSample; i < endSample; i += scanStep) {
        const v = Math.abs(data[i]);
        if (v > maxVal) maxVal = v;
    }

    const threshold = Math.max(0.01, maxVal * thresholdRatio);

    const ranges = [];
    let isSpeech = false;
    let rangeStart = startSample;

    for (let i = startSample; i < endSample; i += scanStep) {
        const val = Math.abs(data[i]);
        if (val > threshold && !isSpeech) {
            ranges.push({ start: rangeStart, end: i, type: 'silence' });
            rangeStart = i;
            isSpeech = true;
        } else if (val <= threshold && isSpeech) {
            let futureSpeech = false;
            for (let j = 1; j < (minSilenceDur * sampleRate) / scanStep && (i + j * scanStep) < endSample; j++) {
                if (Math.abs(data[i + j * scanStep]) > threshold) {
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

    return {
        threshold,
        segments: ranges.filter(r => r.type === 'speech' && (r.end - r.start) / sampleRate > minSpeechDur)
    };
}

/**
 * Get file extension from filename
 */
export function getFileExt(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot) : '.mp4';
}

/**
 * Build the thumbnail cache key
 */
export function thumbCacheKey(url, time) {
    return url + '|' + time.toFixed(2);
}
