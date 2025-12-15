# iOS CI/CD Setup Guide (GitHub Actions -> TestFlight)

이 설정 파일들은 GitHub에 코드를 푸시(Push)하면 자동으로 iOS 앱을 빌드하고 TestFlight에 업로드하도록 구성되어 있습니다.
이 과정이 작동하려면 GitHub Repository의 **Settings > Secrets and variables > Actions** 메뉴에 아래의 **Secrets**들을 등록해야 합니다.

## 1. 필요한 파일 준비 (Mac 필요)

### A. Apple Distribution Certificate (p12)
1. Mac의 `Keychain Access` (키체인 접근) 앱을 엽니다.
2. `Apple Distribution` 인증서를 찾습니다 (없으면 Apple Developer 사이트에서 생성 후 다운로드).
3. 인증서와 개인 키를 함께 선택하고 우클릭 -> `Export 2 items...` (내보내기).
4. `build_certificate.p12` 등의 이름으로 저장하고, 암호를 설정합니다 (이 암호는 나중에 씁니다).
5. 터미널에서 다음 명령어로 base64 코드를 복사합니다:
   ```bash
   base64 -i build_certificate.p12 | pbcopy
   ```
   (Windows의 경우 `certutil -encode` 사용 필요, 혹은 온라인 인코더 사용시 주의)

### B. Provisioning Profile (mobileprovision)
1. [Apple Developer Portal](https://developer.apple.com/account/resources/profiles/list) 접속.
2. `App Store`용 (Distribution) Provisioning Profile을 생성하거나 다운로드합니다 (`App.mobileprovision`).
3. 터미널에서 base64 코드를 복사합니다:
   ```bash
   base64 -i App.mobileprovision | pbcopy
   ```

### C. App Store Connect API Key
1. [App Store Connect](https://appstoreconnect.apple.com/access/api) > Users and Access > Keys 탭 접속.
2. `+` 버튼을 눌러 새 키 생성 (Access 권한: `App Manager` 이상).
3. `Issuer ID` (페이지 상단) 복사.
4. `Key ID` 복사.
5. `.p8` 파일 다운로드 (한 번만 가능하니 잘 보관). 터미널에서 내용을 봅니다: `cat AuthKey_xxxx.p8`

---

## 2. GitHub Secrets 등록

GitHub 저장소 > **Settings** > **Secrets and variables** > **Actions** > **New repository secret** 클릭하여 아래 값들을 등록하세요.

| Secret 이름 | 설명 | 값 예시 / 얻는 법 |
|---|---|---|
| `IOS_BUILD_CERTIFICATE_BASE64` | 위 A단계에서 복사한 p12 파일의 Base64 문자열 | (매우 긴 문자열) |
| `IOS_BUILD_CERTIFICATE_PASSWORD` | p12 파일 내보낼 때 설정한 암호 | `mypassword123` |
| `IOS_PROVISIONING_PROFILE_BASE64` | 위 B단계에서 복사한 mobileprovision 파일의 Base64 문자열 | (매우 긴 문자열) |
| `IOS_PROVISIONING_PROFILE_NAME` | Xcode나 개발자 포털에 등록된 프로파일의 **정확한 이름** | `UhCut App Store Profile` |
| `IOS_KEYCHAIN_PASSWORD` | CI 빌드용 임시 키체인 암호 (아무거나 설정 가능) | `temporaryPassword` |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect API 페이지 상단 Issuer ID | `57243a33-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `APP_STORE_CONNECT_API_KEY_ID` | 생성한 API Key의 ID | `2X9R4HX...` |
| `APP_STORE_CONNECT_API_PRIVATE_KEY` | .p8 파일의 내용 전체 (BEGIN/END 포함) | `-----BEGIN PRIVATE KEY----- ...` |

---

## 3. 프로젝트 설정 수정

`ios/App/exportOptions.plist` 파일을 열어 다음을 수정해서 커밋해야 할 수 있습니다:
- `YOUR_TEAM_ID_HERE` 부분을 Apple Developer Team ID로 변경하세요. (https://developer.apple.com/account 에서 확인 가능, 보통 10자리 문자열)

## 4. 작동 확인

모든 설정이 완료되면, 코드를 `main` 브랜치에 푸시하세요.
GitHub Actions 탭에서 빌드가 진행되는 것을 볼 수 있으며, 성공 시 TestFlight에 자동으로 업로드됩니다.
