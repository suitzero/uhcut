import { Component, signal } from '@angular/core';
import { Toolbar } from './components/toolbar/toolbar';
import { Player } from './components/player/player';
import { Timeline } from './components/timeline/timeline';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [Toolbar, Player, Timeline],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('UhCut');
}
