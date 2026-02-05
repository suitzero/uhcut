# UhCut 실행 계획: 버그 수정 + ffmpeg.wasm 통합 + CI/CD 자동 테스트

> 서버 없음. 모바일 전용. ffmpeg.wasm으로 인코딩/디코딩 최적화.

---

## Part 1: 프리뷰 & 익스포트 버그 분석

### 1.1 프리뷰 버그 (script.js)

#### BUG-P1: AudioContext 자동 생성 정책 위반 (line 37)

```js
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
```

**문제:** 페이지 로드 시점에 AudioContext를 생성하면 iOS Safari에서 `suspended` 상태로 시작됨.

**증상:** 오디오 클립이 타임라인에 있어도 소리가 안 남.

**수정:**
- AudioContext 생성을 lazy로 전환
- 모든 사용자 인터랙션 핸들러에서 `audioCtx.resume()` 호출

#### BUG-P2 [CRITICAL]: 클립 썸네일 생성-파괴 무한 루프 (lines 468-623)

**문제 (5가지 복합 버그):**

1. `renderClipContent` → `el.innerHTML = ''` → 매번 전체 삭제 → 재큐잉 루프
2. `thumbQueue.length > 30`이면 마지막 10개만 남기고 삭제
3. 썸네일 캐시 없음 (웨이브폼은 있음)
4. `state.isPlaying`이면 큐 처리 중단 → 끝나면 전부 파괴
5. safety check에서 `onSeek()` 직접 호출 시 seeked 리스너 누수

**수정:**
- 썸네일 캐시 도입 (`mediaUrl + time` → dataURL)
- props 변경 없으면 `innerHTML` 초기화 건너뛰기
- safety check 시 기존 리스너 제거
- 재생 후 캐시에서 즉시 복원

#### BUG-P3: 비디오/오디오 동기화 드리프트 (lines 727-745, 684)

**문제:** dt 기반 시간 전진이 실제 비디오 재생과 독립적. 0.3초 threshold가 누적 드리프트 허용.

**수정:** threshold를 0.05초로 줄이고 비디오 stall 감지 시 playbackTime 동결.

#### BUG-P4: iOS에서 다중 Audio 엘리먼트 동시 재생 제한 (lines 713-724)

**문제:** iOS Safari는 동시 Audio 엘리먼트 수 제한. 여러 오디오 트랙 겹치면 일부 누락.

**수정:** Web Audio API AudioBufferSourceNode로 전환하여 단일 AudioContext에서 믹싱.

### 1.2 익스포트 버그 (script.js)

#### BUG-E1 [CRITICAL]: 오디오 트랙이 익스포트에 포함 안 됨 (lines 1062-1074)

**문제:** `elements.mainVideo`의 오디오만 캡처. audioPool 클립들은 연결 안 됨.

**수정:** ffmpeg.wasm 익스포트로 교체하여 모든 오디오 트랙을 필터 그래프로 정확히 믹싱.

#### BUG-E2 [CRITICAL]: createMediaElementSource 중복 호출 (line 1066)

**문제:** 두 번째 익스포트부터 `InvalidStateError` → catch로 조용히 실패 → 소리 없음.

**수정:** ffmpeg.wasm 익스포트로 교체 시 자동 해결 (MediaElementSource 사용 안 함).

#### BUG-E3: iOS Safari MediaRecorder 코덱 지원 부족 (lines 1077-1086)

**문제:** iOS Safari MediaRecorder는 mp4/webm 코덱 제한적 → 빈 파일 생성.

**수정:** ffmpeg.wasm으로 교체. H.264 + AAC 직접 인코딩.

#### BUG-E4: 캔버스에 빈 프레임 그려짐 (lines 1161-1181)

**문제:** 비디오 프레임 미로딩 상태에서 canvas drawImage → 검은 프레임.

**수정:** ffmpeg.wasm이 원본 파일에서 직접 프레임 추출하므로 문제 없음.

#### BUG-E5: 메모리 부족 (OOM) 위험 (line 1090)

**문제:** timeslice 없이 전체 영상 메모리 버퍼링 → 긴 영상 OOM.

**수정:** ffmpeg.wasm은 스트리밍 인코딩으로 메모리 사용량 일정.

---

## Part 2: ffmpeg.wasm 통합 — MediaRecorder 교체

### 2.1 아키텍처

```
┌──────────────────────────────────────────┐
│          UhCut (Capacitor WebView)        │
│                                          │
│  메인 스레드                               │
│  ├─ UI / 타임라인 / 프리뷰                 │
│  ├─ AudioContext (프리뷰 재생용)           │
│  └─ ffmpeg 워커 통신                      │
│                                          │
│  Web Worker: ffmpeg.wasm                  │
│  ├─ 비디오 디코딩/인코딩 (H.264, AAC)      │
│  ├─ 다중 오디오 트랙 믹싱 (amix 필터)      │
│  ├─ 클립 컨캣/트림 (concat, trim 필터)    │
│  └─ 진행률 콜백 → 메인 스레드              │
│                                          │
│  서버: 없음                               │
└──────────────────────────────────────────┘
```

### 2.2 설치

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/util
```

### 2.3 익스포트 파이프라인 (새로운 방식)

```js
// www/export-worker.js (Web Worker)
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const ffmpeg = new FFmpeg();
await ffmpeg.load();

// 진행률 콜백
ffmpeg.on('progress', ({ progress }) => {
    self.postMessage({ type: 'progress', value: progress });
});

self.onmessage = async ({ data }) => {
    const { mediaFiles, timeline, outputConfig } = data;

    // 1. 미디어 파일을 가상 파일시스템에 쓰기
    for (const [name, blob] of Object.entries(mediaFiles)) {
        await ffmpeg.writeFile(name, await fetchFile(blob));
    }

    // 2. 타임라인 기반 FFmpeg 필터 그래프 생성
    const { args } = buildFFmpegCommand(timeline, outputConfig);

    // 3. 인코딩 실행
    await ffmpeg.exec(args);

    // 4. 결과 읽기
    const output = await ffmpeg.readFile('output.mp4');
    self.postMessage({ type: 'done', data: output }, [output.buffer]);
};

function buildFFmpegCommand(timeline, config) {
    const inputs = [];
    const filterParts = [];
    let inputIdx = 0;

    // 비디오 클립 입력
    for (const clip of timeline.video) {
        inputs.push('-i', clip.fileName);
        filterParts.push(
            `[${inputIdx}:v]trim=start=${clip.offset}:duration=${clip.duration},setpts=PTS-STARTPTS[v${inputIdx}]`
        );
        inputIdx++;
    }

    // 오디오 클립 입력
    for (const track of timeline.audio) {
        for (const clip of track) {
            if (clip.muted) continue;
            inputs.push('-i', clip.fileName);
            filterParts.push(
                `[${inputIdx}:a]atrim=start=${clip.offset}:duration=${clip.duration},` +
                `adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)},` +
                `asetpts=PTS-STARTPTS[a${inputIdx}]`
            );
            inputIdx++;
        }
    }

    // concat + amix
    const videoStreams = timeline.video.map((_, i) => `[v${i}]`).join('');
    const audioInputs = /* ... collect non-muted audio stream labels ... */;

    const filter = filterParts.join('; ') +
        `; ${videoStreams}concat=n=${timeline.video.length}:v=1:a=0[vout]` +
        `; ${audioInputs}amix=inputs=${audioCount}[aout]`;

    return {
        args: [
            ...inputs,
            '-filter_complex', filter,
            '-map', '[vout]', '-map', '[aout]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', 'output.mp4'
        ]
    };
}
```

### 2.4 기존 setupExport() 교체

기존 MediaRecorder 기반 `setupExport()` (lines 1048-1192)를 ffmpeg.wasm 기반으로 완전 교체:

```js
async function setupExport() {
    const modal = elements.exportModal;
    modal.style.display = 'flex';

    const progress = modal.querySelector('.export-progress');
    const saveBtn = modal.querySelector('#save-video-btn');

    progress.textContent = 'FFmpeg 로딩 중...';

    // Web Worker 시작
    const worker = new Worker('export-worker.js', { type: 'module' });

    // 미디어 파일 수집
    const mediaFiles = {};
    for (const m of state.media) {
        const resp = await fetch(m.url);
        mediaFiles[m.id + getExt(m.name)] = await resp.blob();
    }

    // 타임라인 데이터 직렬화
    const timeline = {
        video: state.tracks.video.map(clip => ({
            fileName: clip.mediaId + getExt(findMedia(clip.mediaId).name),
            offset: clip.offset,
            duration: clip.duration,
            startTime: clip.startTime,
            stabilized: !!clip.stabilized
        })),
        audio: state.tracks.audio.map(track =>
            track.map(clip => ({
                fileName: clip.mediaId + getExt(findMedia(clip.mediaId).name),
                offset: clip.offset,
                duration: clip.duration,
                startTime: clip.startTime,
                muted: !!clip.muted
            }))
        )
    };

    worker.postMessage({ mediaFiles, timeline, outputConfig: { width: 1280, height: 720 } });

    worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
            progress.textContent = `인코딩 중... ${Math.round(data.value * 100)}%`;
        }
        if (data.type === 'done') {
            const blob = new Blob([data.data], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);

            saveBtn.style.display = 'block';
            saveBtn.onclick = () => {
                if (navigator.share) {
                    navigator.share({ files: [new File([blob], 'uhcut-export.mp4', { type: 'video/mp4' })] });
                } else {
                    const a = document.createElement('a');
                    a.href = url; a.download = 'uhcut-export.mp4'; a.click();
                }
            };
            progress.textContent = '완료!';
            worker.terminate();
        }
    };
}
```

### 2.5 해결되는 버그

| 버그 | ffmpeg.wasm으로 해결 | 이유 |
|------|---------------------|------|
| BUG-E1 (오디오 누락) | O | amix 필터로 모든 트랙 정확히 믹싱 |
| BUG-E2 (중복 호출) | O | MediaElementSource 사용 안 함 |
| BUG-E3 (iOS 코덱) | O | libx264 + aac 직접 인코딩 |
| BUG-E4 (빈 프레임) | O | 원본 파일에서 직접 디코딩 |
| BUG-E5 (OOM) | O | 스트리밍 인코딩 |

---

## Part 3: GitHub Actions — 안드로이드 & iOS 자동 테스트

### 3.1 현재 CI/CD 상태

- `ios-deploy.yml`: 빌드 → TestFlight 업로드만 수행
- 테스트 0개
- Android 빌드 파이프라인 없음

### 3.2 필요한 워크플로우 구성

```
.github/workflows/
├── ios-deploy.yml          # 기존 (iOS 빌드 + TestFlight)
├── android-deploy.yml      # NEW: Android 빌드 + Play Store
├── test-unit.yml           # NEW: JavaScript 유닛 테스트
├── test-ios-e2e.yml        # NEW: iOS 시뮬레이터 E2E 테스트
├── test-android-e2e.yml    # NEW: Android 에뮬레이터 E2E 테스트
└── pr-check.yml            # NEW: PR 시 전체 검증
```

### 3.3 워크플로우 상세 설계

#### WF-1: JavaScript 유닛 테스트 (`test-unit.yml`)

```yaml
name: Unit Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - run: npm test
```

**사전 작업:** script.js 모듈화 + Vitest 도입

#### WF-2: iOS E2E 테스트 (`test-ios-e2e.yml`)

```yaml
name: iOS E2E Tests
on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  ios-e2e:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci
      - run: npx cap sync ios

      # 시뮬레이터 빌드 (서명 불필요)
      - name: Build for Simulator
        run: |
          xcodebuild build-for-testing \
            -workspace ios/App/App.xcworkspace \
            -scheme App \
            -sdk iphonesimulator \
            -destination "platform=iOS Simulator,name=iPhone 16"

      # Appium + WebDriverIO E2E
      - name: Run E2E Tests
        run: |
          npx appium &
          sleep 5
          npx wdio run tests/e2e/wdio.ios.conf.js

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ios-e2e-results
          path: tests/e2e/results/
```

#### WF-3: Android E2E 테스트 (`test-android-e2e.yml`)

```yaml
name: Android E2E Tests
on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  android-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - run: npm ci
      - run: npx cap add android && npx cap sync android

      - name: Android Emulator + E2E
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          profile: Pixel 7
          script: |
            cd android && ./gradlew assembleDebug
            adb install app/build/outputs/apk/debug/app-debug.apk
            npx appium &
            sleep 5
            npx wdio run tests/e2e/wdio.android.conf.js

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: android-e2e-results
          path: tests/e2e/results/
```

#### WF-4: Android 빌드 & 배포 (`android-deploy.yml`)

```yaml
name: Android Build & Deploy
on:
  push:
    branches: [main, master]
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - run: npm ci
      - run: npx cap sync android

      - name: Build Release Bundle
        run: cd android && ./gradlew bundleRelease

      - name: Sign AAB
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > keystore.jks
          jarsigner -keystore keystore.jks \
            -storepass "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}" \
            -keypass "${{ secrets.ANDROID_KEY_PASSWORD }}" \
            android/app/build/outputs/bundle/release/app-release.aab \
            "${{ secrets.ANDROID_KEY_ALIAS }}"

      - name: Upload to Play Store
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_STORE_SERVICE_ACCOUNT }}
          packageName: com.uhcut.app
          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
          track: internal
```

#### WF-5: PR 통합 검증 (`pr-check.yml`)

```yaml
name: PR Check
on:
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    uses: ./.github/workflows/test-unit.yml
  ios-e2e:
    needs: unit-tests
    uses: ./.github/workflows/test-ios-e2e.yml
  android-e2e:
    needs: unit-tests
    uses: ./.github/workflows/test-android-e2e.yml

  status:
    needs: [unit-tests, ios-e2e, android-e2e]
    runs-on: ubuntu-latest
    steps:
      - run: echo "All checks passed"
```

### 3.4 테스트 프레임워크 구성

```
uhcut/
├── tests/
│   ├── unit/
│   │   ├── vitest.config.js
│   │   ├── timeline.test.js
│   │   ├── collision.test.js
│   │   ├── silence.test.js
│   │   └── state.test.js
│   │
│   ├── e2e/
│   │   ├── wdio.ios.conf.js
│   │   ├── wdio.android.conf.js
│   │   ├── specs/
│   │   │   ├── app-launch.spec.js
│   │   │   ├── media-import.spec.js
│   │   │   ├── timeline-edit.spec.js
│   │   │   ├── playback.spec.js
│   │   │   └── export.spec.js
│   │   └── fixtures/
│   │       ├── test-video-5s.mp4
│   │       └── test-audio-3s.wav
│   │
│   └── integration/
│       └── export-flow.test.js
```

---

## Part 4: 전체 구현 로드맵

### Phase 1: 프리뷰 버그 수정

| 단계 | 작업 | 파일 | 우선순위 |
|------|------|------|----------|
| 1-1 | AudioContext lazy 초기화 + resume | script.js:37 | P0 |
| 1-2 | 썸네일 캐시 도입 + 파괴-재생성 루프 수정 | script.js:468-623 | P0 |
| 1-3 | 동기화 드리프트 threshold 수정 | script.js:684, 727-745 | P1 |
| 1-4 | iOS 오디오 AudioBufferSourceNode 전환 | script.js:713-724 | P2 |

### Phase 2: ffmpeg.wasm 익스포트 교체

| 단계 | 작업 |
|------|------|
| 2-1 | @ffmpeg/ffmpeg, @ffmpeg/util 설치 |
| 2-2 | export-worker.js 작성 (Web Worker + ffmpeg 파이프라인) |
| 2-3 | 타임라인 → FFmpeg 필터 그래프 변환 로직 구현 |
| 2-4 | setupExport() 교체 (MediaRecorder → Worker 통신) |
| 2-5 | 진행률 UI 연동 |
| 2-6 | Share API / 다운로드 연동 |

### Phase 3: 코드 모듈화 & 테스트

| 단계 | 작업 |
|------|------|
| 3-1 | 빌드 시스템 도입 (Vite) — ffmpeg.wasm이 ES module이므로 필요 |
| 3-2 | script.js를 모듈로 분리 (timeline, playback, export, tools) |
| 3-3 | Vitest 설치 및 유닛 테스트 작성 |
| 3-4 | GitHub Actions test-unit.yml 추가 |

### Phase 4: Android 지원 + CI/CD

| 단계 | 작업 |
|------|------|
| 4-1 | Capacitor Android 플랫폼 추가 |
| 4-2 | Android 빌드/서명 설정 |
| 4-3 | android-deploy.yml 워크플로우 작성 |
| 4-4 | Appium + WebDriverIO E2E 테스트 설정 |
| 4-5 | test-ios-e2e.yml, test-android-e2e.yml 작성 |
| 4-6 | pr-check.yml 통합 검증 워크플로우 |

---

## 부록: 기술 결정 사항

### npm 의존성 추가

```json
{
  "dependencies": {
    "@ffmpeg/ffmpeg": "^0.12",
    "@ffmpeg/util": "^0.12"
  },
  "devDependencies": {
    "vite": "^6",
    "vitest": "^3",
    "@wdio/cli": "^9",
    "appium": "^2"
  }
}
```

### GitHub Secrets 추가 필요

**Android 배포용:**
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `PLAY_STORE_SERVICE_ACCOUNT`

### GitHub Actions 사용량

- iOS E2E: macOS 러너 ~15분/실행 (10x 요금)
- Android E2E: Ubuntu 러너 ~10분/실행 (1x 요금)
- Unit Tests: Ubuntu 러너 ~2분/실행
