// UhCut Export Worker — ffmpeg.wasm based
// Runs in a Web Worker to avoid blocking the UI thread

importScripts(
    'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/umd/util.js'
);

const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

let ffmpeg = null;

async function initFFmpeg() {
    if (ffmpeg) return;
    ffmpeg = new FFmpeg();

    ffmpeg.on('progress', ({ progress, time }) => {
        self.postMessage({ type: 'progress', value: Math.max(0, Math.min(1, progress)) });
    });

    ffmpeg.on('log', ({ message }) => {
        // Forward logs for debugging
        self.postMessage({ type: 'log', message });
    });

    await ffmpeg.load({
        coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
    });
}

self.onmessage = async ({ data }) => {
    try {
        self.postMessage({ type: 'progress', value: 0 });
        self.postMessage({ type: 'status', text: 'FFmpeg loading...' });

        await initFFmpeg();

        self.postMessage({ type: 'status', text: 'Preparing files...' });

        const { mediaFiles, timeline, outputConfig } = data;

        // Write media files to ffmpeg virtual filesystem
        for (const [name, arrayBuffer] of Object.entries(mediaFiles)) {
            await ffmpeg.writeFile(name, new Uint8Array(arrayBuffer));
        }

        // Build ffmpeg command from timeline
        const args = buildFFmpegArgs(timeline, outputConfig);

        self.postMessage({ type: 'status', text: 'Encoding...' });
        self.postMessage({ type: 'log', message: 'ffmpeg ' + args.join(' ') });

        await ffmpeg.exec(args);

        // Read result
        const output = await ffmpeg.readFile('output.mp4');

        self.postMessage(
            { type: 'done', data: output.buffer },
            [output.buffer]
        );
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};

function buildFFmpegArgs(timeline, config) {
    const inputs = [];
    const filterParts = [];
    const videoLabels = [];
    const audioLabels = [];
    let idx = 0;

    // Video clips
    for (const clip of timeline.video) {
        inputs.push('-i', clip.fileName);
        const vLabel = `v${idx}`;
        let vFilter = `[${idx}:v]trim=start=${clip.offset.toFixed(4)}:duration=${clip.duration.toFixed(4)},setpts=PTS-STARTPTS`;
        if (clip.stabilized) {
            // Apply stabilization crop (10% zoom center crop, same as original behavior)
            vFilter += `,crop=iw/1.1:ih/1.1:(iw-iw/1.1)/2:(ih-ih/1.1)/2,scale=${config.width}:${config.height}`;
        } else {
            vFilter += `,scale=${config.width}:${config.height}`;
        }
        vFilter += `,setsar=1[${vLabel}]`;
        filterParts.push(vFilter);
        videoLabels.push(`[${vLabel}]`);

        // Video clip audio (if not muted)
        if (!clip.muted) {
            const aLabel = `va${idx}`;
            filterParts.push(
                `[${idx}:a]atrim=start=${clip.offset.toFixed(4)}:duration=${clip.duration.toFixed(4)},asetpts=PTS-STARTPTS,adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}[${aLabel}]`
            );
            audioLabels.push(`[${aLabel}]`);
        }
        idx++;
    }

    // Audio-only clips
    for (const track of timeline.audio) {
        for (const clip of track) {
            if (clip.muted) continue;
            inputs.push('-i', clip.fileName);
            const aLabel = `a${idx}`;
            filterParts.push(
                `[${idx}:a]atrim=start=${clip.offset.toFixed(4)}:duration=${clip.duration.toFixed(4)},asetpts=PTS-STARTPTS,adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}[${aLabel}]`
            );
            audioLabels.push(`[${aLabel}]`);
            idx++;
        }
    }

    // Build concat + mix
    let filter = filterParts.join(';');

    // Video concat
    if (videoLabels.length > 1) {
        filter += `;${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vout]`;
    } else if (videoLabels.length === 1) {
        // Single video, just alias it
        filter = filter.replace(new RegExp(`\\[${videoLabels[0].slice(1, -1)}\\]$`, 'm'), '[vout]');
    }

    // Audio mix
    if (audioLabels.length > 1) {
        filter += `;${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[aout]`;
    } else if (audioLabels.length === 1) {
        filter = filter.replace(new RegExp(`\\[${audioLabels[0].slice(1, -1)}\\]$`, 'm'), '[aout]');
    }

    const args = [
        ...inputs,
        '-filter_complex', filter
    ];

    // Map outputs
    if (videoLabels.length > 0) {
        args.push('-map', '[vout]');
    }
    if (audioLabels.length > 0) {
        args.push('-map', '[aout]');
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', 'output.mp4'
    );

    return args;
}
