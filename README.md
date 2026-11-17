# Stir & Evolve

유리막대로 비커를 저어 용액을 진화시키는 인터랙티브 웹 토이입니다.
여러 사람이 저은 횟수가 합쳐져 하나의 용액이 12단계를 거쳐 세대를 반복하며 진화합니다.

- 단일 파일: `index.html` (PixiJS 7, Matter.js 0.19 CDN 사용, 사운드는 Web Audio로 합성)
- 정적 호스팅(Cloudflare Pages 등)에 그대로 올리면 동작합니다. 빌드 과정이 없습니다.

## Cloudflare Pages 설정
- Framework preset: None
- Build command: (비움)
- Build output directory: `/`

## 여러 사람의 젓기 합치기
`index.html` 상단 `CONFIG.sync.endpoint`에 서버 주소를 넣으면 공유 모드로 동작합니다.
비워두면 각 브라우저에만 저장되는 로컬 모드입니다.

- `POST {endpoint}` body `{ delta, client }` → `{ total, online? }`
- `GET {endpoint}` → `{ total, online? }`

## 미리보기용 주소 파라미터 (로컬 모드 전용)
- `?stage=5` 해당 단계부터 시작
- `?fast=15` 진화 속도 15배
