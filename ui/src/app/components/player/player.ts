import { Component, ElementRef, ViewChild, AfterViewInit, inject, effect, Signal, computed } from '@angular/core';
import { StateService, Clip } from '../../services/state';
import { AudioService } from '../../services/audio';

@Component({
  selector: 'app-player',
  standalone: true,
  templateUrl: './player.html',
  styleUrl: './player.css'
})
export class Player implements AfterViewInit {
  @ViewChild('mainVideo') mainVideo!: ElementRef<HTMLVideoElement>;

  protected state = inject(StateService);
  protected audio = inject(AudioService);

  private lastFrameTime = 0;
  private animationFrameId = 0;
  private mainVideoSource: MediaElementAudioSourceNode | null = null;
  private mainVideoGain: GainNode | null = null;

  // Computed state for UI
  formattedTime = computed(() => {
      const time = this.state.playbackTime();
      const m = Math.floor(time / 60);
      const s = Math.floor(time % 60);
      const ms = Math.floor((time % 1) * 100);
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  });

  constructor() {
      // Effect to handle seeking when paused
      effect(() => {
          const time = this.state.playbackTime();
          const isPlaying = this.state.isPlaying();
          if (!isPlaying) {
             this.syncMedia(time, false);
          }
      });
  }

  ngAfterViewInit() {
      // Start render loop
      this.renderLoop(0);
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
          v.style.transform = videoClip.stabilized ? 'scale(1.1)' : 'scale(1)';

          if (this.state.isPlaying() && v.paused) v.play().catch(()=>{});
          if (!this.state.isPlaying() && !v.paused) v.pause();

      } else {
          v.style.opacity = '0';
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
