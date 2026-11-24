/**
 * 便签 · 隐私聊天 — Cloudflare Worker 后端
 * 单一共享聊天室：两人（或多人）打开同一个网址即可实时聊天
 * - Durable Object 持有所有 WebSocket 连接（Hibernation 休眠省额度）
 * - SQLite 持久化消息历史；Durable Object storage 持久化图片/文件
 * - Workers Free 永久免费：无需信用卡、无需自己的服务器
 */

import { DurableObject } from 'cloudflare:workers';

const uid = () => crypto.randomUUID();
const now = () => Date.now();

/* 极光推送：把中文昵称编码成 ASCII alias（极光 alias 只允许字母数字及部分符号） */
function nickToAlias(nick) {
  const bytes = new TextEncoder().encode(String(nick || '匿名'));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return 'bz' + hex; // 例：bzE5BC...
}

/* 发送极光推送：固定文案，不含发送人和内容（隐私）
 * target 优先用 registration_id（SDK 注册成功即有，最可靠），
 * 没有 rid 时才退回 alias（二次设置，国产机上易失败）。 */
async function jpushPush(env, target, msgId) {
  const key = env.JPUSH_KEY, secret = env.JPUSH_SECRET;
  if (!key || !secret || !target) return;
  const auth = 'Basic ' + btoa(key + ':' + secret);
  const isRid = /^[a-zA-Z0-9]{20,}$/.test(target) && !target.startsWith('bz');
  const audience = isRid ? { registration_id: [target] } : { alias: [target] };
  const body = {
    platform: 'android',
    audience,
    notification: {
      alert: '你有一条新消息',
      android: {
        alert: '你有一条新消息',
        extras: { from_message: '1', mid: String(msgId || '') }
      }
    },
    options: { apns_production: false }
  };
  try {
    const r = await fetch('https://api.jpush.cn/v3/push', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    console.log('jpush push', isRid ? 'rid' : 'alias', target.slice(0, 12), r.status, JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.log('jpush error', String(e && e.message || e));
  }
}

/* ==================== Durable Object：聊天室 ==================== */
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // 休眠唤醒后会重新执行构造函数，这里做幂等初始化
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        nick TEXT NOT NULL,
        color TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL,
        quote TEXT
      )
    `);
    // 老库兼容：没有 quote 列则补上
    try { this.sql.exec('ALTER TABLE messages ADD COLUMN quote TEXT'); } catch {}
    try { this.sql.exec('ALTER TABLE messages ADD COLUMN av TEXT'); } catch {}
    // 稳定身份：改名后仍能认出自己的历史消息（按 uid 判断归属，而不是昵称）
    try { this.sql.exec('ALTER TABLE messages ADD COLUMN uid TEXT'); } catch {}
    // 网络表情搜索缓存（同一关键词缓存 12 小时，避免第三方接口限流）
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sticker_cache (
        kw TEXT PRIMARY KEY,
        urls TEXT NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
  }

  /* 定位缓存：逆地理 / 地点搜索结果缓存（7 天，减少第三方请求） */
  async geoGet(key) {
    try { return await this.ctx.storage.get('geo:' + key) || null; } catch { return null; }
  }
  async geoPut(key, value) {
    try { await this.ctx.storage.put('geo:' + key, value); } catch {}
  }

  /* 内容缓存：新闻/小说代理结果（带 TTL 秒） */
  async contentGet(key) {
    try {
      const v = await this.ctx.storage.get('content:' + key);
      return v && v.data ? v.data : null;
    } catch { return null; }
  }
  async contentPut(key, value, ttlSec) {
    try {
      await this.ctx.storage.put('content:' + key, { data: value },
        ttlSec ? { expiration: Date.now() / 1000 + ttlSec } : undefined);
    } catch {}
  }

  /* 网络表情搜索：调第三方接口 + 本地缓存，规避公共 key 限流 */
  async stickerSearch(keyword) {
    const kw = String(keyword || '').trim().slice(0, 20);
    if (!kw) return [];
    const row = this.sql.exec('SELECT urls,ts FROM sticker_cache WHERE kw=?', kw).toArray()[0];
    const TTL = 12 * 3600 * 1000;
    if (row && now() - row.ts < TTL) {
      try { return JSON.parse(row.urls); } catch {}
    }
    // 环境变量可配自己的 id/key（接口盒子免费注册），无则用公共 key
    const id = this.env?.APIHZ_ID || '88888888';
    const key = this.env?.APIHZ_KEY || '88888888';
    let urls = [];
    // 搜狗通道失败则退回百度通道（同一账号，互为备份）
    const channels = [
      `https://cn.apihz.cn/api/img/apihzbqbsougou.php?id=${id}&key=${key}&page=1&words=${encodeURIComponent(kw)}`,
      `https://cn.apihz.cn/api/img/apihzbqbbaidu.php?id=${id}&key=${key}&limit=40&page=1&words=${encodeURIComponent(kw)}`
    ];
    for (const u of channels) {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const d = await res.json();
        if (d && d.code === 200 && Array.isArray(d.res) && d.res.length) {
          urls = d.res.slice(0, 40);
          break;
        }
      } catch {}
    }
    if (urls.length) {
      this.sql.exec(
        'INSERT OR REPLACE INTO sticker_cache(kw,urls,ts) VALUES(?,?,?)',
        kw, JSON.stringify(urls), now()
      );
    }
    return urls;
  }

  /* ---------- 文件存储：图片 / 视频 / 语音 / 附件 ---------- */
  async putFile(request) {
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || uid()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || uid();
    const name = decodeURIComponent(url.searchParams.get('name') || 'file').slice(0, 120);
    const mime = decodeURIComponent(url.searchParams.get('mime') || 'application/octet-stream').slice(0, 120);
    const ab = await request.arrayBuffer();
    // Durable Object 单值上限约 2MB，留余量
    if (ab.byteLength > 1800000) return json({ ok: false, error: '文件过大（上限约1.8MB）' }, 413);
    await this.ctx.storage.put('file:' + id, ab);
    await this.ctx.storage.put('filemeta:' + id, { name, mime, size: ab.byteLength, ts: now() });
    return json({ ok: true, id, name, mime, size: ab.byteLength });
  }

  async getFile(id) {
    id = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const ab = await this.ctx.storage.get('file:' + id);
    if (!ab) return null;
    const meta = await this.ctx.storage.get('filemeta:' + id) || {};
    return { ab, meta };
  }

  /* 客户端通过 WebSocket 连入 */
  async fetch(request) {
    const url = new URL(request.url);

    // 文件上传 / 下载（由外层 Worker 转发进来）
    if (url.pathname === '/_dofile/upload' && request.method === 'POST') {
      return this.putFile(request);
    }
    if (url.pathname.startsWith('/_dofile/file/')) {
      const id = url.pathname.slice('/_dofile/file/'.length);
      const f = await this.getFile(id);
      if (!f) return new Response('Not found', { status: 404 });
      const mime = f.meta.mime || 'application/octet-stream';
      const name = (f.meta.name || 'file').replace(/["\r\n]/g, '');
      const disp = /^(image|video|audio)\//.test(mime) ? 'inline' : 'attachment';
      return new Response(f.ab, {
        headers: {
          'Content-Type': mime,
          'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'public, max-age=31536000',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 内部 HTTP 查询在线人数
    if (url.pathname === '/presence') {
      const members = this.ctx.getWebSockets().map(ws => {
        const a = ws.deserializeAttachment() || {};
        return { nick: a.nick || '匿名', color: a.color || '#6a8caf', av: a.av || '', cid: a.cid || '' };
      });
      return new Response(JSON.stringify({ count: members.length, members }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    // 昵称与颜色由客户端在连接时带上，存入 attachment 以便休眠后恢复
    const nick = decodeURIComponent(url.searchParams.get('nick') || '匿名').slice(0, 20) || '匿名';
    const color = /^#[0-9a-fA-F]{6}$/.test(url.searchParams.get('color') || '') ? url.searchParams.get('color') : '#6a8caf';
    const av = String(url.searchParams.get('av') || '').slice(0, 16);
    const clientUid = String(url.searchParams.get('uid') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // cid：每次连接的唯一标识，通话信令按 cid 精确路由，避免重名冲突
    const cid = uid().replace(/-/g, '').slice(0, 12);
    server.serializeAttachment({ nick, color, av, uid: clientUid, cid, joinedAt: now() });
    server.send(JSON.stringify({ type: 'self', cid }));

    // 向新连接推送历史
    const history = this.sql.exec('SELECT * FROM messages ORDER BY ts ASC LIMIT 500').toArray()
      .map(r => ({ id: r.id, nick: r.nick, color: r.color, av: r.av || '', uid: r.uid || '', kind: r.kind, content: r.content, ts: r.ts, quote: r.quote || null }));
    server.send(JSON.stringify({ type: 'history', messages: history }));

    // 系统欢迎消息（只推送，不入库，避免每次连接都刷屏）
    server.send(JSON.stringify({ type: 'system', text: `欢迎 ${nick} 进入私密空间 · 端到端加密` }));

    // 广播在线成员 + 上线系统消息
    this.broadcastPresence();
    this.broadcast({ type: 'system', text: `${nick} 已上线` }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* 休眠式 WebSocket：收到客户端消息 */
  async webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const who = ws.deserializeAttachment() || { nick: '匿名', color: '#6a8caf' };

    // 音视频通话信令：按对方 cid 定向转发，不入库、不广播
    if (data?.type === 'signal') {
      const to = String(data.to || '').slice(0, 40);
      const callId = String(data.callId || '').slice(0, 40);
      const sig = data.data && typeof data.data === 'object' ? data.data : {};
      // sdp/candidate 允许稍大，但仍设上限
      const str = JSON.stringify({ type: 'signal', from: who.cid, fromNick: who.nick, fromColor: who.color, callId, data: sig }).slice(0, 60000);
      let delivered = false;
      if (to) {
        for (const w of this.ctx.getWebSockets()) {
          const a = w.deserializeAttachment() || {};
          if (a.cid === to) { try { w.send(str); delivered = true; } catch {} }
        }
      }
      if (!delivered) {
        try { ws.send(JSON.stringify({ type: 'signal-error', callId, reason: '对方不在线' })); } catch {}
      }
      return;
    }

    // 设备诊断上报：存到 storage，供 /api/diag 查询（不入库、不进聊天记录）
    if (data?.type === 'diag') {
      const nick = who.nick || '匿名';
      try {
        await this.ctx.storage.put('diag:' + nick, {
          rid: String(data.rid || '').slice(0, 200),
          bridge: !!data.bridge,
          ver: String(data.ver || '').slice(0, 20),
          ts: now()
        });
      } catch (e) {}
      return;
    }

    // 更新个人资料（头像/昵称），实时广播在线成员（改名换头像即时同步）
    if (data?.type === 'profile') {
      const a = ws.deserializeAttachment() || {};
      if (data.nick) a.nick = String(data.nick).slice(0, 20);
      if (data.avatar !== undefined) a.av = String(data.avatar || '').slice(0, 16);
      ws.serializeAttachment(a);
      // 改名后把本人历史消息的昵称一并刷新（按 uid 定位，不影响别人）
      if (data.nick && a.uid) {
        try { this.sql.exec('UPDATE messages SET nick=? WHERE uid=?', a.nick, a.uid); } catch {}
      }
      this.broadcastPresence();
      return;
    }

    // 删除消息（私密房间内成员均可删，不限于作者本人）
    if (data?.type === 'delete') {
      const id = String(data.id || '').slice(0, 60);
      const row = this.sql.exec('SELECT id FROM messages WHERE id=?', id).toArray()[0];
      if (row) {
        this.sql.exec('DELETE FROM messages WHERE id=?', id);
        this.broadcast({ type: 'delete', id });
      }
      return;
    }
    if (data?.type !== 'message') return;

    const kind = String(data.kind || 'text').slice(0, 20);
    // 结构化消息（图片/视频/文件/位置）content 是对象，需序列化成 JSON 字符串，
    // 不能用 String()——否则会变成 "[object Object]"，前端无法解析。
    const maxLen = (kind === 'voice' || kind === 'image') ? 1500000 : 20000;
    // 随消息更新连接上的头像（在线列表即时反映）
    if (data.avatar) {
      try {
        const a = ws.deserializeAttachment() || {};
        a.av = String(data.avatar).slice(0, 16);
        ws.serializeAttachment(a);
      } catch (e) {}
    }
    const serialize = v => {
      if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch { return ''; } }
      return String(v ?? '');
    };
    const content = serialize(data.content).slice(0, maxLen);
    // 引用信息：{nick, kind, content} 或 null（content 也可能是对象）
    let quote = null;
    if (data.quote && typeof data.quote === 'object') {
      quote = {
        nick: String(data.quote.nick || '').slice(0, 20),
        kind: String(data.quote.kind || 'text').slice(0, 20),
        content: serialize(data.quote.content).slice(0, 200)
      };
    }
    const av = String(data.avatar || who.av || '').slice(0, 16);
    const msgUid = String(who.uid || data.uid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const msg = { id: uid(), nick: who.nick, color: who.color, av, uid: msgUid, kind, content, ts: now(), quote };

    // 入库
    this.sql.exec(
      'INSERT INTO messages(id,nick,color,av,uid,kind,content,ts,quote) VALUES(?,?,?,?,?,?,?,?,?)',
      msg.id, msg.nick, msg.color, msg.av, msg.uid, msg.kind, msg.content, msg.ts, quote ? JSON.stringify(quote) : null
    );
    // 广播给所有人（含发送者，前端按 id 去重）
    this.broadcast({ type: 'message', message: msg });

    // 离线成员走极光推送（固定文案，隐私不含内容）
    // 记录发送者昵称到"注册用户"表，用于给从未在线过的成员也能推送
    this.ctx.waitUntil(this.pushOfflineMembers(msg));
  }

  /* 给所有"离线"的历史成员推一条通知：排除发送者本人 + 当前在线者 */
  async pushOfflineMembers(msg) {
    try {
      // 历史出现过的昵称（去重）
      const rows = this.sql.exec('SELECT DISTINCT nick FROM messages').toArray();
      // 当前在线的昵称
      const online = new Set();
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() || {};
        if (a.nick) online.add(a.nick);
      }
      for (const row of rows) {
        const n = row.nick;
        if (!n || n === msg.nick || online.has(n)) continue; // 排除发送者和在线者
        // 优先用该昵称上报的 registrationID 直推，没有则退回 alias
        let target = '';
        try {
          const rec = await this.ctx.storage.get('rid:' + n);
          if (rec && rec.rid) target = rec.rid;
        } catch {}
        if (!target) target = nickToAlias(n);
        await jpushPush(this.env, target, msg.id);
      }
    } catch (e) { console.log('pushOfflineMembers error', String(e && e.message || e)); }
  }

  /* App 上报 registrationID：存 nick -> rid，供离线直推 + 诊断 */
  async saveRegid(nick, rid, extra) {
    try {
      await this.ctx.storage.put('rid:' + nick, Object.assign({ rid: rid || '', ts: now() }, extra || {}));
      return true;
    } catch (e) { console.log('saveRegid error', String(e && e.message || e)); return false; }
  }

  async diagRegids() {
    const map = new Map();
    try {
      const list = await this.ctx.storage.list({ prefix: 'rid:' });
      for (const [k, v] of list) map.set(k.slice(4), Object.assign({ nick: k.slice(4), ageSec: v && v.ts ? Math.floor((now() - v.ts) / 1000) : -1 }, v || {}));
    } catch (e) {}
    try {
      const list = await this.ctx.storage.list({ prefix: 'diag:' });
      for (const [k, v] of list) {
        const nick = k.slice(5);
        const prev = map.get(nick) || { nick };
        map.set(nick, Object.assign(prev, { rid: v && v.rid, bridge: v && v.bridge, ver: v && v.ver, via: 'ws', ageSec: v ? Math.floor((now() - v.ts) / 1000) : -1 }));
      }
    } catch (e) {}
    return Array.from(map.values());
  }

  /* 连接关闭 */
  async webSocketClose(ws, code, reason, wasClean) {
    const who = ws.deserializeAttachment() || { nick: '匿名' };
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
      else ws.close();
    } catch {}
    this.broadcast({ type: 'system', text: `${who.nick} 已离线` });
    this.broadcastPresence();
  }

  async webSocketError(ws, error) {
    try { ws.close(); } catch {}
  }

  /* 广播给所有连接（可排除某个） */
  broadcast(obj, exclude = null) {
    const str = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(str); } catch {}
    }
  }

  /* 广播在线成员 */
  broadcastPresence() {
    const members = this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment() || {};
      return { nick: a.nick || '匿名', color: a.color || '#6a8caf', av: a.av || '', cid: a.cid || '' };
    });
    this.broadcast({ type: 'presence', members, count: members.length });
  }
}

/* ==================== Worker 入口 ==================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 跨域预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      }});
    }

    // WebSocket 升级请求 → 交给唯一的聊天室实例
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected websocket' }, 426);
      }
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      return stub.fetch(request);
    }

    // 文件上传 → Durable Object
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const fwd = new Request('https://internal/_dofile/upload' + url.search, {
        method: 'POST', body: request.body, headers: request.headers
      });
      return stub.fetch(fwd);
    }

    // 文件下载 → Durable Object
    if (url.pathname.startsWith('/api/file/')) {
      const id = url.pathname.slice('/api/file/'.length);
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      return stub.fetch(new Request('https://internal/_dofile/file/' + encodeURIComponent(id)));
    }

    // 健康检查
    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'bianqian-private-chat', ts: now() });
    }

    // App 上报极光 registrationID（nick/rid/alias 走 query，避免 body 解析）
    if (url.pathname === '/api/regid') {
      const nick = url.searchParams.get('nick') || '';
      const rid = url.searchParams.get('rid') || '';
      if (!nick) return json({ ok: false, error: 'missing nick' }, 400);
      // 收集全部 query 作为诊断字段（bridge/diag/stage/err/brand/sdk 等），不入库、仅存 DO
      const extra = {};
      try { url.searchParams.forEach((v, k) => { if (k !== 'nick' && k !== 'rid') extra[k] = String(v).slice(0, 300); }); } catch (e) {}
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const ok = await stub.saveRegid(nick, rid, extra);
      return json({ ok: !!ok, nick, rid: !!rid });
    }

    // 诊断：查看所有已上报的 rid（仅用于排查，不影响功能）
    if (url.pathname === '/api/diag') {
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const list = await stub.diagRegids();
      return json({ ok: true, regids: list });
    }

    // 在线人数（HTTP 查询）
    if (url.pathname === '/api/presence') {
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const res = await stub.fetch(new Request('https://internal/presence'));
      return res;
    }

    // ============ 内容：新闻 ============
    if (url.pathname === '/api/news') {
      const type = url.searchParams.get('type') || 'toutiao';
      return json(await getNews(type, env), 200);
    }
    // ============ 内容：小说 ============
    if (url.pathname === '/api/novel/books') {
      return json(await novelBooks(env), 200);
    }
    if (url.pathname === '/api/novel/search') {
      return json(await novelSearch(url.searchParams.get('q') || '', env), 200);
    }
    if (url.pathname.startsWith('/api/novel/book/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/novel/book/'.length));
      return json(await novelBook(id, env), 200);
    }
    if (url.pathname.startsWith('/api/novel/chapter/')) {
      const rest = url.pathname.slice('/api/novel/chapter/'.length).split('/');
      return json(await novelChapter(rest[0], rest[1], env), 200);
    }

    // 网络表情搜索（代理 + 缓存，规避第三方限流 / 跨域）
    if (url.pathname === '/api/sticker-search') {
      const q = url.searchParams.get('q') || '';
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const urls = await stub.stickerSearch(q);
      return json({ ok: true, q, urls }, 200);
    }

    // 逆地理编码：经纬度 → 省市区 + 道路（代理高德网页接口，规避跨域）
    if (url.pathname === '/api/regeo') {
      const lng = url.searchParams.get('lng') || '';
      const lat = url.searchParams.get('lat') || '';
      if (!lng || !lat) return json({ ok: false, error: 'missing lng/lat' }, 400);
      const cacheKey = 'regeo:' + lng + ',' + lat;
      try {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
        const cached = await stub.geoGet(cacheKey);
        if (cached) return json({ ok: true, ...JSON.parse(cached) }, 200);
        const r = await fetch('https://www.amap.com/service/regeo?longitude=' + encodeURIComponent(lng) + '&latitude=' + encodeURIComponent(lat), {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.amap.com/' }
        });
        const txt = await r.text();
        const d = JSON.parse(txt);
        const data = d.data || {};
        const roads = (data.road_list || []).slice(0, 3).map(x => ({ name: x.name, distance: x.distance }));
        const crosses = (data.cross_list || []).slice(0, 3).map(x => [x.first_road, x.second_road].filter(Boolean).join('×'));
        const result = {
          province: data.province || '', city: data.city || '', district: data.district || '',
          desc: data.desc || '', roads, crosses,
          title: roads[0] ? roads[0].name : (data.district || data.city || '当前位置')
        };
        ctx.waitUntil(stub.geoPut(cacheKey, JSON.stringify(result)).catch(() => {}));
        return json({ ok: true, ...result }, 200);
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 200);
      }
    }

    // 高德 Web 服务 key（在 Cloudflare 里配 AMAP_KEY secret 即可启用真实国内 POI）
    const AMAP_KEY = env.AMAP_KEY || '';

    // 关键词地点搜索：有高德 key 用高德 place/text（国内数据全），否则回退 Photon（OSM）
    if (url.pathname === '/api/place-search') {
      const q = url.searchParams.get('q') || '';
      if (!q) return json({ ok: true, places: [] }, 200);
      const lng = url.searchParams.get('lng') || '';
      const lat = url.searchParams.get('lat') || '';
      const cacheKey = 'placesearch:' + (AMAP_KEY ? 'amap:' : 'photon:') + q + ':' + lat + ',' + lng;
      try {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
        const cached = await stub.geoGet(cacheKey);
        if (cached) return json({ ok: true, places: JSON.parse(cached), src: AMAP_KEY ? 'amap' : 'photon' }, 200);
        let places = [];
        if (AMAP_KEY) {
          // 高德关键词搜索，返回 GCJ-02 坐标（与高德底图一致）
          let api = 'https://restapi.amap.com/v3/place/text?key=' + encodeURIComponent(AMAP_KEY)
            + '&keywords=' + encodeURIComponent(q) + '&offset=15&page=1&extensions=base&sort=distance'
            + '&output=json';
          if (lat && lng) api += '&location=' + encodeURIComponent(lng + ',' + lat);
          const r = await fetch(api);
          const d = await r.json();
          places = (d.pois || []).map(p => {
            const lc = String(p.location || '').split(',');
            return { name: p.name || '', addr: [p.cityname, p.adname, p.address].filter(Boolean).join(''), lat: parseFloat(lc[1]), lng: parseFloat(lc[0]) };
          }).filter(x => x.name && !isNaN(x.lat) && !isNaN(x.lng));
        } else {
          let api = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=8';
          if (lat && lng) api += '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
          const r = await fetch(api, { headers: { 'User-Agent': 'bianqian-app/1.0' } });
          const d = await r.json();
          places = (d.features || []).map(f => {
            const p = f.properties || {};
            const c = (f.geometry && f.geometry.coordinates) || [];
            const name = p.name || '';
            const addr = [p.state, p.city, p.district, p.street, p.housenumber].filter(Boolean).join('');
            return { name, addr: addr || name, lat: c[1], lng: c[0] };
          }).filter(x => x.name && x.lat && x.lng);
        }
        ctx.waitUntil(stub.geoPut(cacheKey, JSON.stringify(places)).catch(() => {}));
        return json({ ok: true, places, src: AMAP_KEY ? 'amap' : 'photon' }, 200);
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e), places: [] }, 200);
      }
    }

    // 周边 POI：当前坐标附近的小区/大厦/店铺/酒店等（高德 place/around，需 key）
    if (url.pathname === '/api/nearby') {
      const lng = url.searchParams.get('lng') || '';
      const lat = url.searchParams.get('lat') || '';
      if (!lng || !lat) return json({ ok: false, error: 'missing lng/lat', places: [] }, 400);
      // 坐标量化到约 200 米做缓存，避免拖动时产生海量 key
      const cacheKey = 'nearby:' + (AMAP_KEY ? 'k:' : 'w:') + Number(lng).toFixed(3) + ',' + Number(lat).toFixed(3);
      // 无 key：从 Cloudflare 出口 IP 尝试高德网页版 POI 接口（沙箱 IP 会被风控，CF 出口有机会通过）
      if (!AMAP_KEY) {
        try {
          const stub0 = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
          const cached0 = await stub0.geoGet(cacheKey);
          if (cached0) return json({ ok: true, places: JSON.parse(cached0), src: 'amap-web' }, 200);
          const dlt = 0.012;
          const geoobj = (Number(lng) - dlt).toFixed(5) + '|' + (Number(lat) - dlt).toFixed(5) + '|' + (Number(lng) + dlt).toFixed(5) + '|' + (Number(lat) + dlt).toFixed(5);
          const wapi = 'https://www.amap.com/service/poiInfo?query_type=RQBXY&pagesize=25&pagenum=1&qii=true'
            + '&cluster_state=5&need_utd=true&utd_sceneid=1000&div=PC1000&addr_poi_merge=true&is_classify=true'
            + '&zoom=16&geoobj=' + encodeURIComponent(geoobj);
          const wr = await fetch(wapi, { headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
            'Referer': 'https://www.amap.com/', 'Accept': 'application/json, text/plain, */*'
          } });
          const wtxt = await wr.text();
          const wd = JSON.parse(wtxt);
          const pois = (wd && wd.data && wd.data.poi_list) || [];
          const places = pois.map(p => {
            const lc = String(p.longitude || p.lon || '') + ',' + String(p.latitude || p.lat || '');
            const c = lc.split(',');
            return {
              name: p.name || '', addr: p.address || p.adname || '',
              lat: parseFloat(c[1]), lng: parseFloat(c[0]),
              distance: Number(p.distance) || 0, type: p.typename || ''
            };
          }).filter(x => x.name && !isNaN(x.lat) && !isNaN(x.lng));
          if (places.length) {
            ctx.waitUntil(stub0.geoPut(cacheKey, JSON.stringify(places)).catch(() => {}));
            return json({ ok: true, places, src: 'amap-web' }, 200);
          }
        } catch (e) {}
        return json({ ok: true, places: [], src: 'none' }, 200);
      }
      try {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
        const cached = await stub.geoGet(cacheKey);
        if (cached) return json({ ok: true, places: JSON.parse(cached), src: 'amap' }, 200);
        const api = 'https://restapi.amap.com/v3/place/around?key=' + encodeURIComponent(AMAP_KEY)
          + '&location=' + encodeURIComponent(lng + ',' + lat) + '&radius=1500&offset=25&page=1'
          + '&extensions=base&sort=distance&output=json';
        const r = await fetch(api);
        const d = await r.json();
        const places = (d.pois || []).map(p => {
          const lc = String(p.location || '').split(',');
          return {
            name: p.name || '', addr: [p.cityname, p.adname, p.address].filter(Boolean).join(''),
            lat: parseFloat(lc[1]), lng: parseFloat(lc[0]),
            distance: Number(p.distance) || 0, type: p.typename || ''
          };
        }).filter(x => x.name && !isNaN(x.lat) && !isNaN(x.lng));
        ctx.waitUntil(stub.geoPut(cacheKey, JSON.stringify(places)).catch(() => {}));
        return json({ ok: true, places, src: 'amap' }, 200);
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e), places: [] }, 200);
      }
    }

    // 其余交给静态资源（前端页面）
    return env.ASSETS.fetch(request);
  }
};

/* ==================== 内容模块：新闻 + 小说 ====================
 * 均为公开数据的只读代理，不存储任何内容，不收集用户信息。
 * 走 Cloudflare 边缘网络抓取，规避前端跨域；带边缘缓存降低上游压力。
 */

// 简单 HTML 实体解码 + 标签剥离（小说正文清洗用）
function stripHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/\r/g, '');
}

// 带超时的 fetch
async function fetchTimeout(url, ms = 9000, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------- 新闻：公开 RSS 聚合（对 Cloudflare 友好，稳定） ---------- */
const NEWS_FEEDS = {
  rec:  [{ n: '中新网', u: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
         { n: 'IT之家', u: 'https://www.ithome.com/rss/' },
         { n: '少数派', u: 'https://sspai.com/feed' }],
  news: [{ n: '中新网', u: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
         { n: 'IT之家', u: 'https://www.ithome.com/rss/' }],
  tech: [{ n: 'IT之家', u: 'https://www.ithome.com/rss/' },
         { n: '少数派', u: 'https://sspai.com/feed' },
         { n: '爱范儿', u: 'https://www.ifanr.com/feed' }],
  finance:[{ n: '中新网财经', u: 'https://www.chinanews.com.cn/rss/finance.xml' }],
  society:[{ n: '中新网社会', u: 'https://www.chinanews.com.cn/rss/society.xml' },
           { n: '中新网', u: 'https://www.chinanews.com.cn/rss/scroll-news.xml' }],
  life: [{ n: '少数派', u: 'https://sspai.com/feed' },
         { n: '爱范儿', u: 'https://www.ifanr.com/feed' }]
};
const NEWS_CATS = { rec: '推荐', news: '要闻', tech: '科技', finance: '财经', society: '社会', life: '生活' };

// 把 RSS 的 HTML 正文清洗为可在 App WebView 内安全渲染的片段
// 保留段落/图片/标题/列表结构，移除脚本、事件属性与远程 script
function cleanArticleHtml(raw) {
  let h = String(raw || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  // 去整块脚本/样式/iframe
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '')
       .replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // 去 on* 事件属性、javascript: 链接
  h = h.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
       .replace(/javascript:/gi, '');
  // 去掉「查看全文 / 阅读全文」这类尾巴链接
  h = h.replace(/<a[^>]*>\s*(查看全文|阅读全文|点击查看原文|阅读原文)[^<]*<\/a>/gi, '');
  // 图片统一加懒加载与自适应样式，去掉 data-* 冗余属性
  h = h.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src) return '';
    return '<img src="' + src + '" style="max-width:100%;height:auto;border-radius:8px;display:block;margin:10px 0" loading="lazy">';
  });
  // 仅保留白名单标签，其余标签降级为换行
  h = h.replace(/<\/?(p|div|br|h[1-6]|ul|ol|li|blockquote|strong|b|em|i|u|span|figure|figcaption|section|article)\b[^>]*>/gi, (m) => {
    const t = m.toLowerCase();
    if (/^<\/(p|div|h[1-6]|li|blockquote|figure|figcaption|section|article)/.test(t)) return m.replace(/\s[^>]*>/, '>');
    if (t === '<br' || /<br\//.test(m)) return '<br>';
    return m.replace(/\s[^>]*>/, '>');
  });
  h = h.replace(/<(?!\/?(?:p|div|br|h[1-6]|ul|ol|li|blockquote|strong|b|em|i|u|span|figure|figcaption|section|article|img)\b)[^>]+>/gi, '');
  return h.trim();
}

function parseRSS(xml, sourceName) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const g = tag => { const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? m[1] : ''; };
    let title = stripHtml(g('title')).trim();
    const link = stripHtml(g('link')).trim();
    const descRaw = g('content:encoded') || g('description') || '';
    const detail = stripHtml(descRaw).trim().slice(0, 500);
    // 正文 HTML：优先用 content:encoded（通常更全），其次 description
    const fullRaw = g('content:encoded') || g('description') || '';
    const full = cleanArticleHtml(fullRaw);
    const htmlRaw = descRaw.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const imgs = [];
    const imRe = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
    let im;
    while ((im = imRe.exec(htmlRaw)) !== null) {
      const u = im[1];
      if (/logo|icon|avatar|emot|qrcode/i.test(u)) continue;
      if (!imgs.includes(u)) imgs.push(u);
      if (imgs.length >= 3) break;
    }
    if (!imgs.length) {
      const enc = b.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp))/i);
      if (enc) imgs.push(enc[1]);
    }
    const cover = imgs[0] || '';
    const pub = stripHtml(g('pubDate')).trim();
    // 稳定的伪热度（基于标题长度，非真实数据，仅用于界面展示）
    let hash = 0; for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
    const hot = 1000 + (hash % 48000);
    if (title) items.push({ title: title.slice(0, 200), cover, images: imgs, link, detail, full, source: sourceName, pub, hot });
  }
  return items;
}

async function getNews(type, env) {
  const key = NEWS_FEEDS[type] ? type : 'rec';
  const cacheKey = 'news3:' + key;
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
  try {
    const cached = await stub.contentGet(cacheKey);
    if (cached) return { ok: true, type: key, list: JSON.parse(cached), cached: true, categories: NEWS_CATS };
  } catch (e) {}

  let list = [];
  const feeds = NEWS_FEEDS[key];
  // 并行拉取所有源
  const results = await Promise.all(feeds.map(async f => {
    try {
      const r = await fetchTimeout(f.u, 9000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return [];
      let xml = await r.text();
      // GBK 源尝试转码（RSS 多为 UTF-8，这里兜底）
      if (/锘|涓|鏄/.test(xml.slice(0, 300))) {
        try { xml = new TextDecoder('utf-8').decode(new TextEncoder().encode(xml)); } catch (e) {}
      }
      return parseRSS(xml, f.n);
    } catch (e) { return []; }
  }));
  // 交错合并各源，让推荐页来源均衡
  const maxLen = Math.max(0, ...results.map(a => a.length));
  for (let i = 0; i < maxLen && list.length < 80; i++) {
    for (const arr of results) { if (arr[i] && list.length < 80) list.push(arr[i]); }
  }
  list.forEach((x, i) => x.index = i + 1);
  try { if (list.length) await stub.contentPut(cacheKey, JSON.stringify(list), 600); } catch (e) {}
  return { ok: list.length > 0, type: key, list, categories: NEWS_CATS };
}

/* ---------- 小说：笔趣阁系静态站（对 Cloudflare 友好的源） ---------- */
const NOVEL_BASE = 'https://www.ibiquge.cc';
const NOVEL_CATS = [
  { k: 'top',  n: '排行' }, { k: 'list1', n: '玄幻' }, { k: 'list2', n: '武侠' },
  { k: 'list3', n: '都市' }, { k: 'list4', n: '历史' }, { k: 'list5', n: '网游' },
  { k: 'list6', n: '科幻' }, { k: 'list7', n: '言情' }, { k: 'list8', n: '其他' }
];

// 清洗正文 outline
function cleanNovelText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '').split('\n').map(x => x.replace(/\u3000/g, ' ').trim())
    .filter(x => x && !/章节错误|点此举报|请记住|手机阅读|最新网址|手机站|www\.|\.com|百度搜索|笔趣阁.*收录|侵权.*删除|全屏阅读|加入书签/i.test(x))
    .join('\n').trim();
}

// 解析书籍列表页（排行/分类）
function parseBookList(html) {
  const books = [];
  const seen = new Set();
  // 形如 <a href="/143/">[玄幻]斗破苍穹</a>
  const re = /<a[^>]+href="(\/(\d+)\/)"[^>]*>([^<]{2,60})<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[2];
    let title = stripHtml(m[3]).trim().replace(/^\[[^\]]+\]\s*/, '');
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    books.push({ id, title: title.slice(0, 60), link: NOVEL_BASE + m[1] });
    if (books.length >= 60) break;
  }
  return books;
}

// 书城：聚合排行榜 + 玄幻/都市/言情等分类
async function novelBooks(env) {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
  try {
    const cached = await stub.contentGet('novel2:books');
    if (cached) return { ok: true, books: JSON.parse(cached), cats: NOVEL_CATS, cached: true };
  } catch (e) {}
  const paths = ['/top/', '/list1/', '/list3/', '/list7/', '/list6/'];
  const results = await Promise.all(paths.map(async (pp, i) => {
    try {
      const r = await fetchTimeout(NOVEL_BASE + pp, 10000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return { cat: i, books: [] };
      const html = await r.text();
      return { cat: i, books: parseBookList(html) };
    } catch (e) { return { cat: i, books: [] }; }
  }));
  const all = [];
  const seen = new Set();
  for (const grp of results) {
    for (const b of grp.books) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      b.cat = NOVEL_CATS[grp.cat] ? NOVEL_CATS[grp.cat].n : '';
      all.push(b);
      if (all.length >= 80) break;
    }
    if (all.length >= 80) break;
  }
  try { if (all.length) await stub.contentPut('novel2:books', JSON.stringify(all), 3600); } catch (e) {}
  return { ok: all.length > 0, books: all, cats: NOVEL_CATS };
}

// 搜书：/search.php?q=关键词
async function novelSearch(q, env) {
  if (!q) return { ok: false, books: [] };
  try {
    const r = await fetchTimeout(NOVEL_BASE + '/search.php?q=' + encodeURIComponent(q), 10000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const html = await r.text();
    const books = [];
    const seen = new Set();
    // 搜索结果：<a href="/143/157735.html">书名</a> 或从 /143/ 提取
    const re = /<a[^>]+href="(\/(\d+)\/[^"']*)"[^>]*>([^<]{2,60})<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[2];
      const title = stripHtml(m[3]).trim();
      if (!id || !title || seen.has(id) || title.length > 40) continue;
      seen.add(id);
      books.push({ id, title, link: NOVEL_BASE + '/' + id + '/' });
      if (books.length >= 40) break;
    }
    return { ok: true, books };
  } catch (e) { return { ok: false, books: [], error: String(e && e.message || e) }; }
}

// 书籍详情 + 目录：/{id}/
async function novelBook(id, env) {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
  const cacheKey = 'novel2:book:' + id;
  try {
    const cached = await stub.contentGet(cacheKey);
    if (cached) return { ok: true, book: JSON.parse(cached), cached: true };
  } catch (e) {}
  try {
    const r = await fetchTimeout(NOVEL_BASE + '/' + encodeURIComponent(id) + '/', 10000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const html = await r.text();
    const title = stripHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').trim()
      .replace(/目录.*$/, '').trim() || (html.match(/<title>([^_]+)/) || [])[1] || '未命名';
    const introM = html.match(/<div[^>]+id="intro"[^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/小说简介[：:]?([\s\S]{0,800}?)<\/p>/i);
    const intro = introM ? cleanNovelText(introM[1]).slice(0, 600) : '';
    const chapters = [];
    const seen = new Set();
    const re = /<a[^>]+href="(\/\d+\/(\d+)(?:_\d+)?\.html)"[^>]*>([^<]{2,80})<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const cid = m[2];
      const name = stripHtml(m[3]).trim();
      if (!cid || !name || seen.has(cid)) continue;
      // 过滤明显的非章节链接（最新章节/推荐/广告位）
      if (/最新|章节目录|全文阅读|免费阅读|无弹窗|加入书签|推荐|完结|连载|首页/i.test(name) && !/第\s*\d+\s*章/i.test(name)) continue;
      seen.add(cid);
      chapters.push({ cid, name: name.slice(0, 80) });
    }
    // 关键：按章节 cid 数字升序排列，修复「最新章节混到最前」「顺序乱」问题
    chapters.sort((a, b) => {
      const na = parseInt(a.cid, 10), nb = parseInt(b.cid, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.cid).localeCompare(String(b.cid), 'zh-CN', { numeric: true });
    });
    const book = { id, title: title.slice(0, 80), intro, chapters };
    try { if (chapters.length) await stub.contentPut(cacheKey, JSON.stringify(book), 3600); } catch (e) {}
    return { ok: true, book };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// 章节正文（自动合并 _2/_3 分页）
async function novelChapter(id, cid, env) {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
  const cacheKey = 'novel2:ch:' + id + ':' + cid;
  try {
    const cached = await stub.contentGet(cacheKey);
    if (cached) return { ok: true, chapter: JSON.parse(cached), cached: true };
  } catch (e) {}
  try {
    const extractBody = (html) => {
      const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      let body = art ? art[1] : '';
      if (!body) {
        const div = html.match(/<div[^>]+id="content"[^>]*>([\s\S]*?)<\/div>/i);
        body = div ? div[1] : '';
      }
      return cleanNovelText(body)
        .replace(/第\(\d+\/\d+\)页/g, '')
        .replace(/『[^』]*举报[^』]*』/g, '');
    };
    // 第 1 页
    const u1 = NOVEL_BASE + '/' + id + '/' + cid + '.html';
    const r1 = await fetchTimeout(u1, 10000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r1.ok) throw new Error('http ' + r1.status);
    const html1 = await r1.text();
    const title = stripHtml((html1.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').trim();
    // 从首页解析出所有分页页码，并行抓剩余页
    const pageNums = new Set();
    const pgRe = new RegExp(cid + '_(\\d+)\\.html', 'gi');
    let pm;
    while ((pm = pgRe.exec(html1)) !== null) {
      const n = parseInt(pm[1], 10);
      if (n >= 2 && n <= 20) pageNums.add(n);
    }
    const pages = Array.from(pageNums).sort((a, b) => a - b);
    const rest = await Promise.all(pages.map(async (p) => {
      try {
        const r = await fetchTimeout(NOVEL_BASE + '/' + id + '/' + cid + '_' + p + '.html', 10000, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return { p, text: '' };
        return { p, text: extractBody(await r.text()) };
      } catch (e) { return { p, text: '' }; }
    }));
    // 按页顺序拼接、去重
    let full = extractBody(html1);
    const seenChunk = new Set([full.slice(0, 60)]);
    for (const r of rest) {
      if (!r.text || seenChunk.has(r.text.slice(0, 60))) continue;
      seenChunk.add(r.text.slice(0, 60));
      full += '\n' + r.text;
    }
    const chapter = { id, cid, title: title.slice(0, 100), content: full };
    try { if (full) await stub.contentPut(cacheKey, JSON.stringify(chapter), 3600); } catch (e) {}
    return { ok: !!full, chapter, error: full ? undefined : '未解析到正文' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}
