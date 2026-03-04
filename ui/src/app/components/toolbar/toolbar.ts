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
              this.state.updateClip(id, { stabilized: !clip.stabilized });
          }
      }
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
              // Shift subsequent clips (Ripple edit)
              const timeDiff = currentStartTime - (clip.startTime + clip.duration);
              if (timeDiff !== 0) {
                  newT.forEach(c => {
                      if (c.startTime >= clip.startTime + clip.duration) {
                          c.startTime += timeDiff;
                      }
                  });
              }
              return [...newT, ...newClips].sort((a,b) => a.startTime - b.startTime);
          });
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
