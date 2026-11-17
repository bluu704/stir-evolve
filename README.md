# Stir & Evolve

유리막대로 비커를 저어 용액을 진화시키는 인터랙티브 웹 토이입니다.
접속한 모든 사람의 젓기 횟수가 하나로 합쳐져, 12단계 용액이 세대를 반복하며 진화합니다.

## 구성
| 경로 | 내용 |
|---|---|
| `public/index.html` | 게임 전체 (PixiJS 7 · Matter.js 0.19 CDN, 사운드는 Web Audio 합성) |
| `src/worker.js` | 모두의 젓기 합계를 관리하는 Cloudflare Worker + Durable Object |
| `wrangler.jsonc` | Worker 설정 (정적 파일 + Durable Object) |

## Cloudflare에 배포 (Workers, Git 연결)
1. Cloudflare 대시보드 → **Workers & Pages → Create → Import a repository**
2. 이 저장소 선택. 빌드 설정은 기본값 그대로 두면 됩니다.
   - Build command: 비움
   - Deploy command: `npx wrangler deploy`
3. 배포 후 `https://stir-evolve.<계정>.workers.dev` 주소로 접속합니다. `main`에 push할 때마다 자동 재배포됩니다.

Pages 프로젝트가 아니라 **Worker**로 만들어야 합니다(Durable Object를 쓰기 때문). 무료 플랜에서 동작합니다.

## 공유 카운터 API
- `GET /api/stir` → `{ total, online }`
- `POST /api/stir` body `{ delta, client }` → `{ total, online }`

조작 방지를 위해 클라이언트당 초당 약 6회까지만 인정하고, 저장소 기록은 5초에 한 번으로 묶습니다.
서버에 연결할 수 없으면(예: index.html만 따로 열었을 때) 게임은 자동으로 로컬 모드로 동작합니다.

## 로컬 실행
```bash
npx wrangler dev
```

## 미리보기용 주소 파라미터 (로컬 모드에서만 적용)
- `?stage=5` 해당 단계부터 시작
- `?fast=15` 진화 속도 15배
