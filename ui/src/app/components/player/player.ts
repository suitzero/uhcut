import { Component, ElementRef, ViewChild, AfterViewInit, inject, effect, Signal, computed, OnDestroy } from '@angular/core';
import { StateService, Clip } from '../../services/state';
import { AudioService } from '../../services/audio';
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

@Component({
  selector: 'app-player',
  standalone: true,
  templateUrl: './player.html',
  styleUrl: './player.css'
})
export class Player implements AfterViewInit, OnDestroy {
  @ViewChild('mainVideo') mainVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlayCanvas') overlayCanvas!: ElementRef<HTMLCanvasElement>;

  protected state = inject(StateService);
  protected audio = inject(AudioService);

  private lastFrameTime = 0;
  private animationFrameId = 0;
  private mainVideoSource: MediaElementAudioSourceNode | null = null;
  private mainVideoGain: GainNode | null = null;

  // Face Detection State
  private faceDetector: FaceDetector | null = null;
  private isFaceDetectorReady = false;
  private ballImage: HTMLImageElement;

  // Computed state for UI
  formattedTime = computed(() => {
      const time = this.state.playbackTime();
      const m = Math.floor(time / 60);
      const s = Math.floor(time % 60);
      const ms = Math.floor((time % 1) * 100);
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  });

  activeCaption = computed(() => {
      const time = this.state.playbackTime();
      return this.state.captions().find(c => time >= c.startTime && time <= c.endTime);
  });

  activeCaptionWords = computed(() => {
      const caption = this.activeCaption();
      if (!caption) return [];
      const time = this.state.playbackTime();

      const words = caption.text.split(/\s+/).filter(w => w.length > 0);
      const duration = caption.endTime - caption.startTime;
      const wordDuration = duration / words.length;

      return words.map((text, index) => {
          const wordStartTime = caption.startTime + (index * wordDuration);
          const isHighlighted = time >= wordStartTime;
          return {
              text: text + ' ',
              highlighted: isHighlighted
          };
      });
  });

  constructor() {
      // Effect to handle seeking when paused
      this.ballImage = new Image();
      this.ballImage.src = '/assets/tongki.jpeg';

      effect(() => {
          const time = this.state.playbackTime();
          const isPlaying = this.state.isPlaying();
          if (!isPlaying && this.mainVideo) {
             this.syncMedia(time, false);
          }
      });
  }

  async ngAfterViewInit() {
      await this.initFaceDetector();
      // Start render loop
      this.renderLoop(0);
  }

  ngOnDestroy() {
      if (this.animationFrameId) {
          cancelAnimationFrame(this.animationFrameId);
      }
      if (this.faceDetector) {
          this.faceDetector.close();
      }
  }

  private async initFaceDetector() {
      try {
          const vision = await FilesetResolver.forVisionTasks(
              "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
          );
          this.faceDetector = await FaceDetector.createFromOptions(vision, {
              baseOptions: {
                  modelAssetPath: "/models/blaze_face_short_range.tflite",
                  delegate: "GPU"
              },
              runningMode: "VIDEO"
          });
          this.isFaceDetectorReady = true;
          console.log("Face detector initialized");
      } catch (error) {
          console.error("Failed to initialize Face Detector", error);
      }
  }

  togglePlay() {
      this.state.isPlaying.update(p => !p);
      if (this.state.isPlaying()) {
          this.audio.resumeContext();
      } else {
          this.mainVideo.nativeElement.pause();
          // Pause audio pool
          const activeClips = this.getActiveClips(this.state.playbackTime());
          activeClips.forEach(c => this.audio.pauseAudio(c.id));
      }
  }

  private renderLoop(timestamp: number) {
      if (this.state.isPlaying()) {
          if (!this.lastFrameTime) this.lastFrameTime = timestamp;
          const dt = (timestamp - this.lastFrameTime) / 1000;
          this.lastFrameTime = timestamp;

          let videoDriving = false;
          const currentTime = this.state.playbackTime();

          const videoClip = this.getVideoClipAtTime(currentTime);

          // Video driving logic
          if (videoClip && this.mainVideo.nativeElement && !this.mainVideo.nativeElement.paused && this.mainVideo.nativeElement.readyState > 2) {
              const currentVideoTime = this.mainVideo.nativeElement.currentTime;
              const newTime = videoClip.startTime + (currentVideoTime - videoClip.offset);
              if (Math.abs(newTime - currentTime) < 0.5) {
                  this.state.playbackTime.set(newTime);
                  videoDriving = true;
              }
          }

          if (!videoDriving) {
              this.state.playbackTime.update(t => t + dt);
          }

          this.syncMedia(this.state.playbackTime(), videoDriving);
      } else {
          this.lastFrameTime = 0;
      }

      this.animationFrameId = requestAnimationFrame(t => this.renderLoop(t));
  }

  private syncMedia(time: number, videoDriving: boolean) {
      const v = this.mainVideo.nativeElement;
      const videoClip = this.getVideoClipAtTime(time);

      // Setup Audio Graph for Video Element if needed
      if (!this.mainVideoSource && v) {
          try {
              this.mainVideoSource = this.audio.audioCtx.createMediaElementSource(v);
              this.mainVideoGain = this.audio.audioCtx.createGain();
              this.mainVideoSource.connect(this.mainVideoGain);
              this.mainVideoGain.connect(this.audio.masterGain);
          } catch(e) { /* Already connected */ }
      }

      if (videoClip) {
          const media = this.state.getMedia(videoClip.mediaId);
          if (media && v.src !== media.url) v.src = media.url || '';

          if (!videoDriving) {
              const clipTime = time - videoClip.startTime + videoClip.offset;
              if (Math.abs(v.currentTime - clipTime) > 0.1) v.currentTime = clipTime;
          }

          if (this.mainVideoGain) {
              const vol = videoClip.muted ? 0 : videoClip.volume;
              this.mainVideoGain.gain.value = vol;
          }
          v.muted = false; // We control volume via GainNode
          v.style.opacity = '1';

          let transformStr = 'scale(1)';
          if (videoClip.stabilized) {
              const zoom = videoClip.stabilizationZoom || 1.3;
              transformStr = `scale(${zoom})`;
              if (videoClip.stabilizationData) {
                  const clipTime = time - videoClip.startTime;
                  // Find nearest correction frame
                  let bestCorrection = { dx: 0, dy: 0 };
                  for (let d of videoClip.stabilizationData) {
                      if (d.time <= clipTime) {
                          bestCorrection = d;
                      } else {
                          break;
                      }
                  }
                  transformStr += ` translate(${bestCorrection.dx}px, ${bestCorrection.dy}px)`;
              }
          }
          v.style.transform = transformStr;

          if (this.state.isPlaying() && v.paused) v.play().catch(()=>{});
          if (!this.state.isPlaying() && !v.paused) v.pause();

          // Overlay processing
          this.drawOverlay(v, videoClip);

      } else {
          v.style.opacity = '0';
          this.clearOverlay();
          if (this.mainVideoGain) this.mainVideoGain.gain.value = 0;
          v.pause();
      }

      // Audio Tracks
      const activeClips = this.getActiveClips(time);

      // Cleanup inactive audio
      this.audio.cleanup(activeClips.map(c => c.id));

      // Play active audio
      activeClips.forEach(clip => {
           const media = this.state.getMedia(clip.mediaId);
           if (media && media.url) {
               this.audio.playAudio(clip.id, media.url, clip.startTime, clip.offset, clip.volume, clip.muted, time);
           }
      });
  }

  private clearOverlay() {
      if (this.overlayCanvas) {
          const canvas = this.overlayCanvas.nativeElement;
          const ctx = canvas.getContext('2d');
          if (ctx) {
             ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
      }
  }

  private drawOverlay(video: HTMLVideoElement, clip: Clip) {
      if (!this.isFaceDetectorReady || !this.faceDetector || !this.overlayCanvas) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const canvas = this.overlayCanvas.nativeElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Make canvas match video element's displayed size
      const rect = video.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      canvas.width = rect.width;
      canvas.height = rect.height;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // We need to pass the video time as timestamp
      const startTimeMs = performance.now();

      try {
          const detections = this.faceDetector.detectForVideo(video, startTimeMs).detections;

          // The video element might be letterboxed (object-fit: contain)
          // We need to calculate the actual drawn video dimensions to map coordinates correctly.
          const videoAspect = video.videoWidth / video.videoHeight;
          const canvasAspect = canvas.width / canvas.height;

          let drawWidth, drawHeight, drawX, drawY;

          if (canvasAspect > videoAspect) {
              // Canvas is wider than video (pillarbox)
              drawHeight = canvas.height;
              drawWidth = drawHeight * videoAspect;
              drawX = (canvas.width - drawWidth) / 2;
              drawY = 0;
          } else {
              // Canvas is taller than video (letterbox)
              drawWidth = canvas.width;
              drawHeight = drawWidth / videoAspect;
              drawX = 0;
              drawY = (canvas.height - drawHeight) / 2;
          }

          // Apply stabilization transform to the canvas context to match the video element's transform
          ctx.save();
          if (clip.stabilized) {
              const zoom = clip.stabilizationZoom || 1.3;
              let dx = 0;
              let dy = 0;
              if (clip.stabilizationData) {
                  const clipTime = this.state.playbackTime() - clip.startTime;
                  for (let d of clip.stabilizationData) {
                      if (d.time <= clipTime) {
                          dx = d.dx;
                          dy = d.dy;
                      } else {
                          break;
                      }
                  }
              }
              // The translation in CSS is in pixels relative to the unscaled element.
              // Center origin, scale, translate, uncenter.
              ctx.translate(canvas.width / 2, canvas.height / 2);
              ctx.scale(zoom, zoom);
              ctx.translate(-canvas.width / 2, -canvas.height / 2);
              ctx.translate(dx, dy);
          }

          for (const detection of detections) {
              const bb = detection.boundingBox;
              if (!bb) continue;

              // boundingBox coordinates are relative to the original video width/height
              const x = drawX + (bb.originX / video.videoWidth) * drawWidth;
              const y = drawY + (bb.originY / video.videoHeight) * drawHeight;
              const w = (bb.width / video.videoWidth) * drawWidth;
              const h = (bb.height / video.videoHeight) * drawHeight;

              // Enlarge the ball slightly to cover the whole head
              const paddingX = w * 0.2;
              const paddingY = h * 0.4;
              const ballX = x - paddingX;
              const ballY = y - paddingY;
              const ballW = w + (paddingX * 2);
              const ballH = h + (paddingY * 2);

              if (this.ballImage.complete) {
                  // Draw the image as a circle mask
                  ctx.save();
                  ctx.beginPath();
                  ctx.arc(ballX + ballW / 2, ballY + ballH / 2, Math.max(ballW, ballH) / 2, 0, Math.PI * 2);
                  ctx.closePath();
                  ctx.clip();
                  ctx.drawImage(this.ballImage, ballX, ballY, ballW, ballH);
                  ctx.restore();
              }
          }

          ctx.restore();

      } catch (e) {
          // Ignore occasional detector errors
      }
  }

  private getVideoClipAtTime(time: number): Clip | undefined {
      return this.state.videoTrack().find(c => time >= c.startTime && time < c.startTime + c.duration);
  }

  private getActiveClips(time: number): Clip[] {
      const clips: Clip[] = [];
      this.state.audioTracks().forEach(track => {
          track.forEach(c => {
              if (time >= c.startTime && time < c.startTime + c.duration) {
                  clips.push(c);
              }
          });
      });
      return clips;
  }
}
