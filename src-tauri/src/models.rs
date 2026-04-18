use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
  Light,
  Dark,
  System,
}

fn default_float_always_on_top() -> bool {
  true
}

impl Default for ThemeMode {
  fn default() -> Self {
    Self::System
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
  pub base_url: String,
  pub token: String,
  pub user_id: String,
  pub fetch_interval_minutes: u32,
  pub status_refresh_interval_minutes: u32,
  pub cache_hit_rate_window_minutes: u32,
  #[serde(default = "default_float_always_on_top")]
  pub float_always_on_top: bool,
  pub theme_mode: ThemeMode,
}

impl Default for AppConfig {
  fn default() -> Self {
    Self {
      base_url: "https://ai.centos.hk".to_string(),
      token: String::new(),
      user_id: String::new(),
      fetch_interval_minutes: 15,
      status_refresh_interval_minutes: 5,
      cache_hit_rate_window_minutes: 60,
      float_always_on_top: true,
      theme_mode: ThemeMode::System,
    }
  }
}

impl AppConfig {
  pub fn sanitized(mut self) -> Self {
    self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
    self.token = self.token.trim().to_string();
    self.user_id = self.user_id.trim().to_string();
    self.fetch_interval_minutes = self.fetch_interval_minutes.max(1);
    self.status_refresh_interval_minutes = self.status_refresh_interval_minutes.max(1);
    self.cache_hit_rate_window_minutes = self.cache_hit_rate_window_minutes.max(1);
    self
  }

  pub fn is_ready(&self) -> bool {
    !self.base_url.trim().is_empty()
      && !self.user_id.trim().is_empty()
      && !self.token.trim().is_empty()
  }

  pub fn scope_key(&self) -> String {
    format!(
      "{}|{}",
      self.base_url.trim().to_lowercase(),
      self.user_id.trim().to_lowercase()
    )
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyLoginRequest {
  pub base_url: String,
  pub user_id: String,
  pub token: String,
}

impl VerifyLoginRequest {
  pub fn into_config(self, current: &AppConfig) -> AppConfig {
    AppConfig {
      base_url: self.base_url,
      user_id: self.user_id,
      token: self.token,
      fetch_interval_minutes: current.fetch_interval_minutes,
      status_refresh_interval_minutes: current.status_refresh_interval_minutes,
      cache_hit_rate_window_minutes: current.cache_hit_rate_window_minutes,
      float_always_on_top: current.float_always_on_top,
      theme_mode: current.theme_mode.clone(),
    }
    .sanitized()
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapPayload {
  pub config: AppConfig,
  pub can_auto_login: bool,
  pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserInfo {
  pub id: i64,
  pub username: String,
  #[serde(default)]
  pub display_name: String,
  #[serde(default)]
  pub email: String,
  pub quota: i64,
  pub used_quota: i64,
  pub request_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogStat {
  pub quota: i64,
  pub rpm: i64,
  pub tpm: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OtherInfo {
  pub cache_tokens: i64,
  pub cache_write_tokens: i64,
  pub model_ratio: f64,
  pub group_ratio: f64,
  pub completion_ratio: f64,
  pub cache_creation_ratio_5m: f64,
  pub frt: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogItem {
  pub id: i64,
  pub user_id: i64,
  pub created_at: i64,
  pub r#type: i64,
  #[serde(default)]
  pub content: String,
  #[serde(default)]
  pub username: String,
  #[serde(default)]
  pub token_name: String,
  pub token_id: i64,
  #[serde(default)]
  pub model_name: String,
  pub quota: i64,
  pub prompt_tokens: i64,
  pub completion_tokens: i64,
  pub use_time: i64,
  pub is_stream: bool,
  pub channel: i64,
  #[serde(default)]
  pub channel_name: String,
  #[serde(default)]
  pub group: String,
  #[serde(default)]
  pub ip: String,
  #[serde(default)]
  pub request_id: String,
  #[serde(default)]
  pub other: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogPage {
  pub page: i64,
  pub page_size: i64,
  pub total: i64,
  pub items: Vec<LogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEnvelope<T> {
  pub success: bool,
  #[serde(default)]
  pub message: String,
  pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusPayload {
  pub user: UserInfo,
  pub stat: LogStat,
  pub cache_hit_rate: Option<f64>,
  pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogQueryRequest {
  pub bucket_key: String,
  pub page: i64,
  pub page_size: i64,
  pub model_name: Option<String>,
  pub token_name: Option<String>,
  pub request_id: Option<String>,
  pub start_ts: Option<i64>,
  pub end_ts: i64,
  pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheSyncState {
  #[serde(default)]
  pub scope_key: String,
  #[serde(default)]
  pub bucket_key: String,
  #[serde(default)]
  pub status: String,
  #[serde(default)]
  pub sync_mode: String,
  pub last_attempt_at: i64,
  pub last_success_at: i64,
  pub synced_at: i64,
  #[serde(default)]
  pub last_error: String,
  pub failure_count: i64,
  pub next_retry_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogQueryResult {
  pub page: LogPage,
  pub used_cache: bool,
  pub remote_fetched: bool,
  pub cached_at: i64,
  pub available_models: Vec<String>,
  pub available_tokens: Vec<String>,
  pub cache_hit_rate: Option<f64>,
  pub sync_state: CacheSyncState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportLogsRequest {
  pub model_name: Option<String>,
  pub token_name: Option<String>,
  pub request_id: Option<String>,
  pub start_ts: Option<i64>,
  pub end_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportLogsResult {
  pub file_name: String,
  pub csv: String,
  pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheHitRateStats {
  pub cache_read_tokens: i64,
  pub cache_write_tokens: i64,
  pub prompt_tokens: i64,
}

impl CacheHitRateStats {
  pub fn hit_rate(&self) -> Option<f64> {
    let total = self.cache_read_tokens + self.cache_write_tokens + self.prompt_tokens;
    if total > 0 {
      Some(self.cache_read_tokens as f64 * 100.0 / total as f64)
    } else {
      None
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterOptions {
  pub available_models: Vec<String>,
  pub available_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheRangeInfo {
  #[serde(default)]
  pub bucket_key: String,
  pub range_start: i64,
  pub range_end: i64,
  pub synced_at: i64,
  pub item_count: i64,
  pub newest_log_at: i64,
  pub oldest_log_at: i64,
  pub sync_state: CacheSyncState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheOverviewPayload {
  #[serde(default)]
  pub scope_key: String,
  pub total_logs: i64,
  pub range_count: i64,
  pub last_snapshot_at: i64,
  pub ranges: Vec<CacheRangeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClearCacheResult {
  pub cleared_at: i64,
  pub deleted_logs: i64,
  pub deleted_ranges: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogSyncEventPayload {
  pub should_reload: bool,
  pub sync_state: CacheSyncState,
}
