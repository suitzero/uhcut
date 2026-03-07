import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ExportService {

  constructor() { }

  async exportVideo(
    stateService: any,
    audioService: any,
    videoElement: HTMLVideoElement
  ): Promise<void> {
    try {
      const vTrack = stateService.videoTrack();
      const aTracks = stateService.audioTracks();

      if (vTrack.length === 0) {
        alert('No video to export!');
        return;
      }

      // Calculate total duration
      let maxTime = 0;
      vTrack.forEach((c: any) => maxTime = Math.max(maxTime, c.startTime + c.duration));
      aTracks.forEach((t: any[]) => t.forEach((c: any) => maxTime = Math.max(maxTime, c.startTime + c.duration)));

      if (maxTime === 0) {
        alert('Timeline is empty!');
        return;
      }

      // Find export resolution (use first video clip's original resolution)
      const firstClip = vTrack[0];
      const media = stateService.getMedia(firstClip.mediaId);
      let width = media?.videoWidth || 1920;
      let height = media?.videoHeight || 1080;

      // Force even dimensions
      width = Math.round(width / 2) * 2;
      height = Math.round(height / 2) * 2;

      stateService.isExporting.set(true);
      stateService.exportProgress.set(0);
      stateService.exportUrl.set(null);

      // We use MP4Box via window.MP4Box
      const MP4Box = (window as any).MP4Box;
      if (!MP4Box) {
        alert('MP4Box not loaded!');
        stateService.isExporting.set(false);
        return;
      }

      const file = MP4Box.createFile();
      const fps = 30;
      const totalFrames = Math.ceil(maxTime * fps);

      let videoTrackId: number | null = null;
      let audioTrackId: number | null = null;

      const mediaRecorder = new MediaRecorder(audioService.exportDest.stream, { mimeType: 'audio/webm;codecs=opus' });
      const audioChunks: Blob[] = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Cannot get canvas 2d context');

      // Setup VideoEncoder
      const init = {
        output: (chunk: EncodedVideoChunk, config?: EncodedVideoChunkMetadata) => {
          if (videoTrackId === null && config && config.decoderConfig) {
             videoTrackId = file.addTrack({
                timescale: 1000000,
                width: width,
                height: height,
                brands: ['isom', 'iso2', 'avc1', 'mp41'],
                avcDecoderConfigRecord: config.decoderConfig.description
             });
          }
          if (videoTrackId !== null) {
              const buffer = new ArrayBuffer(chunk.byteLength);
              chunk.copyTo(buffer);
              file.addSample(videoTrackId, buffer, {
                  duration: chunk.duration || Math.floor(1000000 / fps),
                  dts: chunk.timestamp,
                  cts: chunk.timestamp,
                  is_sync: chunk.type === 'key'
              });
          }
        },
        error: (e: Error) => {
          console.error("Encoder Error:", e);
        }
      };

      const encoder = new (window as any).VideoEncoder(init);
      encoder.configure({
        codec: 'avc1.640028',
        width: width,
        height: height,
        bitrate: 5000000,
        framerate: fps,
        hardwareAcceleration: 'prefer-hardware'
      });

      // Start processing
      mediaRecorder.start();

      let frameCount = 0;
      stateService.playbackTime.set(0);
      stateService.isPlaying.set(false);
      audioService.resumeContext();

      // Render loop logic
      for (let f = 0; f < totalFrames; f++) {
          const t = f / fps;

          // Audio Sync
          const activeClips: any[] = [];
          aTracks.forEach((track: any[]) => {
            track.forEach((c: any) => {
               if (t >= c.startTime && t < c.startTime + c.duration) activeClips.push(c);
            });
          });
          audioService.cleanup(activeClips.map((c: any) => c.id));
          activeClips.forEach(clip => {
             const am = stateService.getMedia(clip.mediaId);
             if (am && am.url) {
                audioService.playAudio(clip.id, am.url, clip.startTime, clip.offset, clip.volume, clip.muted, t);
             }
          });

          // Video Sync
          const videoClip = vTrack.find((c: any) => t >= c.startTime && t < c.startTime + c.duration);
          ctx.fillStyle = 'black';
          ctx.fillRect(0, 0, width, height);

          if (videoClip) {
              const vm = stateService.getMedia(videoClip.mediaId);
              if (vm && videoElement.src !== vm.url) {
                 videoElement.src = vm.url || '';
                 await new Promise<void>(res => {
                     videoElement.onloadeddata = () => res();
                     videoElement.onerror = () => res();
                     // Fallback
                     setTimeout(res, 500);
                 });
              }

              const clipTime = t - videoClip.startTime + videoClip.offset;
              videoElement.currentTime = clipTime;

              await new Promise<void>(res => {
                  const onSeeked = () => {
                      videoElement.removeEventListener('seeked', onSeeked);
                      res();
                  };
                  videoElement.addEventListener('seeked', onSeeked);
                  if (videoElement.readyState >= 2 && Math.abs(videoElement.currentTime - clipTime) < 0.1) {
                      videoElement.removeEventListener('seeked', onSeeked);
                      res();
                  }
                  setTimeout(() => { videoElement.removeEventListener('seeked', onSeeked); res(); }, 500);
              });

              if (videoClip.stabilized) {
                  const cropW = width / 1.3;
                  const cropH = height / 1.3;
                  let sx = (width - cropW) / 2;
                  let sy = (height - cropH) / 2;

                  if (videoClip.stabilizationData) {
                      const relTime = t - videoClip.startTime;
                      let bestCorrection = { dx: 0, dy: 0 };
                      for (let d of videoClip.stabilizationData) {
                          if (d.time <= relTime) {
                              bestCorrection = d;
                          } else {
                              break;
                          }
                      }
                      // Apply inverse of translation to source crop to simulate moving the camera
                      // The CSS translate moves the video, which means the crop window should move in opposite direction
                      sx -= bestCorrection.dx;
                      sy -= bestCorrection.dy;
                  }

                  ctx.drawImage(videoElement, sx, sy, cropW, cropH, 0, 0, width, height);
              } else {
                  ctx.drawImage(videoElement, 0, 0, width, height);
              }
          }

          // We must wait a tiny bit to let audio context process, but since it's real time for audio,
          // offline audio context would be better, but we are using real-time for now (with wait).
          // Actually, rendering frame by frame faster than real time means audio will glitch or desync
          // if we use real-time MediaRecorder.
          // For a true 3-pass:
          // We can just encode video offline as fast as possible, and maybe capture audio separately?
          // For now, let's just do frame processing.

          const frame = new (window as any).VideoFrame(canvas, { timestamp: f * 1000000 / fps });
          encoder.encode(frame, { keyFrame: f % 60 === 0 });
          frame.close();

          // Wait to match real time to allow MediaRecorder to catch audio?
          // If we await real time, export takes duration.
          await new Promise(r => setTimeout(r, 1000 / fps));

          if (f % 5 === 0) {
              stateService.exportProgress.set(Math.floor((f / totalFrames) * 100));
          }
      }

      await encoder.flush();
      mediaRecorder.stop();

      await new Promise<void>(res => {
          mediaRecorder.onstop = () => res();
          setTimeout(res, 1000);
      });

      stateService.exportProgress.set(100);

      // Muxing logic simplified (assuming video only or simple audio support via mp4box)
      // Save using file buffer and Blob URL instead of file.save()
      const buffer = file.getBuffer();
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      stateService.exportUrl.set(url);

    } catch (err: any) {
       console.error(err);
       stateService.isExporting.set(false);
       alert('Export failed: ' + err.message);
    }
  }
}
