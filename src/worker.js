/**
 * Stir & Evolve — 모두의 젓기 횟수를 합산하는 Cloudflare Worker
 *
 *  GET  /api/stir                     → { total, online }
 *  POST /api/stir  { delta, client }  → { total, online }
 *  POST /api/stir  { reset: true, client } → 그 클라이언트가 보탠 만큼 전체에서 빼고 { total, online, removed }
 *
 *  GET  /api/board?since=ID          → { messages:[{id,name,text,t}] }   (게시판)
 *  POST /api/board { name, text } → { message } | { error }
 *
 * 치트 방지: 탭 id·클라이언트 id는 브라우저가 만든 값이라 조작할 수 있으므로,
 * 젓기 인정량과 게시판 도배는 접속 IP(cf-connecting-ip) 기준으로도 제한합니다.
 *
 * 전체 합계는 Durable Object(Counter) 하나가 메모리에 들고 있고,
 * 저장소 쓰기는 최대 5초에 한 번만 해서 요청이 많아도 쓰기 비용이 늘지 않습니다.
 * 그 외 경로는 public/ 의 정적 파일(index.html)을 그대로 돌려줍니다.
 */
const SAVE_EVERY_MS = 5000;      // 저장소에 합계를 기록하는 최소 간격
const ONLINE_WINDOW_MS = 15000;  // 이 시간 안에 요청한 사람을 '접속 중'으로 셈
const MAX_RATE = 10;             // 탭당 초당 최대 인정 젓기 수 (사람 손 최대치 ≈ 6회/초)
const BURST = 15;                // 탭당 순간 허용 여유분
// ---- 치트 방지: 탭 id는 조작할 수 있으므로 접속 IP 기준으로도 제한 ----
const IP_RATE = 12;              // IP당 초당 최대 인정 젓기 수 (같은 집·학교에서 여럿이 하는 경우 감안)
const IP_BURST = 40;             // IP당 순간 허용 여유분
const IP_HOUR = 15000;           // IP당 1시간 최대 인정 젓기 수 (자동 스크립트를 켜 둬도 이 이상 못 올림)
const MAX_BODY = 2048;           // 요청 본문 최대 크기
const BOARD_KEEP = 150;          // 게시판에 보관하는 최근 글 수
const BOARD_GAP_MS = 4000;       // 같은 사람(IP)이 글을 연달아 쓸 수 있는 최소 간격
const BOARD_PER_MIN = 6;         // 같은 사람(IP)이 1분에 쓸 수 있는 글 수
const NAME_MAX = 16, TEXT_MAX = 200;
const ID_RE = /^[a-z0-9]{4,16}$/; // 클라이언트·탭 id 형식 (임의 문자열로 저장소를 채우는 것 방지)

const ipOf = req => req.headers.get('cf-connecting-ip') || 'local';
async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  const txt = await request.text();
  if (txt.length > MAX_BODY) return null;
  try { const o = JSON.parse(txt); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

export class Counter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.total = null;
    this.lastSave = 0;
    this.lastSweep = 0;
    this.clients = new Map(); // 탭 id → { t: 마지막 요청 시각, ip } (탭당 속도 제한·접속자 수)
    this.ips = new Map();     // IP → { tok, t, hour, hourStart } (IP당 속도·시간당 상한)
    this.contrib = new Map(); // client id → 지금까지 보탠 젓기 합계 (초기화 시 빼기 위해 기록)
    this.dirty = new Set();
    this.msgs = null;           // 게시판 글 (최근 BOARD_KEEP개)
    this.posters = new Map();   // IP → { last, times:[], lastText } (게시판 도배 방지)
  }

  async board(request, url, now, ip) {
    if (this.msgs === null) this.msgs = (await this.ctx.storage.get('board')) || [];
    const json = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    if (request.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const list = since ? this.msgs.filter(m => m.id > since) : this.msgs.slice(-80);
      return json({ messages: list });
    }
    const body = await readJson(request);
    if (!body) return json({ error: '잘못된 요청' }, 400);
    const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const name = clean(body.name, NAME_MAX) || '익명 연구원';
    const text = clean(body.text, TEXT_MAX);
    if (!text) return json({ error: '내용을 입력해 주세요' }, 400);
    const p = this.posters.get(ip) || { last: 0, times: [], lastText: '' };
    p.times = p.times.filter(t => now - t < 60000);
    if (now - p.last < BOARD_GAP_MS || p.times.length >= BOARD_PER_MIN) return json({ error: '조금 뒤에 다시 써 주세요' }, 429);
    if (text === p.lastText && now - p.last < 60000) return json({ error: '같은 글은 잠시 뒤에 다시 쓸 수 있어요' }, 429);
    p.last = now; p.times.push(now); p.lastText = text; this.posters.set(ip, p);
    const last = this.msgs[this.msgs.length - 1];
    const message = { id: (last ? last.id : 0) + 1, name, text, t: now };
    this.msgs.push(message);
    if (this.msgs.length > BOARD_KEEP) this.msgs.splice(0, this.msgs.length - BOARD_KEEP);
    await this.ctx.storage.put('board', this.msgs);
    return json({ message });
  }

  async getContrib(id) {
    if (!this.contrib.has(id)) this.contrib.set(id, (await this.ctx.storage.get('c:' + id)) || 0);
    return this.contrib.get(id);
  }

  async save() {
    const batch = { total: this.total };
    for (const id of this.dirty) batch['c:' + id] = this.contrib.get(id) || 0;
    this.dirty.clear();
    this.lastSave = Date.now();
    await this.ctx.storage.put(batch);
  }

  async ensureLoaded() {
    if (this.total === null) this.total = (await this.ctx.storage.get('total')) || 0;
  }

  // 접속자 수: 같은 IP에서 탭을 여러 개 열어도 1명으로 셈
  online(now) {
    const seen = new Set();
    for (const [id, c] of this.clients) {
      if (now - c.t < ONLINE_WINDOW_MS) seen.add(c.ip);
    }
    return seen.size;
  }

  // 오래된 기록 정리 (메모리 누수 방지)
  sweep(now) {
    if (now - this.lastSweep < 60000) return;
    this.lastSweep = now;
    for (const [k, c] of this.clients) if (now - c.t > 120000) this.clients.delete(k);
    for (const [k, v] of this.ips) if (now - v.t > 3600000) this.ips.delete(k);
    for (const [k, v] of this.posters) if (now - v.last > 120000) this.posters.delete(k);
    if (this.contrib.size > 5000) for (const k of this.contrib.keys()) if (!this.dirty.has(k)) this.contrib.delete(k);
  }

  // 이 IP가 지금 인정받을 수 있는 최대 젓기 수 (토큰 버킷 + 시간당 상한)
  ipAllow(ip, now) {
    let b = this.ips.get(ip);
    if (!b) { b = { tok: IP_BURST, t: now, hour: 0, hourStart: now }; this.ips.set(ip, b); }
    b.tok = Math.min(IP_BURST, b.tok + (now - b.t) / 1000 * IP_RATE);
    b.t = now;
    if (now - b.hourStart > 3600000) { b.hour = 0; b.hourStart = now; }
    return { b, max: Math.max(0, Math.min(b.tok, IP_HOUR - b.hour)) };
  }

  async fetch(request) {
    await this.ensureLoaded();
    const now = Date.now();
    const ip = ipOf(request);
    this.sweep(now);
    const url = new URL(request.url);
    if (url.pathname === '/api/board') return this.board(request, url, now, ip);
    const res = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    const qtab = url.searchParams.get('tab');
    if (request.method === 'GET' && qtab && ID_RE.test(qtab)) {
      const c = this.clients.get(qtab);
      this.clients.set(qtab, { t: now, post: c ? c.post : 0, ip }); // 속도 제한 기준(post)은 POST 때만 갱신
    }

    if (request.method === 'POST') {
      const body = await readJson(request);
      if (!body) return res({ error: 'bad request' }, 400);
      const id = String(body.client || '');
      if (!ID_RE.test(id)) return res({ error: 'bad client' }, 400);
      const tab = ID_RE.test(String(body.tab || '')) ? String(body.tab) : id;
      // 내 젓기 초기화: 이 클라이언트가 보탠 만큼만 전체에서 뺌
      if (body.reset === true) {
        const mine = await this.getContrib(id);
        this.total = Math.max(0, this.total - mine);
        this.contrib.set(id, 0);
        this.dirty.add(id);
        await this.save();
        return res({ total: this.total, online: this.online(now), removed: mine });
      }
      let delta = Number(body.delta);
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      // 1) 탭 기준: 마지막 요청 이후 지난 시간에 비례한 만큼만 인정
      const c = this.clients.get(tab);
      const tabAllowed = (c && c.post ? Math.min(30, (now - c.post) / 1000) : 2) * MAX_RATE + BURST;
      // 2) IP 기준: 탭 id를 바꿔가며 보내도 IP당 초당·시간당 상한을 넘을 수 없음
      const { b, max } = this.ipAllow(ip, now);
      delta = Math.min(delta, tabAllowed, max);
      b.tok -= delta; b.hour += delta;
      this.total += delta;
      this.contrib.set(id, (await this.getContrib(id)) + delta);
      this.dirty.add(id);
      this.clients.set(tab, { t: now, post: now, ip });
      if (now - this.lastSave > SAVE_EVERY_MS) {
        await this.save();
      } else {
        // 마지막 몇 초 분량이 유실되지 않도록 알람으로 한 번 더 저장
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) await this.ctx.storage.setAlarm(now + SAVE_EVERY_MS);
      }
    }

    return res({ total: this.total, online: this.online(now) });
  }

  async alarm() {
    await this.ensureLoaded();
    await this.save();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stir' || url.pathname === '/api/board') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const stub = env.COUNTER.get(env.COUNTER.idFromName('global'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
