/**
 * Stir & Evolve — 모두의 젓기 횟수를 합산하는 Cloudflare Worker
 *
 *  GET  /api/stir                     → { total, online }
 *  POST /api/stir  { delta, client }  → { total, online }
 *  POST /api/stir  { reset: true, client } → 그 클라이언트가 보탠 만큼 전체에서 빼고 { total, online, removed }
 *
 *  GET  /api/board?since=ID          → { messages:[{id,name,text,t}] }   (게시판)
 *  POST /api/board { name, text, tab } → { message } | { error }
 *
 * 전체 합계는 Durable Object(Counter) 하나가 메모리에 들고 있고,
 * 저장소 쓰기는 최대 5초에 한 번만 해서 요청이 많아도 쓰기 비용이 늘지 않습니다.
 * 그 외 경로는 public/ 의 정적 파일(index.html)을 그대로 돌려줍니다.
 */
const SAVE_EVERY_MS = 5000;      // 저장소에 합계를 기록하는 최소 간격
const ONLINE_WINDOW_MS = 15000;  // 이 시간 안에 요청한 클라이언트를 '접속 중'으로 셈
const MAX_RATE = 10;             // 탭(접속)당 초당 최대 인정 젓기 수 (조작 방지)
const BURST = 15;                // 순간 허용 여유분
const BOARD_KEEP = 150;          // 게시판에 보관하는 최근 글 수
const BOARD_GAP_MS = 4000;       // 같은 탭에서 글을 연달아 쓸 수 있는 최소 간격
const NAME_MAX = 16, TEXT_MAX = 200;

export class Counter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.total = null;
    this.lastSave = 0;
    this.clients = new Map(); // 탭 id → 마지막 요청 시각 (접속자 수·속도 제한용)
    this.contrib = new Map(); // client id → 지금까지 보탠 젓기 합계 (초기화 시 빼기 위해 기록)
    this.dirty = new Set();
    this.msgs = null;           // 게시판 글 (최근 BOARD_KEEP개)
    this.lastPost = new Map();  // 탭 id → 마지막 글 시각
  }

  async board(request, url, now) {
    if (this.msgs === null) this.msgs = (await this.ctx.storage.get('board')) || [];
    const json = (o, st = 200) => Response.json(o, { status: st, headers: { 'cache-control': 'no-store' } });
    if (request.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const list = since ? this.msgs.filter(m => m.id > since) : this.msgs.slice(-80);
      return json({ messages: list });
    }
    let body = {};
    try { body = await request.json(); } catch {}
    const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const name = clean(body.name, NAME_MAX) || '익명 연구원';
    const text = clean(body.text, TEXT_MAX);
    if (!text) return json({ error: '내용을 입력해 주세요' }, 400);
    const tab = String(body.tab || 'anon').slice(0, 32);
    if (now - (this.lastPost.get(tab) || 0) < BOARD_GAP_MS) return json({ error: '조금 뒤에 다시 써 주세요' }, 429);
    this.lastPost.set(tab, now);
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

  online(now) {
    let n = 0;
    for (const [id, t] of this.clients) {
      if (now - t < ONLINE_WINDOW_MS) n++;
      else this.clients.delete(id);
    }
    return n;
  }

  async fetch(request) {
    await this.ensureLoaded();
    const now = Date.now();
    const url = new URL(request.url);
    if (url.pathname === '/api/board') return this.board(request, url, now);
    const qtab = url.searchParams.get('tab');
    if (request.method === 'GET' && qtab) this.clients.set(String(qtab).slice(0, 32), now);

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const id = String(body.client || 'anon').slice(0, 32);           // 브라우저 고정 id: 내 기여분(초기화용)
      const tab = String(body.tab || body.client || 'anon').slice(0, 32); // 탭 id: 접속자 수·속도 제한
      // 내 젓기 초기화: 이 클라이언트가 보탠 만큼만 전체에서 뺌
      if (body.reset === true) {
        const mine = await this.getContrib(id);
        this.total = Math.max(0, this.total - mine);
        this.contrib.set(id, 0);
        this.dirty.add(id);
        await this.save();
        return Response.json({ total: this.total, online: this.online(now), removed: mine }, { headers: { 'cache-control': 'no-store' } });
      }
      let delta = Number(body.delta);
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      // 마지막 요청 이후 지난 시간에 비례한 만큼만 인정
      const last = this.clients.get(tab);
      const allowed = (last ? Math.min(30, (now - last) / 1000) : 2) * MAX_RATE + BURST;
      delta = Math.min(delta, allowed);
      this.total += delta;
      this.contrib.set(id, (await this.getContrib(id)) + delta);
      this.dirty.add(id);
      this.clients.set(tab, now);
      if (now - this.lastSave > SAVE_EVERY_MS) {
        await this.save();
      } else {
        // 마지막 몇 초 분량이 유실되지 않도록 알람으로 한 번 더 저장
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm === null) await this.ctx.storage.setAlarm(now + SAVE_EVERY_MS);
      }
    }

    return Response.json({ total: this.total, online: this.online(now) }, {
      headers: { 'cache-control': 'no-store' },
    });
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
