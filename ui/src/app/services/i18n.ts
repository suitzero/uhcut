import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class I18nService {
  lang = signal<'en' | 'ko'>('en');

  private translations = {
    en: {
      add: 'Add',
      record: 'Record',
      undo: 'Undo',
      redo: 'Redo',
      split: 'Split',
      delete: 'Delete',
      stabilize: 'Stabilize',
      extractAudio: 'Extract Audio',
      rmSilence: 'Rm Silence',
      zoomIn: 'In',
      zoomOut: 'Out',
      play: 'Play',
      pause: 'Pause',
      export: 'Save Video',
      language: 'Language',
      en: 'English',
      ko: '한국어',
      exporting: 'Exporting Video...',
      exportComplete: 'Export Complete!',
      close: 'Close'
    },
    ko: {
      add: '추가',
      record: '녹음',
      undo: '실행 취소',
      redo: '다시 실행',
      split: '분할',
      delete: '삭제',
      stabilize: '안정화',
      extractAudio: '오디오 추출',
      rmSilence: '무음 제거',
      zoomIn: '확대',
      zoomOut: '축소',
      play: '재생',
      pause: '일시정지',
      export: '비디오 저장',
      language: '언어',
      en: 'English',
      ko: '한국어',
      exporting: '비디오 저장 중...',
      exportComplete: '저장 완료!',
      close: '닫기'
    }
  };

  t(key: keyof typeof this.translations.en): string {
    return this.translations[this.lang()][key] || key;
  }

  toggleLang() {
    this.lang.update(l => l === 'en' ? 'ko' : 'en');
  }
}
