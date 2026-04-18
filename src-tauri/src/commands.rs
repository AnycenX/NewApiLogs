use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{anyhow, bail, Context};
use chrono::{Local, TimeZone, Utc};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::{sync::Mutex, time::sleep};

use crate::{
  config,
  database::Database,
  models::{
    AppConfig, BootstrapPayload, CacheOverviewPayload, CacheSyncState, ClearCacheResult,
    ExportLogsRequest, ExportLogsResult, LogItem, LogQueryRequest, LogQueryResult,
    LogSyncEventPayload, OtherInfo, StatusPayload, VerifyLoginRequest,
  },
  windowing::{current_platform, float_window_metrics, settings_window_metrics, DesktopPlatform},
  AppState,
};

type CommandResult<T> = Result<T, String>;

const INCREMENTAL_SYNC_OVERLAP_SECONDS: i64 = 300;
const MAX_SYNC_ATTEMPTS: usize = 3;

#[derive(Clone)]
struct SyncPlan {
  sync_mode: String,
  fetch_start: i64,
}

#[tauri::command]
pub fn load_bootstrap(state: State<'_, AppState>) -> CommandResult<BootstrapPayload> {
  let config = config::load_config(&state.config_path).sanitized();

  Ok(BootstrapPayload {
    can_auto_login: config.is_ready(),
    config,
    platform: current_platform().as_str().to_string(),
  })
}

#[tauri::command]
pub async fn verify_login(
  request: VerifyLoginRequest,
  state: State<'_, AppState>,
) -> CommandResult<AppConfig> {
  let current = config::load_config(&state.config_path).sanitized();
  let candidate = request.into_config(&current);

  ensure_config_ready(&candidate).map_err(|error| error.to_string())?;
  state
    .api_client
    .verify_token(&candidate)
    .await
    .map_err(|error| error.to_string())?;

  config::save_config(&state.config_path, &candidate).map_err(|error| error.to_string())?;

  Ok(candidate)
}

#[tauri::command]
pub fn save_config(
  config: AppConfig,
  state: State<'_, AppState>,
  app: tauri::AppHandle,
) -> CommandResult<AppConfig> {
  let sanitized = config.sanitized();
  config::save_config(&state.config_path, &sanitized).map_err(|error| error.to_string())?;

  if let Some(window) = app.get_webview_window("float") {
    apply_float_window_config(&window, &sanitized).map_err(|error| error.to_string())?;
  }

  Ok(sanitized)
}

#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> CommandResult<()> {
  if let Some(window) = app.get_webview_window("settings") {
    focus_window(&window).map_err(|error| error.to_string())?;
    return Ok(());
  }

  let metrics = settings_window_metrics();
  let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
    .title("WebApiLogs 设置")
    .inner_size(metrics.width, metrics.height)
    .min_inner_size(metrics.min_width, metrics.min_height)
    .center()
    .focused(true);

  builder.build().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
pub async fn open_float_window(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
) -> CommandResult<()> {
  if let Some(window) = app.get_webview_window("float") {
    focus_window(&window).map_err(|error| error.to_string())?;
    return Ok(());
  }

  let config = config::load_config(&state.config_path).sanitized();
  let metrics = float_window_metrics();
  let shadow_enabled = !matches!(current_platform(), DesktopPlatform::Linux);
  let builder = WebviewWindowBuilder::new(&app, "float", WebviewUrl::App("index.html".into()))
    .title("WebApiLogs 状态悬浮窗")
    .inner_size(metrics.width, metrics.height)
    .min_inner_size(metrics.min_width, metrics.min_height)
    .resizable(false)
    .decorations(false)
    .always_on_top(config.float_always_on_top)
    .skip_taskbar(true)
    .shadow(shadow_enabled)
    .focused(true);

  builder.build().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
pub async fn close_window(label: String, app: tauri::AppHandle) -> CommandResult<()> {
  if let Some(window) = app.get_webview_window(&label) {
    window.close().map_err(|error| error.to_string())?;
  }

  Ok(())
}

#[tauri::command]
pub async fn start_window_drag(label: String, app: tauri::AppHandle) -> CommandResult<()> {
  let window = app
    .get_webview_window(&label)
    .ok_or_else(|| format!("窗口不存在：{label}"))?;

  window.start_dragging().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
pub async fn fetch_status(state: State<'_, AppState>) -> CommandResult<StatusPayload> {
  let config = require_ready_config(&state).map_err(|error| error.to_string())?;
  let db_path = state.db_path.clone();

  let user = state
    .api_client
    .get_user_info(&config)
    .await
    .map_err(|error| error.to_string())?;

  let today_start = local_day_start_timestamp();
  let now_ts = Utc::now().timestamp();

  let stat = state
    .api_client
    .get_log_stat(&config, today_start, now_ts)
    .await
    .map_err(|error| error.to_string())?;

  let database = Database::open(&db_path).map_err(|error| error.to_string())?;
  database
    .save_snapshot(
      &config.scope_key(),
      user.quota as f64 / 500000.0,
      user.used_quota as f64 / 500000.0,
      user.request_count,
      stat.quota,
    )
    .map_err(|error| error.to_string())?;

  let cache_hit_rate = get_cache_hit_rate(&database, &config).map_err(|error| error.to_string())?;

  Ok(StatusPayload {
    user,
    stat,
    cache_hit_rate,
    fetched_at: now_ts,
  })
}

#[tauri::command]
pub async fn query_logs(
  request: LogQueryRequest,
  state: State<'_, AppState>,
  app: tauri::AppHandle,
) -> CommandResult<LogQueryResult> {
  let config = require_ready_config(&state).map_err(|error| error.to_string())?;
  let scope_key = config.scope_key();
  let now_ts = Utc::now().timestamp();
  let min_synced_at = now_ts
    .checked_sub(config.fetch_interval_minutes.max(1) as i64 * 60)
    .unwrap_or_default();
  let db_path = state.db_path.clone();
  let api_client = state.api_client.clone();
  let sync_lock = state.log_sync_lock.clone();

  let database = Database::open(&db_path).map_err(|error| error.to_string())?;
  let cached_at = database
    .get_log_cache_synced_at(&scope_key, &request.bucket_key)
    .map_err(|error| error.to_string())?
    .unwrap_or_default();
  let cache_fresh = database
    .is_log_cache_available(&scope_key, &request.bucket_key, min_synced_at)
    .map_err(|error| error.to_string())?;
  let has_cache = cached_at > 0;

  if request.force_refresh || !has_cache {
    let plan = build_sync_plan(&database, &scope_key, &request, request.force_refresh)
      .map_err(|error| error.to_string())?;
    let started_at = Utc::now().timestamp();

    database
      .record_sync_started(&scope_key, &request.bucket_key, &plan.sync_mode, started_at)
      .map_err(|error| error.to_string())?;
    let started_state = load_sync_state(&database, &scope_key, &request.bucket_key);
    emit_sync_event(&app, started_state, false).map_err(|error| error.to_string())?;

    drop(database);

    let sync_state = perform_log_sync(
      config.clone(),
      db_path.clone(),
      api_client,
      sync_lock,
      request.clone(),
      plan,
      app.clone(),
      false,
    )
    .await
    .map_err(|error| error.to_string())?;

    let database = Database::open(&db_path).map_err(|error| error.to_string())?;
    return build_log_query_result(
      &database,
      &config,
      &request,
      false,
      true,
      sync_state,
    )
    .map_err(|error| error.to_string());
  }

  let mut sync_state = load_sync_state(&database, &scope_key, &request.bucket_key);

  if !cache_fresh && should_schedule_background_sync(&sync_state, now_ts) {
    let plan = build_sync_plan(&database, &scope_key, &request, false)
      .map_err(|error| error.to_string())?;
    let started_at = Utc::now().timestamp();

    database
      .record_sync_started(&scope_key, &request.bucket_key, &plan.sync_mode, started_at)
      .map_err(|error| error.to_string())?;
    sync_state = load_sync_state(&database, &scope_key, &request.bucket_key);
    emit_sync_event(&app, sync_state.clone(), false).map_err(|error| error.to_string())?;

    let background_request = request.clone();
    let background_config = config.clone();
    let background_db_path = db_path.clone();
    let background_lock = sync_lock.clone();
    let background_app = app.clone();

    tauri::async_runtime::spawn(async move {
      let _ = perform_log_sync(
        background_config,
        background_db_path,
        api_client,
        background_lock,
        background_request,
        plan,
        background_app,
        true,
      )
      .await;
    });
  }

  build_log_query_result(&database, &config, &request, true, false, sync_state)
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_logs(
  request: ExportLogsRequest,
  state: State<'_, AppState>,
) -> CommandResult<ExportLogsResult> {
  let config = require_ready_config(&state).map_err(|error| error.to_string())?;
  let database = Database::open(&state.db_path).map_err(|error| error.to_string())?;
  let items = database
    .get_logs_for_export(
      &config.scope_key(),
      request.model_name.as_deref(),
      request.token_name.as_deref(),
      request.request_id.as_deref(),
      request.start_ts,
      request.end_ts,
    )
    .map_err(|error| error.to_string())?;

  let csv = build_logs_csv(&items).map_err(|error| error.to_string())?;
  let file_name = build_export_file_name(&request);

  Ok(ExportLogsResult {
    file_name,
    csv,
    total: items.len() as i64,
  })
}

#[tauri::command]
pub fn get_cache_overview(state: State<'_, AppState>) -> CommandResult<CacheOverviewPayload> {
  let scope_key = resolve_cache_scope_key(&state).map_err(|error| error.to_string())?;
  let database = Database::open(&state.db_path).map_err(|error| error.to_string())?;
  database
    .get_cache_overview(&scope_key)
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_local_cache(state: State<'_, AppState>) -> CommandResult<ClearCacheResult> {
  let scope_key = resolve_cache_scope_key(&state).map_err(|error| error.to_string())?;
  let mut database = Database::open(&state.db_path).map_err(|error| error.to_string())?;
  database
    .clear_scope_cache(&scope_key)
    .map_err(|error| error.to_string())
}

fn require_ready_config(state: &State<'_, AppState>) -> anyhow::Result<AppConfig> {
  let config = config::load_config(&state.config_path).sanitized();
  ensure_config_ready(&config)?;
  Ok(config)
}

fn resolve_cache_scope_key(state: &State<'_, AppState>) -> anyhow::Result<String> {
  let config = config::load_config(&state.config_path).sanitized();
  if config.base_url.trim().is_empty() || config.user_id.trim().is_empty() {
    bail!("当前没有可管理的缓存范围，请先保存服务地址和用户 ID");
  }

  Ok(config.scope_key())
}

fn ensure_config_ready(config: &AppConfig) -> anyhow::Result<()> {
  if config.base_url.trim().is_empty() {
    bail!("请填写服务地址");
  }
  if config.user_id.trim().is_empty() {
    bail!("请填写用户 ID");
  }
  if config.token.trim().is_empty() {
    bail!("请填写 API Token");
  }
  Ok(())
}

fn local_day_start_timestamp() -> i64 {
  let now = Local::now();
  let naive_start = now
    .date_naive()
    .and_hms_opt(0, 0, 0)
    .expect("midnight should be valid");

  Local
    .from_local_datetime(&naive_start)
    .single()
    .unwrap_or(now)
    .timestamp()
}

fn get_cache_hit_rate(database: &Database, config: &AppConfig) -> anyhow::Result<Option<f64>> {
  let end_ts = Utc::now().timestamp();
  let start_ts = Utc::now()
    .checked_sub_signed(chrono::Duration::minutes(
      config.cache_hit_rate_window_minutes.max(1) as i64,
    ))
    .unwrap_or_else(Utc::now)
    .timestamp();

  let stats = database
    .get_cache_hit_rate_stats(&config.scope_key(), start_ts, end_ts)
    .context("无法统计缓存命中率")?;

  Ok(stats.hit_rate())
}

fn focus_window(window: &tauri::WebviewWindow) -> anyhow::Result<()> {
  if window.is_minimized()? {
    window.unminimize()?;
  }

  window.show()?;
  window.set_focus()?;
  Ok(())
}

fn apply_float_window_config(
  window: &tauri::WebviewWindow,
  config: &AppConfig,
) -> anyhow::Result<()> {
  window.set_always_on_top(config.float_always_on_top)?;
  Ok(())
}

fn build_sync_plan(
  database: &Database,
  scope_key: &str,
  request: &LogQueryRequest,
  force_full: bool,
) -> anyhow::Result<SyncPlan> {
  let query_start = request.start_ts.unwrap_or_default();

  if force_full {
    return Ok(SyncPlan {
      sync_mode: "full".to_string(),
      fetch_start: query_start,
    });
  }

  let latest_log_at = database.get_latest_log_timestamp(scope_key, query_start, request.end_ts)?;
  if let Some(latest_log_at) = latest_log_at {
    return Ok(SyncPlan {
      sync_mode: "incremental".to_string(),
      fetch_start: latest_log_at
        .saturating_sub(INCREMENTAL_SYNC_OVERLAP_SECONDS)
        .max(query_start),
    });
  }

  Ok(SyncPlan {
    sync_mode: "full".to_string(),
    fetch_start: query_start,
  })
}

fn load_sync_state(database: &Database, scope_key: &str, bucket_key: &str) -> CacheSyncState {
  database
    .get_sync_state(scope_key, bucket_key)
    .ok()
    .flatten()
    .unwrap_or_else(|| CacheSyncState {
      scope_key: scope_key.to_string(),
      bucket_key: bucket_key.to_string(),
      status: "idle".to_string(),
      sync_mode: "full".to_string(),
      last_attempt_at: 0,
      last_success_at: 0,
      synced_at: 0,
      last_error: String::new(),
      failure_count: 0,
      next_retry_at: 0,
    })
}

fn should_schedule_background_sync(sync_state: &CacheSyncState, now_ts: i64) -> bool {
  if sync_state.status == "syncing" && sync_state.last_attempt_at > 0 {
    return now_ts.saturating_sub(sync_state.last_attempt_at) >= 30;
  }

  sync_state.next_retry_at <= 0 || sync_state.next_retry_at <= now_ts
}

fn build_log_query_result(
  database: &Database,
  config: &AppConfig,
  request: &LogQueryRequest,
  used_cache: bool,
  remote_fetched: bool,
  sync_state: CacheSyncState,
) -> anyhow::Result<LogQueryResult> {
  let page = database.get_logs_page(
    &config.scope_key(),
    request.page.max(1),
    request.page_size.max(1),
    request.model_name.as_deref(),
    request.token_name.as_deref(),
    request.request_id.as_deref(),
    request.start_ts,
    request.end_ts,
  )?;

  let options = database.get_filter_options(&config.scope_key())?;
  let cached_at = database
    .get_log_cache_synced_at(&config.scope_key(), &request.bucket_key)?
    .unwrap_or_default();
  let cache_hit_rate = get_cache_hit_rate(database, config)?;

  Ok(LogQueryResult {
    page,
    used_cache,
    remote_fetched,
    cached_at,
    available_models: options.available_models,
    available_tokens: options.available_tokens,
    cache_hit_rate,
    sync_state: CacheSyncState {
      synced_at: cached_at.max(sync_state.synced_at),
      ..sync_state
    },
  })
}

async fn perform_log_sync(
  config: AppConfig,
  db_path: PathBuf,
  api_client: crate::new_api::NewApiClient,
  sync_lock: Arc<Mutex<()>>,
  request: LogQueryRequest,
  plan: SyncPlan,
  app: tauri::AppHandle,
  should_reload: bool,
) -> anyhow::Result<CacheSyncState> {
  let _guard = sync_lock.lock().await;
  let scope_key = config.scope_key();
  let attempted_at = Utc::now().timestamp();
  let query_start = request.start_ts.unwrap_or_default();
  let mut last_error = None;

  for attempt in 1..=MAX_SYNC_ATTEMPTS {
    match api_client
      .fetch_all_logs(&config, plan.fetch_start, request.end_ts)
      .await
    {
      Ok(items) => {
        let mut database = Database::open(&db_path)?;

        if plan.sync_mode == "incremental" {
          database.append_logs(
            &scope_key,
            &request.bucket_key,
            query_start,
            request.end_ts,
            &items,
          )?;
        } else {
          database.replace_logs(
            &scope_key,
            &request.bucket_key,
            query_start,
            request.end_ts,
            &items,
          )?;
        }

        let synced_at = database
          .get_log_cache_synced_at(&scope_key, &request.bucket_key)?
          .unwrap_or_else(|| Utc::now().timestamp());

        database.record_sync_success(
          &scope_key,
          &request.bucket_key,
          &plan.sync_mode,
          attempted_at,
          synced_at,
        )?;

        let sync_state = load_sync_state(&database, &scope_key, &request.bucket_key);
        emit_sync_event(&app, sync_state.clone(), should_reload)?;
        return Ok(sync_state);
      }
      Err(error) => {
        last_error = Some(error);
        if attempt < MAX_SYNC_ATTEMPTS {
          sleep(Duration::from_secs(retry_attempt_delay_seconds(attempt))).await;
        }
      }
    }
  }

  let error_message = simplify_sync_error(last_error.unwrap_or_else(|| anyhow!("日志同步失败")));
  let database = Database::open(&db_path)?;
  let current_state = load_sync_state(&database, &scope_key, &request.bucket_key);
  let failure_count = current_state.failure_count + 1;
  let next_retry_at = attempted_at + retry_backoff_seconds(failure_count);
  let sync_state = database.record_sync_failure(
    &scope_key,
    &request.bucket_key,
    &plan.sync_mode,
    attempted_at,
    next_retry_at,
    &error_message,
  )?;

  emit_sync_event(&app, sync_state.clone(), false)?;
  Err(anyhow!(error_message))
}

fn retry_attempt_delay_seconds(attempt: usize) -> u64 {
  match attempt {
    1 => 1,
    2 => 2,
    _ => 3,
  }
}

fn retry_backoff_seconds(failure_count: i64) -> i64 {
  match failure_count {
    0 | 1 => 60,
    2 => 3 * 60,
    3 => 5 * 60,
    _ => 10 * 60,
  }
}

fn simplify_sync_error(error: anyhow::Error) -> String {
  let raw = error.to_string();
  let trimmed = raw.trim();
  let mut shortened: String = trimmed.chars().take(180).collect();
  if shortened.is_empty() {
    shortened = "日志同步失败".to_string();
  }

  if trimmed.chars().count() > 180 {
    format!("{shortened}...")
  } else {
    shortened
  }
}

fn emit_sync_event(
  app: &tauri::AppHandle,
  sync_state: CacheSyncState,
  should_reload: bool,
) -> anyhow::Result<()> {
  app
    .emit(
      "logs-sync-updated",
      LogSyncEventPayload {
        should_reload,
        sync_state,
      },
    )
    .map_err(|error| anyhow!(error.to_string()))
}

fn build_logs_csv(items: &[LogItem]) -> anyhow::Result<String> {
  let headers = [
    "时间",
    "模型",
    "Token名",
    "分组",
    "请求ID",
    "消费(元)",
    "输入Tokens",
    "输入缓存写入Tokens",
    "输出Tokens",
    "输出缓存命中Tokens",
    "耗时(秒)",
    "FRT(ms)",
    "FRT(秒)",
    "流式",
    "模型倍率",
    "分组倍率",
    "输出倍率",
    "5m缓存倍率",
    "渠道",
    "用户名",
    "来源IP",
    "日志内容",
    "Other原始数据",
  ];

  let mut lines = Vec::with_capacity(items.len() + 1);
  lines.push(headers.join(","));

  for item in items {
    let other = parse_other(&item.other);
    let created_at = format_date_time(item.created_at);
    let quota = format!("{:.6}", item.quota as f64 / 500000.0);
    let frt_seconds = format!("{:.2}", other.frt as f64 / 1000.0);

    let row = [
      created_at,
      item.model_name.clone(),
      item.token_name.clone(),
      item.group.clone(),
      item.request_id.clone(),
      quota,
      item.prompt_tokens.to_string(),
      other.cache_write_tokens.to_string(),
      item.completion_tokens.to_string(),
      other.cache_tokens.to_string(),
      item.use_time.to_string(),
      other.frt.to_string(),
      frt_seconds,
      if item.is_stream {
        "流式".to_string()
      } else {
        "非流式".to_string()
      },
      format_ratio(other.model_ratio),
      format_ratio(other.group_ratio),
      format_ratio(other.completion_ratio),
      format_ratio(other.cache_creation_ratio_5m),
      item.channel_name.clone(),
      item.username.clone(),
      item.ip.clone(),
      item.content.clone(),
      item.other.clone(),
    ];

    lines.push(
      row
        .into_iter()
        .map(|value| escape_csv_field(&value))
        .collect::<Vec<_>>()
        .join(","),
    );
  }

  Ok(lines.join("\n"))
}

fn build_export_file_name(request: &ExportLogsRequest) -> String {
  let timestamp = Local::now().format("%Y%m%d-%H%M%S");
  let mut parts = vec!["webapilogs".to_string(), timestamp.to_string()];

  if let Some(model_name) = request.model_name.as_deref().filter(|value| !value.trim().is_empty()) {
    parts.push(format!("model-{}", sanitize_file_part(model_name)));
  }

  if let Some(token_name) = request.token_name.as_deref().filter(|value| !value.trim().is_empty()) {
    parts.push(format!("token-{}", sanitize_file_part(token_name)));
  }

  if let Some(request_id) = request.request_id.as_deref().filter(|value| !value.trim().is_empty()) {
    parts.push(format!("request-{}", sanitize_file_part(request_id)));
  }

  format!("{}.csv", parts.join("-"))
}

fn sanitize_file_part(value: &str) -> String {
  let sanitized: String = value
    .trim()
    .chars()
    .map(|ch| match ch {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ' => '_',
      _ => ch,
    })
    .collect();

  let sanitized = sanitized.trim_matches('_');
  if sanitized.is_empty() {
    "empty".to_string()
  } else {
    sanitized.chars().take(40).collect()
  }
}

fn escape_csv_field(value: &str) -> String {
  let escaped = value.replace('"', "\"\"");
  format!("\"{escaped}\"")
}

fn parse_other(raw: &str) -> OtherInfo {
  serde_json::from_str::<OtherInfo>(raw).unwrap_or_default()
}

fn format_date_time(timestamp: i64) -> String {
  Local
    .timestamp_opt(timestamp, 0)
    .single()
    .or_else(|| Local.timestamp_opt(timestamp, 0).earliest())
    .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
    .unwrap_or_else(|| timestamp.to_string())
}

fn format_ratio(value: f64) -> String {
  if value > 0.0 {
    format!("{value:.2}")
  } else {
    String::new()
  }
}
