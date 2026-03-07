import { Component, signal, HostListener, inject } from '@angular/core';
import { Toolbar } from './components/toolbar/toolbar';
import { Player } from './components/player/player';
import { Timeline } from './components/timeline/timeline';
import { StateService } from './services/state';
import { AudioService } from './services/audio';
import { ExportService } from './services/export';
import { I18nService } from './services/i18n';
import { ViewChild } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [Toolbar, Player, Timeline],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('UhCut');
  @ViewChild(Player) playerComponent!: Player;

  protected state = inject(StateService);
  protected audio = inject(AudioService);
  protected exportSvc = inject(ExportService);
  public i18n = inject(I18nService);

  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
    }

    if (event.code === 'Space') {
        event.preventDefault();
        this.state.isPlaying.update(p => !p);
        if (this.state.isPlaying()) {
            this.audio.resumeContext();
        }
    } else if (event.code === 'Delete' || event.code === 'Backspace') {
        event.preventDefault();
        const id = this.state.selectedClipId();
        if (id) {
            this.state.deleteClip(id);
        }
    } else if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.state.undo();
    } else if (event.key === 'y' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.state.redo();
    }
  }

  exportVideo() {
    console.log("Export started...");
    if (this.playerComponent && this.playerComponent.mainVideo) {
      this.exportSvc.exportVideo(this.state, this.audio, this.playerComponent.mainVideo.nativeElement);
    } else {
      alert("Player not ready.");
    }
  }

  saveExportedVideo() {
    const url = this.state.exportUrl();
    if (!url) return;

    if (navigator.share) {
      // Need a File object to share on some platforms
      fetch(url)
        .then(res => res.blob())
        .then(blob => {
          const file = new File([blob], 'uhcut_video.mp4', { type: 'video/mp4' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({
              files: [file],
              title: 'UhCut Video',
              text: 'Exported from UhCut'
            }).catch(e => console.error("Share failed", e));
          } else {
            // Fallback to manual download or open
            window.open(url, '_blank');
          }
        });
    } else {
      // Direct download link
      const a = document.createElement('a');
      a.href = url;
      a.download = 'uhcut_video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  closeExport() {
    this.state.isExporting.set(false);
    this.state.exportProgress.set(0);
    this.state.exportUrl.set(null);
  }
}
