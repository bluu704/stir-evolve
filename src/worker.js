/**
 * Stir & Evolve — 모두의 젓기 횟수를 합산하는 Cloudflare Worker
 *
 *  GET  /api/stir                     → { total, online }
 *  POST /api/stir  { delta, client, tab, name }  → { total, online }
 *  GET  /api/rank?client=ID          → { top:[{name,c,me?}], me:{rank,c} }  (연구원별 기여도 순위)
 *  POST /api/stir  { reset: true, client } → 그 클라이언트가 보탠 만큼 전체에서 빼고 { total, online, removed }
 *
 *  GET  /api/board?since=ID          → { messages:[{id,name,text,t}] }   (게시판)
 *  POST /api/board { name, text } → { message } | { error }
 *
 *  GET  /api/dex?client=ID           → { found:[레시피 id] }   (연구원 코드별 도감)
 *  POST /api/dex { client, found }   → { found }  (합집합으로 저장, 지워지지 않음)
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
const BURST = 25;                // 탭당 순간 허용 여유분 (브라우저는 2초마다 최대 ~15씩 보냄)
// ---- 치트 방지: 탭 id는 조작할 수 있으므로 접속 IP 기준으로도 제한 ----
const IP_RATE = 12;              // IP당 초당 최대 인정 젓기 수 (같은 집·학교에서 여럿이 하는 경우 감안)
const IP_BURST = 40;             // IP당 순간 허용 여유분
const IP_HOUR = 15000;           // IP당 1시간 최대 인정 젓기 수 (자동 스크립트를 켜 둬도 이 이상 못 올림)
// ---- 프록시(IP 바꿔치기) 대비 ----
const NEW_IP_RATE = 5;           // 처음 보는 IP의 초당 인정 젓기 수 (점점 늘어남)
const TRUST_MS = 5 * 60000;      // 이 시간 동안 꾸준히 접속하면 IP당 정상 속도까지 올라감
const NET_RATE = 30;             // 같은 대역(IPv4 /24, IPv6 /48) 전체의 초당 상한 (프록시 묶음 대비)
const NET_BURST = 80;
const NET_HOUR = 40000;          // 같은 대역 1시간 상한
const CLIENT_HOUR = 15000;       // 연구원(client id) 1명의 1시간 상한 (여러 IP로 한 사람 순위 올리기 방지)
// ---- 전역 소프트캡: 사이트 전체 합계가 늘어나는 속도 자체를 제한 ----
const G_RATE = 300;              // 사이트 전체 초당 인정 젓기 수
const G_BURST = 3000;            // 전체 순간 여유분
const G_SOFT = 0.5;              // 여유분이 이 비율 아래로 떨어지면 모두의 인정량을 점점 줄임
const G_HOUR = 600000;           // 사이트 전체 1시간 상한
const BOARD_GLOBAL_PER_MIN = 40; // 게시판 전체 1분 글 수 (여러 IP로 도배 방지)
const BOARD_NEW_IP_MS = 15000;   // 처음 보는 IP는 이 시간이 지나야 글을 쓸 수 있음
// ---- 봇 확인 (Cloudflare Turnstile) ----
// wrangler.jsonc 의 vars.TURNSTILE_SITEKEY 와 Worker 비밀값 TURNSTILE_SECRET 이 둘 다 있을 때만 켜짐
const HUMAN_MS = 6 * 3600000;    // 한 번 확인되면 이 시간 동안 그 IP를 사람으로 봄
const UNVERIFIED_MUL = 0.1;      // 확인 안 된 IP의 젓기는 10%만 인정 (스크립트·curl 대비)
const MAX_BODY = 2048;           // 요청 본문 최대 크기
const BOARD_KEEP = 150;          // 게시판에 보관하는 최근 글 수
const BOARD_GAP_MS = 4000;       // 같은 사람(IP)이 글을 연달아 쓸 수 있는 최소 간격
const BOARD_PER_MIN = 6;         // 같은 사람(IP)이 1분에 쓸 수 있는 글 수
const NAME_MAX = 16, TEXT_MAX = 200;
const ID_RE = /^[a-z0-9]{4,16}$/; // 클라이언트·탭 id 형식 (임의 문자열로 저장소를 채우는 것 방지)

const DEX_ID_RE = /^[A-Za-z0-9_]{1,24}$/; // 도감 레시피 id 형식
const DEX_MAX = 120;             // 연구원 한 명이 저장할 수 있는 도감 항목 수
const DEX_IP_RATE = 0.2, DEX_IP_BURST = 20, DEX_IP_HOUR = 300; // IP당 도감 저장 횟수 제한

const RANK_KEEP = 100;           // 기여도 순위표에 보관하는 연구원 수
const RANK_SHOW = 30;            // 한 번에 보여 주는 순위 수
const cleanText = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const ipOf = req => req.headers.get('cf-connecting-ip') || 'local';
// IP가 속한 대역: IPv4는 앞 3칸(/24), IPv6는 앞 3블록(/48)
const netOf = ip => ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + '::/48' : ip.split('.').slice(0, 3).join('.') + '.0/24';
// 토큰 버킷 + 시간당 상한
function bucket(map, key, now, rate, burst, hourCap) {
  let b = map.get(key);
  if (!b) { b = { tok: burst, t: now, hour: 0, hourStart: now, born: now }; map.set(key, b); }
  b.tok = Math.min(burst, b.tok + (now - b.t) / 1000 * rate);
  b.t = now;
  if (now - b.hourStart > 3600000) { b.hour = 0; b.hourStart = now; }
  return b;
}
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
    this.env = env || {};
    this.human = new Map();     // IP → 봇 확인 통과 시각
    this.total = null;
    this.lastSave = 0;
    this.lastSweep = 0;
    this.clients = new Map(); // 탭 id → { t: 마지막 요청 시각, ip } (탭당 속도 제한·접속자 수)
    this.ips = new Map();     // IP → { tok, t, hour, hourStart } (IP당 속도·시간당 상한)
    this.contrib = new Map(); // client id → 지금까지 보탠 젓기 합계 (초기화 시 빼기 위해 기록)
    this.dirty = new Set();
    this.lb = null;             // 기여도 순위표 { client id → { n: 닉네임, c: 기여 } } (상위 RANK_KEEP명)
    this.lbDirty = false;
    this.msgs = null;           // 게시판 글 (최근 BOARD_KEEP개)
    this.dexW = new Map();      // IP → 도감 저장 횟수 버킷
    this.posters = new Map();   // IP → { last, times:[], lastText } (게시판 도배 방지)
    this.nets = new Map();      // IP 대역 → 버킷 (프록시 묶음 제한)
    this.cHour = new Map();     // client id → { hour, hourStart } (연구원당 시간 상한)
    this.g = { tok: G_BURST, t: Date.now(), hour: 0, hourStart: Date.now() }; // 사이트 전체 버킷
    this.boardTimes = [];       // 게시판 전체 최근 1분 글 시각
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
    const clean = cleanText;
    const name = clean(body.name, NAME_MAX) || '익명 연구원';
    const text = clean(body.text, TEXT_MAX);
    if (!text) return json({ error: '내용을 입력해 주세요' }, 400);
    const p = this.posters.get(ip) || { last: 0, times: [], lastText: '' };
    p.times = p.times.filter(t => now - t < 60000);
    if (now - p.last < BOARD_GAP_MS || p.times.length >= BOARD_PER_MIN) return json({ error: '조금 뒤에 다시 써 주세요' }, 429);
    this.boardTimes = this.boardTimes.filter(t => now - t < 60000);
    if (this.boardTimes.length >= BOARD_GLOBAL_PER_MIN) return json({ error: '지금 게시판이 붐벼요. 조금 뒤에 써 주세요' }, 429);
    if (this.botOn() && !this.isHuman(ip, now)) return json({ error: '봇 확인이 끝나면 쓸 수 있어요' }, 403);
    const ib = this.ips.get(ip);
    if (!ib || now - ib.born < BOARD_NEW_IP_MS) return json({ error: '접속 직후에는 잠시 뒤에 쓸 수 있어요' }, 429);
    if (text === p.lastText && now - p.last < 60000) return json({ error: '같은 글은 잠시 뒤에 다시 쓸 수 있어요' }, 429);
    p.last = now; p.times.push(now); this.boardTimes.push(now); p.lastText = text; this.posters.set(ip, p);
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
    if (this.lbDirty && this.lb) { batch.lb = this.lb; this.lbDirty = false; }
    this.dirty.clear();
    this.lastSave = Date.now();
    await this.ctx.storage.put(batch);
  }

  async ensureLoaded() {
    if (this.total === null) this.total = (await this.ctx.storage.get('total')) || 0;
    if (this.lb === null) {
      this.lb = await this.ctx.storage.get('lb');
      if (!this.lb) {
        // 순위표가 생기기 전의 기여 기록으로 처음 한 번 채움
        this.lb = {};
        const all = await this.ctx.storage.list({ prefix: 'c:' });
        for (const [k, v] of all) if (v > 0) this.lb[k.slice(2)] = { n: '', c: v };
        this.trimRank();
        this.lbDirty = true;
      }
    }
  }

  trimRank() {
    const ids = Object.keys(this.lb);
    if (ids.length <= RANK_KEEP) return;
    ids.sort((a, b) => this.lb[b].c - this.lb[a].c);
    for (const id of ids.slice(RANK_KEEP)) delete this.lb[id];
  }

  // 기여가 늘 때 순위표 갱신 (상위권이거나 상위권에 새로 들 때만 기록)
  updateRank(id, c, name) {
    const e = this.lb[id];
    if (e) { e.c = c; if (name) e.n = name; this.lbDirty = true; return; }
    const ids = Object.keys(this.lb);
    if (ids.length >= RANK_KEEP) {
      let minId = null, min = Infinity;
      for (const k of ids) if (this.lb[k].c < min) { min = this.lb[k].c; minId = k; }
      if (c <= min) return;
      delete this.lb[minId];
    }
    this.lb[id] = { n: name || '', c };
    this.lbDirty = true;
  }

  rank(url) {
    const me = String(url.searchParams.get('client') || '');
    const ids = Object.keys(this.lb).filter(k => this.lb[k].c >= 1).sort((a, b) => this.lb[b].c - this.lb[a].c);
    const top = ids.slice(0, RANK_SHOW).map(k => {
      const o = { name: this.lb[k].n || '익명 연구원', c: Math.floor(this.lb[k].c) };
      if (k === me) o.me = true;
      return o;
    });
    const i = ids.indexOf(me);
    const mine = ID_RE.test(me) ? (this.contrib.get(me) ?? this.lb[me]?.c ?? null) : null;
    return Response.json({ top, me: { rank: i >= 0 ? i + 1 : null, c: mine == null ? null : Math.floor(mine) }, n: ids.length },
      { headers: { 'cache-control': 'no-store' } });
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
    for (const [k, v] of this.dexW) if (now - v.t > 3600000) this.dexW.delete(k);
    for (const [k, v] of this.posters) if (now - v.last > 120000) this.posters.delete(k);
    for (const [k, t] of this.human) if (now - t > HUMAN_MS) this.human.delete(k);
    for (const [k, v] of this.nets) if (now - v.t > 3600000) this.nets.delete(k);
    for (const [k, v] of this.cHour) if (now - v.hourStart > 3600000) this.cHour.delete(k);
    if (this.contrib.size > 5000) for (const k of this.contrib.keys()) if (!this.dirty.has(k)) this.contrib.delete(k);
  }

  // 이 IP가 지금 인정받을 수 있는 최대 젓기 수
  // 처음 보는 IP는 느리게 시작해 TRUST_MS 동안 꾸준히 쓰면 정상 속도가 됨 → 일회용 프록시는 효율이 낮음
  ipAllow(ip, now) {
    const pre = this.ips.get(ip);
    const age = pre ? now - pre.born : 0;
    const trust = Math.min(1, age / TRUST_MS);
    const rate = NEW_IP_RATE + (IP_RATE - NEW_IP_RATE) * trust;
    const burst = Math.round(10 + (IP_BURST - 10) * trust);
    const b = bucket(this.ips, ip, now, rate, burst, IP_HOUR);
    return { b, max: Math.max(0, Math.min(b.tok, IP_HOUR - b.hour)) };
  }

  botOn() { return !!(this.env.TURNSTILE_SITEKEY && this.env.TURNSTILE_SECRET); }
  isHuman(ip, now) { const t = this.human.get(ip); return t != null && now - t < HUMAN_MS; }
  // 응답에 붙이는 봇 확인 상태: 켜져 있으면 사이트 키와 통과 여부를 알려 줌
  botInfo(ip, now) { return this.botOn() ? { bot: this.env.TURNSTILE_SITEKEY, human: this.isHuman(ip, now) } : {}; }

  // Turnstile 토큰을 Cloudflare에 확인받고, 통과하면 이 IP를 사람으로 기록
  async verify(request, now, ip) {
    const json = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    if (!this.botOn()) return json({ ok: true, off: true });
    const body = await readJson(request);
    const token = body && typeof body.token === 'string' ? body.token.slice(0, 2048) : '';
    if (!token) return json({ ok: false }, 400);
    const form = new FormData();
    form.append('secret', this.env.TURNSTILE_SECRET);
    form.append('response', token);
    if (ip !== 'local') form.append('remoteip', ip);
    let ok = false;
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      const j = await r.json();
      ok = !!j.success;
    } catch { ok = false; }
    if (ok) this.human.set(ip, now);
    return json({ ok }, ok ? 200 : 403);
  }

  // 사이트 전체 소프트캡: 여유분이 줄면 모두의 인정 비율을 부드럽게 낮추고, 바닥나면 0
  globalAllow(now) {
    const g = this.g;
    g.tok = Math.min(G_BURST, g.tok + (now - g.t) / 1000 * G_RATE);
    g.t = now;
    if (now - g.hourStart > 3600000) { g.hour = 0; g.hourStart = now; }
    const soft = Math.min(1, g.tok / (G_BURST * G_SOFT));
    return { soft, max: Math.max(0, Math.min(g.tok, G_HOUR - g.hour)) };
  }

  async fetch(request) {
    await this.ensureLoaded();
    const now = Date.now();
    const ip = ipOf(request);
    this.sweep(now);
    if (!this.ips.has(ip)) this.ipAllow(ip, now); // 처음 본 시각 기록 (게시판 대기 시간용)
    const url = new URL(request.url);
    if (url.pathname === '/api/verify') return request.method === 'POST' ? this.verify(request, now, ip) : Response.json(this.botInfo(ip, now));
    if (url.pathname === '/api/board') return this.board(request, url, now, ip);
    if (url.pathname === '/api/dex') return this.dex(request, url, now, ip);
    if (url.pathname === '/api/rank') {
      const me = String(url.searchParams.get('client') || '');
      if (ID_RE.test(me) && !this.contrib.has(me)) await this.getContrib(me);
      return this.rank(url);
    }
    const res = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    const qtab = url.searchParams.get('tab');
    if (request.method === 'GET' && qtab && ID_RE.test(qtab)) {
      const c = this.clients.get(qtab);
      this.clients.set(qtab, { t: now, post: c ? c.post : 0, tok: c ? c.tok : undefined, ip }); // 속도 제한 기준(post)은 POST 때만 갱신
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
        if (this.lb[id]) { delete this.lb[id]; this.lbDirty = true; }
        await this.save();
        return res({ total: this.total, online: this.online(now), removed: mine, ...this.botInfo(ip, now) });
      }
      let delta = Number(body.delta);
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      // 1) 탭 기준: 마지막 요청 이후 지난 시간에 비례한 만큼만 인정
      // (토큰 버킷: 연달아 보내도 여유분이 매번 새로 생기지 않음)
      const c = this.clients.get(tab);
      const tabTok = c && c.post ? Math.min(BURST, (c.tok ?? BURST) + (now - c.post) / 1000 * MAX_RATE) : BURST;
      // 2) IP 기준: 탭 id를 바꿔가며 보내도 IP당 초당·시간당 상한을 넘을 수 없음
      const { b, max } = this.ipAllow(ip, now);
      // 3) IP 대역 기준: 같은 데이터센터 프록시를 여러 개 써도 대역 전체 상한
      const nb = bucket(this.nets, netOf(ip), now, NET_RATE, NET_BURST, NET_HOUR);
      const netMax = Math.max(0, Math.min(nb.tok, NET_HOUR - nb.hour));
      // 4) 연구원 기준: 한 사람 id로 여러 IP에서 보내도 시간당 상한
      let ch = this.cHour.get(id);
      if (!ch || now - ch.hourStart > 3600000) { ch = { hour: 0, hourStart: now }; this.cHour.set(id, ch); }
      const cMax = Math.max(0, CLIENT_HOUR - ch.hour);
      // 5) 전역 소프트캡
      const gl = this.globalAllow(now);
      // 6) 봇 확인을 안 거친 IP는 일부만 인정
      if (this.botOn() && !this.isHuman(ip, now)) delta *= UNVERIFIED_MUL;
      delta = Math.min(delta * gl.soft, tabTok, max, netMax, cMax, gl.max);
      delta = Math.max(0, delta);
      b.tok -= delta; b.hour += delta;
      nb.tok -= delta; nb.hour += delta;
      ch.hour += delta;
      this.g.tok -= delta; this.g.hour += delta;
      this.total += delta;
      const myC = (await this.getContrib(id)) + delta;
      this.contrib.set(id, myC);
      this.dirty.add(id);
      const name = cleanText(body.name, NAME_MAX);
      if (delta > 0 || (name && this.lb[id])) this.updateRank(id, myC, name);
      this.clients.set(tab, { t: now, post: now, tok: tabTok - delta, ip });
      if (now - this.lastSave > SAVE_EVERY_MS) {
        await this.save();
      } else {
        // 마지막 몇 초 분량이 유실되지 않도록 알람으로 한 번 더 저장
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) await this.ctx.storage.setAlarm(now + SAVE_EVERY_MS);
      }
    }

    return res({ total: this.total, online: this.online(now), ...this.botInfo(ip, now) });
  }

  // 연구원 코드별 도감: 같은 코드를 쓰는 기기끼리 발견한 레시피를 합쳐서 공유
  async dex(request, url, now, ip) {
    const res = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    if (request.method === 'GET') {
      const id = String(url.searchParams.get('client') || '');
      if (!ID_RE.test(id)) return res({ error: 'bad client' }, 400);
      return res({ found: (await this.ctx.storage.get('d:' + id)) || [] });
    }
    const body = await readJson(request);
    if (!body || !Array.isArray(body.found)) return res({ error: 'bad request' }, 400);
    const id = String(body.client || '');
    if (!ID_RE.test(id)) return res({ error: 'bad client' }, 400);
    const cur = (await this.ctx.storage.get('d:' + id)) || [];
    const set = new Set(cur);
    for (const v of body.found.slice(0, DEX_MAX)) if (typeof v === 'string' && DEX_ID_RE.test(v) && set.size < DEX_MAX) set.add(v);
    if (set.size === cur.length) return res({ found: cur });
    const b = bucket(this.dexW, ip, now, DEX_IP_RATE, DEX_IP_BURST, DEX_IP_HOUR);
    if (b.tok < 1 || b.hour >= DEX_IP_HOUR) return res({ error: 'slow down', found: cur }, 429);
    b.tok -= 1; b.hour += 1;
    const out = [...set];
    await this.ctx.storage.put('d:' + id, out);
    return res({ found: out });
  }

  async alarm() {
    await this.ensureLoaded();
    await this.save();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stir' || url.pathname === '/api/board' || url.pathname === '/api/rank' || url.pathname === '/api/verify' || url.pathname === '/api/dex') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const stub = env.COUNTER.get(env.COUNTER.idFromName('global'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
