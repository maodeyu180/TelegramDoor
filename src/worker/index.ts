import { Hono } from 'hono';
import type { Context as HonoContext } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import type { Env, Challenge, Update } from './types';
import {
  configured,
  constantEqual,
  dayStart,
  decryptSecret,
  derivedSecret,
  digest,
  encryptSecret,
  isBanned,
  now,
  randomToken,
  validUserId,
} from './security';
import {
  changeUser,
  cleanup,
  getSettings,
  getUser,
  getValue,
  logEvent,
  settingsSchema,
  setValue,
  takeRate,
} from './store';
import { handleUpdate, sendAdminReply } from './bot';
import { ownerCommands, telegram, TelegramError } from './telegram';
import { completeChallenge, failChallenge } from './verification';
import { DatabaseSetupError, ensureDatabase } from './database';

type Context = { Bindings: Env; Variables: { sessionId: string } };
export const app = new Hono<Context>();
const cookieName = 'td_session';

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  if (!configured(c.env))
    return c.json(
      {
        error:
          '请在 Worker 设置 → 变量和机密中配置 ADMIN_PASSWORD（至少8位）、BOT_TOKEN 和 OWNER_ID；仅填写构建变量不会生效。',
      },
      503,
    );
  await next();
});
app.use(
  '*',
  bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: '请求内容过大' }, 413) }),
);
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('x-td-request') !== '1')
      return c.json({ error: '请求来源无效' }, 403);
    if (!c.req.header('content-type')?.includes('application/json'))
      return c.json({ error: '需要 JSON 请求' }, 415);
  }
  await next();
});

app.use('/webhook', async (c, next) => {
  const supplied = c.req.header('x-telegram-bot-api-secret-token') || '';
  if (!supplied || !(await constantEqual(supplied, await derivedSecret(c.env, 'webhook'))))
    return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
app.use('*', async (c, next) => {
  await ensureDatabase(c.env.DB);
  await next();
});

async function readSession(c: HonoContext<Context>) {
  const token = getCookie(c, cookieName);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const id = await digest(`${token}:${c.env.ADMIN_PASSWORD}`);
  const session = await c.env.DB.prepare('SELECT id FROM sessions WHERE id=? AND expires_at>?')
    .bind(id, now())
    .first<{ id: string }>();
  return session?.id || null;
}

app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || 'local';
  const perIp = await takeRate(c.env, `login:${await digest(ip)}`, 10, 900);
  const global = await takeRate(c.env, 'login:global', 100, 900);
  if (!perIp || !global) return c.json({ error: '登录尝试过多，请在 15 分钟后重试。' }, 429);
  const { password } = z.object({ password: z.string().max(1000) }).parse(await c.req.json());
  if (!(await constantEqual(password, c.env.ADMIN_PASSWORD)))
    return c.json({ error: '密码不正确' }, 401);
  const previous = await readSession(c);
  if (previous) await c.env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(previous).run();
  const token = randomToken(32),
    id = await digest(`${token}:${c.env.ADMIN_PASSWORD}`);
  await c.env.DB.prepare('INSERT INTO sessions(id,expires_at) VALUES(?,?)')
    .bind(id, now() + 12 * 3600)
    .run();
  setCookie(c, cookieName, token, {
    path: '/api',
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 12 * 3600,
  });
  return c.json({ ok: true });
});
app.get('/api/auth/session', async (c) => c.json({ authenticated: !!(await readSession(c)) }));
app.post('/api/auth/logout', async (c) => {
  const id = await readSession(c);
  if (id) await c.env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
  deleteCookie(c, cookieName, { path: '/api' });
  return c.json({ ok: true });
});
app.use('/api/admin/*', async (c, next) => {
  const id = await readSession(c);
  if (!id) return c.json({ error: '请先登录' }, 401);
  c.set('sessionId', id);
  await next();
});

const periodSchema = z.enum(['today', '7d', '30d', 'all']);
function period(query: Record<string, string>): { start: number; end: number; offset: number } {
  const range = periodSchema.parse(query.range || 'today');
  const offset = z.coerce
    .number()
    .int()
    .min(-720)
    .max(840)
    .parse(query.offset || '480');
  const start =
    range === 'all'
      ? 0
      : dayStart(now(), offset) - (range === '7d' ? 6 : range === '30d' ? 29 : 0) * 86400;
  return { start, end: now() + 1, offset };
}
app.get('/api/admin/stats', async (c) => {
  const { start, end, offset } = period(c.req.query()),
    env = c.env;
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT
      SUM(CASE WHEN direction='in' AND message_id IS NOT NULL AND reason!='edited' THEN 1 ELSE 0 END) AS received,
      SUM(CASE WHEN status='delivered' AND direction='in' AND reason='relayed' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN status='verified' THEN 1 ELSE 0 END) AS verified
      FROM events WHERE created_at>=? AND created_at<?`,
    ).bind(start, end),
    env.DB.prepare(
      'SELECT COUNT(*) AS users,SUM(CASE WHEN banned_until=-1 OR banned_until>? THEN 1 ELSE 0 END) AS banned FROM users',
    ).bind(now()),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d',created_at,'unixepoch',?) AS day,
      SUM(CASE WHEN status='delivered' AND direction='in' AND reason='relayed' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked
      FROM events WHERE created_at>=? AND created_at<? GROUP BY day ORDER BY day`,
    ).bind(`${offset * 60} seconds`, Math.max(start, dayStart(now(), offset) - 29 * 86400), end),
    env.DB.prepare(
      `SELECT reason,COUNT(*) AS count FROM events WHERE status='blocked' AND created_at>=? AND created_at<? GROUP BY reason ORDER BY count DESC`,
    ).bind(start, end),
  ]);
  const counts = {
    ...(results[0].results[0] as Record<string, unknown>),
    ...(results[1].results[0] as Record<string, unknown>),
  };
  return c.json({
    ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
    chart: results[2].results,
    reasons: results[3].results,
  });
});
app.get('/api/admin/events', async (c) => {
  const query = c.req.query(),
    { start, end } = period(query);
  const status = z
    .enum(['all', 'blocked', 'delivered', 'error', 'verified', 'action'])
    .parse(query.status || 'all');
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(query.page || '1');
  const search = z
    .string()
    .max(100)
    .parse(query.search || '');
  const user = z
    .string()
    .max(20)
    .parse(query.user || '');
  const where = ['e.created_at>=?', 'e.created_at<?'];
  const values: (string | number)[] = [start, end];
  if (status !== 'all') {
    where.push('e.status=?');
    values.push(status);
  }
  if (user) {
    where.push('e.user_id=?');
    values.push(user);
  }
  if (search) {
    where.push(
      "(e.content LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR e.user_id=? OR u.username LIKE ? ESCAPE '\\')",
    );
    const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(term, term, search, term);
  }
  const clause = where.join(' AND '),
    join = 'events e LEFT JOIN users u ON u.id=e.user_id';
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT e.*,u.name,u.username,u.banned_until FROM ${join} WHERE ${clause} ORDER BY e.created_at DESC,e.id DESC LIMIT 25 OFFSET ?`,
    ).bind(...values, (page - 1) * 25),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM ${join} WHERE ${clause}`).bind(...values),
  ]);
  return c.json({
    items: results[0].results,
    total: (results[1].results[0] as { total: number })?.total || 0,
    page,
    pageSize: 25,
  });
});
app.get('/api/admin/users', async (c) => {
  const query = c.req.query(),
    search = z
      .string()
      .max(100)
      .parse(query.search || '');
  const state = z
    .enum(['all', 'banned', 'trusted', 'verified', 'pending'])
    .parse(query.state || 'all');
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(query.page || '1');
  const clauses: string[] = ['1=1'],
    values: (string | number)[] = [];
  if (search) {
    clauses.push("(name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR id=?)");
    const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(term, term, search);
  }
  if (state === 'banned') {
    clauses.push('(banned_until=-1 OR banned_until>?)');
    values.push(now());
  }
  if (state === 'trusted') clauses.push('trusted=1');
  if (state === 'verified' || state === 'pending') {
    clauses.push(
      `banned_until!=-1 AND banned_until<=? AND trusted=0 AND verified_until${state === 'verified' ? '>' : '<='}?`,
    );
    values.push(now(), now());
  }
  const where = clauses.join(' AND ');
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM users WHERE ${where} ORDER BY last_seen DESC LIMIT 25 OFFSET ?`,
    ).bind(...values, (page - 1) * 25),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE ${where}`).bind(...values),
  ]);
  return c.json({
    items: result[0].results,
    total: (result[1].results[0] as { total: number })?.total || 0,
    page,
    pageSize: 25,
  });
});
app.post('/api/admin/users/:id/action', async (c) => {
  const id = c.req.param('id');
  if (!validUserId(id)) return c.json({ error: '用户 ID 无效' }, 400);
  const body = z
    .object({
      action: z.enum(['ban', 'unban', 'trust', 'untrust', 'reset']),
      reason: z.string().max(300).default(''),
      duration: z
        .number()
        .int()
        .min(0)
        .max(365 * 86400)
        .default(0),
    })
    .parse(await c.req.json());
  if (!(await changeUser(c.env, id, body.action, body.reason, body.duration)))
    return c.json({ error: '目标不存在或不能操作管理员' }, 400);
  return c.json({ ok: true });
});
app.post('/api/admin/users/:id/reply', async (c) => {
  const id = c.req.param('id');
  if (!validUserId(id)) return c.json({ error: '用户 ID 无效' }, 400);
  if (!(await takeRate(c.env, 'admin:reply', 20, 60)))
    return c.json({ error: '发送过于频繁，请稍后重试' }, 429);
  const { text } = z.object({ text: z.string().trim().min(1).max(4096) }).parse(await c.req.json());
  await sendAdminReply(c.env, id, text);
  return c.json({ ok: true });
});
app.get('/api/admin/settings', async (c) =>
  c.json({
    ...(await getSettings(c.env)),
    turnstileConfigured: !!(await getValue(c.env, 'turnstileSecret')),
  }),
);
app.put('/api/admin/settings', async (c) => {
  const body = await c.req.json(),
    config = settingsSchema.parse(body);
  const secret = z.string().max(500).optional().parse(body.turnstileSecret);
  if (
    config.verification === 'turnstile' &&
    (!config.turnstileSiteKey || !(secret || (await getValue(c.env, 'turnstileSecret'))))
  )
    return c.json({ error: '启用 Turnstile 前请填写 Site key 和 Secret key' }, 400);
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(JSON.stringify(config)),
  ];
  if (secret)
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('turnstileSecret',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).bind(await encryptSecret(c.env, secret)),
    );
  await c.env.DB.batch(statements);
  await logEvent(c.env, { status: 'action', reason: 'settings', detail: '更新防护设置' });
  return c.json({ ok: true });
});
app.get('/api/admin/status', async (c) => {
  const origin = await getValue(c.env, 'publicOrigin'),
    bot = await getValue(c.env, 'botProfile');
  return c.json({
    connected: !!origin,
    origin,
    bot: bot ? JSON.parse(bot) : null,
    ownerId: c.env.OWNER_ID,
    version: '0.1.0',
  });
});
app.get('/api/admin/webhook', async (c) => {
  const info = await telegram<Record<string, unknown>>(c.env, 'getWebhookInfo');
  const configuredOrigin = await getValue(c.env, 'publicOrigin');
  // Keep the saved canonical origin when the dashboard is opened via another domain.
  const expectedUrl = `${configuredOrigin || new URL(c.req.url).origin}/webhook`;
  return c.json({
    url: info.url,
    expectedUrl,
    matches: info.url === expectedUrl,
    configured: !!configuredOrigin,
    pending: info.pending_update_count,
    lastError: info.last_error_message || null,
    lastErrorAt: info.last_error_date || null,
  });
});
app.post('/api/admin/setup', async (c) => {
  const origin = new URL(c.req.url).origin;
  if (!origin.startsWith('https://'))
    return c.json({ error: '请部署到 HTTPS 地址后连接 Telegram。' }, 400);
  const bot = await telegram<{ id: number; username: string; first_name: string }>(c.env, 'getMe');
  // Do not drop pending updates when reconnecting or upgrading.
  await telegram(c.env, 'setWebhook', {
    url: `${origin}/webhook`,
    secret_token: await derivedSecret(c.env, 'webhook'),
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    max_connections: 1,
    drop_pending_updates: false,
  });
  await setValue(c.env, 'publicOrigin', origin);
  await setValue(
    c.env,
    'botProfile',
    JSON.stringify({ id: bot.id, username: bot.username, name: bot.first_name }),
  );
  const warnings: string[] = [];
  try {
    await telegram(c.env, 'setMyCommands', {
      commands: [
        { command: 'start', description: '开始留言' },
        { command: 'verify', description: '进行人机验证' },
        { command: 'help', description: '使用说明' },
        { command: 'react', description: '引用消息发送 /react 👍 回应；/react clear 撤销' },
      ],
    });
    await telegram(c.env, 'setMyCommands', {
      commands: ownerCommands,
      scope: { type: 'chat', chat_id: c.env.OWNER_ID },
    });
  } catch {
    warnings.push('Webhook 已连接；管理员请先打开机器人发送 /start，然后再次连接以更新命令菜单。');
  }
  await logEvent(c.env, { status: 'action', reason: 'webhook', detail: '已连接 Telegram Webhook' });
  return c.json({ ok: true, bot: bot.username, warnings });
});

app.get('/api/challenge/:id', async (c) => {
  if (!/^[a-f0-9]{32}$/.test(c.req.param('id'))) return c.json({ error: '验证链接无效' }, 400);
  const challenge = await c.env.DB.prepare(
    "SELECT * FROM challenges WHERE id=? AND kind='turnstile' AND expires_at>?",
  )
    .bind(c.req.param('id'), now())
    .first<Challenge>();
  const settings = await getSettings(c.env);
  if (!challenge || settings.verification !== 'turnstile')
    return c.json({ error: '验证链接已失效，请回到 Telegram 发送 /verify。' }, 410);
  return c.json({ siteKey: settings.turnstileSiteKey, expiresAt: challenge.expires_at });
});
app.post('/api/challenge/verify', async (c) => {
  const { id, token } = z
    .object({ id: z.string().regex(/^[a-f0-9]{32}$/), token: z.string().min(1).max(2048) })
    .parse(await c.req.json());
  const ip = c.req.header('cf-connecting-ip') || 'local';
  if (!(await takeRate(c.env, `webverify:${await digest(ip)}`, 20, 60)))
    return c.json({ error: '验证过于频繁' }, 429);
  const settings = await getSettings(c.env),
    challenge = await c.env.DB.prepare(
      "SELECT * FROM challenges WHERE id=? AND kind='turnstile' AND expires_at>?",
    )
      .bind(id, now())
      .first<Challenge>();
  if (!challenge || settings.verification !== 'turnstile')
    return c.json({ error: '验证已失效，请重新获取链接' }, 410);
  const user = await getUser(c.env, challenge.user_id);
  if (!user || isBanned(user) || user.cooldown_until > now())
    return c.json({ error: '当前无法验证，请稍后重试' }, 403);
  const cipher = await getValue(c.env, 'turnstileSecret'),
    publicOrigin = await getValue(c.env, 'publicOrigin');
  if (!cipher || !publicOrigin) return c.json({ error: '管理员尚未完成验证设置' }, 503);
  let secret: string;
  try {
    secret = await decryptSecret(c.env, cipher);
  } catch {
    return c.json({ error: '验证密钥已失效，请管理员在后台重新保存' }, 503);
  }
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, response: token, ...(ip !== 'local' ? { remoteip: ip } : {}) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return c.json({ error: '验证服务暂时不可用，请重试' }, 503);
  const result = await response.json<{
    success: boolean;
    hostname?: string;
    action?: string;
    cdata?: string;
    'error-codes'?: string[];
  }>();
  if (
    result['error-codes']?.some((code) =>
      ['internal-error', 'invalid-input-secret', 'missing-input-secret'].includes(code),
    )
  )
    return c.json({ error: '验证服务配置错误或暂时不可用，请联系管理员' }, 503);
  const ctx = { env: c.env, settings, origin: publicOrigin };
  if (
    !result.success ||
    result.hostname !== new URL(publicOrigin).hostname ||
    result.action !== 'telegramdoor' ||
    result.cdata !== id
  ) {
    await failChallenge(ctx, id, user.id);
    return c.json({ error: '验证未通过，请回到 Telegram 重新获取链接' }, 400);
  }
  if (!(await completeChallenge(ctx, id, user.id, 'turnstile', '')))
    return c.json({ error: '验证链接已被使用或已失效' }, 409);
  return c.json({ ok: true });
});

app.post('/webhook', async (c) => {
  const update = await c.req.json<Update>();
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
    return c.json({ error: 'Invalid update' }, 400);
  const at = now();
  const claimed = await c.env.DB.prepare(
    `INSERT INTO updates(id,state,started_at) VALUES(?,'processing',?)
    ON CONFLICT(id) DO UPDATE SET state='processing',started_at=excluded.started_at,error=''
    WHERE updates.state='failed' OR (updates.state='processing' AND updates.started_at<?) RETURNING id`,
  )
    .bind(update.update_id, at, at - 120)
    .first();
  if (!claimed) {
    const row = await c.env.DB.prepare('SELECT state FROM updates WHERE id=?')
      .bind(update.update_id)
      .first<{ state: string }>();
    return row?.state === 'done'
      ? c.json({ ok: true })
      : c.json({ error: 'Update in progress' }, 503);
  }
  try {
    await handleUpdate(c.env, update, new URL(c.req.url).origin);
    await c.env.DB.prepare("UPDATE updates SET state='done',finished_at=? WHERE id=?")
      .bind(now(), update.update_id)
      .run();
    return c.json({ ok: true });
  } catch (error) {
    const detail =
      error instanceof TelegramError ? error.description : '消息处理异常，请检查数据库和连接';
    await c.env.DB.prepare("UPDATE updates SET state='failed',error=? WHERE id=?")
      .bind(detail, update.update_id)
      .run();
    await logEvent(c.env, {
      id: `update:${update.update_id}:failure`,
      status: 'error',
      reason: 'delivery_failed',
      detail,
    });
    if (error instanceof TelegramError && error.retryAfter)
      c.header('Retry-After', String(error.retryAfter));
    return c.json({ error: '暂时无法处理，请重试' }, 503);
  }
});
app.get('/health', async (c) => {
  await c.env.DB.prepare('SELECT key FROM settings LIMIT 1').all();
  return c.json({ ok: true, version: '0.1.0' });
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof DatabaseSetupError) {
    c.header('Retry-After', '5');
    return c.json({ error: error.message }, 503);
  }
  if (error instanceof ZodError)
    return c.json(
      { error: '参数格式不正确', fields: error.issues.map((i) => i.path.join('.')) },
      400,
    );
  if (error instanceof SyntaxError) return c.json({ error: 'JSON 格式不正确' }, 400);
  if (error instanceof HTTPException) return c.json({ error: '请求格式不正确' }, error.status);
  if (error instanceof TelegramError)
    return c.json({ error: error.description }, error.code === 429 ? 429 : 502);
  // Never log request bodies, Bot Tokens, passwords, or database error strings.
  console.error('TelegramDoor request failed', { path: c.req.path, type: error.name });
  return c.json({ error: '服务暂时不可用，请检查配置、数据库迁移和网络。' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!configured(env)) return;
    ctx.waitUntil(
      (async () => {
        await ensureDatabase(env.DB);
        await cleanup(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
