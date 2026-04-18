export type ThemeMode = "light" | "dark" | "system";
export type DesktopPlatform = "windows" | "macos" | "linux" | "unknown";

export interface AppConfig {
  base_url: string;
  token: string;
  user_id: string;
  fetch_interval_minutes: number;
  status_refresh_interval_minutes: number;
  cache_hit_rate_window_minutes: number;
  float_always_on_top: boolean;
  theme_mode: ThemeMode;
}

export interface BootstrapPayload {
  config: AppConfig;
  can_auto_login: boolean;
  platform: DesktopPlatform;
}

export interface VerifyLoginRequest {
  base_url: string;
  user_id: string;
  token: string;
}

export interface UserInfo {
  id: number;
  username: string;
  display_name: string;
  email: string;
  quota: number;
  used_quota: number;
  request_count: number;
}

export interface LogStat {
  quota: number;
  rpm: number;
  tpm: number;
}

export interface OtherInfo {
  cache_tokens: number;
  cache_write_tokens: number;
  model_ratio: number;
  group_ratio: number;
  completion_ratio: number;
  cache_creation_ratio_5m: number;
  frt: number;
}

export interface LogItem {
  id: number;
  user_id: number;
  created_at: number;
  type: number;
  content: string;
  username: string;
  token_name: string;
  token_id: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  is_stream: boolean;
  channel: number;
  channel_name: string;
  group: string;
  ip: string;
  request_id: string;
  other: string;
}

export interface LogPage {
  page: number;
  page_size: number;
  total: number;
  items: LogItem[];
}

export interface StatusPayload {
  user: UserInfo;
  stat: LogStat;
  cache_hit_rate: number | null;
  fetched_at: number;
}

export interface LogQueryRequest {
  bucket_key: string;
  page: number;
  page_size: number;
  model_name: string | null;
  token_name: string | null;
  request_id: string | null;
  start_ts: number | null;
  end_ts: number;
  force_refresh: boolean;
}

export interface CacheSyncState {
  scope_key: string;
  bucket_key: string;
  status: string;
  sync_mode: string;
  last_attempt_at: number;
  last_success_at: number;
  synced_at: number;
  last_error: string;
  failure_count: number;
  next_retry_at: number;
}

export interface LogQueryResult {
  page: LogPage;
  used_cache: boolean;
  remote_fetched: boolean;
  cached_at: number;
  available_models: string[];
  available_tokens: string[];
  cache_hit_rate: number | null;
  sync_state: CacheSyncState;
}

export interface ExportLogsRequest {
  model_name: string | null;
  token_name: string | null;
  request_id: string | null;
  start_ts: number | null;
  end_ts: number;
}

export interface ExportLogsResult {
  file_name: string;
  csv: string;
  total: number;
}

export interface CacheRangeInfo {
  bucket_key: string;
  range_start: number;
  range_end: number;
  synced_at: number;
  item_count: number;
  newest_log_at: number;
  oldest_log_at: number;
  sync_state: CacheSyncState;
}

export interface CacheOverviewPayload {
  scope_key: string;
  total_logs: number;
  range_count: number;
  last_snapshot_at: number;
  ranges: CacheRangeInfo[];
}

export interface ClearCacheResult {
  cleared_at: number;
  deleted_logs: number;
  deleted_ranges: number;
}

export interface LogSyncEventPayload {
  should_reload: boolean;
  sync_state: CacheSyncState;
}
