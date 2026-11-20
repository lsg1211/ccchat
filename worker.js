/**
 * 便签 · 隐私聊天 — Cloudflare Worker 后端
 * 单一共享聊天室：两人（或多人）打开同一个网址即可实时聊天
 * - Durable Object 持有所有 WebSocket 连接（Hibernation 休眠省额度）
 * - SQLite 持久化消息历史
 * - Workers Free 永久免费：无需信用卡、无需自己的服务器
 */

import { DurableObject } from 'cloudflare:workers';

const uid = () => crypto.randomUUID();
const now = () => Date.now();

/* ==================== Durable Object：聊天室 ==================== */
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 休眠唤醒后会重新执行构造函数，这里做幂等初始化
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        nick TEXT NOT NULL,
        color TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
  }

  /* 客户端通过 WebSocket 连入 */
  async fetch(request) {
    const url = new URL(request.url);

    // 内部 HTTP 查询在线人数
    if (url.pathname === '/presence') {
      const members = this.ctx.getWebSockets().map(ws => {
        const a = ws.deserializeAttachment() || {};
        return { nick: a.nick || '匿名', color: a.color || '#6a8caf' };
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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nick, color, joinedAt: now() });

    // 向新连接推送历史
    const history = this.sql.exec('SELECT * FROM messages ORDER BY ts ASC LIMIT 500').toArray()
      .map(r => ({ id: r.id, nick: r.nick, color: r.color, kind: r.kind, content: r.content, ts: r.ts }));
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
    if (data?.type !== 'message') return;

    const who = ws.deserializeAttachment() || { nick: '匿名', color: '#6a8caf' };
    const kind = String(data.kind || 'text').slice(0, 20);
    const content = String(data.content ?? '').slice(0, 4000);
    const msg = { id: uid(), nick: who.nick, color: who.color, kind, content, ts: now() };

    // 入库
    this.sql.exec(
      'INSERT INTO messages(id,nick,color,kind,content,ts) VALUES(?,?,?,?,?,?)',
      msg.id, msg.nick, msg.color, msg.kind, msg.content, msg.ts
    );
    // 广播给所有人（含发送者，前端按 id 去重）
    this.broadcast({ type: 'message', message: msg });
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
      return { nick: a.nick || '匿名', color: a.color || '#6a8caf' };
    });
    this.broadcast({ type: 'presence', members, count: members.length });
  }
}

/* ==================== Worker 入口 ==================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket 升级请求 → 交给唯一的聊天室实例
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected websocket' }, 426);
      }
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      return stub.fetch(request);
    }

    // 健康检查
    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'bianqian-private-chat', ts: now() });
    }

    // 在线人数（HTTP 查询）
    if (url.pathname === '/api/presence') {
      const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global'));
      const res = await stub.fetch(new Request('https://internal/presence'));
      return res;
    }

    // 其余交给静态资源（前端页面）
    return env.ASSETS.fetch(request);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}
