#!/bin/bash
cat << 'INNER_EOF' > ui/src/app/components/toolbar/toolbar.ts
import { Component, ElementRef, ViewChild, inject, computed } from '@angular/core';
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
}
INNER_EOF
