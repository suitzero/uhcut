import { Injectable, signal, Inject } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AudioService {
  audioCtx: AudioContext;
  masterGain: GainNode;
  exportDest: MediaStreamAudioDestinationNode;

  // Audio Pool: clipId -> { audio, source, gain, enhancerNodes }
  private audioPool: { [key: string]: {
      audio: HTMLAudioElement,
      source: MediaElementAudioSourceNode,
      gain: GainNode,
      enhancerNodes?: { hp: BiquadFilterNode, peak: BiquadFilterNode, comp: DynamicsCompressorNode }
  } } = {};

  // Waveform cache
  private waveformCache: { [key: string]: AudioBuffer } = {};

  constructor() {
    // Check if AudioContext is available (in browser)
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.connect(this.audioCtx.destination);

        // Handle JSDOM/Node environment where createMediaStreamDestination might not exist
        if (typeof this.audioCtx.createMediaStreamDestination === 'function') {
            this.exportDest = this.audioCtx.createMediaStreamDestination();
            this.masterGain.connect(this.exportDest);
        } else {
            this.exportDest = null as any;
        }
    } else {
        // Mock for testing environment
        this.audioCtx = {} as any;
        this.masterGain = { connect: () => {}, gain: { value: 1 } } as any;
        this.exportDest = null as any;
    }
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

  playAudio(clipId: string, url: string, startTime: number, offset: number, volume: number, muted: boolean, playbackTime: number, enhancedAudio: boolean = false) {
      let item = this.audioPool[clipId];

      if (!item) {
          const a = new Audio(url);
          a.crossOrigin = 'anonymous';
          const source = this.audioCtx.createMediaElementSource(a);
          const gain = this.audioCtx.createGain();

          item = { audio: a, source, gain };
          this.audioPool[clipId] = item;
          this.setupRouting(item, enhancedAudio);
      } else {
          // Check if enhancement state changed
          const currentlyEnhanced = !!item.enhancerNodes;
          if (currentlyEnhanced !== enhancedAudio) {
              this.setupRouting(item, enhancedAudio);
          }
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
              this.disconnectItem(item);
              delete this.audioPool[id];
          }
      });
  }

  private setupRouting(item: any, enhancedAudio: boolean) {
      this.disconnectItem(item);

      if (enhancedAudio) {
          const hp = this.audioCtx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 80;

          const peak = this.audioCtx.createBiquadFilter();
          peak.type = 'peaking';
          peak.frequency.value = 3000;
          peak.Q.value = 1.0;
          peak.gain.value = 3;

          const comp = this.audioCtx.createDynamicsCompressor();
          comp.threshold.value = -24;
          comp.knee.value = 30;
          comp.ratio.value = 12;
          comp.attack.value = 0.003;
          comp.release.value = 0.25;

          item.enhancerNodes = { hp, peak, comp };

          item.source.connect(hp);
          hp.connect(peak);
          peak.connect(comp);
          comp.connect(item.gain);
      } else {
          item.enhancerNodes = undefined;
          item.source.connect(item.gain);
      }

      item.gain.connect(this.masterGain);
  }

  private disconnectItem(item: any) {
      try { item.source.disconnect(); } catch (e) {}
      try { item.gain.disconnect(); } catch (e) {}
      if (item.enhancerNodes) {
          try { item.enhancerNodes.hp.disconnect(); } catch (e) {}
          try { item.enhancerNodes.peak.disconnect(); } catch (e) {}
          try { item.enhancerNodes.comp.disconnect(); } catch (e) {}
      }
  }

  resumeContext() {
      if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume();
      }
  }
}
