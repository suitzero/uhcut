import { Component, ElementRef, ViewChild, inject, computed, signal } from '@angular/core';
import { StateService } from '../../services/state';
import { AudioService } from '../../services/audio';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  templateUrl: './toolbar.html',
  styleUrl: './toolbar.css'
})
export class Toolbar {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  protected state = inject(StateService);
  protected audio = inject(AudioService);

  isRecording = signal(false);
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  onAddMedia() {
    this.fileInput.nativeElement.click();
  }

  handleFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      Array.from(input.files).forEach(file => this.processFile(file));
    }
  }

  processFile(file: File) {
      const url = URL.createObjectURL(file);
      let type: 'video' | 'audio' = 'audio';
      if (file.type.startsWith('video')) {
          type = 'video';
      } else if (file.name.toLowerCase().endsWith('.m4a') || file.type.startsWith('audio')) {
          type = 'audio';
      }

      const id = Date.now() + Math.random().toString(36).substr(2, 9);
      const element = document.createElement(type === 'video' ? 'video' : 'audio');
      element.preload = 'metadata';

      element.onerror = () => {
          alert("Failed to load media: " + file.name);
      };

      const tempItem = {
          id,
          file,
          url,
          type,
          name: file.name,
          duration: 30, // temporary
          videoWidth: 1920,
          videoHeight: 1080
      };
      this.state.addMedia(tempItem);
      this.state.addToTimelineSmart(tempItem);

      element.onloadedmetadata = () => {
          const duration = element.duration || 0;
          const w = type === 'video' ? ((element as HTMLVideoElement).videoWidth || 0) : 0;
          const h = type === 'video' ? ((element as HTMLVideoElement).videoHeight || 0) : 0;
          this.state.updateMedia(id, { duration, videoWidth: w, videoHeight: h });
          this.state.updateClipDurationByMediaId(id, duration);
      };
      element.src = url;
  }

  togglePlay() {
      this.state.isPlaying.update(v => !v);
      if (!this.state.isPlaying()) {
          // Pause logic handled in Player component effect?
          // Or globally via service?
          // Ideally Player component reacts to isPlaying signal.
      } else {
          this.audio.resumeContext();
      }
  }

  deleteClip() {
      const id = this.state.selectedClipId();
      if (id) {
          this.state.deleteClip(id);
      }
  }

  undo() { this.state.undo(); }
  redo() { this.state.redo(); }

  zoomIn() { this.state.zoom.update(z => Math.min(200, z * 1.5)); }
  zoomOut() { this.state.zoom.update(z => Math.max(1, z / 1.5)); }

  split() { this.state.splitClip(); }

  selectedClipType = computed(() => {
      const id = this.state.selectedClipId();
      if (!id) return null;
      const clip = this.state.findClip(id);
      return clip ? clip.type : null;
  });

  isStabilized = computed(() => {
      const id = this.state.selectedClipId();
      if (!id) return false;
      const clip = this.state.findClip(id);
      return clip ? !!clip.stabilized : false;
  });

  toggleStabilize() {
      const id = this.state.selectedClipId();
      if (id) {
          const clip = this.state.findClip(id);
          if (clip && clip.type === 'video') {
              this.state.saveState();
              const willStabilize = !clip.stabilized;

              if (willStabilize && (!clip.stabilizationData || clip.stabilizationData.length === 0)) {
                  // Compute stabilization data
                  this.computeStabilization(clip);
              } else {
                  this.state.updateClip(id, { stabilized: willStabilize });
              }
          }
      }
  }

  async computeStabilization(clip: any) {
      const media = this.state.getMedia(clip.mediaId);
      if (!media || !media.url) return;

      alert("Computing stabilization data... This may take a few moments.");

      const video = document.createElement('video');
      video.src = media.url;
      video.muted = true;
      video.playsInline = true;

      await new Promise<void>(res => {
          video.onloadeddata = () => res();
          video.onerror = () => res();
      });

      if (!video.videoWidth) return;

      const canvas = document.createElement('canvas');
      // Low resolution for faster optical flow / block matching
      const targetSize = 64;
      const scale = targetSize / Math.max(video.videoWidth, video.videoHeight);
      canvas.width = Math.floor(video.videoWidth * scale);
      canvas.height = Math.floor(video.videoHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const fps = 15; // sample rate for stabilization
      const totalFrames = Math.ceil(clip.duration * fps);
      const data: {time: number, dx: number, dy: number}[] = [];

      let prevGray: Uint8ClampedArray | null = null;
      let cumDx = 0;
      let cumDy = 0;

      for (let i = 0; i < totalFrames; i++) {
          const t = clip.offset + (i / fps);
          video.currentTime = t;
          await new Promise<void>(res => {
              const onSeeked = () => { video.removeEventListener('seeked', onSeeked); res(); };
              video.addEventListener('seeked', onSeeked);
              if (Math.abs(video.currentTime - t) < 0.1) {
                  video.removeEventListener('seeked', onSeeked); res();
              }
              setTimeout(() => { video.removeEventListener('seeked', onSeeked); res(); }, 500);
          });

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

          const currGray = new Uint8ClampedArray(canvas.width * canvas.height);
          for (let j = 0; j < currGray.length; j++) {
              currGray[j] = (imgData[j*4] * 0.299 + imgData[j*4+1] * 0.587 + imgData[j*4+2] * 0.114);
          }

          if (prevGray) {
              // Very naive whole-frame SAD matching (search within a small window)
              let minSad = Infinity;
              let bestDx = 0;
              let bestDy = 0;
              const range = 4;

              for (let dy = -range; dy <= range; dy++) {
                  for (let dx = -range; dx <= range; dx++) {
                      let sad = 0;
                      let count = 0;
                      for (let y = range; y < canvas.height - range; y += 2) {
                          for (let x = range; x < canvas.width - range; x += 2) {
                              const currIdx = y * canvas.width + x;
                              const prevIdx = (y + dy) * canvas.width + (x + dx);
                              sad += Math.abs(currGray[currIdx] - prevGray[prevIdx]);
                              count++;
                          }
                      }
                      if (count > 0 && sad < minSad) {
                          minSad = sad;
                          bestDx = dx;
                          bestDy = dy;
                      }
                  }
              }

              // Scale motion vector back to original resolution scale
              cumDx += bestDx / scale;
              cumDy += bestDy / scale;
          }

          data.push({ time: i / fps, dx: cumDx, dy: cumDy });
          prevGray = currGray;

          // Yield
          await new Promise(r => setTimeout(r, 0));
      }

      // Smooth the trajectory (Moving Average Filter)
      const windowSize = Math.floor(fps * 1.5); // 1.5 seconds window
      const smoothed = data.map((d, i) => {
          let sumDx = 0, sumDy = 0, count = 0;
          for (let j = Math.max(0, i - windowSize); j <= Math.min(data.length - 1, i + windowSize); j++) {
              sumDx += data[j].dx;
              sumDy += data[j].dy;
              count++;
          }
          return { time: d.time, dx: sumDx / count, dy: sumDy / count };
      });

      // Calculate differential (correction to apply)
      const correction = data.map((d, i) => ({
          time: d.time,
          dx: smoothed[i].dx - d.dx,
          dy: smoothed[i].dy - d.dy
      }));

      this.state.updateClip(clip.id, { stabilized: true, stabilizationData: correction });
      alert("Stabilization complete!");
  }

  async toggleRecording() {
      if (this.isRecording()) {
          this.mediaRecorder?.stop();
          this.isRecording.set(false);
      } else {
          try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              this.audioChunks = [];
              this.mediaRecorder = new MediaRecorder(stream);
              this.mediaRecorder.ondataavailable = (e) => this.audioChunks.push(e.data);
              this.mediaRecorder.onstop = () => {
                  const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
                  const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
                  this.processFile(file);
                  stream.getTracks().forEach(t => t.stop());
              };
              this.mediaRecorder.start();
              this.isRecording.set(true);
          } catch (e) {
              alert("Microphone access denied or error: " + e);
          }
      }
  }

  extractAudio() {
      const id = this.state.selectedClipId();
      if (id) {
          const clip = this.state.findClip(id);
          if (clip && clip.type === 'video') {
              this.state.saveState();
              this.state.updateClip(id, { muted: true });

              const newClip = { ...clip, id: 'clip_' + Date.now(), type: 'audio' as 'video' | 'audio', volume: 1.0, muted: false };
              const aTracks = this.state.audioTracks();
              const newATracks = [...aTracks];
              newATracks[0] = [...newATracks[0], newClip];
              this.state.audioTracks.set(newATracks);
          }
      }
  }

  async removeSilence() {
      const id = this.state.selectedClipId();
      if (!id) return;
      const clip = this.state.findClip(id);
      if (!clip) return;

      const media = this.state.getMedia(clip.mediaId);
      if (!media || !media.url) return;

      // Real silence removal based on memory (dynamic threshold 2-3%, 0.25s padding, 0.15s min)
      const buffer = await this.audio.getWaveform(media.url, media.id);
      if (!buffer) return;

      this.state.saveState();

      const data = buffer.getChannelData(0);
      const sampleRate = buffer.sampleRate;

      // Calculate max amplitude in the clip's specific window
      const startSample = Math.floor(clip.offset * sampleRate);
      const endSample = Math.min(data.length, Math.floor((clip.offset + clip.duration) * sampleRate));

      let maxAmp = 0;
      for (let i = startSample; i < endSample; i++) {
          const v = Math.abs(data[i]);
          if (v > maxAmp) maxAmp = v;
      }

      const threshold = maxAmp * 0.03; // 3% of max amplitude
      const minSilenceLen = Math.floor(0.15 * sampleRate); // 0.15s
      const padding = Math.floor(0.25 * sampleRate); // 0.25s

      const keepRegions: {start: number, end: number}[] = [];
      let inSound = false;
      let soundStart = startSample;
      let silenceStart = 0;

      for (let i = startSample; i < endSample; i++) {
          if (Math.abs(data[i]) > threshold) {
              if (!inSound) {
                  // End of silence
                  if (i - silenceStart >= minSilenceLen) {
                      inSound = true;
                      soundStart = Math.max(startSample, i - padding);
                  } else {
                      // Silence was too short, ignore
                      inSound = true;
                  }
              }
          } else {
              if (inSound) {
                  // Start of potential silence
                  inSound = false;
                  silenceStart = i;
                  keepRegions.push({ start: soundStart, end: Math.min(endSample, i + padding) });
              }
          }
      }

      if (inSound) {
          keepRegions.push({ start: soundStart, end: endSample });
      } else if (keepRegions.length === 0) {
          // No sound found above threshold at all, maybe keep original or just remove whole clip
          // We'll just keep it as is if we fail to detect any sound
          return;
      }

      // Merge overlapping keep regions
      const merged: {start: number, end: number}[] = [];
      keepRegions.forEach(r => {
          if (merged.length === 0) merged.push(r);
          else {
              const last = merged[merged.length - 1];
              if (r.start <= last.end) last.end = Math.max(last.end, r.end);
              else merged.push(r);
          }
      });

      // Generate new clips
      const newClips: any[] = [];
      let currentStartTime = clip.startTime;

      merged.forEach((region, index) => {
          const regionOffset = region.start / sampleRate;
          const regionDur = (region.end - region.start) / sampleRate;
          if (regionDur > 0.1) { // Only keep if it's > 0.1s
              newClips.push({
                  ...clip,
                  id: 'clip_' + Date.now() + '_' + index,
                  startTime: currentStartTime,
                  offset: regionOffset,
                  duration: regionDur
              });
              currentStartTime += regionDur; // Ripple effect! Attach together.
          }
      });

      if (newClips.length === 0) return;

      // Update State
      if (clip.type === 'video') {
          this.state.videoTrack.update(t => {
              const newT = t.filter(c => c.id !== id);
              return [...newT, ...newClips].sort((a,b) => a.startTime - b.startTime);
          });
          this.state.repackVideoTrack();
      } else {
          const aTracks = this.state.audioTracks();
          this.state.audioTracks.set(aTracks.map(track => {
              if (track.some(c => c.id === id)) {
                  const newT = track.filter(c => c.id !== id);
                  const timeDiff = currentStartTime - (clip.startTime + clip.duration);
                  if (timeDiff !== 0) {
                      newT.forEach(c => {
                          if (c.startTime >= clip.startTime + clip.duration) {
                              c.startTime += timeDiff;
                          }
                      });
                  }
                  return [...newT, ...newClips].sort((a,b) => a.startTime - b.startTime);
              }
              return track;
          }));
      }
      this.state.selectedClipId.set(null);
  }
}
