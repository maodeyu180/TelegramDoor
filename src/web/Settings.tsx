import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  Check,
  CircleAlert,
  Database,
  ExternalLink,
  Fingerprint,
  Heart,
  Link2,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import type { Settings } from '../shared/types';
import type { BotStatus, Notify } from './App';
import { api, formatTime } from './api';
import { ErrorBox, Spinner } from './components';
import { useResource } from './hooks';

type Config = Settings & { turnstileConfigured: boolean };
function Toggle({
  checked,
  onChange,
  label,
  text,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  text: string;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
      <button
        className={`toggle ${checked ? 'on' : ''}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
export default function SettingsPage({
  status,
  statusLoading,
  statusError,
  revision,
  refresh,
  notify,
}: {
  status: BotStatus | null;
  statusLoading: boolean;
  statusError: string;
  revision: number;
  refresh: () => void;
  notify: Notify;
}) {
  const resource = useResource<Config>('/admin/settings', revision);
  const [config, setConfig] = useState<Config | null>(null),
    [secret, setSecret] = useState(''),
    [keywordText, setKeywordText] = useState('');
  const [saving, setSaving] = useState(false),
    [connecting, setConnecting] = useState(false),
    [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState<{
    pending: number;
    url: string;
    expectedUrl: string;
    matches: boolean;
    configured: boolean;
    lastError?: string;
    lastErrorAt?: number;
  } | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const statusReady = !statusLoading && !statusError && status !== null;
  const configured = statusReady && status.connected;
  useEffect(() => {
    if (resource.data) {
      setConfig(resource.data);
      setKeywordText(resource.data.keywords.join('\n'));
    }
  }, [resource.data]);
  const update = <K extends keyof Config>(key: K, value: Config[K]) =>
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  const connect = async () => {
    setConnecting(true);
    setError('');
    try {
      const result = await api<{ warnings: string[] }>('/admin/setup', {
        method: 'POST',
        body: {},
      });
      notify(
        result.warnings.length ? result.warnings.join(' ') : 'Telegram 已连接，命令菜单已设置',
      );
      setDiagnostic(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setConnecting(false);
    }
  };
  const diagnose = async () => {
    setDiagnosing(true);
    setError('');
    setDiagnostic(null);
    try {
      setDiagnostic(await api('/admin/webhook'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '检测失败');
    } finally {
      setDiagnosing(false);
    }
  };
  if (resource.error) return <ErrorBox error={resource.error} retry={resource.reload} />;
  if (!config)
    return (
      <div className="loading-area">
        <Spinner /> 正在读取设置…
      </div>
    );
  return (
    <div className="settings-layout">
      <div className="settings-main">
        {error && <ErrorBox error={error} />}
        <section className="panel settings-panel">
          <div className="section-title">
            <span className="section-icon">
              <Bot size={21} />
            </span>
            <div>
              <h2>Telegram 连接</h2>
              <p>首次配置一次，后续更新部署继续使用。</p>
            </div>
            <span className={`soft-tag ${configured ? 'green-tag' : ''}`}>
              {statusLoading
                ? '读取中…'
                : !statusReady
                  ? '状态未知'
                  : configured
                    ? '已配置'
                    : '无连接记录'}
            </span>
          </div>
          <div className="connection-details">
            <div>
              <span>机器人</span>
              <strong>
                {status?.bot ? `@${status.bot.username}` : statusReady ? '暂无本地记录' : '—'}
              </strong>
            </div>
            <div>
              <span>管理员 ID</span>
              <code>{status?.ownerId || '—'}</code>
            </div>
            <div>
              <span>接收地址</span>
              <code>{status?.origin ? `${status.origin}/webhook` : '连接时自动设置'}</code>
            </div>
          </div>
          <div className="action-row">
            {statusReady && !configured && (
              <button className="button primary" disabled={connecting} onClick={connect}>
                {connecting ? <Spinner /> : <Link2 size={15} />}连接 Telegram
              </button>
            )}
            <button
              className={`button ${configured ? 'primary' : 'secondary'}`}
              disabled={diagnosing || connecting}
              onClick={diagnose}
            >
              {diagnosing ? <Spinner /> : <ShieldCheck size={15} />}检查连接
            </button>
            {status?.bot && (
              <a
                className="text-button"
                href={`https://t.me/${status.bot.username}`}
                target="_blank"
                rel="noreferrer"
              >
                打开机器人 <ArrowUpRight size={15} />
              </a>
            )}
          </div>
          <p className="field-hint">
            {statusLoading
              ? '正在读取已保存的连接配置，请稍候。'
              : !statusReady
                ? '暂时无法读取连接配置，不代表机器人已经断开。请刷新页面或检查连接。'
                : configured
                  ? '连接配置已保存。退出后台、重新登录和更新部署都不需要再次连接。收发异常时先检查连接。'
                  : '首次部署：先向机器人发送 /start，再点击连接。若之前已经连接过，请先检查连接，并确认 DB 仍绑定原数据库。'}
          </p>
          {configured && (
            <details>
              <summary className="text-button">连接维护</summary>
              <p className="field-hint">
                仅在更换域名、Bot Token 或修复连接时使用。重新配置会把 Telegram
                接收地址设为当前后台地址，并更新命令菜单；保留待处理消息。
              </p>
              <button
                className="button secondary"
                disabled={connecting || diagnosing}
                onClick={connect}
              >
                {connecting ? <Spinner /> : <Link2 size={15} />}重新配置连接
              </button>
            </details>
          )}
          {diagnostic && (
            <div
              className={`alert ${!diagnostic.matches || !diagnostic.configured || diagnostic.lastError ? 'warning' : 'success'}`}
            >
              <div>
                <strong>
                  {!diagnostic.url
                    ? 'Telegram 尚未设置接收地址'
                    : !diagnostic.matches
                      ? 'Telegram 接收地址与本项目配置不一致'
                      : !diagnostic.configured
                        ? '接收地址已匹配，但当前数据库缺少连接记录'
                        : 'Telegram 接收地址与本项目配置一致'}
                </strong>
                <p>待处理消息：{diagnostic.pending}</p>
                <p>Telegram 接收地址：{diagnostic.url || '未设置'}</p>
                <p>本项目配置地址：{diagnostic.expectedUrl}</p>
                {!diagnostic.configured && diagnostic.url && (
                  <p>
                    若之前已经连接过，请检查 Cloudflare 的 DB 是否仍绑定原
                    D1；重新连接不会恢复另一数据库里的历史数据。
                  </p>
                )}
                {diagnostic.lastError && (
                  <p>
                    最近一次错误：{diagnostic.lastError}
                    {diagnostic.lastErrorAt ? `（${formatTime(diagnostic.lastErrorAt)}）` : ''}
                  </p>
                )}
                <small>这是 Telegram 返回的检测结果；历史错误不一定代表当前仍然异常。</small>
              </div>
            </div>
          )}
        </section>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setError('');
            try {
              await api('/admin/settings', {
                method: 'PUT',
                body: {
                  ...config,
                  keywords: [
                    ...new Set(
                      keywordText
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ),
                  ],
                  ...(secret ? { turnstileSecret: secret } : {}),
                },
              });
              setSecret('');
              notify('防护设置已保存');
              refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : '保存失败');
            } finally {
              setSaving(false);
            }
          }}
        >
          <section className="panel settings-panel">
            <div className="section-title">
              <span className="section-icon">
                <Fingerprint size={21} />
              </span>
              <div>
                <h2>人机验证</h2>
                <p>让陌生访客先敲门，再开始对话。</p>
              </div>
            </div>
            <div className="verification-options">
              <label
                className={`choice-card ${config.verification === 'native' ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="verification"
                  value="native"
                  checked={config.verification === 'native'}
                  onChange={() => update('verification', 'native')}
                />
                <div>
                  <strong>
                    聊天内验证 <span>开箱即用</span>
                  </strong>
                  <p>在 Telegram 内回答简单题目。无需额外密钥，适合基础防护。</p>
                </div>
              </label>
              <label
                className={`choice-card ${config.verification === 'turnstile' ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="verification"
                  value="turnstile"
                  checked={config.verification === 'turnstile'}
                  onChange={() => update('verification', 'turnstile')}
                />
                <div>
                  <strong>
                    Cloudflare Turnstile <span>推荐防广告</span>
                  </strong>
                  <p>打开网页完成人机验证，对自动化骚扰提供更强的防护。</p>
                </div>
              </label>
            </div>
            {config.verification === 'native' && (
              <div className="inline-note">
                <CircleAlert size={16} />
                <span>
                  简单题目可被脚本识别。遇到持续广告时，建议启用 Turnstile，并结合限频与封禁。
                </span>
              </div>
            )}
            {config.verification === 'turnstile' && (
              <div className="turnstile-settings">
                <div className="form-grid">
                  <label className="field">
                    Site key
                    <input
                      autoComplete="off"
                      required
                      maxLength={200}
                      value={config.turnstileSiteKey}
                      onChange={(e) => update('turnstileSiteKey', e.target.value.trim())}
                      placeholder="0x4AAAAAAA…"
                    />
                  </label>
                  <label className="field">
                    Secret key
                    {config.turnstileConfigured && (
                      <span className="saved-secret">
                        <Check size={12} /> 已加密保存
                      </span>
                    )}
                    <input
                      autoComplete="new-password"
                      type="password"
                      required={!config.turnstileConfigured}
                      maxLength={500}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value.trim())}
                      placeholder={
                        config.turnstileConfigured
                          ? '留空以保留现有密钥'
                          : '输入 Turnstile Secret key'
                      }
                    />
                  </label>
                </div>
                <p className="field-hint">
                  在{' '}
                  <a
                    href="https://dash.cloudflare.com/?to=/:account/turnstile"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Cloudflare Turnstile <ExternalLink size={11} />
                  </a>{' '}
                  创建 Managed 类型的组件，将当前部署域名 <code>{location.hostname}</code>{' '}
                  加入允许列表。启用前请先连接机器人。
                </p>
              </div>
            )}
            <div className="form-grid">
              <label className="field">
                验证有效期（天）
                <input
                  type="number"
                  required
                  min={1}
                  max={365}
                  value={config.verifiedDays}
                  onChange={(e) => update('verifiedDays', Number(e.target.value))}
                />
                <small>到期后再次留言需要重新验证。</small>
              </label>
              <div className="field-static">
                <strong>失败冷却</strong>
                <p>连续 3 次失败后，冷却 15 分钟。验证链接 5 分钟内有效，且只能使用一次。</p>
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <div className="section-title">
              <span className="section-icon">
                <SlidersHorizontal size={21} />
              </span>
              <div>
                <h2>消息防护</h2>
                <p>给对话留出空间，也划清边界。</p>
              </div>
            </div>
            <Toggle
              checked={config.paused}
              onChange={(v) => update('paused', v)}
              label="暂停接收新留言"
              text="暂时关门休息。已有消息仍可由管理员回复。"
            />
            <Toggle
              checked={config.blockLinks}
              onChange={(v) => update('blockLinks', v)}
              label="拦截带链接的消息"
              text="检查文本链接、隐藏链接，以及常见域名。白名单用户不受此限制。"
            />
            <div className="form-grid">
              <label className="field">
                每位用户每分钟最多发送
                <input
                  type="number"
                  required
                  min={1}
                  max={60}
                  value={config.messagesPerMinute}
                  onChange={(e) => update('messagesPerMinute', Number(e.target.value))}
                />
                <small>计入命令和编辑消息，默认 10 条。</small>
              </label>
              <label className="field">
                拦截关键词
                <textarea
                  rows={4}
                  maxLength={10100}
                  value={keywordText}
                  onChange={(e) => setKeywordText(e.target.value)}
                  placeholder={'每行一个关键词\n例如：加群领红包'}
                />
                <small>最多 100 个；按文字包含匹配，不区分大小写。</small>
              </label>
            </div>
            <label className="field">
              验证欢迎语
              <textarea
                rows={3}
                value={config.welcome}
                maxLength={1000}
                onChange={(e) => update('welcome', e.target.value)}
              />
              <small>未验证的访客会在验证提示中看到这段话。</small>
            </label>
          </section>
          <section className="panel settings-panel">
            <div className="section-title">
              <span className="section-icon">
                <Database size={21} />
              </span>
              <div>
                <h2>记录与隐私</h2>
                <p>保留需要的记录，定期清理过期内容。</p>
              </div>
            </div>
            <Toggle
              checked={config.storeContent}
              onChange={(v) => update('storeContent', v)}
              label="记录消息文本"
              text="保存文本与媒体说明，便于检查拦截原因。关闭后新记录只保留类型和状态；已有内容按保留期清理。"
            />
            <label className="field narrow">
              记录保留天数
              <input
                type="number"
                required
                min={1}
                max={365}
                value={config.retentionDays}
                onChange={(e) => update('retentionDays', Number(e.target.value))}
              />
              <small>
                每天分批清理。超过保留期的消息对应关系也会删除，旧消息将无法继续引用回复或回应。
              </small>
            </label>
            <div className="inline-note">
              <ShieldCheck size={16} />
              <span>
                媒体文件不下载、不存入数据库。聊天文本和元数据保存在你自己的
                D1；验证密钥加密保存，管理密码和 Bot Token 不会返回前端。
              </span>
            </div>
          </section>
          <div className="save-bar">
            <span>设置保存后立即生效</span>
            <button className="button primary" disabled={saving}>
              {saving ? <Spinner /> : <Save size={16} />}保存设置
            </button>
          </div>
        </form>
      </div>
      <aside className="settings-aside">
        <div className="tip-card">
          <span className="eyebrow">GETTING STARTED</span>
          <h3>只需三个必填变量</h3>
          <ol>
            <li>
              <strong>ADMIN_PASSWORD</strong>
              <p>控制台登录密码，至少 8 个字符。</p>
            </li>
            <li>
              <strong>BOT_TOKEN</strong>
              <p>从 @BotFather 获取的机器人 Token。</p>
            </li>
            <li>
              <strong>OWNER_ID</strong>
              <p>接收留言的个人数字用户 ID。</p>
            </li>
          </ol>
          <p className="field-hint">
            D1 默认按名称 telegramdoor 绑定，无需填写数据库 ID。Turnstile 密钥在本页配置。
          </p>
        </div>
        <div className="tip-card">
          <Heart size={21} className="purple-text" />
          <h3>别忘了给个回应</h3>
          <p>
            双方都可引用消息发送 <code>/react 👍</code>，或用 <code>/react clear</code> 撤销。
          </p>
          <p>
            支持的普通表情会显示在对方消息上；不支持时只提示操作者。私聊长按点赞无法自动同步，付费回应和自定义表情不受支持。
          </p>
        </div>
        <div className="tip-card command-card">
          <h3>常用管理命令</h3>
          <p>回复目标消息即可操作。</p>
          <dl>
            <div>
              <code>/ban</code>
              <span>永久封禁</span>
            </div>
            <div>
              <code>/ban 1d</code>
              <span>封禁一天</span>
            </div>
            <div>
              <code>/unban</code>
              <span>解除封禁</span>
            </div>
            <div>
              <code>/trust</code>
              <span>加入白名单</span>
            </div>
            <div>
              <code>/who</code>
              <span>查看用户</span>
            </div>
            <div>
              <code>/help</code>
              <span>全部命令</span>
            </div>
          </dl>
        </div>
      </aside>
    </div>
  );
}
