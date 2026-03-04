import { Component, signal, HostListener, inject } from '@angular/core';
import { Toolbar } from './components/toolbar/toolbar';
import { Player } from './components/player/player';
import { Timeline } from './components/timeline/timeline';
import { StateService } from './services/state';
import { AudioService } from './services/audio';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [Toolbar, Player, Timeline],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('UhCut');
  protected state = inject(StateService);
  protected audio = inject(AudioService);

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
    alert("Export started... (This is a placeholder for the export process)");
  }
}
