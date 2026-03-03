import { Component, ElementRef, ViewChild, AfterViewInit, inject, computed, HostListener, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StateService, Clip, MediaItem } from '../../services/state';
import { AudioService } from '../../services/audio';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-timeline',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline.html',
  styleUrl: './timeline.css'
})
export class Timeline {
  @ViewChild('timelineTracks') timelineTracks!: ElementRef<HTMLDivElement>;

  protected stateService = inject(StateService);
  protected audioService = inject(AudioService);

  // Computeds
  videoTrack = this.stateService.videoTrack;
  audioTracks = this.stateService.audioTracks;
  zoom = this.stateService.zoom;
  playbackTime = this.stateService.playbackTime;
  selectedClipId = this.stateService.selectedClipId;

  // Layout Computations
  get totalWidth() {
      let maxTime = 0;
      this.videoTrack().forEach(c => maxTime = Math.max(maxTime, c.startTime + c.duration));
      this.audioTracks().forEach(t => t.forEach(c => maxTime = Math.max(maxTime, c.startTime + c.duration)));
      return (Math.max(20, maxTime) * this.zoom()) + 500;
  }

  // Drag State
  isDragging = false;
  dragClipId: string | null = null;
  dragStartX = 0;
  dragOriginalStart = 0;

  // Waveform Cache (local)
  waveforms: { [key: string]: string } = {}; // DataURL or similar? No, draw to canvas directly usually.

  // Thumbnails Cache
  thumbnails: { [key: string]: SafeHtml } = {};
  private sanitizer = inject(DomSanitizer);

  constructor() {
      effect(() => {
          const vTrack = this.videoTrack();
          // We can reactively generate thumbnails when clips are added
          vTrack.forEach(clip => {
              if (!this.thumbnails[clip.id]) {
                  this.generateThumbnails(clip);
              }
          });
      });
  }

  async generateThumbnails(clip: Clip) {
      const media = this.stateService.getMedia(clip.mediaId);
      if (!media || media.type !== 'video' || !media.url) return;

      const video = document.createElement('video');
      video.src = media.url;
      video.muted = true;
      video.playsInline = true;

      // Need it to be somewhat visible or in DOM for iOS sometimes, but let's try just loading data
      await new Promise<void>((resolve) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => resolve(); // Handle error gracefully
      });

      if (!video.videoWidth) return;

      // Based on memory: Video thumbnails are generated asynchronously using a transparent, fixed-position video element (`opacity: 0.01`) instead of off-screen positioning (`top: -9999px`) to ensure WebKit renders frames on iOS.
      video.style.position = 'fixed';
      video.style.top = '0';
      video.style.left = '0';
      video.style.opacity = '0.01';
      video.style.pointerEvents = 'none';
      document.body.appendChild(video);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
          document.body.removeChild(video);
          return;
      }

      const trackHeight = 60; // Approximate height of track
      const aspect = video.videoWidth / video.videoHeight;
      const thumbWidth = trackHeight * aspect;

      canvas.width = thumbWidth;
      canvas.height = trackHeight;

      let html = '';
      const numThumbs = Math.max(1, Math.ceil(clip.duration / 5)); // One thumb every 5 seconds roughly
      const interval = clip.duration / numThumbs;

      for (let i = 0; i < numThumbs; i++) {
          const time = clip.offset + (i * interval);
          video.currentTime = time;
          await new Promise<void>((resolve) => {
              // Using requestVideoFrameCallback if available, otherwise 'seeked'
              if ('requestVideoFrameCallback' in video) {
                  (video as any).requestVideoFrameCallback(() => resolve());
              } else {
                  const onSeeked = () => {
                      (video as HTMLVideoElement).removeEventListener('seeked', onSeeked);
                      resolve();
                  };
                  (video as HTMLVideoElement).addEventListener('seeked', onSeeked);
              }
              // Fallback resolve if seeked doesn't fire
              setTimeout(() => resolve(), 500);
          });

          ctx.drawImage(video, 0, 0, thumbWidth, trackHeight);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
          html += `<img src="${dataUrl}" style="width: ${thumbWidth}px; height: ${trackHeight}px; pointer-events: none; display: inline-block;">`;
      }

      this.thumbnails[clip.id] = this.sanitizer.bypassSecurityTrustHtml(html);
      document.body.removeChild(video);
  }

  onMouseDown(event: MouseEvent, clip: Clip) {
      this.isDragging = true;
      this.dragClipId = clip.id;
      this.dragStartX = event.clientX;
      this.dragOriginalStart = clip.startTime;
      this.stateService.selectedClipId.set(clip.id);
      event.stopPropagation();
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
      if (!this.isDragging || !this.dragClipId) return;

      const deltaPx = event.clientX - this.dragStartX;
      const deltaSec = deltaPx / this.zoom();
      let newStartTime = Math.max(0, this.dragOriginalStart + deltaSec);

      this.stateService.updateClip(this.dragClipId, { startTime: newStartTime });
  }

  @HostListener('window:mouseup', ['$event'])
  onMouseUp(event: MouseEvent) {
      if (this.isDragging) {
          this.isDragging = false;
          this.dragClipId = null;
          this.stateService.saveState();
      }
  }

  onTimelineClick(event: MouseEvent) {
      // If we were dragging, ignore click
      // BUT, click fires after mouseup.
      // We need to differentiate click vs drag.
      // Usually done by checking delta.

      const rect = this.timelineTracks.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = x / this.zoom();

      // If we clicked a clip, stop propagation happens there.
      // If we reached here, we clicked empty space.
      this.stateService.playbackTime.set(Math.max(0, time));
      this.stateService.selectedClipId.set(null);
  }

  onWheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const zoomChange = event.deltaY > 0 ? 0.9 : 1.1;
          this.stateService.zoom.update(z => Math.max(1, Math.min(200, z * zoomChange)));
      }
  }

  getClipStyle(clip: Clip) {
      return {
          left: (clip.startTime * this.zoom()) + 'px',
          width: Math.max(2, clip.duration * this.zoom()) + 'px'
      };
  }

  getMediaName(clip: Clip): string {
      const m = this.stateService.getMedia(clip.mediaId);
      return m ? m.name : 'Missing';
  }

  onClipClick(event: MouseEvent, clip: Clip) {
      event.stopPropagation();
      this.stateService.selectedClipId.set(clip.id);
  }

  // Ruler Generation
  get rulerTicks() {
      const duration = this.totalWidth / this.zoom();
      const ticks = [];
      const minPx = 60;
      let interval = 1;
      while (interval * this.zoom() < minPx) {
         if (interval < 1) interval = 1;
         else if (interval < 2) interval = 2;
         else if (interval < 5) interval = 5;
         else if (interval < 10) interval = 10;
         else if (interval < 30) interval = 30;
         else if (interval < 60) interval = 60;
         else interval += 60;
      }

      for (let t = 0; t <= duration; t += interval) {
          const m = Math.floor(t / 60);
          const s = t % 60;
          ticks.push({
              left: t * this.zoom(),
              label: `${m}:${s.toString().padStart(2, '0')}`
          });
      }
      return ticks;
  }

  // Drag Over
  onDragOver(event: DragEvent) {
      event.preventDefault();
  }

  onDrop(event: DragEvent) {
      event.preventDefault();
      const rect = this.timelineTracks.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const startTime = x / this.zoom();

      if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
          // File Drop
          // We need to process files.
          // This logic is duplicated in Toolbar.
          // Refactor to service?
          // For now, let's just emit or call service if we move logic there.
          // Or just handle here.
          Array.from(event.dataTransfer.files).forEach(file => {
               this.processFile(file, startTime);
          });
      }
  }

  processFile(file: File, startTime: number) {
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

      element.onerror = () => alert("Failed to load media: " + file.name);

      element.onloadedmetadata = () => {
          const item: MediaItem = {
              id,
              file,
              url,
              type,
              name: file.name,
              duration: element.duration || 0,
              videoWidth: type === 'video' ? ((element as HTMLVideoElement).videoWidth || 0) : 0,
              videoHeight: type === 'video' ? ((element as HTMLVideoElement).videoHeight || 0) : 0
          };
          this.stateService.addMedia(item);
          this.stateService.addClipToTimeline(item, startTime);
      };
      element.src = url;
  }
}
