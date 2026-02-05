# UhCut 실행 계획: 버그 수정 + Julia 통합 + CI/CD 자동 테스트

---

## Part 1: 프리뷰 & 익스포트 버그 분석

### 1.1 프리뷰 버그 (script.js)

#### BUG-P1: AudioContext 자동 생성 정책 위반 (line 37)

```js
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
```

**문제:** 페이지 로드 시점에 AudioContext를 생성하면 iOS Safari와 대부분의 모바일 브라우저에서 `suspended` 상태로 시작됨. 사용자 제스처(탭, 클릭) 없이는 오디오가 재생되지 않음.

**증상:** 오디오 클립이 타임라인에 있어도 소리가 안 남. 웨이브폼은 보이지만 재생 시 무음.

**수정 방향:**
- AudioContext 생성을 첫 번째 사용자 인터랙션까지 지연
- `audioCtx.resume()`을 play 버튼 클릭 핸들러에 추가
- 녹음 시작 시에만 `resume()` 호출하는 현재 코드(line 814)로는 불충분

#### BUG-P2 [CRITICAL]: 클립 썸네일 생성-파괴 무한 루프 (lines 468-623)

**관련 코드:**
- `renderClipContent()` (line 468): `el.innerHTML = ''`로 매번 전체 내용 초기화
- `drawThumbnails()` (line 551): 초기화 후 다시 큐에 넣기
- `processThumbQueue()` (line 580): 큐 처리 로직

**문제 (5가지 복합 버그):**

1. **썸네일 파괴-재생성 루프**: `renderTimeline()`이 호출될 때마다 (코드 내 15곳 이상)
   `renderClipContent` → `el.innerHTML = ''` → 기존 썸네일 전부 삭제 → `drawThumbnails`로
   다시 큐에 넣기. 썸네일이 뜨기도 전에 지워지고 다시 요청되는 루프 발생.

2. **큐 프루닝으로 대부분 유실**: `thumbQueue.length > 30`이면 마지막 10개만 남기고 삭제.
   파괴-재생성 루프 때문에 큐가 빠르게 쌓여 앞쪽 클립 썸네일은 영원히 미생성.

3. **캐시 미존재**: 웨이브폼은 `waveformCache`로 캐싱하지만 썸네일은 캐시 없음.
   같은 비디오 같은 프레임을 반복적으로 seek → capture.

4. **재생 중 생성 중단 + 끝나면 파괴**: `state.isPlaying`이면 큐 처리 중단.
   재생 끝나면 `renderTimeline()` → `el.innerHTML = ''`로 삭제 → 처음부터 다시.

5. **seeked 이벤트 리스너 누수**: safety check에서 `onSeek()` 직접 호출 시
   line 612의 `seeked` 리스너가 제거되지 않아 다음 썸네일 seek 시
   이전 리스너가 잘못된 엘리먼트에 그림을 그림.

**증상:** 클립 썸네일이 빈 칸으로 남거나, 잠깐 보였다가 사라지거나, 잘못된 프레임이 표시됨.

**수정 방향:**
- 썸네일 캐시 도입 (mediaId + time → dataURL 맵)
- `renderClipContent`에서 props 변경 없으면 내용 보존 (innerHTML 초기화 금지)
- safety check 경로에서 기존 이벤트 리스너 제거
- 큐 프루닝 전략 개선 (FIFO 대신 우선순위 기반)
- 재생 후 캐시된 썸네일 즉시 복원

#### BUG-P3: 비디오/오디오 동기화 드리프트 (lines 727-745, 684)

```js
// renderLoop에서 dt 기반으로 시간 전진
state.playbackTime += dt;

// syncMedia에서 0.3초 이상 차이날 때만 보정
if (Math.abs(v.currentTime - clipTime) > 0.3) v.currentTime = clipTime;
```

**문제:** `requestAnimationFrame`의 dt 기반 시간 전진은 실제 비디오 재생 시간과 독립적. 비디오가 버퍼링/스톨하면 playbackTime은 계속 전진하지만 비디오는 멈춤. 0.3초 threshold가 누적 드리프트를 허용함.

**증상:** 재생하면 오디오와 비디오가 점점 어긋남. 특히 긴 클립에서 심해짐.

**수정 방향:**
- 비디오의 `timeupdate` 이벤트를 기반으로 시간 동기화
- threshold를 0.1초로 줄이거나 비디오 currentTime을 master clock으로 사용
- Web Audio API의 `currentTime`을 master clock으로 사용하는 방식 검토

#### BUG-P4: iOS에서 다중 Audio 엘리먼트 동시 재생 제한 (lines 713-724)

```js
a = new Audio(media.url);
audioPool[clip.id] = a;
```

**문제:** iOS Safari는 동시에 재생할 수 있는 Audio 엘리먼트 수에 제한이 있음 (보통 1개). 여러 오디오 클립이 겹치면 일부만 재생됨.

**증상:** 오디오 트랙 2개 이상이 동시에 재생될 때 일부 트랙 소리가 안 남.

**수정 방향:**
- Web Audio API의 AudioBufferSourceNode를 사용하여 모든 오디오를 단일 AudioContext에서 믹싱
- 오디오 풀을 AudioBuffer 기반으로 전환

---

### 1.2 익스포트 버그 (script.js)

#### BUG-E1 [CRITICAL]: 오디오 트랙이 익스포트에 포함 안 됨 (lines 1062-1074)

```js
const dest = audioCtx.createMediaStreamDestination();
try {
    const src = audioCtx.createMediaElementSource(elements.mainVideo);
    src.connect(dest);
    src.connect(audioCtx.destination);
} catch(e) {}
```

**문제:** 익스포트 시 `elements.mainVideo` (비디오 엘리먼트)의 오디오만 캡처됨. `audioPool`의 Audio 엘리먼트들(오디오 전용 클립)은 `MediaStreamDestination`에 연결되지 않음. 별도 오디오 트랙의 소리가 익스포트 결과에 완전히 누락.

**증상:** 익스포트된 영상에서 별도로 추가한 배경음악/녹음/오디오 파일의 소리가 없음. 비디오 클립 자체의 오디오만 들림.

**수정 방향:**
- 모든 활성 오디오 클립의 Audio 엘리먼트도 `createMediaElementSource`로 연결
- 또는 Web Audio API의 AudioBufferSourceNode로 통합 믹싱 후 dest에 연결
- GainNode를 사용하여 muted 상태도 정확히 반영

#### BUG-E2 [CRITICAL]: createMediaElementSource 중복 호출 (line 1066)

```js
const src = audioCtx.createMediaElementSource(elements.mainVideo);
```

**문제:** 한 Media Element에 `createMediaElementSource`를 두 번 이상 호출하면 `InvalidStateError` 발생. 첫 익스포트 후 두 번째 익스포트 시도 시 `catch(e) {}`로 조용히 실패하여 오디오 캡처가 아예 안 됨.

**증상:** 두 번째 익스포트부터 영상에 소리가 전혀 없음.

**수정 방향:**
- MediaElementSource를 한 번만 생성하고 전역에 캐시
- 또는 익스포트 시 새로운 비디오 엘리먼트를 생성하여 사용

#### BUG-E3: iOS Safari MediaRecorder 코덱 지원 부족 (lines 1077-1086)

```js
const exportTypes = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm'
];
```

**문제:** iOS Safari의 MediaRecorder는 제한적 지원. `video/mp4` 코덱은 대부분의 iOS 버전에서 지원되지 않으며, `video/webm`도 iOS 17 이전에는 미지원. 모든 타입이 실패하면 기본값(코덱 미지정)으로 시도하지만 이마저도 실패할 수 있음.

**증상:** iOS에서 익스포트 버튼 누르면 아무것도 안 되거나, 빈 파일이 생성됨.

**수정 방향:**
- iOS에서는 canvas + MediaRecorder 대신 서버사이드 인코딩 고려
- 또는 ffmpeg.wasm을 사용한 클라이언트 사이드 인코딩
- WebCodecs API 지원 여부 확인 후 대안 경로 추가

#### BUG-E4: 캔버스에 빈 프레임 그려짐 (lines 1161-1181)

```js
ctx.drawImage(elements.mainVideo, 0, 0, canvas.width, canvas.height);
```

**문제:** `recLoop`에서 비디오 프레임을 캔버스에 그릴 때, 비디오가 아직 해당 프레임을 로드/디코딩하지 못했으면 빈(검은) 프레임이 그려짐. `syncMedia()`가 `renderLoop`에서 비동기적으로 호출되므로 비디오 seek와 canvas draw 사이에 타이밍 갭 존재.

**증상:** 익스포트된 영상에 검은 프레임이 간헐적으로 나타남. 특히 클립 전환 지점에서.

**수정 방향:**
- `video.requestVideoFrameCallback()` API 사용하여 프레임 준비 시점에 그리기
- 또는 프레임별 seek 후 `seeked` 이벤트 대기 방식으로 전환 (실시간이 아닌 프레임 정확 인코딩)

#### BUG-E5: 메모리 부족 (OOM) 위험 (line 1090)

```js
recorder.ondataavailable = e => chunks.push(e.data);
```

**문제:** `recorder.start()`에 timeslice 파라미터가 없어 `stop()` 호출 시에만 `ondataavailable` 발생. 전체 영상이 메모리에 누적됨. 모바일 기기에서 긴 영상 익스포트 시 메모리 부족으로 크래시.

**증상:** 3분 이상 영상 익스포트 시 앱이 멈추거나 크래시.

**수정 방향:**
- `recorder.start(1000)` 등 timeslice 사용하여 주기적 데이터 방출
- IndexedDB나 OPFS를 사용한 청크별 저장 고려

---

## Part 2: Julia 통합 — 컴퓨팅 인텐시브 처리 향상

### 2.1 아키텍처 설계

```
┌─────────────────────────────────┐
│     UhCut Mobile App (Web)      │
│  ┌───────────────────────────┐  │
│  │   UI / Timeline / Preview │  │
│  └──────────┬────────────────┘  │
│             │ HTTP/WebSocket     │
│  ┌──────────▼────────────────┐  │
│  │   Julia Processing Server │  │
│  │  (로컬 또는 클라우드)       │  │
│  │  ┌─────────────────────┐  │  │
│  │  │ Video Stabilization │  │  │
│  │  │ Audio Analysis      │  │  │
│  │  │ Silence Detection   │  │  │
│  │  │ Video Transcoding   │  │  │
│  │  │ Thumbnail Gen       │  │  │
│  │  │ Waveform Render     │  │  │
│  │  │ Export Encoding     │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 2.2 Julia로 옮길 작업 목록 (우선순위순)

#### JULIA-1: 실제 비디오 스태빌라이제이션 (현재: 시뮬레이션)

**현재 상태:** `stabilizeClip()` (line 833-850)은 그냥 `clip.stabilized = true` 플래그만 설정하고, 익스포트 시 `scale(1.1)`로 10% 줌만 함. 실제 모션 보정 없음.

**Julia 구현 계획:**
```
패키지: Images.jl, VideoIO.jl, OpticalFlow.jl (또는 OpenCV.jl)

1. 입력: 비디오 파일 (blob → 서버 업로드)
2. 프레임별 optical flow 계산 (Lucas-Kanade 또는 Farneback)
3. 누적 모션 벡터 계산
4. Kalman 필터 또는 Moving Average로 smooth trajectory 생성
5. 프레임별 affine transform 적용
6. 출력: 스태빌라이즈된 비디오 파일
```

**성능 기대:** Julia의 SIMD 최적화 + GPU 가속으로 Python 대비 5-20x 성능 향상 가능.

#### JULIA-2: 고급 오디오 분석 및 묵음 제거 (현재: 단순 amplitude threshold)

**현재 상태:** `removeSilenceTool()` (line 945-1046)은 amplitude threshold 기반 단순 검출. 100 샘플 단위로 스캔하여 정밀도 낮음.

**Julia 구현 계획:**
```
패키지: DSP.jl, WAV.jl, FFTW.jl

1. 오디오 버퍼를 Julia로 전송
2. STFT 기반 스펙트로그램 분석
3. VAD (Voice Activity Detection) 구현
   - Energy-based + Zero-crossing rate
   - 또는 간단한 ML 모델 (Flux.jl)
4. 음성 구간 경계를 JSON으로 반환
5. 프론트엔드에서 클립 분할
```

**성능 기대:** FFTW.jl은 C의 FFTW 래핑으로 최적 성능. 실시간 처리 가능.

#### JULIA-3: 서버사이드 비디오 익스포트/인코딩

**현재 상태:** 브라우저 MediaRecorder API 의존. iOS 호환성 문제, 코덱 제한, 메모리 부족.

**Julia 구현 계획:**
```
패키지: FFMPEG.jl, VideoIO.jl

1. 타임라인 데이터(클립 목록, 시작시간, duration, offset)를 JSON으로 전송
2. 원본 미디어 파일 업로드
3. Julia에서 FFmpeg 파이프라인 구성:
   - 비디오 컨캣/트림/크롭
   - 오디오 믹싱 (여러 트랙 합성)
   - H.264/H.265 인코딩
   - 스태빌라이제이션 적용
4. 인코딩된 파일을 클라이언트로 스트리밍 반환
```

**핵심 이점:**
- iOS MediaRecorder 호환성 문제 완전 해결
- 모든 오디오 트랙 정확히 믹싱 (BUG-E1 해결)
- 메모리 제한 없음 (스트리밍 방식)
- 고품질 코덱 (H.265, AAC) 사용 가능

#### JULIA-4: 웨이브폼 & 썸네일 일괄 생성

**현재 상태:** 웨이브폼은 Web Audio API로 실시간 생성 (line 499-544). 썸네일은 숨겨진 video 엘리먼트의 seek로 하나씩 생성 (line 546-623).

**Julia 구현 계획:**
```
패키지: WAV.jl, VideoIO.jl, Images.jl

웨이브폼:
1. 오디오 파일 업로드
2. PCM 디코딩 + peak 분석
3. 지정된 width의 amplitude 배열 반환 (JSON)
4. 프론트엔드에서 Canvas에 직접 그리기

썸네일:
1. 비디오 파일 업로드
2. 지정된 시간 포인트들에서 프레임 추출
3. 리사이즈 (160x90)
4. Base64 또는 WebP로 일괄 반환
```

### 2.3 Julia 서버 구성

```
uhcut/
├── server/
│   ├── Project.toml          # Julia 패키지 의존성
│   ├── Manifest.toml
│   ├── src/
│   │   ├── UhCutServer.jl    # 메인 모듈
│   │   ├── api.jl            # HTTP 라우터 (Genie.jl 또는 Oxygen.jl)
│   │   ├── stabilizer.jl     # 비디오 스태빌라이제이션
│   │   ├── audio.jl          # 오디오 분석/VAD
│   │   ├── encoder.jl        # 비디오 인코딩 (FFMPEG.jl)
│   │   ├── thumbnails.jl     # 썸네일 생성
│   │   └── waveform.jl       # 웨이브폼 데이터 생성
│   ├── test/
│   │   ├── runtests.jl
│   │   ├── test_stabilizer.jl
│   │   ├── test_audio.jl
│   │   └── test_encoder.jl
│   └── Dockerfile            # Julia 서버 컨테이너
```

**HTTP API 엔드포인트:**

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/stabilize` | 비디오 스태빌라이제이션 (파일 업로드 → 처리된 파일 반환) |
| POST | `/api/analyze-audio` | 오디오 분석 + 묵음 구간 감지 |
| POST | `/api/export` | 타임라인 기반 비디오 인코딩 |
| POST | `/api/thumbnails` | 비디오 썸네일 일괄 생성 |
| POST | `/api/waveform` | 오디오 웨이브폼 데이터 생성 |
| GET  | `/api/health` | 서버 상태 확인 |

**기술 스택:**
- HTTP 서버: `Oxygen.jl` (경량, 비동기) 또는 `Genie.jl` (풀스택)
- 비디오: `VideoIO.jl` + `FFMPEG.jl`
- 이미지: `Images.jl`
- 오디오: `WAV.jl` + `DSP.jl` + `FFTW.jl`
- 작업 큐: `@async` / `Threads.@spawn` 또는 외부 큐 (Redis)

### 2.4 프론트엔드 ↔ Julia 서버 통신 흐름

```
[사용자: Stabilize 클릭]
    │
    ▼
[프론트엔드: 비디오 blob을 FormData로 POST /api/stabilize]
    │
    ▼
[Julia 서버: optical flow 계산 → 모션 보정 → 인코딩]
    │ (SSE로 진행률 전송)
    ▼
[프론트엔드: 처리된 비디오 URL 수신 → state.media에 추가]
    │
    ▼
[클립의 mediaId를 새 비디오로 교체]
```

```
[사용자: Export 클릭]
    │
    ▼
[프론트엔드: 타임라인 JSON + 미디어 파일들을 POST /api/export]
    │
    │  {
    │    "timeline": {
    │      "video": [{ mediaId, startTime, duration, offset, stabilized }],
    │      "audio": [[{ mediaId, startTime, duration, offset, muted }], [...]]
    │    },
    │    "output": { "width": 1920, "height": 1080, "fps": 30, "codec": "h264" }
    │  }
    │
    ▼
[Julia 서버: FFmpeg 파이프라인 구성 → 인코딩]
    │ (SSE로 진행률 전송)
    ▼
[프론트엔드: 완성된 비디오 다운로드 → Share API / 다운로드]
```

---

## Part 3: GitHub Actions — 안드로이드 & iOS 자동 테스트

### 3.1 현재 CI/CD 상태

- `ios-deploy.yml`: 빌드 → TestFlight 업로드만 수행
- 테스트 0개 (unit test, E2E test 모두 없음)
- Android 빌드 파이프라인 없음

### 3.2 필요한 워크플로우 구성

```
.github/workflows/
├── ios-deploy.yml          # 기존 (iOS 빌드 + TestFlight)
├── android-deploy.yml      # NEW: Android 빌드 + Play Store
├── test-unit.yml           # NEW: JavaScript 유닛 테스트
├── test-ios-e2e.yml        # NEW: iOS 시뮬레이터 E2E 테스트
├── test-android-e2e.yml    # NEW: Android 에뮬레이터 E2E 테스트
├── test-julia.yml          # NEW: Julia 서버 테스트
└── pr-check.yml            # NEW: PR 시 전체 검증
```

### 3.3 워크플로우 상세 설계

#### WF-1: JavaScript 유닛 테스트 (`test-unit.yml`)

```yaml
# 트리거: 모든 push, PR
# 러너: ubuntu-latest
# 내용:
#   1. Vitest 또는 Jest 설치
#   2. script.js의 핵심 로직 테스트:
#      - 타임라인 클립 추가/삭제/분할
#      - 충돌 감지 (checkCollision)
#      - 묵음 제거 로직 (threshold 계산)
#      - 줌/스크롤 계산
#      - 상태 관리 (undo/redo)
#   3. 커버리지 리포트 생성
```

**사전 작업:**
- `script.js`를 모듈화하여 테스트 가능한 구조로 리팩토링
- 순수 함수(계산 로직)를 DOM 조작 로직과 분리
- `package.json`에 Vitest 의존성 추가

#### WF-2: iOS E2E 테스트 (`test-ios-e2e.yml`)

```yaml
# 트리거: PR to main, 수동 dispatch
# 러너: macos-latest (Apple Silicon)
# 내용:

steps:
  # 1. 환경 설정
  - Checkout
  - Node.js 20 설치
  - npm ci
  - npx cap sync ios

  # 2. iOS 시뮬레이터 부팅
  - xcrun simctl boot "iPhone 16"  # 또는 최신 시뮬레이터
  - xcrun simctl bootstatus "iPhone 16" -b  # 부팅 대기

  # 3. 앱 빌드 (시뮬레이터용, 시그니처 불필요)
  - xcodebuild build
      -workspace ios/App/App.xcworkspace
      -scheme App
      -sdk iphonesimulator
      -destination "platform=iOS Simulator,name=iPhone 16"
      -configuration Debug

  # 4. 앱 설치 & 실행
  - xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/App.app
  - xcrun simctl launch booted com.uhcut.app

  # 5. E2E 테스트 실행
  #    옵션 A: XCUITest (Swift 기반)
  #    옵션 B: Detox (JS 기반, React Native 친화적이지만 Capacitor에도 사용 가능)
  #    옵션 C: Appium (크로스 플랫폼)
  #    권장: Appium + WebDriverIO (Capacitor WebView 테스트 최적)

  - npx appium &
  - npx wdio run wdio.ios.conf.js

  # 6. 테스트 시나리오
  #    - 앱 실행 확인
  #    - 미디어 파일 추가 (테스트 비디오/오디오 파일)
  #    - 타임라인에 클립 표시 확인
  #    - 재생/일시정지 동작 확인
  #    - 클립 분할 기능 확인
  #    - 익스포트 시작 및 완료 확인
  #    - 스크린샷 비교 (optional)

  # 7. 결과 업로드
  - actions/upload-artifact로 테스트 결과 + 스크린샷 저장
```

#### WF-3: Android E2E 테스트 (`test-android-e2e.yml`)

```yaml
# 트리거: PR to main, 수동 dispatch
# 러너: ubuntu-latest (또는 macos-latest for HAXM)
# 내용:

steps:
  # 1. 환경 설정
  - Checkout
  - Node.js 20 설치
  - Java 17 설치 (Android SDK 필요)
  - npm ci

  # 2. Android 프로젝트 초기화 (현재 없으므로 생성 필요)
  - npx cap add android
  - npx cap sync android

  # 3. Android 에뮬레이터 설정
  #    reactivecircus/android-emulator-runner 액션 사용
  - uses: reactivecircus/android-emulator-runner@v2
    with:
      api-level: 34
      target: google_apis
      arch: x86_64
      profile: Pixel 7
      script: |
        # 4. 앱 빌드
        cd android
        ./gradlew assembleDebug

        # 5. 앱 설치
        adb install app/build/outputs/apk/debug/app-debug.apk

        # 6. E2E 테스트 실행
        npx appium &
        sleep 5
        npx wdio run wdio.android.conf.js

  # 7. 결과 업로드
  - actions/upload-artifact
```

**Android 사전 작업:**
- `npx cap add android` 로 Android 프로젝트 생성
- `capacitor.config.json`에 Android 설정 추가
- Gradle 빌드 설정 확인

#### WF-4: Julia 서버 테스트 (`test-julia.yml`)

```yaml
# 트리거: server/ 디렉토리 변경 시
# 러너: ubuntu-latest
# 내용:

steps:
  # 1. Julia 설치
  - uses: julia-actions/setup-julia@v2
    with:
      version: '1.11'

  # 2. 의존성 설치
  - uses: julia-actions/cache@v2
  - run: julia --project=server -e 'using Pkg; Pkg.instantiate()'

  # 3. 시스템 의존성 (FFmpeg)
  - run: sudo apt-get install -y ffmpeg

  # 4. 테스트 실행
  - run: julia --project=server -e 'using Pkg; Pkg.test()'

  # 5. 테스트 항목:
  #    - 비디오 스태빌라이제이션 (작은 테스트 비디오)
  #    - 오디오 분석 (테스트 WAV 파일)
  #    - 묵음 감지 정확도
  #    - 인코딩 출력 검증
  #    - API 엔드포인트 응답
  #    - 에러 핸들링
```

#### WF-5: PR 통합 검증 (`pr-check.yml`)

```yaml
# 트리거: PR to main
# 내용: 위의 모든 테스트를 병렬 실행

jobs:
  unit-tests:        # WF-1
  ios-e2e:           # WF-2 (needs: unit-tests)
  android-e2e:       # WF-3 (needs: unit-tests)
  julia-tests:       # WF-4

  status-check:      # 모든 job 완료 후 최종 상태
    needs: [unit-tests, ios-e2e, android-e2e, julia-tests]
```

#### WF-6: Android 빌드 & 배포 (`android-deploy.yml`)

```yaml
# 트리거: main push, 수동 dispatch
# 러너: ubuntu-latest
# 내용:

steps:
  - Checkout
  - Node.js 20 + Java 17
  - npm ci
  - npx cap sync android

  # 빌드
  - cd android && ./gradlew bundleRelease

  # 서명 (keystore는 secrets에 저장)
  - jarsigner 또는 apksigner

  # Play Store 업로드
  - uses: r0adkll/upload-google-play@v1
    with:
      serviceAccountJsonPlainText: ${{ secrets.PLAY_STORE_SERVICE_ACCOUNT }}
      packageName: com.uhcut.app
      releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
      track: internal  # 내부 테스트 트랙
```

### 3.4 테스트 프레임워크 구성

```
uhcut/
├── tests/
│   ├── unit/
│   │   ├── vitest.config.js
│   │   ├── timeline.test.js      # 타임라인 로직
│   │   ├── collision.test.js     # 충돌 감지
│   │   ├── silence.test.js       # 묵음 제거 알고리즘
│   │   └── state.test.js         # 상태 관리 (undo/redo)
│   │
│   ├── e2e/
│   │   ├── wdio.ios.conf.js      # iOS WebDriverIO 설정
│   │   ├── wdio.android.conf.js  # Android WebDriverIO 설정
│   │   ├── specs/
│   │   │   ├── app-launch.spec.js
│   │   │   ├── media-import.spec.js
│   │   │   ├── timeline-edit.spec.js
│   │   │   ├── playback.spec.js
│   │   │   ├── export.spec.js
│   │   │   └── stabilize.spec.js
│   │   └── fixtures/
│   │       ├── test-video-5s.mp4
│   │       └── test-audio-3s.wav
│   │
│   └── integration/
│       ├── julia-api.test.js     # Julia API 통합 테스트
│       └── export-flow.test.js   # 전체 익스포트 플로우
```

---

## Part 4: 전체 구현 로드맵

### Phase 1: 버그 수정 (프론트엔드)

| 단계 | 작업 | 파일 | 우선순위 |
|------|------|------|----------|
| 1-1 | AudioContext 초기화 수정 | script.js:37 | P0 |
| 1-2 | **클립 썸네일 파괴-재생성 루프 수정 + 캐시 도입** | script.js:468-623 | **P0** |
| 1-3 | 익스포트 오디오 트랙 누락 수정 | script.js:1062-1074 | P0 |
| 1-4 | createMediaElementSource 중복 호출 방지 | script.js:1066 | P0 |
| 1-5 | 프리뷰 동기화 드리프트 수정 | script.js:684, 727-745 | P1 |
| 1-6 | iOS MediaRecorder 호환성 개선 | script.js:1077-1086 | P1 |
| 1-7 | 캔버스 빈 프레임 방지 | script.js:1161-1181 | P1 |
| 1-8 | 메모리 관리 개선 (timeslice) | script.js:1090, 1147 | P2 |
| 1-9 | iOS 다중 Audio 엘리먼트 제한 대응 | script.js:713-724 | P2 |

### Phase 2: 코드 모듈화 & 테스트 기반

| 단계 | 작업 |
|------|------|
| 2-1 | script.js를 ES 모듈로 분리 (timeline.js, playback.js, export.js, tools.js) |
| 2-2 | 빌드 시스템 도입 (Vite 또는 esbuild) |
| 2-3 | Vitest 설치 및 유닛 테스트 작성 |
| 2-4 | GitHub Actions unit test 워크플로우 추가 |

### Phase 3: Julia 서버 구축

| 단계 | 작업 |
|------|------|
| 3-1 | Julia 프로젝트 초기화 (Project.toml, 의존성) |
| 3-2 | HTTP API 서버 구현 (Oxygen.jl) |
| 3-3 | 오디오 분석 + VAD 구현 |
| 3-4 | 비디오 스태빌라이제이션 구현 |
| 3-5 | 서버사이드 인코딩/익스포트 구현 |
| 3-6 | 썸네일 & 웨이브폼 API 구현 |
| 3-7 | Julia 테스트 작성 |
| 3-8 | Docker 컨테이너화 |
| 3-9 | 프론트엔드 API 클라이언트 연동 |

### Phase 4: Android 지원

| 단계 | 작업 |
|------|------|
| 4-1 | Capacitor Android 플랫폼 추가 (`npx cap add android`) |
| 4-2 | Android 빌드 설정 (Gradle, SDK 버전) |
| 4-3 | Android 서명 키 생성 및 Secrets 설정 |
| 4-4 | android-deploy.yml 워크플로우 작성 |
| 4-5 | Android 고유 이슈 대응 (WebView 호환성, 파일 접근 권한) |

### Phase 5: E2E 테스트 파이프라인

| 단계 | 작업 |
|------|------|
| 5-1 | Appium + WebDriverIO 설치 및 설정 |
| 5-2 | 테스트 미디어 파일(fixtures) 생성 |
| 5-3 | iOS E2E 테스트 시나리오 작성 |
| 5-4 | Android E2E 테스트 시나리오 작성 |
| 5-5 | test-ios-e2e.yml 워크플로우 작성 |
| 5-6 | test-android-e2e.yml 워크플로우 작성 |
| 5-7 | PR 통합 검증 워크플로우 (pr-check.yml) 작성 |

### Phase 6: 배포 & 모니터링

| 단계 | 작업 |
|------|------|
| 6-1 | Julia 서버 클라우드 배포 (Fly.io / Railway / AWS) |
| 6-2 | 에러 로깅 추가 (Sentry 또는 자체 로깅) |
| 6-3 | 성능 모니터링 (Julia 서버 메트릭) |
| 6-4 | Android Play Store 내부 테스트 배포 자동화 |

---

## 부록: 기술 결정 사항

### Julia 패키지 의존성

```toml
[deps]
Oxygen = "0.x"          # HTTP 서버
VideoIO = "1.x"         # 비디오 I/O
FFMPEG = "0.x"          # FFmpeg 바인딩
Images = "0.x"          # 이미지 처리
DSP = "0.x"             # 디지털 신호 처리
FFTW = "1.x"            # FFT
WAV = "1.x"             # WAV 파일 I/O
JSON3 = "1.x"           # JSON 파싱
HTTP = "1.x"            # HTTP 클라이언트/서버
```

### GitHub Secrets 추가 필요

**Android 배포용:**
- `ANDROID_KEYSTORE_BASE64` - 릴리스 키스토어
- `ANDROID_KEYSTORE_PASSWORD` - 키스토어 비밀번호
- `ANDROID_KEY_ALIAS` - 키 별칭
- `ANDROID_KEY_PASSWORD` - 키 비밀번호
- `PLAY_STORE_SERVICE_ACCOUNT` - Google Play 서비스 계정 JSON

### 추정 리소스

**GitHub Actions 사용량:**
- iOS E2E: macOS 러너 ~15분/실행 (10x 요금)
- Android E2E: Ubuntu 러너 ~10분/실행 (1x 요금)
- Unit Tests: Ubuntu 러너 ~2분/실행
- Julia Tests: Ubuntu 러너 ~5분/실행

**Julia 서버:**
- 최소 요구: 2 vCPU, 4GB RAM
- 비디오 처리 시: 4+ vCPU, 8GB RAM 권장
- 스토리지: 임시 비디오 파일용 SSD 50GB+
