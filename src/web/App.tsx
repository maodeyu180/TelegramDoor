import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  BellOff,
  Check,
  CircleHelp,
  DoorOpen,
  Github,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MessageSquare,
  RefreshCw,
  Settings2,
  ShieldCheck,
  ShieldX,
  Users,
} from 'lucide-react';
import { api } from './api';
import { ErrorBox, Spinner } from './components';
import { useResource } from './hooks';
import { Overview, Events, UserList, EventDetail, UserDetail } from './pages';
import SettingsPage from './Settings';
import type { EventRow, Person } from '../shared/types';

export type Page = 'overview' | 'blocked' | 'messages' | 'users' | 'settings';
export type Notify = (message: string) => void;
export interface BotStatus {
  connected: boolean;
  origin: string | null;
  ownerId: string;
  version: string;
  bot: { username: string; name: string } | null;
}
const navigation = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'blocked', label: '拦截记录', icon: ShieldX },
  { id: 'messages', label: '消息记录', icon: MessageSquare },
  { id: 'users', label: '访客管理', icon: Users },
  { id: 'settings', label: '防护设置', icon: Settings2 },
] as const;
const descriptions: Record<Page, string> = {
  overview: '每一次真实的连接，都值得被认真对待。',
  blocked: '被挡在门外的消息，都有迹可循。',
  messages: '查看收到的留言、发出的回复和操作记录。',
  users: '认识来访的人，也为对话设好边界。',
  settings: '按你的习惯，设置这扇门的打开方式。',
};
function initialPage(): Page {
  const page = window.location.hash.slice(2);
  return navigation.some((n) => n.id === page) ? (page as Page) : 'overview';
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-icon">
            <DoorOpen size={24} />
          </span>
          TelegramDoor
        </div>
        <div className="login-copy">
          <span className="eyebrow">YOUR PRIVATE TELEGRAM INBOX</span>
          <h1>
            对话有来有往。
            <br />
            <span>打扰，到此为止。</span>
          </h1>
          <p>
            给真实的留言留一扇门。
            <br />
            把验证、拦截和回复，交给你的专属机器人。
          </p>
          <div className="login-features">
            <span>
              <ShieldCheck size={16} /> 人机验证
            </span>
            <span>
              <BellOff size={16} /> 骚扰拦截
            </span>
            <span>
              <MessageSquare size={16} /> 双向私信
            </span>
          </div>
        </div>
        <p className="story-foot">自部署 · 开源 · 由你掌控</p>
      </section>
      <section className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/auth/login', { method: 'POST', body: { password } });
              onLogin();
            } catch (err) {
              setError(err instanceof Error ? err.message : '登录失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="login-lock">
            <LockKeyhole size={25} />
          </div>
          <h2>欢迎回来</h2>
          <p className="muted">登录你的 TelegramDoor 控制台。</p>
          <label className="field">
            管理密码
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              required
              maxLength={1000}
              placeholder="输入部署时设置的管理密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <ErrorBox error={error} />}
          <button className="button primary full" disabled={busy || !password}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                进入控制台 <ArrowRight size={16} />
              </>
            )}
          </button>
          <p className="login-hint">
            <CircleHelp size={15} /> 使用 ADMIN_PASSWORD 配置的密码。
            <br />
            忘记密码时，在 Cloudflare 中修改后重新部署。
          </p>
        </form>
        <span className="login-copyright">TelegramDoor · 让对话安心发生</span>
      </section>
    </main>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [bootError, setBootError] = useState('');
  useEffect(() => {
    api<{ authenticated: boolean }>('/auth/session')
      .then((data) => setAuthenticated(data.authenticated))
      .catch((e) => setBootError(e.message));
    const expire = () => setAuthenticated(false);
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, []);
  if (bootError)
    return (
      <main className="verify-page">
        <div className="verify-card">
          <DoorOpen size={32} />
          <h1>暂时无法连接控制台</h1>
          <ErrorBox error={bootError} />
          <button className="button primary" onClick={() => location.reload()}>
            重新连接
          </button>
        </div>
      </main>
    );
  if (authenticated === null)
    return (
      <main className="verify-page">
        <Spinner /> <span>正在连接 TelegramDoor…</span>
      </main>
    );
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  return <Dashboard onLogout={() => setAuthenticated(false)} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>(initialPage),
    [range, setRange] = useState('today'),
    [revision, setRevision] = useState(0),
    [toast, setToast] = useState('');
  const [event, setEvent] = useState<EventRow | null>(null),
    [user, setUser] = useState<Person | null>(null);
  const {
    data: status,
    error: statusError,
    loading: statusLoading,
  } = useResource<BotStatus>('/admin/status', revision);
  const statusReady = !statusLoading && !statusError && status !== null;
  const connectionLabel = statusLoading
    ? '正在读取连接配置…'
    : statusError || !status
      ? '连接状态暂时无法读取'
      : status.connected
        ? 'Webhook 已配置'
        : '尚未配置连接';
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const closeEvent = useCallback(() => setEvent(null), []),
    closeUser = useCallback(() => setUser(null), []);
  useEffect(() => {
    const fn = () => setPage(initialPage());
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const go = (next: Page) => {
    window.location.hash = `/${next}`;
    setPage(next);
  };
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      onLogout();
    } catch (e) {
      setToast(e instanceof Error ? e.message : '退出失败');
    }
  };
  const props = { range, revision, onEvent: setEvent, refresh, notify: setToast };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#/overview" className="brand">
          <span className="brand-icon">
            <DoorOpen size={24} />
          </span>
          <span>
            TelegramDoor<small>你的私信，有人守门</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-dot">
            <MessageSquare size={18} />
          </span>
          <div>
            <strong>{status?.bot ? `@${status.bot.username}` : '我的 Telegram 入口'}</strong>
            <small>{connectionLabel}</small>
          </div>
        </div>
        <span className="nav-label">工作空间</span>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => go(item.id)}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <item.icon size={19} />
              {item.label}
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note">
            <ShieldCheck size={20} />
            <strong>你的空间，你的规则</strong>
            <p>
              消息与防护记录
              <br />
              保存在自己的 Cloudflare 账户。
            </p>
          </div>
          <a
            className="external-link"
            href="https://github.com/maodeyu180/TelegramDoor"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={17} /> 开源项目 <ArrowRight size={14} />
          </a>
          <button className="external-link" onClick={logout}>
            <LogOut size={17} /> 退出登录
          </button>
          <small className="version">TelegramDoor v{status?.version || '0.1.0'}</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            工作空间 <span>/</span> <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </span>
          <div className="topbar-right">
            <span className={`connection ${statusReady && status?.connected ? 'connected' : ''}`}>
              <i />
              {connectionLabel}
            </span>
            <span className="owner-avatar">你</span>
            <button className="icon-button mobile-logout" aria-label="退出登录" onClick={logout}>
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main className="content">
          <div className="page-head">
            <div>
              <span className="eyebrow">
                {page === 'overview'
                  ? 'AT A GLANCE'
                  : page === 'settings'
                    ? 'MAKE IT YOURS'
                    : 'YOUR WORKSPACE'}
              </span>
              <h1>
                {page === 'overview'
                  ? '把噪音留在门外。'
                  : navigation.find((n) => n.id === page)?.label}
              </h1>
              <p>{descriptions[page]}</p>
            </div>
            <div className="page-actions">
              {!['users', 'settings'].includes(page) && (
                <select
                  aria-label="时间范围"
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                >
                  <option value="today">今天</option>
                  <option value="7d">最近 7 天</option>
                  <option value="30d">最近 30 天</option>
                  <option value="all">全部历史</option>
                </select>
              )}
              <button className="button secondary refresh-button" onClick={refresh}>
                <RefreshCw size={15} /> 刷新
              </button>
            </div>
          </div>
          {statusError && <ErrorBox error={statusError} retry={refresh} />}
          {statusReady && status && !status.connected && page !== 'settings' && (
            <div className="setup-banner">
              <div className="banner-icon">
                <DoorOpen size={22} />
              </div>
              <div>
                <strong>当前数据库中没有连接记录</strong>
                <p>
                  首次部署请连接机器人。如果之前已连接，请先在防护设置中检查连接，并核对 D1 绑定。
                </p>
              </div>
              <button className="button primary" onClick={() => go('settings')}>
                查看连接设置 <ArrowRight size={15} />
              </button>
            </div>
          )}
          {page === 'overview' && <Overview {...props} onViewAll={() => go('blocked')} />}
          {(page === 'blocked' || page === 'messages') && (
            <Events {...props} blockedOnly={page === 'blocked'} />
          )}
          {page === 'users' && <UserList revision={revision} onUser={setUser} />}
          {page === 'settings' && (
            <SettingsPage
              status={status}
              statusLoading={statusLoading}
              statusError={statusError}
              revision={revision}
              refresh={refresh}
              notify={setToast}
            />
          )}
          <footer className="content-foot">
            <span>
              <ShieldCheck size={13} /> 为真实的对话，留一扇门。
            </span>
            <span>时间按本机时区显示</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {event && (
        <EventDetail event={event} onClose={closeEvent} refresh={refresh} notify={setToast} />
      )}
      {user && <UserDetail user={user} onClose={closeUser} refresh={refresh} notify={setToast} />}
    </div>
  );
}
