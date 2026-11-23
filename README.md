# 가계부

가족이 함께 쓰는 가계부 웹앱(PWA)입니다. 시놀로지 NAS의 Docker에서 실행하고 Tailscale로만 접속합니다. 설계와 단계별 계획은 [docs/DESIGN.md](docs/DESIGN.md)를 보세요.

> 현재 3단계(기본 가계부)까지 만들었습니다. 로그인·앱 잠금·구성원 초대, 카드·계좌와 분류 관리, 빠른 입력, 내역, 홈 요약이 동작합니다. 인박스·가져오기·통계·예산은 이후 단계입니다.

## 구성

```
apps/server     Fastify API 서버, Drizzle(SQLite) 스키마·마이그레이션, 백업 작업
apps/web        Vue 3 + Vite PWA (폰은 하단 탭, 아이패드·PC는 좌측 메뉴)
packages/shared 서버·화면 공용 타입, 금액(원)·날짜(Asia/Seoul) 유틸
docker/         Dockerfile, compose 예시, Tailscale serve 설정, .env 예시
```

- 금액은 모두 원 단위 정수입니다.
- 시각은 UTC 밀리초로 저장하고, 날짜·월 경계는 한국 시간(Asia/Seoul) 기준으로 계산합니다 (`packages/shared/src/date.ts`).

## 로컬 개발

준비물: Node.js 22.18 이상, pnpm 10 (`corepack enable`이면 `package.json`의 버전이 자동으로 쓰입니다).

```bash
pnpm install
pnpm dev          # 서버(http://localhost:3000)와 화면(http://localhost:5173)을 함께 실행
```

- 브라우저에서 http://localhost:5173 을 엽니다. 화면 개발 서버가 `/api` 요청을 서버로 넘겨 줍니다.
- 서버는 TypeScript 소스를 Node로 바로 실행하며, 파일을 고치면 다시 시작합니다.
- 개발용 데이터는 `apps/server/data/`에 생깁니다 (git에 올라가지 않음). 지우면 초기화됩니다.
- 서버 설정은 환경 변수로 합니다. 개발 중에는 기본값으로 충분하고, 바꾸려면 `apps/server/.env`를 만듭니다. 변수 목록은 [docker/.env.example](docker/.env.example)에 있습니다.

### 데모 데이터

화면을 확인하거나 스크린샷을 찍을 때는 지어낸 데모 데이터를 넣을 수 있습니다.

```bash
pnpm seed:demo            # 사용자가 이미 있으면 거부합니다
pnpm seed:demo --force    # 기존 사용자·카드·거래를 모두 지우고 데모 데이터로 바꿉니다
```

구성원 두 명(`demo-sujin` 관리자, `demo-junho` 구성원, 비밀번호 `demo-pass-1234`), 카드·계좌 다섯 개, 최근 석 달의 거래가 생깁니다. 이름·가맹점·금액은 모두 지어낸 것입니다. 실제로 쓰는 DB에는 실행하지 마세요.

### 검사와 테스트

```bash
pnpm lint          # ESLint
pnpm format:check  # Prettier (고치려면 pnpm format)
pnpm typecheck     # 모든 패키지 타입 검사
pnpm test          # 단위·통합 테스트 (Vitest)
pnpm build         # shared → server, web 프로덕션 빌드
pnpm e2e           # 빌드 후 Playwright로 전체 흐름 테스트 (가상 패스키 사용)
```

`pnpm e2e`는 빌드된 서버를 임시 데이터 폴더로 띄워 처음 설정 → 패스키 등록 → 로그아웃 → 패스키 로그인 → 잠금·해제 → 구성원 초대·가입까지 확인합니다. Chromium이 필요합니다. 처음이면 `pnpm exec playwright install chromium`으로 설치합니다. `SCREENSHOT_DIR=/경로 pnpm e2e`로 화면을 저장할 수 있습니다.

### 프로덕션 빌드를 로컬에서 실행

```bash
pnpm build
NODE_ENV=production \
SESSION_SECRET="$(openssl rand -base64 48)" \
PUBLIC_ORIGIN=http://localhost:3000 \
DATA_DIR=./data \
pnpm start
```

http://localhost:3000 에서 빌드된 화면을, http://localhost:3000/api/health 에서 상태를 볼 수 있습니다. `PUBLIC_ORIGIN`은 브라우저 주소창의 주소와 정확히 같아야 합니다 (다르면 로그인 요청이 `invalid_origin`으로 거부되고 패스키도 동작하지 않습니다).

## 가계부 동작

- **금액**은 원 단위 정수입니다. 거래 유형은 지출·수입·이체이며, **이체(카드대금, 내 계좌 간 이동)와 취소된 거래는 합계에서 빠집니다.** ‘확인 필요’ 거래는 합계에 들어갑니다.
- **날짜**: 거래 시각은 UTC로 저장하고, 날짜와 월은 항상 한국 시간 기준으로 계산합니다. 11월 1일 0시 30분 결제는 기기 시간대와 관계없이 11월 거래입니다.
- **부분 취소**: 금액은 취소 후 남은 금액이고, 원래 금액은 따로 보관합니다(4·5단계에서 자동 수집이 채웁니다). 합계는 남은 금액으로 계산합니다.
- **편집 권한**: 가족 가계부이므로 볼 수 있는 거래는 누구나 고치거나 지울 수 있습니다. 분류도 모두가 함께 관리합니다. 카드·계좌는 누구나 자기 것을 만들 수 있고, 수정·보관은 명의자나 관리자만 합니다(명의자 변경은 관리자만).
- **나만 보기**: 서버는 이미 `나만 보기` 거래를 소유자에게만 보여 주고 합계에도 소유자에게만 넣습니다. 화면에서 켜는 기능은 아직 없습니다.
- **분류 보관**: 분류는 지우지 않고 보관합니다. 상위 분류를 보관하면 그때 활성이던 하위 분류도 함께 보관되고, 상위 분류를 복원하면 함께 보관됐던 하위 분류만 돌아옵니다. 보관된 분류는 새 거래에 쓸 수 없지만 기존 거래에는 그대로 남습니다.

## 로그인과 보안 동작

- **처음 설정**: 사용자가 한 명도 없을 때만 `/setup` 화면이 열립니다. 여기서 만든 계정이 관리자가 되고, 그 뒤로는 다시 열리지 않습니다.
- **로그인**: 패스키(Face ID·Touch ID·Windows Hello)가 기본이고 비밀번호는 대체 수단입니다. 비밀번호를 5번 연속 틀리면 15분 동안 비밀번호 로그인이 막힙니다 (이후 5번마다 2배, 최대 하루). 패스키 로그인은 막히지 않습니다. 로그인 관련 요청은 IP별·아이디별로 횟수가 제한됩니다.
- **복구 코드**: 가입할 때 한 번 보여 줍니다. 아이디 + 복구 코드로 비밀번호를 재설정하면 새 코드가 발급되고, 모든 기기의 로그인이 해제됩니다.
- **세션**: 30일 동안 사용하지 않으면 만료됩니다 (사용할 때마다 연장). 쿠키는 HttpOnly·SameSite=Strict이고, HTTPS에서는 `__Host-` 쿠키에 Secure가 붙습니다.
- **앱 잠금**: 마지막 요청 이후 설정한 시간(5분·1시간)이 지나면 서버가 세션을 잠그고, 패스키나 비밀번호로 풀기 전까지는 데이터를 주지 않습니다. ‘즉시’는 앱이 화면에서 사라지는 순간 잠그며, 그 신호를 놓쳐도 서버가 1분 뒤 잠급니다. ‘끔’은 잠그지 않습니다.
- **본인 재확인**: 패스키 추가·삭제, 비밀번호 변경, 복구 코드 재발급, 구성원 관리 전에는 최근 5분 안에 패스키나 비밀번호로 확인한 적이 있어야 합니다. 없으면 확인 창이 뜨고, 확인 후 원래 작업을 이어서 합니다.
- **화면 가리기**: 앱이 백그라운드로 가면 화면을 가려 앱 전환 화면에 금액이 보이지 않게 합니다.

### DB 스키마 변경

1. `apps/server/src/db/schema.ts`를 고칩니다.
2. `pnpm db:generate`로 `apps/server/drizzle/`에 마이그레이션 SQL을 만들고 함께 커밋합니다.
3. 서버는 시작할 때 아직 적용되지 않은 마이그레이션을 자동으로 적용합니다.

기본 분류(지출·수입 2단계)는 시작할 때마다 빠진 것만 채워 넣습니다. 이름을 바꾸거나 보관 처리한 분류는 건드리지 않습니다.

### 백업

- 서버가 매일 `BACKUP_TIME`(한국 시간, 기본 04:00)에 SQLite 온라인 백업으로 `<DATA_DIR>/backups/budget-YYYYMMDDTHHMMSSZ.sqlite`를 만듭니다 (파일명 시각은 UTC).
- `BACKUP_RETENTION_DAYS`(기본 30일)보다 오래된 백업은 지웁니다. 가장 최근 백업은 항상 남깁니다.
- 서버가 시작될 때 최근 24시간 안의 백업이 없으면 바로 하나 만듭니다.
- 지금 바로 백업: 개발 중에는 `pnpm backup`, 컨테이너에서는 `docker exec <앱 컨테이너> node dist/cli/backup.js`.
- 복원: 앱 컨테이너를 멈추고, 백업 파일을 `budget.sqlite`로 복사한 뒤(`budget.sqlite-wal`, `budget.sqlite-shm`은 삭제) 다시 시작합니다.

### Docker 이미지 직접 빌드

```bash
docker build -f docker/Dockerfile -t budget-app:local .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  budget-app:local
```

컨테이너는 `node`(uid 1000) 사용자로 실행되므로 마운트한 폴더에 그 사용자가 쓸 수 있어야 합니다 (`sudo chown 1000:1000 data`).

## 시놀로지 + Tailscale 배포

GitHub Actions가 `main`에 푸시될 때와 `v1.2.3` 같은 태그를 올릴 때 amd64·arm64 이미지를 만들어 GHCR(`ghcr.io/<소유자>/<저장소>`)에 올립니다. NAS에서는 이미지를 받아 실행만 합니다.

### 1. 사전 준비

1. **Container Manager**: DSM 패키지 센터에서 설치합니다. 지원하지 않는 모델이면 이 방식으로는 배포할 수 없습니다.
2. **GHCR 이미지 접근**: 저장소가 공개이면 이미지도 공개로 둘 수 있습니다. GitHub의 Packages에서 이미지 공개 여부를 확인하세요. 비공개로 두면 NAS에서 `docker login ghcr.io`(읽기 권한 토큰)가 필요합니다.
3. **Tailscale**:
   - 관리 콘솔의 DNS 설정에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다.
   - Settings → Keys에서 **Auth key**를 만듭니다. 처음 연결할 때만 쓰입니다.
   - 가족의 모든 기기(아이폰, 아이패드, 맥, PC)에 Tailscale을 설치하고 같은 tailnet에 넣거나, 앱 노드를 공유합니다.

### 2. NAS에 폴더 만들기

File Station에서 예를 들어 `docker/budget` 공유 폴더 아래에 다음 구조를 만듭니다.

```
docker/budget/
├ compose.yml           ← docker/compose.example.yml 복사
├ .env                  ← docker/.env.example 복사 후 수정
├ tailscale/
│  ├ serve.json         ← docker/tailscale/serve.json 복사
│  └ state/             ← 빈 폴더 (Tailscale 노드 정보 저장)
└ data/                 ← 빈 폴더 (DB와 backups/)
```

`compose.yml`의 `ghcr.io/twkwun/budget-app` 부분은 `.env`의 `APP_IMAGE`로 바꿀 수 있습니다.

### 3. `.env` 작성

`.env.example`의 설명을 따라 채웁니다. 꼭 바꿔야 하는 값:

| 변수                 | 내용                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `TS_AUTHKEY`         | Tailscale auth key                                                  |
| `TS_HOSTNAME`        | 앱 주소의 앞부분 (예: `budget` → `https://budget.<tailnet>.ts.net`) |
| `APP_IMAGE`          | `ghcr.io/<GitHub 소유자>/<저장소>` (소문자)                         |
| `SESSION_SECRET`     | `openssl rand -base64 48`로 만든 임의 문자열                        |
| `PUBLIC_ORIGIN`      | 실제 접속 주소, 예: `https://budget.<tailnet>.ts.net`               |
| `APP_UID`, `APP_GID` | `data` 폴더에 쓸 수 있는 사용자 (아래 4단계)                        |

`compose.example.yml`은 앱에 `TRUST_PROXY=true`를 설정합니다. 앱 포트가 Tailscale 컨테이너를 통해서만 열리므로, Tailscale이 넘겨주는 실제 접속 IP(`X-Forwarded-For`)를 믿고 로그인 횟수 제한에 씁니다. 앱 포트를 직접 열어 쓰는 경우에는 `false`로 두세요.

`PUBLIC_ORIGIN`은 2단계부터 패스키에 묶입니다. 주소를 바꾸면 패스키를 다시 등록해야 하므로 처음에 정하고 바꾸지 않습니다.

### 4. 데이터 폴더 권한

앱 컨테이너는 root가 아닌 사용자로 실행됩니다. SSH로 NAS에 접속해 다음 중 하나를 합니다.

- `data` 폴더 소유자를 1000으로 바꾸기: `sudo chown -R 1000:1000 /volume1/docker/budget/data`
- 또는 `id` 명령으로 확인한 내 계정의 uid/gid를 `.env`의 `APP_UID`, `APP_GID`에 적기

### 5. 프로젝트 만들기

1. Container Manager → **프로젝트** → **생성**.
2. 경로로 `docker/budget`을 고르고 "기존 compose.yml 사용"을 선택합니다.
3. 웹 포털 설정은 건너뜁니다 (앱은 Tailscale로만 접속합니다).
4. 완료하면 이미지를 받아 `app`과 `tailscale` 컨테이너가 시작됩니다. `app`이 healthy가 된 뒤 `tailscale`이 시작됩니다.

SSH로 하려면 같은 폴더에서 `sudo docker compose up -d`.

### 6. 확인

1. Tailscale 관리 콘솔에 `budget` 기기가 보이는지 확인합니다.
2. Tailscale이 켜진 기기에서 `https://budget.<tailnet>.ts.net/api/health`를 엽니다. `"status":"ok"`가 나오면 됩니다. 첫 접속 때 인증서 발급으로 몇 초 걸릴 수 있습니다.
3. 같은 주소를 엽니다. 처음에는 **처음 설정** 화면이 나옵니다.
   1. 이름, 아이디, 비밀번호를 입력해 관리자 계정을 만듭니다.
   2. 화면에 나온 **복구 코드**를 종이나 암호 관리 앱에 저장합니다. 다시 볼 수 없습니다.
   3. **패스키 추가**를 눌러 Face ID로 등록합니다. 아이폰에서 등록하면 iCloud 키체인으로 같은 Apple 계정의 아이패드·맥에도 동기화됩니다.
   4. 홈 화면에 "서버 연결됨"이 보이면 완료입니다.
4. 가족 초대: 설정 → 구성원 → **초대 링크 만들기**로 만든 링크(7일, 1회용)를 가족에게 보냅니다. 받는 사람의 기기도 Tailscale에 연결되어 있어야 합니다. 가족은 링크를 열어 계정을 만들고 각자 패스키를 추가합니다.
5. PC: Windows Hello로 패스키를 따로 추가하거나, 로그인 화면에서 패스키 로그인을 누른 뒤 나오는 QR을 아이폰으로 찍어 로그인합니다.
6. 기기별 설치:
   - 아이폰·아이패드: Safari → 공유 → **홈 화면에 추가**
   - 맥: Safari → 파일 → **Dock에 추가**
   - PC: Chrome·Edge 주소창의 **앱 설치** 아이콘

### 업데이트

Container Manager → 프로젝트 → 해당 프로젝트 → **작업 → 빌드**(이미지 다시 받기) 또는 SSH에서:

```bash
sudo docker compose pull && sudo docker compose up -d
```

DB 마이그레이션은 앱이 시작할 때 자동으로 적용됩니다. 업데이트 전에 `data/backups`에 최근 백업이 있는지 확인하세요.

### Hyper Backup

`docker/budget/data/backups` 폴더(또는 `data` 전체)를 Hyper Backup 작업에 포함합니다. 실행 중인 `budget.sqlite` 파일보다 `backups/`의 파일이 일관된 사본입니다.

### 문제 해결

- `tailscale` 컨테이너 로그에 인증 오류: auth key가 만료됐거나 이미 쓰였습니다. 새 키를 넣고 `tailscale/state`를 비운 뒤 다시 시작합니다.
- 앱이 바로 종료됨: `app` 로그에 `Invalid configuration`과 함께 잘못된 변수가 표시됩니다.
- `SQLITE_CANTOPEN` 또는 권한 오류: 4단계의 데이터 폴더 권한을 확인합니다.
- 로그인할 때 `invalid_origin` 오류: `.env`의 `PUBLIC_ORIGIN`이 실제로 여는 주소(`https://budget.<tailnet>.ts.net`)와 같은지 확인합니다.
- 패스키·비밀번호·복구 코드를 모두 잃은 경우: 본인은 되찾을 방법이 없습니다. 다른 관리자가 그 계정을 사용 중지하고 새로 초대해야 하므로, 관리자를 두 명 두는 것을 권합니다.

## 보안 주의

이 저장소는 공개입니다. 실제 문자, 카드사·은행 파일, DB 파일, `.env`, 토큰은 절대 커밋하지 않습니다. 테스트 데이터는 지어낸 값만 씁니다.
