import { Injectable, signal, Inject } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  audioCtx: AudioContext;
  masterGain: GainNode;
  exportDest: MediaStreamAudioDestinationNode;

  // Audio Pool: clipId -> { audio, source, gain }
  private audioPool: { [key: string]: { audio: HTMLAudioElement, source: MediaElementAudioSourceNode, gain: GainNode } } = {};

  // Waveform cache
  private waveformCache: { [key: string]: AudioBuffer } = {};

  constructor() {
    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.connect(this.audioCtx.destination);
    this.exportDest = this.audioCtx.createMediaStreamDestination();
    this.masterGain.connect(this.exportDest);
  }

  async getWaveform(url: string, mediaId: string): Promise<AudioBuffer | null> {
      if (this.waveformCache[mediaId]) return this.waveformCache[mediaId];
      try {
          const resp = await fetch(url);
          const ab = await resp.arrayBuffer();
          const buffer = await this.audioCtx.decodeAudioData(ab);
          this.waveformCache[mediaId] = buffer;
          return buffer;
      } catch (e) {
          console.error("Waveform error", e);
          return null;
      }
  }

  playAudio(clipId: string, url: string, startTime: number, offset: number, volume: number, muted: boolean, playbackTime: number) {
      let item = this.audioPool[clipId];

      if (!item) {
          const a = new Audio(url);
          a.crossOrigin = 'anonymous';
          const source = this.audioCtx.createMediaElementSource(a);
          const gain = this.audioCtx.createGain();
          source.connect(gain);
          gain.connect(this.masterGain);
          item = { audio: a, source, gain };
          this.audioPool[clipId] = item;
      }

      const clipTime = playbackTime - startTime + offset;

      // Sync check
      if (Math.abs(item.audio.currentTime - clipTime) > 0.3) {
           item.audio.currentTime = clipTime;
      }

      const vol = muted ? 0 : volume;
      item.gain.gain.value = vol;

      if (item.audio.paused) {
          item.audio.play().catch(e => { /* Autoplay block? */ });
      }
  }

  pauseAudio(clipId: string) {
      const item = this.audioPool[clipId];
      if (item && !item.audio.paused) {
          item.audio.pause();
      }
  }

  cleanup(activeClipIds: string[]) {
      Object.keys(this.audioPool).forEach(id => {
          if (!activeClipIds.includes(id)) {
              const item = this.audioPool[id];
              item.audio.pause();
              item.gain.disconnect();
              item.source.disconnect();
              delete this.audioPool[id];
          }
      });
  }

  resumeContext() {
      if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume();
      }
  }
}
