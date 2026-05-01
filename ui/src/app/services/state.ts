import { Injectable, signal, computed, WritableSignal } from '@angular/core';

export interface MediaItem {
  id: string;
  file: File | null;
  url: string | null;
  type: 'video' | 'audio';
  name: string;
  duration: number;
  videoWidth?: number;
  videoHeight?: number;
  _recording?: boolean;
}

export interface Clip {
  id: string;
  mediaId: string;
  startTime: number;
  duration: number;
  offset: number;
  type: 'video' | 'audio';
  muted: boolean;
  volume: number;
  stabilized?: boolean;
  stabilizationData?: {time: number, dx: number, dy: number}[];
  stabilizationZoom?: number;
  enhancedAudio?: boolean;
}

export interface Caption {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface Tracks {
  video: Clip[];
  audio: Clip[][];
}

export interface AppState {
  media: MediaItem[];
  tracks: Tracks;
  captions: Caption[];
  playbackTime: number;
  isPlaying: boolean;
  zoom: number;
  selectedClipId: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class StateService {
  // Signals
  media = signal<MediaItem[]>([]);
  videoTrack = signal<Clip[]>([]);
  audioTracks = signal<Clip[][]>([[], []]); // Two audio channels
  captions = signal<Caption[]>([]);
  playbackTime = signal(0);
  isPlaying = signal(false);
  zoom = signal(20);
  selectedClipId = signal<string | null>(null);
  recordingWaveform = signal<string | null>(null);

  // Export State
  isExporting = signal(false);
  exportProgress = signal(0);
  exportUrl = signal<string | null>(null);




  // History Stacks
  private historyStack: string[] = [];
  private redoStack: string[] = [];

  constructor() {
    // Initial State Save? Maybe not needed immediately
  }

  // --- Actions ---

  addMedia(item: MediaItem) {
    this.media.update(list => [...list, item]);
  }

  updateMedia(id: string, updates: Partial<MediaItem>) {
    this.media.update(list => list.map(m => m.id === id ? { ...m, ...updates } : m));
  }

  updateClipDurationByMediaId(mediaId: string, duration: number) {
      const vTrack = this.videoTrack();
      const vIndex = vTrack.findIndex(c => c.mediaId === mediaId);
      if (vIndex !== -1) {
          this.updateClip(vTrack[vIndex].id, { duration });
          this.repackVideoTrack();
          return;
      }
      const aTracks = this.audioTracks();
      for (let i = 0; i < aTracks.length; i++) {
          const aIndex = aTracks[i].findIndex(c => c.mediaId === mediaId);
          if (aIndex !== -1) {
              this.updateClip(aTracks[i][aIndex].id, { duration });
              return;
          }
      }
  }

  repackVideoTrack() {
      const vTrack = this.videoTrack();
      const sorted = [...vTrack].sort((a, b) => a.startTime - b.startTime);
      let currentTime = 0;
      const repacked = sorted.map(clip => {
          const newClip = { ...clip, startTime: currentTime };
          currentTime += clip.duration;
          return newClip;
      });
      // Do not call saveState here, as it might duplicate undo histories when called in sequence.
      this.videoTrack.set(repacked);
  }

  // Smart Add
  addToTimelineSmart(item: MediaItem) {
    this.saveState();

    const clip: Clip = {
        id: 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5),
        mediaId: item.id,
        duration: item.duration,
        offset: 0,
        type: item.type,
        muted: false,
        volume: 1.0,
        startTime: 0
    };

    if (item.type === 'video') {
        const videoClips = this.videoTrack();
        const lastClip = videoClips.length > 0
            ? videoClips.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b))
            : null;
        clip.startTime = lastClip ? (lastClip.startTime + lastClip.duration) : 0;
        this.videoTrack.update(tracks => [...tracks, clip]);
        this.repackVideoTrack();
    } else {
        const audioTracks = this.audioTracks();
        let added = false;

        // Try to find a track without collision
        const newAudioTracks = [...audioTracks];

        for (let i = 0; i < newAudioTracks.length; i++) {
            const trackClips = newAudioTracks[i];
            const lastClip = trackClips.length > 0
                 ? trackClips.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b))
                 : null;
            const potentialStart = lastClip ? (lastClip.startTime + lastClip.duration) : 0;

            clip.startTime = potentialStart;
            newAudioTracks[i] = [...trackClips, clip];
            added = true;
            break;
        }

        if (!added) {
             // Fallback to first track if somehow logic fails (though loop covers existing tracks)
             // Or maybe we want to extend tracks dynamically? For now stick to 2.
             newAudioTracks[0] = [...newAudioTracks[0], clip];
        }
        this.audioTracks.set(newAudioTracks);
    }
  }

  addClipToTimeline(mediaItem: MediaItem, startTime: number) {
      this.saveState();
      const clip: Clip = {
          id: 'clip_' + Date.now() + Math.random().toString(36).substr(2, 5),
          mediaId: mediaItem.id,
          startTime: Math.max(0, startTime),
          duration: mediaItem.duration,
          offset: 0,
          type: mediaItem.type,
          muted: false,
          volume: 1.0
      };

      if (mediaItem.type === 'video') {
          this.videoTrack.update(t => [...t, clip]);
          this.repackVideoTrack();
      } else {
          const audioTracks = this.audioTracks();
          const newAudioTracks = [...audioTracks];

          let targetTrackIndex = 0;
          let hasCollision = this.checkCollision(newAudioTracks[0], clip);

          if (hasCollision && newAudioTracks[1]) {
              targetTrackIndex = 1;
              if (this.checkCollision(newAudioTracks[1], clip)) {
                  // Collision on both, still add to 1? Or 0? Logic says targetTrackIndex starts 0.
                  // Original code: if collision on 0, try 1. If collision on 1, stays 1.
              }
          }
          newAudioTracks[targetTrackIndex] = [...newAudioTracks[targetTrackIndex], clip];
          this.audioTracks.set(newAudioTracks);
      }
  }

  checkCollision(trackClips: Clip[], newClip: Clip): boolean {
      return trackClips.some(c =>
          c.id !== newClip.id &&
          !(newClip.startTime >= c.startTime + c.duration || newClip.startTime + newClip.duration <= c.startTime)
      );
  }

  updateClip(clipId: string, updates: Partial<Clip>) {
      // Check video
      const vTrack = this.videoTrack();
      const vIndex = vTrack.findIndex(c => c.id === clipId);
      if (vIndex !== -1) {
          const newTrack = [...vTrack];
          newTrack[vIndex] = { ...newTrack[vIndex], ...updates };
          this.videoTrack.set(newTrack);
          if (updates.duration !== undefined) {
              this.repackVideoTrack();
          }
          return;
      }

      // Check audio
      const aTracks = this.audioTracks();
      let found = false;
      const newATracks = aTracks.map(track => {
          const idx = track.findIndex(c => c.id === clipId);
          if (idx !== -1) {
              found = true;
              const newTrack = [...track];
              newTrack[idx] = { ...newTrack[idx], ...updates };
              return newTrack;
          }
          return track;
      });
      if (found) {
          this.audioTracks.set(newATracks);
      }
  }

  moveAudioClipToTrack(clipId: string, targetTrackIndex: number, newStartTime: number) {
      const aTracks = this.audioTracks();
      let clipToMove: Clip | null = null;
      let originalTrackIndex = -1;

      // Find the clip and its current track
      for (let i = 0; i < aTracks.length; i++) {
          const idx = aTracks[i].findIndex(c => c.id === clipId);
          if (idx !== -1) {
              clipToMove = { ...aTracks[i][idx], startTime: Math.max(0, newStartTime) };
              originalTrackIndex = i;
              break;
          }
      }

      if (!clipToMove) return;

      // Ensure target track exists
      const targetIndex = Math.max(0, Math.min(aTracks.length - 1, targetTrackIndex));
      const newATracks = aTracks.map(t => [...t]); // Deep copy outer array

      // Remove from original
      newATracks[originalTrackIndex] = newATracks[originalTrackIndex].filter(c => c.id !== clipId);

      // Move or just update time on target track (no collision check, allow overlap naturally)
      newATracks[targetIndex].push(clipToMove);

      this.audioTracks.set(newATracks);
  }

  deleteClip(clipId: string) {
      this.saveState();
      this.videoTrack.update(t => t.filter(c => c.id !== clipId));
      this.audioTracks.update(tracks => tracks.map(t => t.filter(c => c.id !== clipId)));
      if (this.selectedClipId() === clipId) {
          this.selectedClipId.set(null);
      }

      this.repackVideoTrack();
  }

  splitClip(): void {
      const clipId = this.selectedClipId();
      if (!clipId) {
          const time = this.playbackTime();
          const videoClip = this.videoTrack().find(c => time >= c.startTime && time < c.startTime + c.duration);
          if (videoClip) {
              this.selectedClipId.set(videoClip.id);
              return this.splitClip();
          }
          return;
      }

      const clip = this.findClip(clipId);
      if (!clip) return;

      const currentTime = this.playbackTime();
      const relTime = currentTime - clip.startTime;

      if (relTime > 0.05 && relTime < clip.duration - 0.05) {
          this.saveState();

          const newClip: Clip = {
              ...clip,
              id: 'clip_' + Date.now(),
              startTime: currentTime,
              duration: clip.duration - relTime,
              offset: clip.offset + relTime
          };

          // Update original clip duration
          this.updateClip(clip.id, { duration: relTime });

          // Add new clip
          if (clip.type === 'video') {
              this.videoTrack.update(t => [...t, newClip]);
          } else {
              const aTracks = this.audioTracks();
              const newATracks = aTracks.map(track => {
                  if (track.some(c => c.id === clip.id)) {
                      return [...track, newClip];
                  }
                  return track;
              });
              this.audioTracks.set(newATracks);
          }
          this.repackVideoTrack();
      }
  }

  findClip(id: string): Clip | undefined {
      const v = this.videoTrack().find(c => c.id === id);
      if (v) return v;
      for (const t of this.audioTracks()) {
          const a = t.find(c => c.id === id);
          if (a) return a;
      }
      return undefined;
  }

  getMedia(id: string): MediaItem | undefined {
      return this.media().find(m => m.id === id);
  }

  // --- History ---

  saveState() {
      const snapshot = JSON.stringify({
          videoTrack: this.videoTrack(),
          audioTracks: this.audioTracks(),
          selectedClipId: this.selectedClipId(),
          playbackTime: this.playbackTime(),
          zoom: this.zoom(),
          captions: this.captions()
      });

      if (this.historyStack.length > 0 && this.historyStack[this.historyStack.length - 1] === snapshot) return;

      this.historyStack.push(snapshot);
      this.redoStack = [];
      if (this.historyStack.length > 50) this.historyStack.shift();
  }

  undo() {
      if (this.historyStack.length === 0) return;

      // Save current state to redo stack
      const currentSnapshot = JSON.stringify({
          videoTrack: this.videoTrack(),
          audioTracks: this.audioTracks(),
          selectedClipId: this.selectedClipId(),
          playbackTime: this.playbackTime(),
          zoom: this.zoom(),
          captions: this.captions()
      });
      this.redoStack.push(currentSnapshot);

      const snapshot = JSON.parse(this.historyStack.pop()!);
      this.restoreState(snapshot);
  }

  redo() {
      if (this.redoStack.length === 0) return;

      // Save current to history
      const currentSnapshot = JSON.stringify({
          videoTrack: this.videoTrack(),
          audioTracks: this.audioTracks(),
          selectedClipId: this.selectedClipId(),
          playbackTime: this.playbackTime(),
          zoom: this.zoom(),
          captions: this.captions()
      });
      this.historyStack.push(currentSnapshot);

      const snapshot = JSON.parse(this.redoStack.pop()!);
      this.restoreState(snapshot);
  }

  private restoreState(snapshot: any) {
      this.videoTrack.set(snapshot.videoTrack);
      this.audioTracks.set(snapshot.audioTracks);
      this.selectedClipId.set(snapshot.selectedClipId);
      this.playbackTime.set(snapshot.playbackTime);
      this.zoom.set(snapshot.zoom);
      this.captions.set(snapshot.captions || []);
  }
}
