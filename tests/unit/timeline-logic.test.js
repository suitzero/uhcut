import { describe, it, expect } from 'vitest';
import {
    checkCollision,
    findClipInTracks,
    calculateMaxTime,
    calculateRulerInterval,
    formatTime,
    findActiveClip,
    findActiveAudioClips,
    clipRelativeTime,
    splitClipAt,
    detectSpeechSegments,
    getFileExt,
    thumbCacheKey,
} from '../../www/lib/timeline-logic.js';

// --- checkCollision ---

describe('checkCollision', () => {
    const track = [
        { id: 'a', startTime: 0, duration: 5 },
        { id: 'b', startTime: 10, duration: 5 },
    ];

    it('returns false when clip fits in gap', () => {
        expect(checkCollision(track, { id: 'new', startTime: 5, duration: 5 })).toBe(false);
    });

    it('returns true when clip overlaps start of existing', () => {
        expect(checkCollision(track, { id: 'new', startTime: 4, duration: 3 })).toBe(true);
    });

    it('returns true when clip overlaps end of existing', () => {
        expect(checkCollision(track, { id: 'new', startTime: 12, duration: 5 })).toBe(true);
    });

    it('returns true when clip fully inside existing', () => {
        expect(checkCollision(track, { id: 'new', startTime: 1, duration: 2 })).toBe(true);
    });

    it('returns false when clip is exactly adjacent', () => {
        expect(checkCollision(track, { id: 'new', startTime: 5, duration: 5 })).toBe(false);
    });

    it('returns false on empty track', () => {
        expect(checkCollision([], { id: 'new', startTime: 0, duration: 5 })).toBe(false);
    });

    it('ignores collision with itself', () => {
        expect(checkCollision(track, { id: 'a', startTime: 0, duration: 5 })).toBe(false);
    });
});

// --- findClipInTracks ---

describe('findClipInTracks', () => {
    const tracks = {
        video: [{ id: 'v1', mediaId: 'm1' }],
        audio: [
            [{ id: 'a1', mediaId: 'm2' }],
            [{ id: 'a2', mediaId: 'm3' }],
        ],
    };

    it('finds clip in video track', () => {
        expect(findClipInTracks(tracks, 'v1')).toEqual({ id: 'v1', mediaId: 'm1' });
    });

    it('finds clip in first audio track', () => {
        expect(findClipInTracks(tracks, 'a1')).toEqual({ id: 'a1', mediaId: 'm2' });
    });

    it('finds clip in second audio track', () => {
        expect(findClipInTracks(tracks, 'a2')).toEqual({ id: 'a2', mediaId: 'm3' });
    });

    it('returns null for nonexistent id', () => {
        expect(findClipInTracks(tracks, 'nonexistent')).toBeNull();
    });
});

// --- calculateMaxTime ---

describe('calculateMaxTime', () => {
    it('returns 0 for empty tracks', () => {
        expect(calculateMaxTime({ video: [], audio: [[], []] })).toBe(0);
    });

    it('returns max from video track', () => {
        expect(calculateMaxTime({
            video: [{ startTime: 0, duration: 10 }, { startTime: 10, duration: 5 }],
            audio: [[], []]
        })).toBe(15);
    });

    it('returns max from audio track when it extends further', () => {
        expect(calculateMaxTime({
            video: [{ startTime: 0, duration: 5 }],
            audio: [[{ startTime: 10, duration: 20 }], []]
        })).toBe(30);
    });
});

// --- calculateRulerInterval ---

describe('calculateRulerInterval', () => {
    it('returns 1 for high zoom', () => {
        expect(calculateRulerInterval(100)).toBe(1);
    });

    it('returns larger interval for low zoom', () => {
        const interval = calculateRulerInterval(1);
        expect(interval).toBeGreaterThanOrEqual(60);
    });

    it('returns 2 for medium zoom', () => {
        expect(calculateRulerInterval(40)).toBe(2);
    });
});

// --- formatTime ---

describe('formatTime', () => {
    it('formats zero', () => {
        expect(formatTime(0)).toBe('00:00.00');
    });

    it('formats seconds', () => {
        expect(formatTime(5.5)).toBe('00:05.50');
    });

    it('formats minutes', () => {
        expect(formatTime(125.75)).toBe('02:05.75');
    });
});

// --- findActiveClip ---

describe('findActiveClip', () => {
    const clips = [
        { id: 'c1', startTime: 0, duration: 5 },
        { id: 'c2', startTime: 5, duration: 5 },
    ];

    it('finds clip at start', () => {
        expect(findActiveClip(clips, 0).id).toBe('c1');
    });

    it('finds clip at middle', () => {
        expect(findActiveClip(clips, 2.5).id).toBe('c1');
    });

    it('finds second clip', () => {
        expect(findActiveClip(clips, 7).id).toBe('c2');
    });

    it('returns null past all clips', () => {
        expect(findActiveClip(clips, 10)).toBeNull();
    });

    it('returns null for empty clips', () => {
        expect(findActiveClip([], 5)).toBeNull();
    });
});

// --- findActiveAudioClips ---

describe('findActiveAudioClips', () => {
    const audioTracks = [
        [{ id: 'a1', startTime: 0, duration: 10 }],
        [{ id: 'a2', startTime: 5, duration: 10 }],
    ];

    it('finds clips on both tracks when overlapping', () => {
        const active = findActiveAudioClips(audioTracks, 7);
        expect(active.length).toBe(2);
    });

    it('finds only first track clip before overlap', () => {
        const active = findActiveAudioClips(audioTracks, 3);
        expect(active.length).toBe(1);
        expect(active[0].id).toBe('a1');
    });

    it('returns empty when past all clips', () => {
        expect(findActiveAudioClips(audioTracks, 20).length).toBe(0);
    });
});

// --- clipRelativeTime ---

describe('clipRelativeTime', () => {
    it('calculates relative time with no offset', () => {
        expect(clipRelativeTime({ startTime: 5, offset: 0 }, 8)).toBe(3);
    });

    it('calculates relative time with offset', () => {
        expect(clipRelativeTime({ startTime: 5, offset: 2 }, 8)).toBe(5);
    });
});

// --- splitClipAt ---

describe('splitClipAt', () => {
    const clip = { id: 'c1', startTime: 0, duration: 10, offset: 0, type: 'video', muted: false };

    it('splits at middle correctly', () => {
        const result = splitClipAt(clip, 5);
        expect(result).not.toBeNull();
        expect(result.originalDuration).toBe(5);
        expect(result.newClip.startTime).toBe(5);
        expect(result.newClip.duration).toBe(5);
        expect(result.newClip.offset).toBe(5);
    });

    it('returns null when split point too close to start', () => {
        expect(splitClipAt(clip, 0.01)).toBeNull();
    });

    it('returns null when split point too close to end', () => {
        expect(splitClipAt(clip, 9.99)).toBeNull();
    });

    it('handles clip with offset', () => {
        const clipWithOffset = { ...clip, offset: 3 };
        const result = splitClipAt(clipWithOffset, 4);
        expect(result.newClip.offset).toBe(7); // 3 + 4
        expect(result.newClip.duration).toBe(6);
    });
});

// --- detectSpeechSegments ---

describe('detectSpeechSegments', () => {
    it('detects speech in loud section', () => {
        // Create a simple audio buffer: silence, then loud, then silence
        const sampleRate = 1000;
        const data = new Float32Array(3000);
        // Silence 0-999, speech 1000-1999, silence 2000-2999
        for (let i = 1000; i < 2000; i++) {
            data[i] = 0.5 * Math.sin(i * 0.1);
        }

        const result = detectSpeechSegments(data, 0, 3000, sampleRate, { scanStep: 10 });
        expect(result.segments.length).toBeGreaterThanOrEqual(1);
        expect(result.threshold).toBeGreaterThan(0);
    });

    it('returns empty for pure silence', () => {
        const data = new Float32Array(1000);
        const result = detectSpeechSegments(data, 0, 1000, 1000, { scanStep: 10 });
        expect(result.segments.length).toBe(0);
    });
});

// --- getFileExt ---

describe('getFileExt', () => {
    it('extracts .mp4', () => {
        expect(getFileExt('video.mp4')).toBe('.mp4');
    });

    it('extracts .webm', () => {
        expect(getFileExt('audio.webm')).toBe('.webm');
    });

    it('handles no extension', () => {
        expect(getFileExt('noext')).toBe('.mp4');
    });

    it('handles multiple dots', () => {
        expect(getFileExt('my.video.file.mov')).toBe('.mov');
    });
});

// --- thumbCacheKey ---

describe('thumbCacheKey', () => {
    it('creates consistent keys', () => {
        expect(thumbCacheKey('blob:http://x/abc', 1.234)).toBe('blob:http://x/abc|1.23');
    });

    it('rounds time to 2 decimals', () => {
        expect(thumbCacheKey('url', 1.999)).toBe('url|2.00');
    });
});
