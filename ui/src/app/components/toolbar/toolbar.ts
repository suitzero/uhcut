import { Component, ElementRef, ViewChild, inject, computed, signal } from '@angular/core';
import { StateService } from '../../services/state';
import { AudioService } from '../../services/audio';
import { I18nService } from '../../services/i18n';

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
  public i18n = inject(I18nService);

  isRecording = signal(false);
  isStartingRecording = false;
  isStoppingRecording = false;

  isVideoRecording = signal(false);
  private videoMediaRecorder: MediaRecorder | null = null;
  private videoChunks: Blob[] = [];
  private videoRecordingInterval: any = null;
  private videoRecordingStart: number = 0;
  private videoRecordingClipId: string | null = null;
  private videoRecordingMediaId: string | null = null;
  isStabilizing = signal(false);
  stabilizationProgress = signal(0);

  // Caption / Transcription state
  isTranscribing = signal(false);
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private recordingInterval: any = null;
  private recordingStart: number = 0;
  private recordingClipId: string | null = null;
  private recordingMediaId: string | null = null;

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

      element.onloadedmetadata = async () => {
          let duration = element.duration || 0;

          // Handle WebM audio blobs missing duration
          if (duration === Infinity || duration === 0) {
              if (file.type.startsWith('audio') && file.name.startsWith('recording')) {
                  const buffer = await this.audio.getWaveform(url, id);
                  if (buffer) {
                      duration = buffer.duration;
                  }
              } else {
                  // Fallback setting currentTime to force metadata load
                  element.currentTime = 1e101;
                  await new Promise(r => setTimeout(r, 200));
                  duration = element.duration || 0;
                  if (duration === Infinity || duration === 0) duration = 10; // final fallback
                  element.currentTime = 0;
              }
          }

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

  async toggleVideoRecording() {
      if (this.isStartingRecording || this.isStoppingRecording) return;
      if (this.isVideoRecording()) {
          this.isStoppingRecording = true;
          if (this.videoMediaRecorder && this.videoMediaRecorder.state !== 'inactive') {
              this.videoMediaRecorder.stop();
          }
          this.isVideoRecording.set(false);
          if (this.videoRecordingInterval) {
              clearInterval(this.videoRecordingInterval);
              this.videoRecordingInterval = null;
          }
      } else {
          try {
              this.isStartingRecording = true;
              const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              this.videoChunks = [];
              this.videoMediaRecorder = new MediaRecorder(stream);

              this.videoMediaRecorder.ondataavailable = (e) => this.videoChunks.push(e.data);
              this.videoMediaRecorder.onstop = () => {
                  const mime = this.videoMediaRecorder?.mimeType || 'video/webm';
                  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
                  const blob = new Blob(this.videoChunks, { type: mime });
                  const file = new File([blob], `recording.${ext}`, { type: mime });

                  if (this.videoRecordingClipId && this.videoRecordingMediaId) {
                      const url = URL.createObjectURL(file);
                      const finalMediaId = this.videoRecordingMediaId;
                      this.state.updateMedia(finalMediaId, { file, url, _recording: false });

                      const element = document.createElement('video');
                      element.preload = 'metadata';
                      element.onloadedmetadata = async () => {
                          let duration = element.duration || 0;
                          if (duration === Infinity || duration === 0) {
                              element.currentTime = 1e101;
                              await new Promise(r => setTimeout(r, 200));
                              duration = element.duration || 0;
                              if (duration === Infinity || duration === 0) duration = 10;
                              element.currentTime = 0;
                          }
                          const w = element.videoWidth || 1920;
                          const h = element.videoHeight || 1080;
                          this.state.updateMedia(finalMediaId, { duration, videoWidth: w, videoHeight: h });
                          this.state.updateClipDurationByMediaId(finalMediaId, duration);
                      };
                      element.src = url;
                      this.videoRecordingClipId = null;
                      this.videoRecordingMediaId = null;
                  } else {
                      this.processFile(file);
                  }
                  stream.getTracks().forEach(t => t.stop());
                  this.isStoppingRecording = false;
              };

              this.videoRecordingMediaId = Date.now() + Math.random().toString(36).substr(2, 9);
              this.videoRecordingClipId = 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5);

              const tempItem = {
                  id: this.videoRecordingMediaId,
                  file: null,
                  url: null,
                  type: 'video' as const,
                  name: 'recording.webm',
                  duration: 0.1,
                  videoWidth: 1920,
                  videoHeight: 1080,
                  _recording: true
              };
              this.state.addMedia(tempItem);

              const newClip = {
                  id: this.videoRecordingClipId,
                  mediaId: this.videoRecordingMediaId,
                  duration: 0.1,
                  offset: 0,
                  type: 'video' as const,
                  muted: false,
                  volume: 1.0,
                  startTime: this.state.playbackTime()
              };

              // Insert clip at playhead using similar logic as smart add / add clip
              const videoClips = this.state.videoTrack();
              let collision = videoClips.some(c => newClip.startTime < c.startTime + c.duration && newClip.startTime + newClip.duration > c.startTime);
              if (collision) {
                   const lastClip = videoClips.length > 0 ? videoClips.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b)) : null;
                   newClip.startTime = lastClip ? lastClip.startTime + lastClip.duration : 0;
              }

              this.state.videoTrack.update(tracks => [...tracks, newClip]);
              this.state.repackVideoTrack();

              this.videoRecordingStart = Date.now();
              // To provide a smooth live preview, we could set a URL right away?
              // `MediaStream` can be set to a temporary video element or player, but currently the player expects a URL.
              // We can create a blob URL from the stream directly? No, createObjectURL for MediaStream is deprecated.
              // We'll let the user see a "recording" placeholder and update the duration real-time.
              // If we want real-time preview, we'd need to send the MediaStream to the Player component.
              // For now, it will just show a placeholder thumbnail or black box in the player.

              this.videoMediaRecorder.start(100);
              this.isStartingRecording = false;
              this.isVideoRecording.set(true);

              this.videoRecordingInterval = setInterval(() => {
                  if (this.isVideoRecording() && this.videoRecordingClipId && this.videoRecordingMediaId) {
                      const duration = (Date.now() - this.videoRecordingStart) / 1000;
                      this.state.updateMedia(this.videoRecordingMediaId, { duration });
                      this.state.updateClipDurationByMediaId(this.videoRecordingMediaId, duration);
                  }
              }, 100);

          } catch (e) {
              alert("Camera/Microphone access denied or error: " + e);
              this.isStartingRecording = false;
          }
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

      this.isStabilizing.set(true);
      this.stabilizationProgress.set(0);

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

          if (i % 5 === 0) {
              this.stabilizationProgress.set(Math.floor(((i + 1) / totalFrames) * 100));
          }

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
      let maxAbsDx = 0;
      let maxAbsDy = 0;

      const rawCorrection = data.map((d, i) => {
          const cDx = smoothed[i].dx - d.dx;
          const cDy = smoothed[i].dy - d.dy;
          if (Math.abs(cDx) > maxAbsDx) maxAbsDx = Math.abs(cDx);
          if (Math.abs(cDy) > maxAbsDy) maxAbsDy = Math.abs(cDy);
          return { time: d.time, dx: cDx, dy: cDy };
      });

      // Calculate required zoom to hide black edges
      // If we move the frame by maxAbsDx/maxAbsDy, we need the scaled frame to cover that distance.
      // (zoom - 1) / 2 * width >= maxAbsDx  =>  zoom >= 1 + 2 * maxAbsDx / width
      const reqZoomX = video.videoWidth > 0 ? 1 + (2 * maxAbsDx / video.videoWidth) : 1;
      const reqZoomY = video.videoHeight > 0 ? 1 + (2 * maxAbsDy / video.videoHeight) : 1;
      let finalZoom = Math.max(reqZoomX, reqZoomY);

      // Clamp max zoom to 1.5 to prevent extreme quality loss
      finalZoom = Math.min(finalZoom, 1.5);

      // Recalculate max allowed displacement for the final zoom
      const maxAllowedDx = video.videoWidth * (finalZoom - 1) / 2;
      const maxAllowedDy = video.videoHeight * (finalZoom - 1) / 2;

      // Clamp correction values to stay within the safe margins
      const correction = rawCorrection.map(d => ({
          time: d.time,
          dx: Math.max(-maxAllowedDx, Math.min(maxAllowedDx, d.dx)),
          dy: Math.max(-maxAllowedDy, Math.min(maxAllowedDy, d.dy))
      }));

      this.state.updateClip(clip.id, { stabilized: true, stabilizationData: correction, stabilizationZoom: finalZoom });
      this.isStabilizing.set(false);
  }

  async toggleRecording() {
      if (this.isStartingRecording || this.isStoppingRecording) return;
      if (this.isRecording()) {
          this.isStoppingRecording = true;
          if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
              this.mediaRecorder.stop();
          }
          this.isRecording.set(false);
          if (this.recordingInterval) {
              clearInterval(this.recordingInterval);
              this.recordingInterval = null;
          }
      } else {
          try {

              this.isStartingRecording = true;
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              this.audioChunks = [];
              this.mediaRecorder = new MediaRecorder(stream);

              // Setup analyser for real-time waveform
              const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
              const source = audioCtx.createMediaStreamSource(stream);
              const analyser = audioCtx.createAnalyser();
              analyser.fftSize = 256;
              source.connect(analyser);
              const dataArray = new Uint8Array(analyser.frequencyBinCount);

              const waveCanvas = document.createElement('canvas');
              waveCanvas.width = 1000;
              waveCanvas.height = 50;
              const waveCtx = waveCanvas.getContext('2d');
              let waveX = 0;
              if (waveCtx) {
                  waveCtx.fillStyle = '#111';
              }
              this.state.recordingWaveform.set(null);


              this.mediaRecorder.ondataavailable = (e) => this.audioChunks.push(e.data);
              this.mediaRecorder.onstop = () => {
                  const mime = this.mediaRecorder?.mimeType || 'audio/webm';
                  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
                  const blob = new Blob(this.audioChunks, { type: mime });
                  const file = new File([blob], `recording.${ext}`, { type: mime });

                  if (this.recordingClipId && this.recordingMediaId) {
                      // Update the live clip with final metadata
                      const url = URL.createObjectURL(file);
                      const finalMediaId = this.recordingMediaId; // Capture scope
                      this.state.updateMedia(finalMediaId, { file, url, _recording: false });

                      const element = document.createElement('audio');
                      element.preload = 'metadata';
                      element.onloadedmetadata = async () => {
                          let duration = element.duration || 0;
                          if (duration === Infinity || duration === 0) {
                              const buffer = await this.audio.getWaveform(url, finalMediaId);
                              if (buffer) duration = buffer.duration;
                          }
                          this.state.updateMedia(finalMediaId, { duration });
                          this.state.updateClipDurationByMediaId(finalMediaId, duration);
                      };
                      element.src = url;
                      this.recordingClipId = null;
                      this.recordingMediaId = null;
                  } else {
                      this.processFile(file);
                  }
                  stream.getTracks().forEach(t => t.stop());
                  audioCtx.close().catch(()=>{});
                  this.state.recordingWaveform.set(null);
                  this.isStoppingRecording = false;
              };

              // Create temporary recording clip
              this.recordingMediaId = Date.now() + Math.random().toString(36).substr(2, 9);
              this.recordingClipId = 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5);

              const tempItem = {
                  id: this.recordingMediaId,
                  file: null,
                  url: null,
                  type: 'audio' as const,
                  name: 'recording.webm',
                  duration: 0.1,
                  _recording: true
              };
              this.state.addMedia(tempItem);

              const audioTracks = this.state.audioTracks();
              let newAudioTracks = [...audioTracks];
              let added = false;

              const newClip = {
                  id: this.recordingClipId,
                  mediaId: this.recordingMediaId,
                  duration: 0.1,
                  offset: 0,
                  type: 'audio' as const,
                  muted: false,
                  volume: 1.0,
                  startTime: this.state.playbackTime() // Start at playhead
              };

              for (let i = 0; i < newAudioTracks.length; i++) {
                  // Simply append to the end of the selected track if available, or first track
                  // For realtime recording, let's just use track 0 for simplicity if it fits,
                  // but we should avoid collisions. For now, add to track 0.
                  const trackClips = newAudioTracks[i];
                  newAudioTracks[i] = [...trackClips, newClip];
                  added = true;
                  break;
              }

              if (!added) {
                  newAudioTracks.push([newClip]);
              }
              this.state.audioTracks.set(newAudioTracks);


              this.recordingStart = Date.now();
              this.mediaRecorder.start(100); // chunk every 100ms
              this.isStartingRecording = false;
              this.isRecording.set(true);


              // Update duration in realtime
              this.recordingInterval = setInterval(() => {
                  if (this.isRecording() && this.recordingClipId && this.recordingMediaId) {
                      const duration = (Date.now() - this.recordingStart) / 1000;
                      this.state.updateMedia(this.recordingMediaId, { duration });
                      this.state.updateClipDurationByMediaId(this.recordingMediaId, duration);

                      if (waveCtx) {
                          analyser.getByteTimeDomainData(dataArray);
                          let min = 255, max = 0;
                          for(let i=0; i<dataArray.length; i++) {
                              if (dataArray[i] < min) min = dataArray[i];
                              if (dataArray[i] > max) max = dataArray[i];
                          }
                          // normalize 0-255 to -1 to +1 conceptually, but we map to height directly
                          const heightFactor = waveCanvas.height / 255;
                          const h = Math.max(1, (max - min) * heightFactor);
                          const y = (waveCanvas.height - h) / 2;
                          waveCtx.fillRect(waveX, y, 2, h); // Draw a small 2px bar
                          waveX += 2;

                          // If canvas gets full, we could resize or shift, but for typical recording 1000px * 100ms/2px = 50s before it wraps.
                          // Let's just resize canvas if needed.
                          if (waveX >= waveCanvas.width) {
                              const newCanvas = document.createElement('canvas');
                              newCanvas.width = waveCanvas.width + 500;
                              newCanvas.height = waveCanvas.height;
                              const newCtx = newCanvas.getContext('2d');
                              if (newCtx) {
                                  newCtx.fillStyle = '#111';
                                  newCtx.drawImage(waveCanvas, 0, 0);
                                  waveCanvas.width = newCanvas.width;
                                  waveCanvas.height = newCanvas.height;
                                  if(waveCtx) waveCtx.fillStyle = '#111'; // reset fill style after resize
                                  waveCtx?.drawImage(newCanvas, 0, 0);
                              }
                          }
                          this.state.recordingWaveform.set(waveCanvas.toDataURL());
                      }
                  }
              }, 100);


          } catch (e) {
              alert("Microphone access denied or error: " + e);
              this.isStartingRecording = false;
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

  async toggleTranscribe() {
      if (this.isTranscribing()) return;

      const clipId = this.state.selectedClipId();
      if (!clipId) {
          alert("Please select an audio or video clip to transcribe.");
          return;
      }
      const clip = this.state.findClip(clipId);
      if (!clip) return;
      const media = this.state.getMedia(clip.mediaId);
      if (!media || !media.url) return;

      this.isTranscribing.set(true);

      try {
          // Dynamic import to avoid heavy load on initial startup
          const { pipeline, env } = await import('@xenova/transformers');

          // Disable local models
          env.allowLocalModels = false;

          // Use a tiny whisper model for speed in the browser
          const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');

          // Fetch the audio buffer
          const buffer = await this.audio.getWaveform(media.url, media.id);
          if (!buffer) {
             throw new Error("Could not get audio data.");
          }

          const audioData = buffer.getChannelData(0);

          // Create an AudioBuffer-like object that the pipeline expects
          // OR simply pass the raw Float32Array and sample rate
          // Transformers.js pipeline expects audio to be 16kHz
          const offlineCtx = new OfflineAudioContext(1, audioData.length * (16000 / buffer.sampleRate), 16000);
          const source = offlineCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(offlineCtx.destination);
          source.start();
          const resampled = await offlineCtx.startRendering();
          const resampledData = resampled.getChannelData(0);

          // Transcribe with return_timestamps
          const output = await transcriber(resampledData, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true }) as any;

          if (output.chunks && output.chunks.length > 0) {
              this.state.saveState();

              const newCaptions = output.chunks.map((chunk: any) => {
                  return {
                      id: 'cap_' + Date.now() + Math.random().toString(36).substr(2, 5),
                      text: chunk.text.trim(),
                      startTime: clip.startTime + chunk.timestamp[0],
                      endTime: chunk.timestamp[1] !== null ? clip.startTime + chunk.timestamp[1] : clip.startTime + chunk.timestamp[0] + 2
                  };
              });

              this.state.captions.update(caps => [...caps, ...newCaptions]);
          }

      } catch (error) {
          console.error("Transcription error:", error);
          alert("Failed to transcribe. See console for details.");
      } finally {
          this.isTranscribing.set(false);
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

      const threshold = maxAmp * 0.05; // 5% of max amplitude - increased to catch more breathing/background
      const minSilenceLen = Math.floor(0.2 * sampleRate); // 0.2s minimum silence length
      const padding = Math.floor(0.1 * sampleRate); // 0.1s padding to keep ends natural

      const keepRegions: {start: number, end: number}[] = [];
      let inSound = false;
      let soundStart = startSample;
      let silenceStart = 0;
      let silenceCount = 0; // track consecutive silence samples

      for (let i = startSample; i < endSample; i++) {
          if (Math.abs(data[i]) > threshold) {
              silenceCount = 0;
              if (!inSound) {
                  inSound = true;
                  soundStart = Math.max(startSample, i - padding);
              }
          } else {
              silenceCount++;
              if (inSound) {
                  if (silenceCount >= minSilenceLen) {
                      inSound = false;
                      silenceStart = i - silenceCount;
                      keepRegions.push({ start: soundStart, end: Math.min(endSample, silenceStart + padding) });
                  }
              }
          }
      }

      if (inSound) {
          keepRegions.push({ start: soundStart, end: endSample });
      } else if (keepRegions.length === 0) {
          // No sound found above threshold at all, maybe keep original or just remove whole clip
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
