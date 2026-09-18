import { env as bindings } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/worker/index';
import type { Env, Message, Update, Link, Challenge } from '../src/worker/types';
import { cleanup, defaultSettings, getUser, setValue, touchUser } from '../src/worker/store';
import { dayStart, decryptSecret, derivedSecret, encryptSecret, now } from '../src/worker/security';

const env = bindings as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = 'https://door.example.com';
const userId = '100001';
let nextId = 1000,
  updateId = 0;
let calls: { method: string; body: Record<string, any> }[] = [];
let telegramFailure: { method: string; code: number; description?: string } | null = null;
let turnstileResult: Record<string, unknown> = { success: true };
let webhookInfo: Record<string, unknown>;

function msg(
  id: string,
  text = '你好',
  messageId = ++nextId,
  extra: Partial<Message> = {},
): Message {
  return {
    message_id: messageId,
    chat: { id: Number(id), type: 'private' },
    from: { id: Number(id), first_name: `用户${id}`, username: `person${id}` },
    text,
    ...extra,
  };
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'x-td-request': '1',
        origin,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}
async function login() {
  const response = await request('/api/auth/login', 'POST', { password: env.ADMIN_PASSWORD });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function webhook(update: Partial<Update>) {
  return request('/webhook', 'POST', { update_id: ++updateId, ...update }, undefined, {
    'x-telegram-bot-api-secret-token': await derivedSecret(env, 'webhook'),
  });
}
async function verified(id = userId) {
  await touchUser(env, { id: Number(id), first_name: `用户${id}` });
  await env.DB.prepare('UPDATE users SET verified_until=? WHERE id=?')
    .bind(now() + 86400, id)
    .run();
}
async function config(values: Record<string, unknown>) {
  await setValue(env, 'config', JSON.stringify({ ...defaultSettings, ...values }));
}
async function incoming() {
  await verified();
  const message = msg(userId);
  const response = await webhook({ message });
  expect(response.status).toBe(200);
  return (await env.DB.prepare('SELECT * FROM message_links WHERE source_message=?')
    .bind(message.message_id)
    .first<Link>())!;
}
async function callback(id: string, data: string, chatMessage: number) {
  return webhook({
    callback_query: {
      id: `query${++nextId}`,
      from: { id: Number(id), first_name: '点击者' },
      data,
      message: msg(id, '', chatMessage),
    },
  });
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  nextId = 1000;
  updateId = 0;
  calls = [];
  telegramFailure = null;
  turnstileResult = { success: true };
  webhookInfo = { url: `${origin}/webhook`, pending_update_count: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
        calls.push({ method: 'siteverify', body });
        return Response.json(turnstileResult);
      }
      if (!url.startsWith(`https://api.telegram.org/bot${env.BOT_TOKEN}/`))
        throw new Error('Unexpected external request');
      const method = url.split('/').at(-1)!;
      calls.push({ method, body });
      if (telegramFailure?.method === method)
        return Response.json({
          ok: false,
          error_code: telegramFailure.code,
          description: telegramFailure.description || 'mock failure',
          parameters: { retry_after: 3 },
        });
      const result =
        method === 'getMe'
          ? { id: 123456789, username: 'telegramdoor_test_bot', first_name: 'Test' }
          : method === 'getWebhookInfo'
            ? webhookInfo
            : { message_id: ++nextId };
      return Response.json({ ok: true, result });
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe('administration security', () => {
  it('protects admin data, validates configuration and never returns credentials', async () => {
    expect((await request('/api/admin/settings')).status).toBe(401);
    const bad = await app.request(`${origin}/health`, {}, { ...env, ADMIN_PASSWORD: 'seven77' });
    expect(bad.status).toBe(503);
    expect((await bad.json<{ error: string }>()).error).toContain('至少8位');
    const cookie = await login();
    const settings = await request('/api/admin/settings', 'GET', undefined, cookie);
    const output = await settings.text();
    expect(output).not.toContain(env.BOT_TOKEN);
    expect(output).not.toContain(env.ADMIN_PASSWORD);
  });
  it('accepts an eight-character password for health, login and authenticated requests', async () => {
    const shortPasswordEnv = { ...env, ADMIN_PASSWORD: 'eight888' };
    expect((await app.request(`${origin}/health`, {}, shortPasswordEnv)).status).toBe(200);
    const response = await app.request(
      `${origin}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-td-request': '1', origin },
        body: JSON.stringify({ password: shortPasswordEnv.ADMIN_PASSWORD }),
      },
      shortPasswordEnv,
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const settings = await app.request(
      `${origin}/api/admin/settings`,
      { headers: { cookie } },
      shortPasswordEnv,
    );
    expect(settings.status).toBe(200);
    expect(await settings.text()).not.toContain(shortPasswordEnv.ADMIN_PASSWORD);
  });
  it('uses HttpOnly same-site secure cookies and revokes them on logout', async () => {
    const response = await request('/api/auth/login', 'POST', { password: env.ADMIN_PASSWORD });
    const raw = response.headers.get('set-cookie')!;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    const cookie = raw.split(';')[0];
    expect((await request('/api/admin/status', 'GET', undefined, cookie)).status).toBe(200);
    await request('/api/auth/logout', 'POST', {}, cookie);
    expect((await request('/api/admin/status', 'GET', undefined, cookie)).status).toBe(401);
  });
  it('rejects cross-origin writes and requests missing the custom header', async () => {
    const cookie = await login();
    expect(
      (
        await request('/api/admin/settings', 'PUT', defaultSettings, cookie, {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/admin/settings', 'PUT', defaultSettings, cookie, { 'x-td-request': '' }))
        .status,
    ).toBe(403);
  });
  it('limits password guessing and does not trust an arbitrary session cookie', async () => {
    expect(
      (await request('/api/admin/events', 'GET', undefined, `td_session=${'a'.repeat(64)}`)).status,
    ).toBe(401);
    for (let i = 0; i < 10; i++)
      expect((await request('/api/auth/login', 'POST', { password: 'wrong' })).status).toBe(401);
    expect(
      (await request('/api/auth/login', 'POST', { password: env.ADMIN_PASSWORD })).status,
    ).toBe(429);
  });
  it('validates settings and encrypts Turnstile secrets without echoing them', async () => {
    const cookie = await login();
    expect(
      (
        await request(
          '/api/admin/settings',
          'PUT',
          { ...defaultSettings, messagesPerMinute: 0 },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/api/admin/settings',
          'PUT',
          { ...defaultSettings, verification: 'turnstile' },
          cookie,
        )
      ).status,
    ).toBe(400);
    const secret = 'turnstile-secret-test';
    expect(
      (
        await request(
          '/api/admin/settings',
          'PUT',
          {
            ...defaultSettings,
            verification: 'turnstile',
            turnstileSiteKey: 'site',
            turnstileSecret: secret,
          },
          cookie,
        )
      ).status,
    ).toBe(200);
    const cipher = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='turnstileSecret'",
    ).first<{ value: string }>();
    expect(cipher?.value).not.toContain(secret);
    expect(await decryptSecret(env, cipher!.value)).toBe(secret);
    expect(
      await (await request('/api/admin/settings', 'GET', undefined, cookie)).text(),
    ).not.toContain(secret);
  });
  it('connects webhook with generated secret, explicit updates and no dropped messages', async () => {
    const cookie = await login();
    expect((await request('/api/admin/setup', 'POST', {}, cookie)).status).toBe(200);
    const setup = calls.find((c) => c.method === 'setWebhook')!.body;
    expect(setup.url).toBe(`${origin}/webhook`);
    expect(setup.secret_token).toBe(await derivedSecret(env, 'webhook'));
    expect(setup.drop_pending_updates).toBe(false);
    expect(setup.allowed_updates).toContain('edited_message');
    expect(calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(2);
  });
  it('keeps connection configuration across logout and login without reconnecting', async () => {
    const cookie = await login();
    expect((await request('/api/admin/setup', 'POST', {}, cookie)).status).toBe(200);
    await request('/api/auth/logout', 'POST', {}, cookie);
    const nextCookie = await login();
    const response = await request('/api/admin/status', 'GET', undefined, nextCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: true,
      origin,
      bot: { username: 'telegramdoor_test_bot' },
    });
    expect(calls.filter((c) => c.method === 'setWebhook')).toHaveLength(1);
  });
  it.each([
    [`${origin}/webhook`, true],
    ['https://other.example.com/webhook', false],
    ['', false],
  ])('compares Telegram webhook %s with the saved receiver', async (url, matches) => {
    await setValue(env, 'publicOrigin', origin);
    webhookInfo = { url, pending_update_count: 3 };
    const cookie = await login();
    expect(
      await (await request('/api/admin/webhook', 'GET', undefined, cookie)).json(),
    ).toMatchObject({
      url,
      pending: 3,
      matches,
      configured: true,
      expectedUrl: `${origin}/webhook`,
    });
    expect(calls.map((c) => c.method)).toEqual(['getWebhookInfo']);
  });
  it('uses the saved canonical domain when checking via another dashboard address', async () => {
    const canonical = 'https://inbox.example.com';
    await setValue(env, 'publicOrigin', canonical);
    webhookInfo = { url: `${canonical}/webhook`, pending_update_count: 0 };
    const cookie = await login();
    expect(
      await (await request('/api/admin/webhook', 'GET', undefined, cookie)).json(),
    ).toMatchObject({
      matches: true,
      expectedUrl: `${canonical}/webhook`,
    });
  });
  it('distinguishes missing local configuration from an already registered webhook', async () => {
    const cookie = await login();
    expect(
      await (await request('/api/admin/webhook', 'GET', undefined, cookie)).json(),
    ).toMatchObject({
      matches: true,
      configured: false,
      expectedUrl: `${origin}/webhook`,
    });
    expect(
      await env.DB.prepare("SELECT value FROM settings WHERE key='publicOrigin'").first(),
    ).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['getWebhookInfo']);
  });
});

describe('webhook delivery and mapping', () => {
  it('rejects forged webhooks before inserting updates', async () => {
    expect((await request('/webhook', 'POST', { update_id: 1, message: msg(userId) })).status).toBe(
      401,
    );
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM updates').first<{ n: number }>())?.n,
    ).toBe(0);
  });
  it('forwards inbound media natively without added controls and deduplicates updates', async () => {
    await verified();
    const message = msg(userId, undefined, 100, {
      text: undefined,
      photo: [{ file_id: 'photo-id' }],
    });
    expect((await webhook({ update_id: 42, message })).status).toBe(200);
    expect((await webhook({ update_id: 42, message })).status).toBe(200);
    const forwards = calls.filter((c) => c.method === 'forwardMessage');
    expect(forwards).toHaveLength(1);
    expect(forwards[0].body).toEqual({
      chat_id: env.OWNER_ID,
      from_chat_id: userId,
      message_id: 100,
    });
    expect(calls).toHaveLength(1);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status='delivered'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it('routes owner replies and visitor follow-ups to the correct counterpart', async () => {
    const link = await incoming();
    const ownerMessage = msg(env.OWNER_ID, '收到啦', 777, {
      reply_to_message: msg(env.OWNER_ID, '', link.target_message),
    });
    await webhook({ message: ownerMessage });
    const out = calls.filter((c) => c.method === 'copyMessage').at(-1)!.body;
    expect(out.chat_id).toBe(userId);
    expect(out.reply_markup).toBeUndefined();
    expect(calls.filter((c) => c.method === 'forwardMessage')).toHaveLength(1);
    expect(out.reply_parameters.message_id).toBe(link.source_message);
    const ownerLink = (await env.DB.prepare(
      'SELECT * FROM message_links WHERE source_message=777',
    ).first<Link>())!;
    await webhook({
      message: msg(userId, '谢谢', 778, {
        reply_to_message: msg(userId, '', ownerLink.target_message),
      }),
    });
    // Native forwards have attribution but cannot carry reply_parameters.
    expect(calls.filter((c) => c.method === 'forwardMessage').at(-1)!.body).toEqual({
      chat_id: env.OWNER_ID,
      from_chat_id: userId,
      message_id: 778,
    });
    const followUp = (await env.DB.prepare(
      'SELECT * FROM message_links WHERE source_chat=? AND source_message=778',
    )
      .bind(userId)
      .first<Link>())!;
    await webhook({
      message: msg(env.OWNER_ID, '继续回复', 779, {
        reply_to_message: msg(env.OWNER_ID, '', followUp.target_message),
      }),
    });
    expect(calls.filter((c) => c.method === 'copyMessage').at(-1)!.body).toMatchObject({
      chat_id: userId,
      reply_parameters: { message_id: 778 },
    });
  });
  it('does not guess recipients and rejects spoofed owner identity', async () => {
    await incoming();
    calls = [];
    await webhook({ message: msg(env.OWNER_ID, '没有引用对象') });
    await webhook({
      message: msg(userId, '/ban 100002', undefined, {
        from: { id: Number(env.OWNER_ID), first_name: 'fake' },
      }),
    });
    expect(calls).toHaveLength(0);
  });
  it('silently discards unquoted owner text and media even after talking to different visitors', async () => {
    const first = await incoming();
    await verified('100002');
    await webhook({ message: msg('100002', '另一位访客', 50) });
    await webhook({
      message: msg(env.OWNER_ID, '明确回复第一位访客', 777, {
        reply_to_message: msg(env.OWNER_ID, '', first.target_message),
      }),
    });
    const countLinks = () =>
      env.DB.prepare('SELECT COUNT(*) AS n FROM message_links').first<{ n: number }>();
    const countEvents = () =>
      env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
    const linksBefore = await countLinks();
    const eventsBefore = await countEvents();
    calls = [];
    const direct = msg(env.OWNER_ID, '不要发送给最近聊天的人', 778);
    await webhook({ message: direct });
    await webhook({ edited_message: { ...direct, text: '修改也不能触发发送' } });
    await webhook({
      message: msg(env.OWNER_ID, '', undefined, {
        text: undefined,
        photo: [{ file_id: 'owner-photo' }],
      }),
    });
    await webhook({
      message: msg(env.OWNER_ID, '', undefined, {
        text: undefined,
        voice: { file_id: 'owner-voice' },
      }),
    });
    await webhook({
      message: msg(env.OWNER_ID, '管理员自己转发过来的消息', undefined, {
        forward_origin: {
          type: 'user',
          sender_user: { id: Number(userId), first_name: '访客' },
          date: 1,
        },
      }),
    });
    expect(calls).toHaveLength(0);
    expect(await countLinks()).toEqual(linksBefore);
    expect(await countEvents()).toEqual(eventsBefore);
  });
  it('only routes new owner replies quoting delivered visitor messages', async () => {
    const link = await incoming();
    await webhook({
      message: msg(env.OWNER_ID, '已发送的回复', 777, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    const cookie = await login();
    expect(
      (await request(`/api/admin/users/${userId}/reply`, 'POST', { text: '后台回复' }, cookie))
        .status,
    ).toBe(200);
    const mirror = calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(mirror.body.chat_id).toBe(env.OWNER_ID);
    const mirrorLink = (await env.DB.prepare(
      'SELECT * FROM message_links WHERE source_chat=? AND source_message!=777',
    )
      .bind(env.OWNER_ID)
      .first<Link>())!;
    calls = [];
    for (const messageId of [777, mirrorLink.source_message, 999999]) {
      await webhook({
        message: msg(env.OWNER_ID, '引用的不是访客来信', undefined, {
          reply_to_message: msg(env.OWNER_ID, '', messageId),
        }),
      });
    }
    expect(calls).toHaveLength(0);
    await webhook({
      message: msg(env.OWNER_ID, '引用访客来信才发送', undefined, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'copyMessage', body: { chat_id: userId } });
  });
  it('still handles unquoted owner commands instead of treating them as messages to discard', async () => {
    await incoming();
    calls = [];
    for (const command of ['/help', '/stats', `/ban ${userId}`, `/unban ${userId}`]) {
      await webhook({ message: msg(env.OWNER_ID, command) });
    }
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === 'sendMessage' && c.body.chat_id === env.OWNER_ID)).toBe(
      true,
    );
    expect((await getUser(env, userId))!.banned_until).toBe(0);
  });
  it('keeps identical message IDs in different visitor chats isolated', async () => {
    await verified('100001');
    await verified('100002');
    await webhook({ message: msg('100001', '访客甲', 50) });
    await webhook({ message: msg('100002', '访客乙', 50) });
    const links = await env.DB.prepare('SELECT * FROM message_links ORDER BY user_id').all<Link>();
    expect(links.results).toHaveLength(2);
    for (const link of links.results) {
      await webhook({
        message: msg(env.OWNER_ID, `回复${link.user_id}`, undefined, {
          reply_to_message: msg(env.OWNER_ID, '', link.target_message),
        }),
      });
      expect(calls.filter((c) => c.method === 'copyMessage').at(-1)!.body.chat_id).toBe(
        link.user_id,
      );
    }
  });
  it('retries transient Telegram failures and preserves retry_after', async () => {
    await verified();
    telegramFailure = { method: 'forwardMessage', code: 429 };
    const message = msg(userId);
    const first = await webhook({ update_id: 77, message });
    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after')).toBe('3');
    telegramFailure = null;
    expect((await webhook({ update_id: 77, message })).status).toBe(200);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM message_links').first<{ n: number }>())?.n,
    ).toBe(1);
  });
  it('records permanent delivery failures without retrying forever', async () => {
    await verified();
    telegramFailure = {
      method: 'forwardMessage',
      code: 403,
      description: 'bot was blocked by the user',
    };
    expect((await webhook({ message: msg(userId) })).status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status='error'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it('forwards stickers and voice messages through the same reliable mapping', async () => {
    await verified();
    for (const kind of ['sticker', 'voice'])
      await webhook({
        message: msg(userId, '', undefined, { text: undefined, [kind]: { file_id: `${kind}-id` } }),
      });
    expect(calls.filter((c) => c.method === 'forwardMessage')).toHaveLength(2);
  });
  it('still syncs editable legacy copies but applies filters to edited text', async () => {
    const link = await incoming();
    await config({ blockLinks: true });
    calls = [];
    await webhook({ edited_message: msg(userId, '修改后的正文', link.source_message) });
    expect(calls.find((c) => c.method === 'editMessageText')?.body.message_id).toBe(
      link.target_message,
    );
    calls = [];
    await webhook({ edited_message: msg(userId, 'https://spam.example', link.source_message) });
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    expect(await env.DB.prepare("SELECT id FROM events WHERE reason='links'").first()).toBeTruthy();
  });
  it('reports an uneditable native forward without resending it or logging a successful edit', async () => {
    const link = await incoming();
    calls = [];
    telegramFailure = {
      method: 'editMessageText',
      code: 400,
      description: "Bad Request: message can't be edited",
    };
    expect(
      (await webhook({ edited_message: msg(userId, '修改后的内容', link.source_message) })).status,
    ).toBe(200);
    expect(calls.find((c) => c.method === 'sendMessage')?.body).toMatchObject({
      chat_id: userId,
      text: expect.stringContaining('修改未能同步'),
    });
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
    expect(await env.DB.prepare("SELECT id FROM events WHERE reason='edited'").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM events WHERE reason='delivery_failed'").first(),
    ).toBeTruthy();
  });
  it('preserves owner reply editing without adding menus or forwarding owner identity', async () => {
    const link = await incoming();
    await webhook({
      message: msg(env.OWNER_ID, '原回复', 777, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    const out = (await env.DB.prepare(
      'SELECT * FROM message_links WHERE source_chat=? AND source_message=777',
    )
      .bind(env.OWNER_ID)
      .first<Link>())!;
    calls = [];
    await webhook({ edited_message: msg(env.OWNER_ID, '更新的回复', 777) });
    expect(calls).toEqual([
      {
        method: 'editMessageText',
        body: {
          chat_id: userId,
          message_id: out.target_message,
          text: '更新的回复',
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });
  it('uses the actual visitor identity for /who, replies and bans even with a different forward origin', async () => {
    await verified();
    await webhook({
      message: msg(userId, '转发别人的内容', 50, {
        forward_origin: {
          type: 'user',
          sender_user: { id: 999999, first_name: '原作者' },
          date: 1,
        },
      }),
    });
    const link = (await env.DB.prepare('SELECT * FROM message_links').first<Link>())!;
    const reference = msg(env.OWNER_ID, '', link.target_message);
    await webhook({
      message: msg(env.OWNER_ID, '/who', undefined, { reply_to_message: reference }),
    });
    expect(calls.filter((c) => c.method === 'sendMessage').at(-1)!.body.text).toContain(
      `ID：${userId}`,
    );
    await webhook({
      message: msg(env.OWNER_ID, '/ban', undefined, { reply_to_message: reference }),
    });
    expect((await getUser(env, userId))!.banned_until).toBe(-1);
    expect(await getUser(env, '999999')).toBeNull();
    await webhook({
      message: msg(env.OWNER_ID, '/unban', undefined, { reply_to_message: reference }),
    });
    expect((await getUser(env, userId))!.banned_until).toBe(0);
  });
  it('mirrors web replies and stores mappings so visitors can quote and react', async () => {
    await verified();
    const cookie = await login();
    expect(
      (await request(`/api/admin/users/${userId}/reply`, 'POST', { text: '后台回复' }, cookie))
        .status,
    ).toBe(200);
    const link = await env.DB.prepare('SELECT * FROM message_links').first<Link>();
    expect(link?.source_chat).toBe(env.OWNER_ID);
    expect(link?.target_chat).toBe(userId);
    expect(calls.every((c) => c.body.reply_markup === undefined)).toBe(true);
    expect(calls.some((c) => c.method === 'forwardMessage')).toBe(false);
  });
  it('anchors web replies to that visitor’s message without a user-info keyboard', async () => {
    const link = await incoming();
    await verified('100002');
    await webhook({ message: msg('100002', '其他人的消息') });
    calls = [];
    const cookie = await login();
    expect(
      (await request(`/api/admin/users/${userId}/reply`, 'POST', { text: '后台回复' }, cookie))
        .status,
    ).toBe(200);
    expect(calls.find((c) => c.method === 'sendMessage')!.body).toMatchObject({
      chat_id: env.OWNER_ID,
      reply_parameters: { message_id: link.target_message },
    });
    expect(calls.find((c) => c.method === 'copyMessage')!.body).toMatchObject({
      chat_id: userId,
      reply_parameters: { message_id: link.source_message },
    });
    expect(calls.every((c) => c.body.reply_markup === undefined)).toBe(true);
  });
});

describe('verification and anti-spam', () => {
  it('keeps unverified messages out of the owner inbox and requires resend after verification', async () => {
    await webhook({ message: msg(userId, '第一条留言') });
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9);
    expect((await getUser(env, userId))!.verified_until).toBeGreaterThan(now());
    expect(calls.find((c) => c.method === 'editMessageText')!.body).toEqual({
      chat_id: userId,
      message_id: 9,
      text: expect.stringContaining('✅ 验证通过'),
      reply_markup: { inline_keyboard: [] },
    });
    // A successful edit is the persistent confirmation; no extra message is needed.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
    await webhook({ message: msg(userId, '重新发送') });
    expect(calls.some((c) => c.method === 'forwardMessage')).toBe(true);
  });
  it('binds challenges to a user and prevents replay', async () => {
    await webhook({ message: msg(userId, '/start') });
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    await touchUser(env, { id: 100002, first_name: 'Other' });
    await callback('100002', `v:${challenge.id}:${challenge.answer}`, 9);
    expect((await getUser(env, '100002'))!.verified_until).toBe(0);
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9);
    const expiry = (await getUser(env, userId))!.verified_until;
    await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9);
    expect((await getUser(env, userId))!.verified_until).toBe(expiry);
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.body.text).toContain(
      '已通过验证',
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status='verified'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it('sends a visible verification result when the original prompt cannot be edited', async () => {
    await webhook({ message: msg(userId, '/verify') });
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    calls = [];
    telegramFailure = {
      method: 'editMessageText',
      code: 400,
      description: 'Bad Request: message to edit not found',
    };
    expect((await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9)).status).toBe(200);
    expect(calls.find((c) => c.method === 'sendMessage')!.body).toMatchObject({
      chat_id: userId,
      text: expect.stringContaining('✅ 验证通过'),
    });
    expect((await getUser(env, userId))!.verified_until).toBeGreaterThan(now());
    expect(await env.DB.prepare('SELECT * FROM challenges').first()).toBeNull();
    calls = [];
    await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('answerCallbackQuery');
  });
  it('keeps successful verification when callback acknowledgement expires', async () => {
    await webhook({ message: msg(userId, '/verify') });
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    telegramFailure = {
      method: 'answerCallbackQuery',
      code: 400,
      description: 'Bad Request: query is too old',
    };
    expect((await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9)).status).toBe(200);
    expect(calls.find((c) => c.method === 'editMessageText')!.body.text).toContain('✅ 验证通过');
    expect((await getUser(env, userId))!.verified_until).toBeGreaterThan(now());
    calls = [];
    await webhook({ message: msg(userId, '重新发送留言') });
    expect(calls.map((c) => c.method)).toEqual(['forwardMessage']);
  });
  it('does not send duplicate confirmations when the prompt already has the result', async () => {
    await webhook({ message: msg(userId, '/verify') });
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    calls = [];
    telegramFailure = {
      method: 'editMessageText',
      code: 400,
      description: 'Bad Request: message is not modified',
    };
    expect((await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9)).status).toBe(200);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
    expect((await getUser(env, userId))!.verified_until).toBeGreaterThan(now());
  });
  it('expires challenges and imposes cooldown after three wrong attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await webhook({ message: msg(userId, '/verify') });
      const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
      await callback(userId, `v:${challenge.id}:wrong`, 9);
      const result = calls.filter((c) => c.method === 'editMessageText').at(-1)!.body;
      expect(result.text).toContain(i === 2 ? '验证暂时锁定' : '答案不正确');
      expect(result.reply_markup).toEqual({ inline_keyboard: [] });
    }
    expect((await getUser(env, userId))!.cooldown_until).toBeGreaterThan(now());
    await webhook({ message: msg(userId, '/verify') });
    expect(await env.DB.prepare('SELECT * FROM challenges').first()).toBeNull();
  });
  it('does not allow an expired native challenge', async () => {
    await webhook({ message: msg(userId, '/verify') });
    const challenge = (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
    await env.DB.prepare('UPDATE challenges SET expires_at=?')
      .bind(now() - 1)
      .run();
    await callback(userId, `v:${challenge.id}:${challenge.answer}`, 9);
    expect((await getUser(env, userId))!.verified_until).toBe(0);
    expect(calls.find((c) => c.method === 'editMessageText')!.body).toMatchObject({
      chat_id: userId,
      message_id: 9,
      text: expect.stringContaining('这道题已过期'),
      reply_markup: { inline_keyboard: [] },
    });
  });
  it('resets failure counts after the cooldown has elapsed', async () => {
    await touchUser(env, { id: Number(userId), first_name: 'Cooldown' });
    await env.DB.prepare('UPDATE users SET verify_failures=3,cooldown_until=? WHERE id=?')
      .bind(now() - 1, userId)
      .run();
    await webhook({ message: msg(userId, '/verify') });
    expect((await getUser(env, userId))!.verify_failures).toBe(0);
    expect(
      await env.DB.prepare('SELECT * FROM challenges WHERE user_id=?').bind(userId).first(),
    ).toBeTruthy();
  });
  it('supports reply-based temporary ban, silent blocking and unban requiring verification', async () => {
    const link = await incoming();
    await webhook({
      message: msg(env.OWNER_ID, '/ban 1d 重复广告', undefined, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    const user = (await getUser(env, userId))!;
    expect(user.banned_until).toBeGreaterThan(now() + 86000);
    expect(user.ban_reason).toBe('重复广告');
    calls = [];
    await webhook({ message: msg(userId, '骚扰') });
    await webhook({ message: msg(userId, '/start') });
    expect(calls).toHaveLength(0);
    await webhook({ message: msg(env.OWNER_ID, `/unban ${userId}`) });
    expect((await getUser(env, userId))!.banned_until).toBe(0);
    expect((await getUser(env, userId))!.verified_until).toBe(0);
  });
  it('ignores fake admin ban callbacks and refuses to ban owner', async () => {
    const link = await incoming();
    await callback(userId, `ban:${userId}`, 9);
    expect((await getUser(env, userId))!.banned_until).toBe(0);
    const cookie = await login();
    expect(
      (await request(`/api/admin/users/${env.OWNER_ID}/action`, 'POST', { action: 'ban' }, cookie))
        .status,
    ).toBe(400);
    await callback(env.OWNER_ID, `ban:${userId}`, link.target_message);
    expect((await getUser(env, userId))!.banned_until).toBe(-1);
  });
  it('blocks hidden links, normalizes keyword matching and honors white lists', async () => {
    await verified();
    await config({ blockLinks: true, keywords: ['SPAM'] });
    await webhook({
      message: msg(userId, '点击这里', undefined, {
        entities: [{ type: 'text_link', url: 'https://spam.example', offset: 0, length: 4 }],
      }),
    });
    await webhook({ message: msg(userId, 'ＳＰＡＭ') });
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
    await env.DB.prepare('UPDATE users SET trusted=1 WHERE id=?').bind(userId).run();
    await webhook({ message: msg(userId, 'SPAM https://example.com') });
    expect(calls.some((c) => c.method === 'forwardMessage')).toBe(true);
  });
  it('rate limits trusted users and pauses all incoming messages', async () => {
    await verified();
    await env.DB.prepare('UPDATE users SET trusted=1 WHERE id=?').bind(userId).run();
    await config({ messagesPerMinute: 1 });
    await webhook({ message: msg(userId) });
    await webhook({ message: msg(userId) });
    expect(calls.filter((c) => c.method === 'forwardMessage')).toHaveLength(1);
    await config({ paused: true });
    calls = [];
    await webhook({ message: msg(userId) });
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
  });
  it('respects disabled content logging and keeps ban records through cleanup', async () => {
    await verified();
    await config({ storeContent: false, retentionDays: 1 });
    await webhook({ message: msg(userId, 'private-text') });
    expect(
      (await env.DB.prepare('SELECT content FROM events').first<{ content: string }>())?.content,
    ).toBe('');
    await env.DB.prepare('UPDATE users SET banned_until=-1 WHERE id=?').bind(userId).run();
    await env.DB.prepare('UPDATE events SET created_at=?')
      .bind(now() - 2 * 86400)
      .run();
    await env.DB.prepare('UPDATE message_links SET created_at=?')
      .bind(now() - 2 * 86400)
      .run();
    await cleanup(env);
    expect(await env.DB.prepare('SELECT * FROM events').first()).toBeNull();
    expect(await env.DB.prepare('SELECT * FROM message_links').first()).toBeNull();
    expect((await getUser(env, userId))!.banned_until).toBe(-1);
  });
});

describe('reaction bridge', () => {
  it('keeps old reaction buttons working for previously sent messages', async () => {
    const link = await incoming();
    await callback(env.OWNER_ID, `r:${link.id}:0`, link.target_message);
    const call = calls.find((c) => c.method === 'setMessageReaction')!.body;
    expect(call).toMatchObject({
      chat_id: userId,
      message_id: link.source_message,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
    await callback(env.OWNER_ID, `r:${link.id}:clear`, link.target_message);
    expect(calls.filter((c) => c.method === 'setMessageReaction').at(-1)!.body.reaction).toEqual(
      [],
    );
  });
  it('binds buttons to exact recipient/message and blocks reactions from banned users', async () => {
    const link = await incoming();
    await callback('100002', `r:${link.id}:0`, link.target_message);
    await callback(env.OWNER_ID, `r:${link.id}:0`, link.target_message + 100);
    await env.DB.prepare('UPDATE users SET banned_until=-1 WHERE id=?').bind(userId).run();
    await callback(env.OWNER_ID, `r:${link.id}:0`, link.target_message);
    expect(calls.some((c) => c.method === 'setMessageReaction')).toBe(false);
  });
  it('supports /react and user reactions on owner replies', async () => {
    const link = await incoming();
    await webhook({
      message: msg(env.OWNER_ID, '/react ❤️', 888, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    expect(calls.find((c) => c.method === 'setMessageReaction')!.body.reaction[0].emoji).toBe('❤');
    await webhook({
      message: msg(env.OWNER_ID, '回复', 889, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    const out = (await env.DB.prepare(
      'SELECT * FROM message_links WHERE source_message=889',
    ).first<Link>())!;
    await webhook({
      message: msg(userId, '/react 🔥', undefined, {
        reply_to_message: msg(userId, '', out.target_message),
      }),
    });
    expect(calls.filter((c) => c.method === 'setMessageReaction').at(-1)!.body).toMatchObject({
      chat_id: env.OWNER_ID,
      message_id: 889,
      reaction: [{ type: 'emoji', emoji: '🔥' }],
    });
    calls = [];
    await webhook({
      message: msg(userId, '/react clear', undefined, {
        reply_to_message: msg(userId, '', out.target_message),
      }),
    });
    expect(calls.find((c) => c.method === 'setMessageReaction')!.body.reaction).toEqual([]);
    expect(calls.some((c) => c.method === 'forwardMessage')).toBe(false);
  });
  it('lets Telegram accept additional ordinary emoji and explains unsupported ones only to the sender', async () => {
    const link = await incoming();
    calls = [];
    await webhook({
      message: msg(env.OWNER_ID, '/react 🥰', undefined, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
      }),
    });
    expect(calls.find((c) => c.method === 'setMessageReaction')!.body.reaction).toEqual([
      { type: 'emoji', emoji: '🥰' },
    ]);
    calls = [];
    telegramFailure = {
      method: 'setMessageReaction',
      code: 400,
      description: 'Bad Request: REACTION_INVALID',
    };
    await webhook({
      message: msg(userId, '/react 🦄', undefined, {
        reply_to_message: msg(userId, '', link.source_message),
      }),
    });
    const notices = calls.filter((c) => c.method === 'sendMessage');
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toMatchObject({
      chat_id: userId,
      text: expect.stringContaining('不支持回应'),
    });
    expect(calls.some((c) => c.method === 'forwardMessage' || c.method === 'copyMessage')).toBe(
      false,
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE reason='reaction'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it('rejects invalid targets, multiple emoji, custom emoji and banned visitor commands', async () => {
    const link = await incoming();
    calls = [];
    await verified('100002');
    await webhook({
      message: msg('100002', '/react 👍', undefined, {
        reply_to_message: msg('100002', '', link.source_message),
      }),
    });
    for (const text of ['/react', '/react words', '/react 👍👍', '/react 👍 👏']) {
      await webhook({
        message: msg(env.OWNER_ID, text, undefined, {
          reply_to_message: msg(env.OWNER_ID, '', link.target_message),
        }),
      });
    }
    await webhook({
      message: msg(env.OWNER_ID, '/react 👍', undefined, {
        reply_to_message: msg(env.OWNER_ID, '', link.target_message),
        entities: [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: '123' }],
      }),
    });
    await env.DB.prepare('UPDATE users SET banned_until=-1 WHERE id=?').bind(userId).run();
    await webhook({
      message: msg(userId, '/react 👍', undefined, {
        reply_to_message: msg(userId, '', link.source_message),
      }),
    });
    expect(
      calls.some((c) => c.method === 'setMessageReaction' || c.method === 'forwardMessage'),
    ).toBe(false);
  });
  it('requires verification and honors pause and rate limits for visitor reaction commands', async () => {
    const link = await incoming();
    const command = () =>
      msg(userId, '/react 👍', undefined, {
        reply_to_message: msg(userId, '', link.source_message),
      });
    await env.DB.prepare('UPDATE users SET verified_until=0 WHERE id=?').bind(userId).run();
    await webhook({ message: command() });
    expect(calls.some((c) => c.method === 'setMessageReaction')).toBe(false);
    await verified();
    await config({ paused: true });
    await webhook({ message: command() });
    expect(calls.some((c) => c.method === 'setMessageReaction')).toBe(false);
    await config({ messagesPerMinute: 1 });
    await webhook({ message: command() });
    expect(calls.some((c) => c.method === 'setMessageReaction')).toBe(false);
  });
  it('retries transient visitor reaction failures instead of pretending they are unsupported', async () => {
    const link = await incoming();
    telegramFailure = { method: 'setMessageReaction', code: 429 };
    const message = msg(userId, '/react 👍', undefined, {
      reply_to_message: msg(userId, '', link.source_message),
    });
    const response = await webhook({ update_id: 900, message });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    telegramFailure = null;
    expect((await webhook({ update_id: 900, message })).status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE reason='reaction'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
});

describe('Turnstile server validation', () => {
  async function prepare() {
    await config({ verification: 'turnstile', turnstileSiteKey: 'test-site' });
    await setValue(env, 'publicOrigin', origin);
    await setValue(env, 'turnstileSecret', await encryptSecret(env, 'test-secret'));
    await webhook({ message: msg(userId, '/verify') });
    return (await env.DB.prepare('SELECT * FROM challenges').first<Challenge>())!;
  }
  it('requires hostname, action and challenge binding, consumes token exactly once', async () => {
    const challenge = await prepare();
    turnstileResult = {
      success: true,
      hostname: 'door.example.com',
      action: 'telegramdoor',
      cdata: challenge.id,
    };
    expect(
      (await request('/api/challenge/verify', 'POST', { id: challenge.id, token: 'test-token' }))
        .status,
    ).toBe(200);
    expect((await getUser(env, userId))!.verified_until).toBeGreaterThan(now());
    expect(
      (await request('/api/challenge/verify', 'POST', { id: challenge.id, token: 'test-token' }))
        .status,
    ).toBe(410);
    expect(calls.filter((c) => c.method === 'siteverify')).toHaveLength(1);
  });
  it.each(['hostname', 'action', 'cdata'])(
    'rejects mismatched %s even when Cloudflare returns success',
    async (field) => {
      const challenge = await prepare();
      turnstileResult = {
        success: true,
        hostname: 'door.example.com',
        action: 'telegramdoor',
        cdata: challenge.id,
        [field]: 'wrong',
      };
      expect(
        (await request('/api/challenge/verify', 'POST', { id: challenge.id, token: 'test-token' }))
          .status,
      ).toBe(400);
      expect((await getUser(env, userId))!.verified_until).toBe(0);
    },
  );
  it('cannot downgrade an active Turnstile challenge into native verification', async () => {
    const challenge = await prepare();
    await callback(userId, `v:${challenge.id}:`, 9);
    expect((await getUser(env, userId))!.verified_until).toBe(0);
  });
});

describe('dashboard queries', () => {
  it('uses local midnight for today and filters historical records', async () => {
    await incoming();
    await env.DB.prepare('UPDATE events SET created_at=?')
      .bind(dayStart(now(), 480) - 1)
      .run();
    const cookie = await login();
    const today = await (
      await request('/api/admin/events?range=today&offset=480', 'GET', undefined, cookie)
    ).json<any>();
    const all = await (
      await request('/api/admin/events?range=all', 'GET', undefined, cookie)
    ).json<any>();
    expect(today.total).toBe(0);
    expect(all.total).toBe(1);
    const stats = await (
      await request('/api/admin/stats?range=all', 'GET', undefined, cookie)
    ).json<any>();
    expect(stats.delivered).toBe(1);
    expect(stats.received).toBe(1);
    expect(stats.users).toBe(1);
  });
  it('searches safely, paginates, and validates ranges', async () => {
    await incoming();
    const cookie = await login();
    const found = await (
      await request(
        `/api/admin/events?range=all&search=${encodeURIComponent('你好')}`,
        'GET',
        undefined,
        cookie,
      )
    ).json<any>();
    expect(found.total).toBe(1);
    const injection = await (
      await request(
        `/api/admin/events?range=all&search=${encodeURIComponent("' OR 1=1 --")}`,
        'GET',
        undefined,
        cookie,
      )
    ).json<any>();
    expect(injection.total).toBe(0);
    expect((await request('/api/admin/events?page=-1', 'GET', undefined, cookie)).status).toBe(400);
    expect((await request('/api/admin/stats?range=forever', 'GET', undefined, cookie)).status).toBe(
      400,
    );
    expect(
      (await request('/api/admin/users?state=verified', 'GET', undefined, cookie)).status,
    ).toBe(200);
  });
});
