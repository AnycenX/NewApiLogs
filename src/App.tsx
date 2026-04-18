import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Coins,
  Copy,
  Database,
  History,
  Link2,
  ListFilter,
  Monitor,
  MoonStar,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Component, ErrorInfo, FormEvent, ReactNode, useEffect, useRef, useState } from "react";

import "./App.css";
import type {
  AppConfig,
  BootstrapPayload,
  CacheOverviewPayload,
  CacheSyncState,
  ClearCacheResult,
  DesktopPlatform,
  ExportLogsRequest,
  ExportLogsResult,
  LogItem,
  LogQueryRequest,
  LogQueryResult,
  LogSyncEventPayload,
  OtherInfo,
  StatusPayload,
  ThemeMode,
  VerifyLoginRequest,
} from "./types";

type TimeRangeKey = "today" | "week" | "month" | "all";
type AppWindowKind = "main" | "settings" | "float";
type LogViewMode = "card" | "table";

const PAGE_SIZE = 20;
const WINDOW_LABELS: AppWindowKind[] = ["main", "settings", "float"];

const defaultConfig: AppConfig = {
  base_url: "https://ai.centos.hk",
  token: "",
  user_id: "",
  fetch_interval_minutes: 15,
  status_refresh_interval_minutes: 5,
  cache_hit_rate_window_minutes: 60,
  float_always_on_top: true,
  theme_mode: "system",
};

const defaultSyncState: CacheSyncState = {
  scope_key: "",
  bucket_key: "",
  status: "idle",
  sync_mode: "full",
  last_attempt_at: 0,
  last_success_at: 0,
  synced_at: 0,
  last_error: "",
  failure_count: 0,
  next_retry_at: 0,
};

const themeOptions: Array<{ key: ThemeMode; label: string; icon: typeof SunMedium }> = [
  { key: "light", label: "浅色", icon: SunMedium },
  { key: "dark", label: "深色", icon: MoonStar },
  { key: "system", label: "跟随系统", icon: Monitor },
];

const timeRangeOptions: Array<{ key: TimeRangeKey; label: string }> = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "all", label: "全部" },
];

function App() {
  const windowKind = resolveWindowKind();

  if (windowKind === "settings") {
    return (
      <WindowErrorBoundary windowKind="settings">
        <SettingsWindowApp />
      </WindowErrorBoundary>
    );
  }

  if (windowKind === "float") {
    return (
      <WindowErrorBoundary windowKind="float">
        <FloatWindowApp />
      </WindowErrorBoundary>
    );
  }

  return (
    <WindowErrorBoundary windowKind="main">
      <MainWindowApp />
    </WindowErrorBoundary>
  );
}

function MainWindowApp() {
  const appWindow = getCurrentWebviewWindow();
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [loginForm, setLoginForm] = useState<VerifyLoginRequest>(toLoginForm(defaultConfig));
  const [authenticated, setAuthenticated] = useState(false);
  const [booting, setBooting] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [isRefreshingLogs, setIsRefreshingLogs] = useState(false);
  const [statusData, setStatusData] = useState<StatusPayload | null>(null);
  const [logsResult, setLogsResult] = useState<LogQueryResult | null>(null);
  const [currentSyncState, setCurrentSyncState] = useState<CacheSyncState>(defaultSyncState);
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("today");
  const [page, setPage] = useState(1);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [tokenFilter, setTokenFilter] = useState("");
  const [requestIdFilter, setRequestIdFilter] = useState("");
  const [viewMode, setViewMode] = useState<LogViewMode>("card");
  const [selectedLog, setSelectedLog] = useState<LogItem | null>(null);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [statusText, setStatusText] = useState("正在加载本地配置...");

  const statusRefreshLock = useRef(false);
  const logsRefreshLock = useRef(false);

  useResolvedTheme(config.theme_mode);
  const activeScopeKey = getScopeKey(config);
  const activeBucketKey = resolveTimeRangeQuery(timeRange).bucket_key;

  const totalPages = logsResult
    ? Math.max(1, Math.ceil(logsResult.page.total / Math.max(1, logsResult.page.page_size)))
    : 1;

  useEffect(() => {
    if (!selectedLog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedLog(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedLog]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const payload = await invoke<BootstrapPayload>("load_bootstrap");
        if (!active) {
          return;
        }

        applyDesktopPlatform(payload.platform);
        setConfig(payload.config);
        setLoginForm(toLoginForm(payload.config));
        setAuthenticated(payload.can_auto_login);
        setStatusText(
          payload.can_auto_login
            ? "已读取到本地连接配置，正在准备日志工作台..."
            : "请填写服务地址、用户 ID 和 Token 后开始使用。",
        );
      } catch (error) {
        if (!active) {
          return;
        }
        setStatusText(readError(error));
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenConfig: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenSync: (() => void) | undefined;
    let unlistenCacheCleared: (() => void) | undefined;

    const attach = async () => {
      unlistenConfig = await appWindow.listen<AppConfig>("config-updated", ({ payload }) => {
        if (!active) {
          return;
        }

        setConfig(payload);
        setLoginForm(toLoginForm(payload));
        setAuthenticated(isConfigReady(payload));
        setPage(1);

        if (!isConfigReady(payload)) {
          setStatusData(null);
          setLogsResult(null);
          setCurrentSyncState(defaultSyncState);
          setCacheHitRate(null);
          setSelectedLog(null);
          setStatusText("连接配置已清空，请重新登录。");
          return;
        }

        setStatusText("已从其他窗口同步最新配置，正在刷新状态与日志...");
        void refreshStatus(payload, false);
        void refreshLogsWith({
          forceRefresh: true,
          targetPage: 1,
          targetConfig: payload,
          targetTimeRange: timeRange,
          targetModelFilter: modelFilter,
          targetTokenFilter: tokenFilter,
          targetRequestIdFilter: requestIdFilter,
        });
      });

      unlistenStatus = await appWindow.listen<StatusPayload>("status-updated", ({ payload }) => {
        if (!active) {
          return;
        }

        setStatusData(payload);
        setCacheHitRate(payload.cache_hit_rate);
        setStatusText(`状态已刷新，更新时间 ${formatTime(payload.fetched_at)}`);
      });

      unlistenSync = await appWindow.listen<LogSyncEventPayload>("logs-sync-updated", ({ payload }) => {
        if (!active) {
          return;
        }

        if (payload.sync_state.scope_key && activeScopeKey && payload.sync_state.scope_key !== activeScopeKey) {
          return;
        }

        if (payload.sync_state.bucket_key !== activeBucketKey) {
          return;
        }

        setCurrentSyncState(payload.sync_state);
        setStatusText(describeSyncEvent(payload.sync_state));

        if (payload.should_reload) {
          void refreshLogsWith({
            forceRefresh: false,
            targetPage: page,
            targetConfig: config,
            targetTimeRange: timeRange,
            targetModelFilter: modelFilter,
            targetTokenFilter: tokenFilter,
            targetRequestIdFilter: requestIdFilter,
          });
        }
      });

      unlistenCacheCleared = await appWindow.listen<ClearCacheResult>("cache-cleared", ({ payload }) => {
        if (!active) {
          return;
        }

        setLogsResult(null);
        setCurrentSyncState(defaultSyncState);
        setSelectedLog(null);
        setStatusText(
          `当前连接的本地缓存已清空，共移除 ${payload.deleted_logs} 条日志缓存。`,
        );
      });
    };

    void attach();
    return () => {
      active = false;
      unlistenConfig?.();
      unlistenStatus?.();
      unlistenSync?.();
      unlistenCacheCleared?.();
    };
  }, [activeBucketKey, activeScopeKey, appWindow, config, modelFilter, page, requestIdFilter, timeRange, tokenFilter]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    void refreshStatus();
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    void refreshLogsWith({
      forceRefresh: false,
      targetPage: page,
      targetConfig: config,
      targetTimeRange: timeRange,
      targetModelFilter: modelFilter,
      targetTokenFilter: tokenFilter,
      targetRequestIdFilter: requestIdFilter,
    });
  }, [
    authenticated,
    config.base_url,
    config.token,
    config.user_id,
    modelFilter,
    page,
    requestIdFilter,
    timeRange,
    tokenFilter,
  ]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, Math.max(1, config.status_refresh_interval_minutes) * 60_000);

    return () => window.clearInterval(timer);
  }, [
    authenticated,
    config.base_url,
    config.status_refresh_interval_minutes,
    config.token,
    config.user_id,
  ]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshLogsWith({
        forceRefresh: false,
        targetPage: page,
        targetConfig: config,
        targetTimeRange: timeRange,
        targetModelFilter: modelFilter,
        targetTokenFilter: tokenFilter,
        targetRequestIdFilter: requestIdFilter,
      });
    }, Math.max(1, config.fetch_interval_minutes) * 60_000);

    return () => window.clearInterval(timer);
  }, [
    authenticated,
    config.base_url,
    config.fetch_interval_minutes,
    config.token,
    config.user_id,
    modelFilter,
    page,
    requestIdFilter,
    timeRange,
    tokenFilter,
  ]);

  const refreshStatus = async (targetConfig: AppConfig = config, broadcast = true) => {
    if (statusRefreshLock.current) {
      return;
    }

    statusRefreshLock.current = true;
    setIsRefreshingStatus(true);

    try {
      const payload = await invoke<StatusPayload>("fetch_status");
      setStatusData(payload);
      setCacheHitRate(payload.cache_hit_rate);
      setStatusText(`状态已刷新，更新时间 ${formatTime(payload.fetched_at)}`);
      setConfig(targetConfig);

      if (broadcast) {
        await broadcastWindowEvent(appWindow.label as AppWindowKind, "status-updated", payload);
      }
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      statusRefreshLock.current = false;
      setIsRefreshingStatus(false);
    }
  };

  const refreshLogsWith = async ({
    forceRefresh,
    targetPage,
    targetConfig,
    targetTimeRange,
    targetModelFilter,
    targetTokenFilter,
    targetRequestIdFilter,
  }: {
    forceRefresh: boolean;
    targetPage: number;
    targetConfig: AppConfig;
    targetTimeRange: TimeRangeKey;
    targetModelFilter: string;
    targetTokenFilter: string;
    targetRequestIdFilter: string;
  }) => {
    if (logsRefreshLock.current) {
      return;
    }

    logsRefreshLock.current = true;
    setIsRefreshingLogs(true);

    try {
      const request = buildLogQuery(
        targetTimeRange,
        targetPage,
        targetModelFilter,
        targetTokenFilter,
        targetRequestIdFilter,
        forceRefresh,
      );
      const payload = await invoke<LogQueryResult>("query_logs", { request });
      setLogsResult(payload);
      setCurrentSyncState(payload.sync_state);
      setCacheHitRate(payload.cache_hit_rate);
      setStatusText(describeLogRefresh(payload));
      setConfig(targetConfig);
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      logsRefreshLock.current = false;
      setIsRefreshingLogs(false);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoggingIn(true);
    setStatusText("正在验证连接配置...");

    try {
      const verified = await invoke<AppConfig>("verify_login", { request: loginForm });
      setConfig(verified);
      setLoginForm(toLoginForm(verified));
      setAuthenticated(true);
      setPage(1);
      setStatusText("连接成功，正在同步主窗口、设置页和悬浮窗...");
      await broadcastWindowEvent(appWindow.label as AppWindowKind, "config-updated", verified);
      await refreshStatus(verified);
      await refreshLogsWith({
        forceRefresh: true,
        targetPage: 1,
        targetConfig: verified,
        targetTimeRange: timeRange,
        targetModelFilter: modelFilter,
        targetTokenFilter: tokenFilter,
        targetRequestIdFilter: requestIdFilter,
      });
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleQuickTheme = async (themeMode: ThemeMode) => {
    const nextConfig = { ...config, theme_mode: themeMode };
    setConfig(nextConfig);

    try {
      const saved = await invoke<AppConfig>("save_config", { config: nextConfig });
      setConfig(saved);
      await broadcastWindowEvent(appWindow.label as AppWindowKind, "config-updated", saved);
    } catch {
      // 主题切换失败时保留当前预览效果，不中断用户操作。
    }
  };

  const handleExportLogs = async () => {
    if (!logsResult) {
      setStatusText("请先加载日志后再导出。");
      return;
    }

    setIsExportingLogs(true);

    try {
      const request = buildExportLogsRequest(
        timeRange,
        modelFilter,
        tokenFilter,
        requestIdFilter,
      );
      const payload = await invoke<ExportLogsResult>("export_logs", { request });

      if (payload.total <= 0) {
        setStatusText("当前筛选条件下没有可导出的日志。");
        return;
      }

      downloadTextFile(payload.file_name, payload.csv, "text/csv;charset=utf-8;");
      setStatusText(`已导出 ${payload.total} 条日志：${payload.file_name}`);
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      setIsExportingLogs(false);
    }
  };

  const balance = statusData ? statusData.user.quota / 500000 : null;
  const usedBalance = statusData ? statusData.user.used_quota / 500000 : null;
  const todayCost = statusData ? statusData.stat.quota / 500000 : null;
  const currentLogs = logsResult?.page.items ?? [];

  if (booting) {
    return <LoadingView message={statusText} />;
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      {!authenticated ? (
        <main className="login-layout">
          <section className="login-card panel">
            <div className="hero-copy">
              <span className="eyebrow">P1 已升级</span>
              <h1>旧版多窗口能力已迁到 Tauri</h1>
              <p>
                主窗口负责日志工作台，设置页和悬浮窗改成独立窗口；状态区也补齐了余额、已用余额、
                今日消费、请求次数和缓存命中率五项展示。
              </p>
            </div>

            <form className="auth-form" onSubmit={handleLogin}>
              <label>
                <span>服务地址</span>
                <div className="field-shell">
                  <Server size={17} />
                  <input
                    autoComplete="off"
                    value={loginForm.base_url}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, base_url: event.target.value }))
                    }
                    placeholder="https://ai.centos.hk"
                  />
                </div>
              </label>

              <label>
                <span>用户 ID</span>
                <div className="field-shell">
                  <UserRound size={17} />
                  <input
                    autoComplete="off"
                    value={loginForm.user_id}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, user_id: event.target.value }))
                    }
                    placeholder="请输入 New-Api-User"
                  />
                </div>
              </label>

              <label>
                <span>API Token</span>
                <div className="field-shell">
                  <ShieldCheck size={17} />
                  <input
                    type="password"
                    value={loginForm.token}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, token: event.target.value }))
                    }
                    placeholder="请输入 Bearer Token"
                  />
                </div>
              </label>

              <button className="primary-button submit-button" disabled={isLoggingIn} type="submit">
                <Play size={16} />
                <span>{isLoggingIn ? "验证中..." : "连接并进入工作台"}</span>
              </button>
            </form>
          </section>

          <section className="feature-grid">
            <article className="feature-card panel">
              <Database size={18} />
              <h3>SQLite 缓存优先</h3>
              <p>日志分页优先走本地缓存，同一时间桶会自动判断是否需要远程同步。</p>
            </article>
            <article className="feature-card panel">
              <Settings2 size={18} />
              <h3>设置页独立窗口</h3>
              <p>连接配置、刷新频率和主题设置不再挤在弹层里，而是单独布局独立保存。</p>
            </article>
            <article className="feature-card panel">
              <Activity size={18} />
              <h3>Tauri 悬浮状态窗</h3>
              <p>悬浮窗会常驻置顶，方便在做其他工作时随手查看余额、消费和缓存命中率。</p>
            </article>
          </section>
        </main>
      ) : (
        <main className="dashboard">
          <section className="hero panel">
            <div className="hero-main">
              <div className="hero-kicker">
                <Link2 size={16} />
                <span>当前连接</span>
              </div>
              <h2>{config.base_url}</h2>
              <p>
                用户 ID：<strong>{config.user_id}</strong>
                <span className="dot-divider" />
                状态刷新：<strong>{config.status_refresh_interval_minutes} 分钟</strong>
                <span className="dot-divider" />
                日志刷新：<strong>{config.fetch_interval_minutes} 分钟</strong>
              </p>
            </div>

            <div className="hero-actions">
              <div className="theme-switch">
                {themeOptions.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    className={
                      `${key === config.theme_mode ? "theme-chip active" : "theme-chip"}${key === "system" ? "" : " icon-only"}`
                    }
                    onClick={() => void handleQuickTheme(key)}
                    title={label}
                    type="button"
                  >
                    <Icon size={16} />
                    {key === "system" ? <span>{label}</span> : null}
                  </button>
                ))}
              </div>
              <button
                className="toolbar-panel"
                disabled={isRefreshingStatus}
                onClick={() => void refreshStatus()}
                type="button"
                title="刷新状态"
              >
                <RefreshCw className={isRefreshingStatus ? "spin" : ""} size={17} />
              </button>
              <button
                className="toolbar-panel"
                onClick={() => void invoke("open_float_window")}
                type="button"
                title="打开悬浮窗"
              >
                <Activity size={17} />
              </button>
              <button
                className="toolbar-panel"
                onClick={() => void invoke("open_settings_window")}
                type="button"
                title="打开设置页"
              >
                <Settings2 size={17} />
              </button>
              <button
                className="primary-button"
                disabled={isRefreshingLogs}
                onClick={() => {
                  setPage(1);
                  void refreshLogsWith({
                    forceRefresh: true,
                    targetPage: 1,
                    targetConfig: config,
                    targetTimeRange: timeRange,
                    targetModelFilter: modelFilter,
                    targetTokenFilter: tokenFilter,
                    targetRequestIdFilter: requestIdFilter,
                  });
                }}
                type="button"
              >
                <Database size={16} />
                <span>{isRefreshingLogs ? "同步中..." : "同步日志"}</span>
              </button>
            </div>
          </section>

          <section className="stats-grid">
            <StatusMetricCard
              accent="blue"
              icon={<Coins size={18} />}
              label="余额"
              value={formatCurrency(balance)}
              hint="当前剩余额度"
            />
            <StatusMetricCard
              accent="cyan"
              icon={<Database size={18} />}
              label="已用余额"
              value={formatCurrency(usedBalance)}
              hint="累计已使用额度"
            />
            <StatusMetricCard
              accent="amber"
              icon={<Activity size={18} />}
              label="今日消费"
              value={formatCurrency(todayCost)}
              hint="按当日消费实时计算"
            />
            <StatusMetricCard
              accent="green"
              icon={<ScrollText size={18} />}
              label="请求次数"
              value={`${statusData?.user.request_count ?? "--"}`}
              hint="来自当前账号统计"
            />
            <StatusMetricCard
              accent="violet"
              icon={<History size={18} />}
              label="缓存命中率"
              value={cacheHitRate === null ? "--" : `${cacheHitRate.toFixed(1)}%`}
              hint={`统计窗口 ${formatWindow(config.cache_hit_rate_window_minutes)}`}
            />
          </section>

          <section className="filters panel">
            <div className="filters-head">
              <div className="section-title">
                <ListFilter size={17} />
                <span>日志筛选</span>
              </div>
              <div className="filters-actions">
                <button
                  className="ghost-button compact"
                  onClick={() => setFiltersExpanded((current) => !current)}
                  type="button"
                >
                  <SlidersHorizontal size={15} />
                  <span>{filtersExpanded ? "收起筛选" : "展开筛选"}</span>
                </button>
                <button
                  className={viewMode === "card" ? "theme-chip active" : "theme-chip"}
                  onClick={() => setViewMode("card")}
                  type="button"
                >
                  卡片
                </button>
                <button
                  className={viewMode === "table" ? "theme-chip active" : "theme-chip"}
                  onClick={() => setViewMode("table")}
                  type="button"
                >
                  表格
                </button>
                <button
                  className="ghost-button compact"
                  onClick={() => {
                    setModelFilter("");
                    setTokenFilter("");
                    setRequestIdFilter("");
                    setTimeRange("today");
                    setPage(1);
                    setSelectedLog(null);
                  }}
                  type="button"
                >
                  <SlidersHorizontal size={15} />
                  <span>重置</span>
                </button>
              </div>
            </div>

            {filtersExpanded ? (
              <div className="filter-grid">
                <div className="segment-group">
                  {timeRangeOptions.map((option) => (
                    <button
                      key={option.key}
                      className={option.key === timeRange ? "segment active" : "segment"}
                      onClick={() => {
                        setTimeRange(option.key);
                        setPage(1);
                      }}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <label className="filter-field">
                  <Search size={16} />
                  <input
                    list="model-options"
                    value={modelFilter}
                    onChange={(event) => {
                      setModelFilter(event.target.value);
                      setPage(1);
                    }}
                    placeholder="按模型名筛选"
                  />
                </label>

                <label className="filter-field">
                  <Link2 size={16} />
                  <input
                    list="token-options"
                    value={tokenFilter}
                    onChange={(event) => {
                      setTokenFilter(event.target.value);
                      setPage(1);
                    }}
                    placeholder="按 Token 名筛选"
                  />
                </label>

                <label className="filter-field">
                  <Copy size={16} />
                  <input
                    value={requestIdFilter}
                    onChange={(event) => {
                      setRequestIdFilter(event.target.value);
                      setPage(1);
                    }}
                    placeholder="按请求 ID 搜索"
                  />
                </label>
              </div>
            ) : null}

            <datalist id="model-options">
              {logsResult?.available_models.map((item) => <option key={item} value={item} />)}
            </datalist>
            <datalist id="token-options">
              {logsResult?.available_tokens.map((item) => <option key={item} value={item} />)}
            </datalist>
          </section>

          <section className="logs-section panel">
            <div className="logs-header">
              <div>
                <div className="section-title">
                  <Database size={17} />
                  <span>日志明细</span>
                </div>
                <p>
                  共 {logsResult?.page.total ?? 0} 条记录，当前第 {page} / {totalPages} 页
                </p>
              </div>
              <div className="logs-actions">
                <button
                  className="ghost-button compact"
                  disabled={!logsResult || isRefreshingLogs || isExportingLogs}
                  onClick={() => void handleExportLogs()}
                  type="button"
                >
                  <Save size={15} />
                  <span>{isExportingLogs ? "导出中..." : "导出日志"}</span>
                </button>
                <div className="log-status-pill">
                  <span
                    className={
                      logsResult?.remote_fetched ? "pill accent" : logsResult?.used_cache ? "pill" : "pill muted"
                    }
                  >
                    {logsResult?.remote_fetched
                      ? "已远程同步"
                      : logsResult?.used_cache
                        ? "本地缓存"
                        : "等待查询"}
                  </span>
                  <span className="pill muted">
                    缓存时间 {logsResult?.cached_at ? formatDateTime(logsResult.cached_at) : "--"}
                  </span>
                  <span
                    className={getSyncStatePillClass(currentSyncState)}
                    title={describeSyncStateDetail(currentSyncState)}
                  >
                    {describeSyncStateLabel(currentSyncState)}
                  </span>
                </div>
              </div>
            </div>

            <div className="logs-list">
              {currentLogs.length ? (
                viewMode === "card" ? (
                  currentLogs.map((item, index) => {
                  const other = parseOther(item.other);
                  return (
                    <article
                      className={index === 0 ? "log-card panel highlight" : "log-card panel"}
                      key={`${item.id}-${item.created_at}`}
                      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                    >
                      <div className="log-card-main">
                        <div className="log-main-stack">
                          <div className="log-avatar">{buildInitials(item.model_name)}</div>
                          <div className="log-content">
                            <div className="log-title-row">
                              <h3>{item.model_name || "未命名模型"}</h3>
                              <span className={item.is_stream ? "tag active" : "tag"}>
                                {item.is_stream ? "流式" : "非流式"}
                              </span>
                            </div>
                            <p>
                              Token：{item.token_name || "未命名"}，分组：{item.group || "默认"}
                            </p>
                            <div className="meta-row">
                              <span>
                                <Clock3 size={14} />
                                {formatDateTime(item.created_at)}
                              </span>
                              <span>
                                <Coins size={14} />
                                {formatCurrency(item.quota / 500000)}
                              </span>
                              <span>
                                <Server size={14} />
                                {item.channel_name || "未知渠道"}
                              </span>
                              <span>
                                <UserRound size={14} />
                                {item.username || "-"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <aside className="log-tools">
                          <button
                            className="log-primary-action"
                            onClick={() => {
                              setSelectedLog(item);
                              setStatusText(`已打开日志详情：${item.request_id || item.id}`);
                            }}
                            type="button"
                          >
                            <ScrollText size={15} />
                            <span>详情</span>
                          </button>

                          <div className="log-tool-group">
                            <button
                              className="log-tool-button"
                              disabled={!item.model_name}
                              onClick={() => {
                                setModelFilter(item.model_name || "");
                                setPage(1);
                                setStatusText(`已按模型 ${item.model_name || "--"} 筛选日志。`);
                              }}
                              title="按同模型筛选"
                              type="button"
                            >
                              <Search size={16} />
                            </button>
                            <button
                              className="log-tool-button"
                              disabled={!item.token_name}
                              onClick={() => {
                                setTokenFilter(item.token_name || "");
                                setPage(1);
                                setStatusText(`已按 Token ${item.token_name || "--"} 筛选日志。`);
                              }}
                              title="按同 Token 筛选"
                              type="button"
                            >
                              <Link2 size={16} />
                            </button>
                            <button
                              className="log-tool-button"
                              disabled={!item.request_id}
                              onClick={() => {
                                setRequestIdFilter(item.request_id || "");
                                setPage(1);
                                setStatusText(`已按请求 ID ${item.request_id || "--"} 搜索日志。`);
                              }}
                              title="按请求 ID 搜索"
                              type="button"
                            >
                              <Copy size={16} />
                            </button>
                            <button
                              className="log-tool-button"
                              disabled={!item.content}
                              onClick={() => void copyToClipboard("日志内容", item.content, setStatusText)}
                              title="复制日志内容"
                              type="button"
                            >
                              <Database size={16} />
                            </button>
                            <button
                              className="log-tool-button"
                              disabled={!item.ip}
                              onClick={() => void copyToClipboard("IP", item.ip, setStatusText)}
                              title="复制来源 IP"
                              type="button"
                            >
                              <Server size={16} />
                            </button>
                          </div>
                        </aside>
                      </div>

                      <div className="metric-strip">
                        <MetricBadge label="输入" value={formatInput(item.prompt_tokens, other.cache_write_tokens)} />
                        <MetricBadge label="输出" value={formatInput(item.completion_tokens, other.cache_tokens)} />
                        <MetricBadge label="耗时" value={formatDuration(item.use_time)} />
                        <MetricBadge label="首字" value={formatLatency(other.frt)} />
                        <MetricBadge label="模型倍率" value={formatRatio(other.model_ratio)} />
                        <MetricBadge label="分组倍率" value={formatRatio(other.group_ratio)} />
                      </div>

                      <div className="request-meta">
                        <span>请求 ID：{item.request_id || "--"}</span>
                        <span>IP：{item.ip || "--"}</span>
                      </div>
                    </article>
                  );
                  })
                ) : (
                  <LogTableView
                    items={currentLogs}
                    onFilterModel={(value) => {
                      setModelFilter(value);
                      setPage(1);
                      setStatusText(`已按模型 ${value || "--"} 筛选日志。`);
                    }}
                    onFilterRequestId={(value) => {
                      setRequestIdFilter(value);
                      setPage(1);
                      setStatusText(`已按请求 ID ${value || "--"} 搜索日志。`);
                    }}
                    onFilterToken={(value) => {
                      setTokenFilter(value);
                      setPage(1);
                      setStatusText(`已按 Token ${value || "--"} 筛选日志。`);
                    }}
                    onOpenDetail={(item) => {
                      setSelectedLog(item);
                      setStatusText(`已打开日志详情：${item.request_id || item.id}`);
                    }}
                    onCopyContent={(value) => void copyToClipboard("日志内容", value, setStatusText)}
                  />
                )
              ) : (
                <div className="empty-state">
                  <CircleAlert size={28} />
                  <h3>当前条件下暂无日志</h3>
                  <p>可以切换时间范围，或者点击“远程同步日志”主动刷新当前时间桶。</p>
                </div>
              )}
            </div>

            <div className="pagination">
              <button
                className="ghost-button compact"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                <ChevronLeft size={16} />
                <span>上一页</span>
              </button>
              <span className="page-indicator">
                第 {page} 页 / 共 {totalPages} 页
              </span>
              <button
                className="ghost-button compact"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                type="button"
              >
                <span>下一页</span>
                <ChevronRight size={16} />
              </button>
            </div>
          </section>
        </main>
      )}

      {selectedLog ? (
        <LogDetailDialog
          item={selectedLog}
          onClose={() => setSelectedLog(null)}
          onCopy={(label, value) => void copyToClipboard(label, value, setStatusText)}
          onFilterRequestId={(value) => {
            setRequestIdFilter(value);
            setPage(1);
            setSelectedLog(null);
            setStatusText(`已按请求 ID ${value || "--"} 搜索日志。`);
          }}
        />
      ) : null}

      <footer className="statusbar panel">
        <div className="status-inline">
          <Sparkles size={15} />
          <span>{statusText}</span>
        </div>
        <div className="status-inline subtle">
          <Clock3 size={14} />
          <span>
            {statusData?.fetched_at
              ? `状态时间 ${formatDateTime(statusData.fetched_at)}`
              : "尚未完成状态刷新"}
          </span>
        </div>
      </footer>
    </div>
  );
}

function SettingsWindowApp() {
  const appWindow = getCurrentWebviewWindow();
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [settingsDraft, setSettingsDraft] = useState<AppConfig>(defaultConfig);
  const [desktopPlatform, setDesktopPlatform] = useState<DesktopPlatform>("unknown");
  const [cacheOverview, setCacheOverview] = useState<CacheOverviewPayload>(createEmptyCacheOverview());
  const [booting, setBooting] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isLoadingCacheOverview, setIsLoadingCacheOverview] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [statusText, setStatusText] = useState("正在载入设置页...");
  const normalizedConfig = normalizeConfig(config);
  const normalizedDraft = normalizeConfig(settingsDraft);
  const hasUnsavedChanges =
    normalizedDraft.base_url !== normalizedConfig.base_url ||
    normalizedDraft.user_id !== normalizedConfig.user_id ||
    normalizedDraft.token !== normalizedConfig.token ||
    normalizedDraft.fetch_interval_minutes !== normalizedConfig.fetch_interval_minutes ||
    normalizedDraft.status_refresh_interval_minutes !== normalizedConfig.status_refresh_interval_minutes ||
    normalizedDraft.cache_hit_rate_window_minutes !== normalizedConfig.cache_hit_rate_window_minutes ||
    normalizedDraft.float_always_on_top !== normalizedConfig.float_always_on_top ||
    normalizedDraft.theme_mode !== normalizedConfig.theme_mode;
  const draftConnectionReady = isConfigReady(normalizedDraft);
  const savedScopeKey = getScopeKey(config);

  useResolvedTheme(settingsDraft.theme_mode);

  const loadCacheOverview = async (scopeKey: string = savedScopeKey, silent = false) => {
    if (!scopeKey) {
      setCacheOverview(createEmptyCacheOverview());
      return;
    }

    if (!silent) {
      setIsLoadingCacheOverview(true);
    }

    try {
      const payload = await invoke<CacheOverviewPayload>("get_cache_overview");
      setCacheOverview(payload);
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      if (!silent) {
        setIsLoadingCacheOverview(false);
      }
    }
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const payload = await invoke<BootstrapPayload>("load_bootstrap");
        if (!active) {
          return;
        }

        applyDesktopPlatform(payload.platform);
        setDesktopPlatform(payload.platform);
        setConfig(payload.config);
        setSettingsDraft(payload.config);
        setStatusText("已读取本地配置，可以直接修改并保存。");
        if (hasCacheScope(payload.config)) {
          await loadCacheOverview(getScopeKey(payload.config), true);
        } else {
          setCacheOverview(createEmptyCacheOverview());
        }
      } catch (error) {
        if (!active) {
          return;
        }
        setStatusText(readError(error));
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenConfig: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenSync: (() => void) | undefined;
    let unlistenCacheCleared: (() => void) | undefined;

    const attach = async () => {
      try {
        unlistenConfig = await appWindow.listen<AppConfig>("config-updated", ({ payload }) => {
          if (!active) {
            return;
          }

          setConfig(payload);
          setSettingsDraft(payload);
          setStatusText("已同步来自其他窗口的最新配置。");
          if (hasCacheScope(payload)) {
            void loadCacheOverview(getScopeKey(payload), true);
          } else {
            setCacheOverview(createEmptyCacheOverview());
          }
        });

        unlistenStatus = await appWindow.listen<StatusPayload>("status-updated", ({ payload }) => {
          if (!active) {
            return;
          }

          setStatusText(`最近一次状态刷新：${formatDateTime(payload.fetched_at)}`);
        });

        unlistenSync = await appWindow.listen<LogSyncEventPayload>("logs-sync-updated", ({ payload }) => {
          if (!active) {
            return;
          }

          if (payload.sync_state.scope_key && savedScopeKey && payload.sync_state.scope_key !== savedScopeKey) {
            return;
          }

          setStatusText(describeSyncEvent(payload.sync_state));
          void loadCacheOverview(savedScopeKey, true);
        });

        unlistenCacheCleared = await appWindow.listen<ClearCacheResult>("cache-cleared", ({ payload }) => {
          if (!active) {
            return;
          }

          setCacheOverview(createEmptyCacheOverview(savedScopeKey));
          setStatusText(`本地缓存已清空，共移除 ${payload.deleted_logs} 条日志。`);
        });
      } catch (error) {
        if (active) {
          setStatusText(`设置页事件监听失败：${readError(error)}`);
        }
      }
    };

    void attach();
    return () => {
      active = false;
      unlistenConfig?.();
      unlistenStatus?.();
      unlistenSync?.();
      unlistenCacheCleared?.();
    };
  }, [appWindow, savedScopeKey]);

  const handleClearLocalCache = async () => {
    if (!savedScopeKey) {
      setStatusText("当前没有可清空的缓存范围，请先保存服务地址和用户 ID。");
      return;
    }

    setIsClearingCache(true);

    try {
      const payload = await invoke<ClearCacheResult>("clear_local_cache");
      setCacheOverview(createEmptyCacheOverview(savedScopeKey));
      setStatusText(`已清空本地缓存，共移除 ${payload.deleted_logs} 条日志记录。`);
      await broadcastWindowEvent(appWindow.label as AppWindowKind, "cache-cleared", payload);
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleSaveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSavingSettings(true);
    setStatusText("正在保存设置...");

    try {
      const draft = normalizeConfig(settingsDraft);
      const credentialsChanged =
        draft.base_url !== config.base_url ||
        draft.user_id !== config.user_id ||
        draft.token !== config.token;

      let candidate = draft;

      if (credentialsChanged && isConfigReady(draft)) {
        candidate = await invoke<AppConfig>("verify_login", {
          request: toLoginForm(draft),
        });
      }

      const saved = await invoke<AppConfig>("save_config", {
        config: {
          ...candidate,
          fetch_interval_minutes: draft.fetch_interval_minutes,
          status_refresh_interval_minutes: draft.status_refresh_interval_minutes,
          cache_hit_rate_window_minutes: draft.cache_hit_rate_window_minutes,
          float_always_on_top: draft.float_always_on_top,
          theme_mode: draft.theme_mode,
        },
      });

      setConfig(saved);
      setSettingsDraft(saved);
      setStatusText("设置已保存，正在同步其他窗口...");
      await broadcastWindowEvent(appWindow.label as AppWindowKind, "config-updated", saved);

      if (isConfigReady(saved)) {
        const payload = await invoke<StatusPayload>("fetch_status");
        await broadcastWindowEvent(appWindow.label as AppWindowKind, "status-updated", payload);
      }

      await closeWindowByLabel(appWindow.label as AppWindowKind);
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      setIsSavingSettings(false);
    }
  };

  if (booting) {
    return <LoadingView message={statusText} compact />;
  }

  return (
    <div className="app-shell settings-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <main className="dashboard settings-dashboard">
        <section className="hero panel settings-hero">
          <div className="hero-main settings-hero-main">
            <div className="hero-kicker">
              <Settings2 size={16} />
              <span>设置页</span>
            </div>
            <p>
              当前主题：<strong>{themeLabel(settingsDraft.theme_mode)}</strong>
              <span className="dot-divider" />
              缓存命中率窗口：
              <strong>{formatWindow(settingsDraft.cache_hit_rate_window_minutes)}</strong>
            </p>
            <div className="settings-hero-badges">
              <div className="settings-badge">
                <Link2 size={15} />
                <span>{draftConnectionReady ? "连接信息完整" : "连接信息待补全"}</span>
              </div>
              <div className={hasUnsavedChanges ? "settings-badge active" : "settings-badge"}>
                <Sparkles size={15} />
                <span>{hasUnsavedChanges ? "有未保存修改" : "草稿已同步"}</span>
              </div>
              <div className="settings-badge">
                <RefreshCw size={15} />
                <span>
                  状态 {settingsDraft.status_refresh_interval_minutes} 分钟 / 日志{" "}
                  {settingsDraft.fetch_interval_minutes} 分钟
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-layout">
          <form className="settings-card panel settings-form-card" onSubmit={handleSaveSettings}>
            <div className="settings-card-head">
              <div>
                <div className="section-title">
                  <Server size={17} />
                  <span>连接与刷新配置</span>
                </div>
              </div>
              <div className={hasUnsavedChanges ? "settings-sync-pill active" : "settings-sync-pill"}>
                <Sparkles size={15} />
                <span>{hasUnsavedChanges ? "待保存" : "已同步"}</span>
              </div>
            </div>

            <section className="settings-section-block">
              <div className="settings-block-title">
                <div className="settings-block-icon">
                  <Link2 size={16} />
                </div>
                <div>
                  <h3>连接信息</h3>
                </div>
              </div>

              <div className="settings-grid settings-grid-connection">
                <label className="settings-field-card full-span">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <Server size={15} />
                      <span>服务地址</span>
                    </span>
                    <small>建议填写完整域名，结尾斜杠会自动处理。</small>
                  </span>
                  <input
                    value={settingsDraft.base_url}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({ ...current, base_url: event.target.value }))
                    }
                    placeholder="https://ai.centos.hk"
                  />
                </label>

                <label className="settings-field-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <UserRound size={15} />
                      <span>用户 ID</span>
                    </span>
                    <small>用于登录验证和后续状态拉取。</small>
                  </span>
                  <input
                    value={settingsDraft.user_id}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({ ...current, user_id: event.target.value }))
                    }
                    placeholder="New-Api-User"
                  />
                </label>

                <label className="settings-field-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <ShieldCheck size={15} />
                      <span>API Token</span>
                    </span>
                    <small>仅本地保存，提交时会先做一次连接校验。</small>
                  </span>
                  <input
                    type="password"
                    value={settingsDraft.token}
                    onChange={(event) =>
                      setSettingsDraft((current) => ({ ...current, token: event.target.value }))
                    }
                    placeholder="Bearer Token"
                  />
                </label>
              </div>
            </section>

            <section className="settings-section-block">
              <div className="settings-block-title">
                <div className="settings-block-icon">
                  <Clock3 size={16} />
                </div>
                <div>
                  <h3>刷新节奏</h3>
                </div>
              </div>

              <div className="settings-grid settings-grid-metrics">
                <label className="settings-field-card metric-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <RefreshCw size={15} />
                      <span>日志刷新间隔</span>
                    </span>
                    <small>控制日志列表从服务端重新同步的频率。</small>
                  </span>
                  <div className="settings-number-shell">
                    <input
                      min={1}
                      type="number"
                      value={settingsDraft.fetch_interval_minutes}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          fetch_interval_minutes: Number(event.target.value) || 1,
                        }))
                      }
                    />
                    <span>分钟</span>
                  </div>
                </label>

                <label className="settings-field-card metric-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <Activity size={15} />
                      <span>状态刷新间隔</span>
                    </span>
                    <small>影响余额、已用金额和命中率的更新速度。</small>
                  </span>
                  <div className="settings-number-shell">
                    <input
                      min={1}
                      type="number"
                      value={settingsDraft.status_refresh_interval_minutes}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          status_refresh_interval_minutes: Number(event.target.value) || 1,
                        }))
                      }
                    />
                    <span>分钟</span>
                  </div>
                </label>

                <label className="settings-field-card metric-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <Sparkles size={15} />
                      <span>命中率统计窗口</span>
                    </span>
                    <small>用于计算缓存命中率的时间范围。</small>
                  </span>
                  <div className="settings-number-shell">
                    <input
                      min={1}
                      type="number"
                      value={settingsDraft.cache_hit_rate_window_minutes}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          cache_hit_rate_window_minutes: Number(event.target.value) || 1,
                        }))
                      }
                    />
                    <span>分钟</span>
                  </div>
                </label>
              </div>
            </section>

            <section className="settings-section-block">
              <div className="settings-block-title">
                <div className="settings-block-icon">
                  <SlidersHorizontal size={16} />
                </div>
                <div>
                  <h3>窗口偏好</h3>
                </div>
              </div>

              <div className="settings-preferences">
                <label className="toggle-field settings-preference-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      {settingsDraft.float_always_on_top ? <Pin size={15} /> : <PinOff size={15} />}
                      <span>悬浮窗默认置顶</span>
                    </span>
                    <small>
                      {settingsDraft.float_always_on_top
                        ? "适合在处理其他工作时持续观察状态变化。"
                        : "悬浮窗会和普通窗口一样参与层级切换。"}
                    </small>
                  </span>
                  <button
                    aria-pressed={settingsDraft.float_always_on_top}
                    className={
                      settingsDraft.float_always_on_top ? "toggle-button active" : "toggle-button"
                    }
                    onClick={() =>
                      setSettingsDraft((current) => ({
                        ...current,
                        float_always_on_top: !current.float_always_on_top,
                      }))
                    }
                    type="button"
                  >
                    <span>{settingsDraft.float_always_on_top ? "已开启" : "已关闭"}</span>
                    <small>
                      {settingsDraft.float_always_on_top
                        ? "悬浮窗会固定在最前"
                        : "悬浮窗会按普通窗口显示"}
                    </small>
                  </button>
                </label>

                <div className="theme-picker settings-preference-card">
                  <span className="settings-field-label">
                    <span className="settings-field-title">
                      <Monitor size={15} />
                      <span>主题模式</span>
                    </span>
                    <small>切换后主窗口、设置页和悬浮窗都会同步更新。</small>
                  </span>
                  <div className="theme-switch wide settings-theme-grid">
                    {themeOptions.map(({ key, label, icon: Icon }) => (
                      <button
                        key={key}
                        className={key === settingsDraft.theme_mode ? "theme-chip active" : "theme-chip"}
                        onClick={() => setSettingsDraft((current) => ({ ...current, theme_mode: key }))}
                        type="button"
                      >
                        <Icon size={16} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <div className="settings-actions">
              <button
                className="ghost-button"
                onClick={() => {
                  setSettingsDraft(config);
                  void closeWindowByLabel(appWindow.label as AppWindowKind, setStatusText);
                }}
                type="button"
              >
                取消
              </button>
              <button className="primary-button" disabled={isSavingSettings} type="submit">
                <Save size={16} />
                <span>{isSavingSettings ? "保存中..." : "保存并应用"}</span>
              </button>
            </div>
          </form>

          <aside className="settings-sidebar">
            <article className="settings-note panel settings-overview-card">
              <div className="section-title">
                <ShieldCheck size={17} />
                <span>当前配置快照</span>
              </div>

              <div className="settings-overview-grid">
                <div className="settings-overview-item">
                  <span>连接状态</span>
                  <strong>{draftConnectionReady ? "可校验" : "信息未完整"}</strong>
                </div>
                <div className="settings-overview-item">
                  <span>主题模式</span>
                  <strong>{themeLabel(settingsDraft.theme_mode)}</strong>
                </div>
                <div className="settings-overview-item">
                  <span>日志刷新</span>
                  <strong>{settingsDraft.fetch_interval_minutes} 分钟</strong>
                </div>
                <div className="settings-overview-item">
                  <span>状态刷新</span>
                  <strong>{settingsDraft.status_refresh_interval_minutes} 分钟</strong>
                </div>
                <div className="settings-overview-item">
                  <span>命中率窗口</span>
                  <strong>{formatWindow(settingsDraft.cache_hit_rate_window_minutes)}</strong>
                </div>
                <div className="settings-overview-item">
                  <span>悬浮窗置顶</span>
                  <strong>{settingsDraft.float_always_on_top ? "开启" : "关闭"}</strong>
                </div>
                <div className="settings-overview-item">
                  <span>当前平台</span>
                  <strong>{formatDesktopPlatform(desktopPlatform)}</strong>
                </div>
                <div className="settings-overview-item">
                  <span>字体回退</span>
                  <strong>{describePlatformFontFallback(desktopPlatform)}</strong>
                </div>
              </div>

              <div className="settings-inline-tip">
                <Sparkles size={15} />
                <span>
                  {hasUnsavedChanges
                    ? "草稿已变更，保存后会同步到主窗口和悬浮窗。"
                    : "当前草稿与已保存配置一致。"}
                </span>
              </div>
            </article>

            <article className="settings-note panel settings-cache-card">
              <div className="settings-card-head">
                <div>
                  <div className="section-title">
                    <Database size={17} />
                    <span>缓存范围管理</span>
                  </div>
                  <p>查看当前连接下各时间范围的缓存状态、失败重试和最近同步结果。</p>
                </div>
                <button
                  className="ghost-button compact"
                  disabled={isClearingCache || !savedScopeKey}
                  onClick={() => void handleClearLocalCache()}
                  type="button"
                >
                  <Trash2 size={15} />
                  <span>{isClearingCache ? "清空中..." : "清空本地缓存"}</span>
                </button>
              </div>

              <div className="settings-cache-summary">
                <div className="settings-overview-item">
                  <span>缓存范围</span>
                  <strong>{cacheOverview.range_count} 个</strong>
                </div>
                <div className="settings-overview-item">
                  <span>缓存日志数</span>
                  <strong>{cacheOverview.total_logs} 条</strong>
                </div>
                <div className="settings-overview-item">
                  <span>最近状态快照</span>
                  <strong>
                    {cacheOverview.last_snapshot_at
                      ? formatDateTime(cacheOverview.last_snapshot_at)
                      : "--"}
                  </strong>
                </div>
              </div>

              {cacheOverview.ranges.length ? (
                <div className="cache-range-list">
                  {cacheOverview.ranges.map((range) => (
                    <div className="cache-range-card" key={range.bucket_key}>
                      <div className="cache-range-head">
                        <strong>{describeBucketLabel(range.bucket_key)}</strong>
                        <span className={getSyncStatePillClass(range.sync_state)}>
                          {describeSyncStateLabel(range.sync_state)}
                        </span>
                      </div>
                      <div className="cache-range-meta">
                        <span>日志 {range.item_count} 条</span>
                        <span>
                          时间 {range.range_start ? formatDateTime(range.range_start) : "--"} -{" "}
                          {range.range_end ? formatDateTime(range.range_end) : "--"}
                        </span>
                        <span>
                          最新同步 {range.synced_at ? formatDateTime(range.synced_at) : "--"}
                        </span>
                      </div>
                      <p>{describeSyncStateDetail(range.sync_state)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="settings-inline-tip">
                  <Database size={15} />
                  <span>
                    {isLoadingCacheOverview
                      ? "正在读取缓存范围概览..."
                      : "当前连接下还没有本地缓存，首次进入日志页后会自动建立缓存。"}
                  </span>
                </div>
              )}
            </article>

            <article className="settings-note panel">
              <div className="section-title">
                <Clock3 size={17} />
                <span>保存后会发生什么</span>
              </div>
              <div className="settings-checklist">
                <div className="settings-check-item">
                  <strong>1</strong>
                  <span>如果连接信息变更，会先重新校验登录，避免保存不可用配置。</span>
                </div>
                <div className="settings-check-item">
                  <strong>2</strong>
                  <span>保存成功后，主窗口和悬浮窗会立刻收到新配置并刷新状态。</span>
                </div>
                <div className="settings-check-item">
                  <strong>3</strong>
                  <span>主题模式和刷新频率会立即生效，不需要重启应用。</span>
                </div>
              </div>
            </article>

            <article className="settings-note panel">
              <div className="section-title">
                <Sparkles size={17} />
                <span>推荐节奏</span>
              </div>
              <div className="settings-checklist compact">
                <div className="settings-check-item">
                  <strong>稳</strong>
                  <span>日志 15 分钟 / 状态 5 分钟，适合长期挂机观察。</span>
                </div>
                <div className="settings-check-item">
                  <strong>快</strong>
                  <span>状态可调到 1 到 3 分钟，便于盯余额和消费变化。</span>
                </div>
              </div>
            </article>
          </aside>
        </section>
      </main>

      <footer className="statusbar panel">
        <div className="status-inline">
          <Sparkles size={15} />
          <span>{statusText}</span>
        </div>
      </footer>
    </div>
  );
}

function FloatWindowApp() {
  const appWindow = getCurrentWebviewWindow();
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [authenticated, setAuthenticated] = useState(false);
  const [booting, setBooting] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingFloatPrefs, setIsSavingFloatPrefs] = useState(false);
  const [statusData, setStatusData] = useState<StatusPayload | null>(null);
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  const [statusText, setStatusText] = useState("正在加载悬浮窗...");

  const refreshLock = useRef(false);

  useResolvedTheme(config.theme_mode);

  useEffect(() => {
    const root = document.getElementById("root");
    document.documentElement.classList.add("float-window");
    document.body.classList.add("float-window");
    root?.classList.add("float-window-root");

    return () => {
      document.documentElement.classList.remove("float-window");
      document.body.classList.remove("float-window");
      root?.classList.remove("float-window-root");
    };
  }, []);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const payload = await invoke<BootstrapPayload>("load_bootstrap");
        if (!active) {
          return;
        }

        applyDesktopPlatform(payload.platform);
        setConfig(payload.config);
        setAuthenticated(payload.can_auto_login);
        setStatusText(
          payload.can_auto_login ? "悬浮窗已就绪，正在同步状态..." : "尚未登录，点击设置页完成连接。",
        );
      } catch (error) {
        if (!active) {
          return;
        }
        setStatusText(readError(error));
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenConfig: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    const attach = async () => {
      try {
        unlistenConfig = await appWindow.listen<AppConfig>("config-updated", ({ payload }) => {
          if (!active) {
            return;
          }

          setConfig(payload);
          setAuthenticated(isConfigReady(payload));

          if (!isConfigReady(payload)) {
            setStatusData(null);
            setCacheHitRate(null);
            setStatusText("连接配置已清空，请先在设置页重新配置。");
            return;
          }

          setStatusText("已同步最新配置，正在刷新悬浮状态...");
          void refreshStatus(payload, false);
        });

        unlistenStatus = await appWindow.listen<StatusPayload>("status-updated", ({ payload }) => {
          if (!active) {
            return;
          }

          setStatusData(payload);
          setCacheHitRate(payload.cache_hit_rate);
          setStatusText(`同步时间 ${formatTime(payload.fetched_at)}`);
        });
      } catch (error) {
        if (active) {
          setStatusText(`悬浮窗事件监听失败：${readError(error)}`);
        }
      }
    };

    void attach();
    return () => {
      active = false;
      unlistenConfig?.();
      unlistenStatus?.();
    };
  }, [appWindow]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    void refreshStatus();
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshStatus();
    }, Math.max(1, config.status_refresh_interval_minutes) * 60_000);

    return () => window.clearInterval(timer);
  }, [
    authenticated,
    config.base_url,
    config.status_refresh_interval_minutes,
    config.token,
    config.user_id,
  ]);

  const refreshStatus = async (targetConfig: AppConfig = config, broadcast = true) => {
    if (refreshLock.current) {
      return;
    }

    refreshLock.current = true;
    setIsRefreshing(true);

    try {
      const payload = await invoke<StatusPayload>("fetch_status");
      setStatusData(payload);
      setCacheHitRate(payload.cache_hit_rate);
      setConfig(targetConfig);
      setStatusText(`同步时间 ${formatTime(payload.fetched_at)}`);

      if (broadcast) {
        await broadcastWindowEvent(appWindow.label as AppWindowKind, "status-updated", payload);
      }
    } catch (error) {
      setStatusText(readError(error));
    } finally {
      refreshLock.current = false;
      setIsRefreshing(false);
    }
  };

  const balance = statusData ? statusData.user.quota / 500000 : null;
  const usedBalance = statusData ? statusData.user.used_quota / 500000 : null;
  const todayCost = statusData ? statusData.stat.quota / 500000 : null;
  const floatSummaryText = !authenticated
    ? "未登录"
    : isRefreshing
      ? "刷新中..."
      : statusData?.fetched_at
        ? `已同步 ${formatTime(statusData.fetched_at)}`
        : "等待同步";

  const handleToggleAlwaysOnTop = async () => {
    const previousConfig = config;
    const nextConfig = {
      ...previousConfig,
      float_always_on_top: !previousConfig.float_always_on_top,
    };

    setConfig(nextConfig);
    setIsSavingFloatPrefs(true);
    setStatusText(nextConfig.float_always_on_top ? "正在启用悬浮窗置顶..." : "正在取消悬浮窗置顶...");

    try {
      const saved = await invoke<AppConfig>("save_config", { config: nextConfig });
      setConfig(saved);
      setStatusText(saved.float_always_on_top ? "悬浮窗已固定在最前。" : "悬浮窗已改为非置顶。");
      await broadcastWindowEvent(appWindow.label as AppWindowKind, "config-updated", saved);
    } catch (error) {
      setConfig(previousConfig);
      setStatusText(`更新置顶状态失败：${readError(error)}`);
    } finally {
      setIsSavingFloatPrefs(false);
    }
  };

  const handleFloatDragStart = (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("button")) {
      return;
    }

    void invoke("start_window_drag", { label: appWindow.label }).catch((error) => {
      setStatusText(`拖拽失败：${readError(error)}`);
    });
  };

  if (booting) {
    return <LoadingView message={statusText} compact />;
  }

  return (
    <div className="app-shell float-shell">
      <section className="float-panel" onMouseDown={handleFloatDragStart}>
        <div className="float-header">
          <div className="float-heading" title={statusText}>
            <div className="float-heading-copy">
              <div className="section-title float-title">
                <span>状态悬浮窗</span>
                <span className="float-window-tag">
                  {config.float_always_on_top ? "置顶" : "普通"}
                </span>
              </div>
              <p>{floatSummaryText}</p>
            </div>
          </div>

          <div className="float-actions">
            <button
              className="float-icon-button"
              disabled={isSavingFloatPrefs}
              onClick={() => void handleToggleAlwaysOnTop()}
              onMouseDown={(event) => event.stopPropagation()}
              title={config.float_always_on_top ? "取消置顶" : "固定在最前"}
              type="button"
            >
              {config.float_always_on_top ? <Pin size={13} /> : <PinOff size={13} />}
            </button>
            <button
              className="float-icon-button"
              disabled={isRefreshing || !authenticated}
              onClick={() => void refreshStatus()}
              onMouseDown={(event) => event.stopPropagation()}
              title="刷新状态"
              type="button"
            >
              <RefreshCw className={isRefreshing ? "spin" : ""} size={13} />
            </button>
            <button
              className="float-icon-button danger"
              onClick={() => void closeWindowByLabel(appWindow.label as AppWindowKind, setStatusText)}
              onMouseDown={(event) => event.stopPropagation()}
              title="关闭悬浮窗"
              type="button"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {authenticated ? (
          <div className="float-content">
            <div className="float-stats">
              <FloatMetric label="余额" value={formatCurrency(balance)} />
              <FloatMetric label="已用余额" value={formatCurrency(usedBalance)} />
              <FloatMetric label="今日消费" value={formatCurrency(todayCost)} />
              <FloatMetric label="请求次数" value={`${statusData?.user.request_count ?? "--"}`} />
              <FloatMetric
                label="缓存命中率"
                value={cacheHitRate === null ? "--" : `${cacheHitRate.toFixed(1)}%`}
              />
            </div>
            <div className="float-footnote">
              <span>统计窗口 {formatWindow(config.cache_hit_rate_window_minutes)}</span>
              <span>{statusData?.fetched_at ? formatDateTime(statusData.fetched_at) : "--"}</span>
            </div>
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <CircleAlert size={24} />
            <h3>还没有可用连接</h3>
            <p>先打开设置页填写服务地址、用户 ID 和 Token，悬浮窗就会自动开始同步状态。</p>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusMetricCard({
  accent,
  icon,
  label,
  value,
  hint,
}: {
  accent: "blue" | "amber" | "green" | "violet" | "cyan";
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="stat-card panel">
      <div className={`stat-icon ${accent}`}>{icon}</div>
      <div>
        <span className="stat-label">{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </article>
  );
}

class WindowErrorBoundary extends Component<
  { children: ReactNode; windowKind: AppWindowKind },
  { errorMessage: string | null }
> {
  constructor(props: { children: ReactNode; windowKind: AppWindowKind }) {
    super(props);
    this.state = { errorMessage: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      errorMessage: error instanceof Error ? error.message : "窗口渲染失败，请尝试重新打开。",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.windowKind}] window render failed`, error, info);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <WindowCrashView
          errorMessage={this.state.errorMessage}
          windowKind={this.props.windowKind}
        />
      );
    }

    return this.props.children;
  }
}

function WindowCrashView({
  windowKind,
  errorMessage,
}: {
  windowKind: AppWindowKind;
  errorMessage: string;
}) {
  const [statusText, setStatusText] = useState(errorMessage);

  return (
    <div className="loading-shell">
      <div className="loading-card crash-card">
        <CircleAlert size={22} />
        <div className="crash-copy">
          <strong>{windowKind === "main" ? "主窗口异常" : windowKind === "settings" ? "设置页异常" : "悬浮窗异常"}</strong>
          <p>{statusText}</p>
          <div className="crash-actions">
            <button
              className="ghost-button compact"
              onClick={() => window.location.reload()}
              type="button"
            >
              重新加载
            </button>
            {windowKind !== "main" ? (
              <button
                className="primary-button compact"
                onClick={() => void closeWindowByLabel(windowKind, setStatusText)}
                type="button"
              >
                关闭窗口
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-badge">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LogTableView({
  items,
  onFilterModel,
  onFilterRequestId,
  onFilterToken,
  onOpenDetail,
  onCopyContent,
}: {
  items: LogItem[];
  onFilterModel: (value: string) => void;
  onFilterRequestId: (value: string) => void;
  onFilterToken: (value: string) => void;
  onOpenDetail: (item: LogItem) => void;
  onCopyContent: (value: string) => void;
}) {
  return (
    <div className="log-table-shell">
      <table className="log-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>Token</th>
            <th>分组</th>
            <th>请求 ID</th>
            <th>消费</th>
            <th>输入</th>
            <th>输出</th>
            <th>耗时</th>
            <th>首字</th>
            <th>模型倍率</th>
            <th>分组倍率</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const other = parseOther(item.other);
            return (
              <tr key={`${item.id}-${item.created_at}`} onClick={() => onOpenDetail(item)}>
                <td>{formatDateTime(item.created_at)}</td>
                <td>{item.model_name || "--"}</td>
                <td>{item.token_name || "--"}</td>
                <td>{item.group || "--"}</td>
                <td className="mono-cell">{item.request_id || "--"}</td>
                <td>{formatCurrency(item.quota / 500000)}</td>
                <td>{formatInput(item.prompt_tokens, other.cache_write_tokens)}</td>
                <td>{formatInput(item.completion_tokens, other.cache_tokens)}</td>
                <td>{formatDuration(item.use_time)}</td>
                <td>{formatLatency(other.frt)}</td>
                <td>{formatRatio(other.model_ratio)}</td>
                <td>{formatRatio(other.group_ratio)}</td>
                <td>
                  <div className="table-actions">
                    <button
                      className="table-action-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenDetail(item);
                      }}
                      type="button"
                    >
                      详情
                    </button>
                    <button
                      className="table-action-button"
                      disabled={!item.model_name}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterModel(item.model_name || "");
                      }}
                      type="button"
                    >
                      模型
                    </button>
                    <button
                      className="table-action-button"
                      disabled={!item.token_name}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterToken(item.token_name || "");
                      }}
                      type="button"
                    >
                      Token
                    </button>
                    <button
                      className="table-action-button"
                      disabled={!item.request_id}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilterRequestId(item.request_id || "");
                      }}
                      type="button"
                    >
                      请求
                    </button>
                    <button
                      className="table-action-button"
                      disabled={!item.content}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCopyContent(item.content);
                      }}
                      type="button"
                    >
                      内容
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LogDetailDialog({
  item,
  onClose,
  onCopy,
  onFilterRequestId,
}: {
  item: LogItem;
  onClose: () => void;
  onCopy: (label: string, value: string) => void;
  onFilterRequestId: (value: string) => void;
}) {
  const other = parseOther(item.other);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="log-detail-panel panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="logs-header">
          <div>
            <div className="section-title">
              <ScrollText size={17} />
              <span>日志详情</span>
            </div>
            <p>
              {item.model_name || "未命名模型"} · {formatDateTime(item.created_at)}
            </p>
          </div>
          <div className="detail-actions">
            <button
              className="ghost-button compact"
              disabled={!item.request_id}
              onClick={() => onFilterRequestId(item.request_id)}
              type="button"
            >
              <Search size={15} />
              <span>同请求</span>
            </button>
            <button className="ghost-button compact" onClick={onClose} type="button">
              关闭
            </button>
          </div>
        </div>

        <div className="detail-grid">
          <MetricBadge label="消费" value={formatCurrency(item.quota / 500000)} />
          <MetricBadge label="输入" value={formatInput(item.prompt_tokens, other.cache_write_tokens)} />
          <MetricBadge label="输出" value={formatInput(item.completion_tokens, other.cache_tokens)} />
          <MetricBadge label="耗时" value={formatDuration(item.use_time)} />
          <MetricBadge label="首字" value={formatLatency(other.frt)} />
          <MetricBadge label="流式" value={item.is_stream ? "流式" : "非流式"} />
          <MetricBadge label="模型倍率" value={formatRatio(other.model_ratio)} />
          <MetricBadge label="分组倍率" value={formatRatio(other.group_ratio)} />
          <MetricBadge label="输出倍率" value={formatRatio(other.completion_ratio)} />
          <MetricBadge label="5m缓存倍率" value={formatRatio(other.cache_creation_ratio_5m)} />
          <MetricBadge label="渠道" value={item.channel_name || "--"} />
          <MetricBadge label="用户" value={item.username || "--"} />
        </div>

        <div className="detail-meta-grid">
          <div className="detail-block">
            <span>请求 ID</span>
            <strong>{item.request_id || "--"}</strong>
            <button
              className="table-action-button"
              disabled={!item.request_id}
              onClick={() => onCopy("请求 ID", item.request_id)}
              type="button"
            >
              复制
            </button>
          </div>
          <div className="detail-block">
            <span>Token / 分组</span>
            <strong>{`${item.token_name || "--"} / ${item.group || "--"}`}</strong>
            <button
              className="table-action-button"
              disabled={!item.token_name}
              onClick={() => onCopy("Token 名", item.token_name)}
              type="button"
            >
              复制
            </button>
          </div>
          <div className="detail-block">
            <span>来源 IP</span>
            <strong>{item.ip || "--"}</strong>
            <button
              className="table-action-button"
              disabled={!item.ip}
              onClick={() => onCopy("来源 IP", item.ip)}
              type="button"
            >
              复制
            </button>
          </div>
          <div className="detail-block">
            <span>Other 原始数据</span>
            <strong>{item.other ? "可查看" : "--"}</strong>
            <button
              className="table-action-button"
              disabled={!item.other}
              onClick={() => onCopy("Other 原始数据", item.other)}
              type="button"
            >
              复制
            </button>
          </div>
        </div>

        <div className="detail-content-grid">
          <article className="detail-content-card">
            <div className="section-title">
              <Database size={16} />
              <span>请求内容</span>
            </div>
            <pre>{item.content || "当前日志没有请求内容。"}</pre>
          </article>

          <article className="detail-content-card">
            <div className="section-title">
              <Server size={16} />
              <span>倍率与缓存细节</span>
            </div>
            <pre>{JSON.stringify(other, null, 2)}</pre>
          </article>
        </div>
      </section>
    </div>
  );
}

function FloatMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="float-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingView({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={compact ? "loading-shell compact-loading" : "loading-shell"}>
      <div className="loading-card">
        <Sparkles size={22} />
        <div>
          <strong>WebApiLogs</strong>
          <p>{message}</p>
        </div>
      </div>
    </div>
  );
}

function resolveWindowKind(): AppWindowKind {
  try {
    const label = getCurrentWebviewWindow().label;
    if (label === "settings") {
      return "settings";
    }
    if (label === "float") {
      return "float";
    }
  } catch {
    return "main";
  }

  return "main";
}

function useResolvedTheme(themeMode: ThemeMode) {
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const resolvedTheme =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
}

function applyDesktopPlatform(platform: DesktopPlatform) {
  document.documentElement.dataset.platform = platform;
}

async function broadcastWindowEvent<T>(sourceLabel: AppWindowKind, event: string, payload: T) {
  const sender = getCurrentWebviewWindow();
  const targets = WINDOW_LABELS.filter((label) => label !== sourceLabel);

  await Promise.allSettled(targets.map((label) => sender.emitTo(label, event, payload)));
}

async function closeWindowByLabel(
  label: AppWindowKind,
  setStatusText?: (message: string) => void,
) {
  try {
    await invoke("close_window", { label });
  } catch (error) {
    setStatusText?.(`关闭窗口失败：${readError(error)}`);
  }
}

function buildLogQuery(
  timeRange: TimeRangeKey,
  page: number,
  modelFilter: string,
  tokenFilter: string,
  requestIdFilter: string,
  forceRefresh: boolean,
): LogQueryRequest {
  const range = resolveTimeRangeQuery(timeRange);

  return {
    bucket_key: range.bucket_key,
    page,
    page_size: PAGE_SIZE,
    model_name: normalizeNullable(modelFilter),
    token_name: normalizeNullable(tokenFilter),
    request_id: normalizeNullable(requestIdFilter),
    start_ts: range.start_ts,
    end_ts: range.end_ts,
    force_refresh: forceRefresh,
  };
}

function buildExportLogsRequest(
  timeRange: TimeRangeKey,
  modelFilter: string,
  tokenFilter: string,
  requestIdFilter: string,
): ExportLogsRequest {
  const range = resolveTimeRangeQuery(timeRange);

  return {
    model_name: normalizeNullable(modelFilter),
    token_name: normalizeNullable(tokenFilter),
    request_id: normalizeNullable(requestIdFilter),
    start_ts: range.start_ts,
    end_ts: range.end_ts,
  };
}

function resolveTimeRangeQuery(timeRange: TimeRangeKey) {
  const now = new Date();
  const end_ts = Math.floor(now.getTime() / 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (timeRange === "today") {
    return {
      bucket_key: `day:${formatBucketDate(startOfToday)}`,
      start_ts: Math.floor(startOfToday.getTime() / 1000),
      end_ts,
    };
  }

  if (timeRange === "week") {
    const weekStart = new Date(startOfToday);
    const delta = (startOfToday.getDay() + 6) % 7;
    weekStart.setDate(startOfToday.getDate() - delta);

    return {
      bucket_key: `week:${formatBucketDate(weekStart)}`,
      start_ts: Math.floor(weekStart.getTime() / 1000),
      end_ts,
    };
  }

  if (timeRange === "month") {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      bucket_key: `month:${formatBucketDate(monthStart)}`,
      start_ts: Math.floor(monthStart.getTime() / 1000),
      end_ts,
    };
  }

  return {
    bucket_key: "all",
    start_ts: null,
    end_ts,
  };
}

function normalizeNullable(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    base_url: config.base_url.trim().replace(/\/+$/, ""),
    user_id: config.user_id.trim(),
    token: config.token.trim(),
    fetch_interval_minutes: Math.max(1, Number(config.fetch_interval_minutes) || 1),
    status_refresh_interval_minutes: Math.max(1, Number(config.status_refresh_interval_minutes) || 1),
    cache_hit_rate_window_minutes: Math.max(1, Number(config.cache_hit_rate_window_minutes) || 1),
    float_always_on_top: Boolean(config.float_always_on_top),
  };
}

function parseOther(raw: string): OtherInfo {
  try {
    return JSON.parse(raw) as OtherInfo;
  } catch {
    return {
      cache_tokens: 0,
      cache_write_tokens: 0,
      model_ratio: 0,
      group_ratio: 0,
      completion_ratio: 0,
      cache_creation_ratio_5m: 0,
      frt: 0,
    };
  }
}

function formatCurrency(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "--";
  }

  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatWindow(minutes: number) {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440} 天`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }
  return `${minutes} 分钟`;
}

function formatInput(primary: number, extra: number) {
  return extra > 0 ? `${primary} (+${extra})` : `${primary}`;
}

function formatDuration(value: number) {
  return `${value}s`;
}

function formatLatency(value: number) {
  return `${(value / 1000).toFixed(2)}s`;
}

function formatRatio(value: number) {
  return value > 0 ? value.toFixed(2) : "--";
}

function formatDesktopPlatform(platform: DesktopPlatform) {
  if (platform === "macos") {
    return "macOS";
  }
  if (platform === "linux") {
    return "Linux / Ubuntu";
  }
  if (platform === "windows") {
    return "Windows";
  }
  return "未知平台";
}

function describePlatformFontFallback(platform: DesktopPlatform) {
  if (platform === "macos") {
    return "SF Pro Text / PingFang SC";
  }
  if (platform === "linux") {
    return "Noto Sans CJK SC / Ubuntu";
  }
  if (platform === "windows") {
    return "Segoe UI Variable / 微软雅黑";
  }
  return "系统默认字体";
}

function formatBucketDate(date: Date) {
  return `${date.getFullYear()}${`${date.getMonth() + 1}`.padStart(2, "0")}${`${date.getDate()}`.padStart(2, "0")}`;
}

function buildInitials(modelName: string) {
  const clean = modelName.trim();
  if (!clean) {
    return "NA";
  }

  const chunks = clean.split(/[\s:/-]+/).filter(Boolean);
  return chunks.slice(0, 2).map((item) => item[0]?.toUpperCase() ?? "").join("");
}

async function copyToClipboard(
  label: string,
  value: string,
  setStatusText: (message: string) => void,
) {
  if (!value) {
    setStatusText(`${label}为空，无法复制。`);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatusText(`${label}已复制到剪贴板。`);
  } catch {
    setStatusText(`复制${label}失败，请检查系统剪贴板权限。`);
  }
}

function downloadTextFile(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生了未知错误，请稍后再试。";
}

function describeLogRefresh(result: LogQueryResult) {
  if (result.sync_state.status === "backoff") {
    return `已从本地缓存读取日志，后台同步失败，将在 ${formatTime(result.sync_state.next_retry_at)} 后重试。`;
  }
  if (result.sync_state.status === "syncing") {
    return "已从本地缓存读取日志，后台正在执行增量同步。";
  }
  if (result.remote_fetched) {
    return `已完成远程同步，缓存更新时间 ${result.cached_at ? formatDateTime(result.cached_at) : "--"}`;
  }
  if (result.used_cache) {
    return `已从本地缓存读取日志，缓存更新时间 ${result.cached_at ? formatDateTime(result.cached_at) : "--"}`;
  }
  return "日志查询完成。";
}

function describeSyncEvent(syncState: CacheSyncState) {
  if (syncState.status === "syncing") {
    return syncState.sync_mode === "incremental"
      ? "后台增量同步已开始，先显示本地缓存。"
      : "后台全量同步已开始，先显示本地缓存。";
  }

  if (syncState.status === "backoff") {
    return `同步失败，已进入退避重试，将在 ${formatTime(syncState.next_retry_at)} 后再次尝试。`;
  }

  if (syncState.status === "error") {
    return syncState.last_error || "同步失败，请稍后重试。";
  }

  if (syncState.status === "ready" && syncState.synced_at) {
    return `同步完成，缓存更新时间 ${formatDateTime(syncState.synced_at)}。`;
  }

  return "缓存状态已更新。";
}

function describeSyncStateLabel(syncState: CacheSyncState) {
  if (syncState.status === "syncing") {
    return syncState.sync_mode === "incremental" ? "后台增量同步中" : "后台同步中";
  }
  if (syncState.status === "backoff") {
    return "失败待重试";
  }
  if (syncState.status === "error") {
    return "同步失败";
  }
  if (syncState.status === "ready") {
    return syncState.sync_mode === "incremental" ? "最近增量同步" : "缓存可用";
  }
  return "尚未同步";
}

function describeSyncStateDetail(syncState: CacheSyncState) {
  if (syncState.status === "syncing") {
    const startText = syncState.last_attempt_at ? formatDateTime(syncState.last_attempt_at) : "--";
    return `已在 ${startText} 发起${syncState.sync_mode === "incremental" ? "增量" : "全量"}同步。`;
  }

  if (syncState.status === "backoff") {
    return `${syncState.last_error || "最近一次同步失败"}，将在 ${formatTime(syncState.next_retry_at)} 后自动重试。`;
  }

  if (syncState.status === "error") {
    return syncState.last_error || "最近一次同步失败。";
  }

  if (syncState.status === "ready") {
    return syncState.synced_at
      ? `最近同步完成于 ${formatDateTime(syncState.synced_at)}。`
      : "缓存已建立，可直接读取本地数据。";
  }

  return "当前范围还没有可用缓存。";
}

function getSyncStatePillClass(syncState: CacheSyncState) {
  if (syncState.status === "syncing") {
    return "pill accent";
  }
  if (syncState.status === "backoff" || syncState.status === "error") {
    return "pill warning";
  }
  if (syncState.status === "ready") {
    return "pill";
  }
  return "pill muted";
}

function isConfigReady(config: AppConfig) {
  return Boolean(config.base_url && config.user_id && config.token);
}

function hasCacheScope(config: AppConfig) {
  return Boolean(config.base_url.trim() && config.user_id.trim());
}

function getScopeKey(config: AppConfig) {
  if (!hasCacheScope(config)) {
    return "";
  }

  return `${config.base_url.trim().replace(/\/+$/, "").toLowerCase()}|${config.user_id.trim().toLowerCase()}`;
}

function createEmptyCacheOverview(scopeKey = ""): CacheOverviewPayload {
  return {
    scope_key: scopeKey,
    total_logs: 0,
    range_count: 0,
    last_snapshot_at: 0,
    ranges: [],
  };
}

function toLoginForm(config: AppConfig): VerifyLoginRequest {
  return {
    base_url: config.base_url,
    user_id: config.user_id,
    token: config.token,
  };
}

function themeLabel(themeMode: ThemeMode) {
  return themeOptions.find((item) => item.key === themeMode)?.label ?? "跟随系统";
}

function describeBucketLabel(bucketKey: string) {
  if (bucketKey === "all") {
    return "全部日志";
  }
  if (bucketKey.startsWith("day:")) {
    return "今日范围";
  }
  if (bucketKey.startsWith("week:")) {
    return "本周范围";
  }
  if (bucketKey.startsWith("month:")) {
    return "本月范围";
  }
  return bucketKey || "自定义范围";
}

export default App;
