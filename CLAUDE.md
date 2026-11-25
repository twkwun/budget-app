# 가계부 작업 지침

설계는 [docs/DESIGN.md](docs/DESIGN.md), 운영·개발 방법은 [README.md](README.md)에 있다.

## 문서 · 버전 이력 관리 규칙 (필수)

사용자가 보는 기능이나 화면을 추가·수정·삭제할 때는 커밋 전에 아래 두 가지를 **반드시** 함께 갱신한다.

1. **사용자 설명서**: 앱 안의 설명서 내용([apps/web/src/manual.ts](apps/web/src/manual.ts), `/manual` 화면)에 바뀐 기능·화면·사용법을 사용자 입장에서 쉬운 말로 반영하고, `pnpm manual:md`로 [docs/user-manual.md](docs/user-manual.md)를 다시 만든다(직접 고치지 않는다. 테스트가 둘이 같은지 확인한다). 화면 구성이 눈에 띄게 바뀌면 `pnpm build && pnpm manual:shots`로 `apps/web/public/manual/`의 캡처를 다시 만든다(지어낸 데모 데이터만 쓰고, 설치된 Chrome을 쓴다).
2. **버전 이력** ([apps/web/src/changelog.ts](apps/web/src/changelog.ts)): `Major.Minor.Patch` 버전을 올리고 `APP_VERSION`과 `CHANGELOG` 맨 위에 변경 내역을 추가한다. 새 기능·화면은 Minor, 고침·작은 개선만 있으면 Patch를 올린다. 루트, `apps/web`, `apps/server`, `packages/shared`의 `package.json` `version`도 같은 값으로 바꾼다(`apps/web/test/changelog.test.ts`가 확인한다).
