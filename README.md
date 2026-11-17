# Stir & Evolve

유리막대로 비커를 저어 용액을 진화시키는 인터랙티브 웹 토이입니다.
접속한 모든 사람의 젓기 횟수가 하나로 합쳐져, 12단계 용액이 세대를 반복하며 진화합니다.

## 구성
| 경로 | 내용 |
|---|---|
| `public/index.html` | 게임 전체 (PixiJS 7 · Matter.js 0.19 CDN, 사운드는 Web Audio 합성) |
| `src/worker.js` | 모두의 젓기 합계를 관리하는 Cloudflare Worker + Durable Object |
| `wrangler.jsonc` | Worker 설정 (정적 파일 + Durable Object) |
| `functions/api/stir.js`, `functions/api/board.js` | Pages에서 `/api/*` 요청을 Worker로 전달하는 함수 |

## Cloudflare에 배포
공유 카운터는 **Worker**(Durable Object)가 담당하고, 화면은 **Pages**(`stir-evolve.pages.dev`)로도 제공합니다.
두 주소 모두 같은 카운터를 씁니다.

### 1) 카운터 Worker (이미 배포됨)
- Workers & Pages → Create → Import a repository → 이 저장소
- 빌드 설정 기본값 (Deploy command: `npx wrangler deploy`)

### 2) Pages (계정 이름 없는 주소)
1. Workers & Pages → Create → **Pages** → Connect to Git → 이 저장소
2. Framework preset: None · Build command: 비움 · **Build output directory: `public`**
3. 배포 후 프로젝트 **Settings → Bindings → Add → Service binding**
   - Variable name: `STIR_API`
   - Service: `stir-evolve`
4. **Deployments**에서 최신 배포를 **Retry deployment**(재배포)해야 바인딩이 적용됩니다.

`functions/api/stir.js`가 `/api/stir` 요청을 Worker로 전달합니다.

## 공유 API
- `GET /api/board?since=ID` → `{ messages }` · `POST /api/board` body `{ name, text, tab }` (게시판, 최근 150개 보관, 탭당 4초 간격)

### 젓기 카운터
- `GET /api/stir` → `{ total, online }`
- `POST /api/stir` body `{ delta, client }` → `{ total, online }`
- `POST /api/stir` body `{ reset: true, client }` → 그 클라이언트가 보탠 만큼 전체에서 뺌 (`removed` 포함)

조작 방지를 위해 탭당 초당 10회, 접속 IP당 초당 12회·1시간 15,000회까지만 인정합니다. 처음 보는 IP는 초당 5회로 시작해 5분에 걸쳐 정상 속도가 되고, 같은 IP 대역(/24, /48)은 합쳐서 초당 30회·1시간 40,000회, 연구원 1명은 1시간 15,000회로 묶입니다. 사이트 전체에는 초당 300회·1시간 600,000회 소프트캡이 있어 프록시를 많이 써도 합계가 급증하지 않습니다. 게시판은 IP당 4초 간격·1분 6개, 전체 1분 40개, 접속 15초 뒤부터 쓸 수 있습니다. 저장소 기록은 5초에 한 번으로 묶습니다.
서버에 연결할 수 없으면(예: index.html만 따로 열었을 때) 게임은 자동으로 로컬 모드로 동작합니다.

## 로컬 실행
```bash
npx wrangler dev
```


### 봇 확인 (Cloudflare Turnstile)
1. Cloudflare 대시보드 → Turnstile → 위젯 추가 (호스트: `stir-evolve.pages.dev`, `stir-evolve.lsshhh704.workers.dev`, 모드: Managed).
2. 사이트 키를 `wrangler.jsonc` 의 `vars.TURNSTILE_SITEKEY` 에 넣습니다.
3. 비밀 키는 Workers → stir-evolve → 설정 → 변수 및 비밀 에서 **비밀(Secret)** `TURNSTILE_SECRET` 으로 넣습니다.

둘 다 있으면 켜집니다. 확인을 통과한 IP는 6시간 동안 정상 인정, 통과하지 않은 IP(스크립트 등)는 젓기 10%만 인정되고 게시판에 글을 쓸 수 없습니다.
