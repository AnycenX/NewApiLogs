use std::path::Path;

use anyhow::Context;
use rusqlite::{
  params, params_from_iter, types::Value, Connection, OptionalExtension, Transaction,
};

use crate::models::{
  CacheHitRateStats, CacheOverviewPayload, CacheRangeInfo, CacheSyncState, ClearCacheResult,
  FilterOptions, LogItem, LogPage, OtherInfo,
};

pub struct Database {
  connection: Connection,
}

impl Database {
  pub fn initialize(db_path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = db_path.parent() {
      std::fs::create_dir_all(parent).context("无法创建数据库目录")?;
    }

    let connection = Connection::open(db_path).context("无法打开 SQLite 数据库")?;
    Self::ensure_schema(&connection)?;
    Ok(())
  }

  pub fn open(db_path: &Path) -> anyhow::Result<Self> {
    let connection = Connection::open(db_path).context("无法打开 SQLite 数据库")?;
    Self::ensure_schema(&connection)?;
    Ok(Self { connection })
  }

  fn ensure_schema(connection: &Connection) -> anyhow::Result<()> {
    connection.execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS log_items (
        scope_key TEXT NOT NULL,
        remote_id INTEGER NOT NULL,
        user_id INTEGER,
        created_at INTEGER NOT NULL,
        type INTEGER,
        content TEXT,
        username TEXT,
        token_name TEXT,
        token_id INTEGER,
        model_name TEXT,
        quota INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        use_time INTEGER,
        is_stream INTEGER,
        channel INTEGER,
        channel_name TEXT,
        group_name TEXT,
        ip TEXT,
        request_id TEXT,
        other TEXT,
        last_synced_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_key, remote_id)
      );

      CREATE INDEX IF NOT EXISTS idx_log_items_scope_created_at
        ON log_items(scope_key, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_log_items_scope_model
        ON log_items(scope_key, model_name);

      CREATE INDEX IF NOT EXISTS idx_log_items_scope_token
        ON log_items(scope_key, token_name);

      CREATE INDEX IF NOT EXISTS idx_log_items_scope_request_id
        ON log_items(scope_key, request_id);

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL DEFAULT '',
        fetched_at INTEGER NOT NULL,
        balance REAL,
        used_balance REAL,
        request_count INTEGER,
        today_quota INTEGER
      );

      CREATE TABLE IF NOT EXISTS log_cache_ranges (
        scope_key TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        range_start INTEGER NOT NULL,
        range_end INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, bucket_key)
      );

      CREATE TABLE IF NOT EXISTS log_sync_states (
        scope_key TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        sync_mode TEXT NOT NULL DEFAULT 'full',
        last_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        failure_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_key, bucket_key)
      );
      "#,
    )?;

    Ok(())
  }

  pub fn replace_logs(
    &mut self,
    scope_key: &str,
    bucket_key: &str,
    start_ts: i64,
    end_ts: i64,
    items: &[LogItem],
  ) -> anyhow::Result<()> {
    let transaction = self.connection.transaction()?;
    let sync_ts = chrono::Utc::now().timestamp();

    transaction.execute(
      "CREATE TEMP TABLE synced_remote_ids (remote_id INTEGER PRIMARY KEY)",
      [],
    )?;

    Self::upsert_logs_in_transaction(&transaction, scope_key, items, sync_ts)?;

    {
      let mut track = transaction.prepare(
        "INSERT OR IGNORE INTO synced_remote_ids (remote_id) VALUES (?)",
      )?;

      for item in items {
        track.execute(params![item.id])?;
      }
    }

    transaction.execute(
      r#"
      DELETE FROM log_items
      WHERE scope_key = ?
        AND created_at >= ?
        AND created_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM synced_remote_ids ids
          WHERE ids.remote_id = log_items.remote_id
        )
      "#,
      params![scope_key, start_ts, end_ts],
    )?;

    Self::save_cache_range_exact(&transaction, scope_key, bucket_key, start_ts, end_ts, sync_ts)?;
    transaction.execute("DROP TABLE synced_remote_ids", [])?;
    transaction.commit()?;
    Ok(())
  }

  pub fn append_logs(
    &mut self,
    scope_key: &str,
    bucket_key: &str,
    start_ts: i64,
    end_ts: i64,
    items: &[LogItem],
  ) -> anyhow::Result<()> {
    let transaction = self.connection.transaction()?;
    let sync_ts = chrono::Utc::now().timestamp();

    Self::upsert_logs_in_transaction(&transaction, scope_key, items, sync_ts)?;
    Self::save_cache_range_merged(&transaction, scope_key, bucket_key, start_ts, end_ts, sync_ts)?;

    transaction.commit()?;
    Ok(())
  }

  pub fn save_snapshot(
    &self,
    scope_key: &str,
    balance: f64,
    used_balance: f64,
    request_count: i64,
    today_quota: i64,
  ) -> anyhow::Result<()> {
    self.connection.execute(
      r#"
      INSERT INTO snapshots (scope_key, fetched_at, balance, used_balance, request_count, today_quota)
      VALUES (?, ?, ?, ?, ?, ?)
      "#,
      params![
        scope_key,
        chrono::Utc::now().timestamp(),
        balance,
        used_balance,
        request_count,
        today_quota
      ],
    )?;

    Ok(())
  }

  pub fn is_log_cache_available(
    &self,
    scope_key: &str,
    bucket_key: &str,
    min_synced_at: i64,
  ) -> anyhow::Result<bool> {
    let count: i64 = self.connection.query_row(
      r#"
      SELECT COUNT(*)
      FROM log_cache_ranges
      WHERE scope_key = ?
        AND bucket_key = ?
        AND synced_at >= ?
      "#,
      params![scope_key, bucket_key, min_synced_at],
      |row| row.get(0),
    )?;

    Ok(count > 0)
  }

  pub fn get_log_cache_synced_at(
    &self,
    scope_key: &str,
    bucket_key: &str,
  ) -> anyhow::Result<Option<i64>> {
    self.connection
      .query_row(
        r#"
        SELECT synced_at
        FROM log_cache_ranges
        WHERE scope_key = ?
          AND bucket_key = ?
        "#,
        params![scope_key, bucket_key],
        |row| row.get(0),
      )
      .optional()
      .map_err(Into::into)
  }

  pub fn get_latest_log_timestamp(
    &self,
    scope_key: &str,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<Option<i64>> {
    self.connection
      .query_row(
        r#"
        SELECT MAX(created_at)
        FROM log_items
        WHERE scope_key = ?
          AND created_at >= ?
          AND created_at <= ?
        "#,
        params![scope_key, start_ts, end_ts],
        |row| row.get(0),
      )
      .optional()
      .map(|value| value.flatten())
      .map_err(Into::into)
  }

  pub fn record_sync_started(
    &self,
    scope_key: &str,
    bucket_key: &str,
    sync_mode: &str,
    started_at: i64,
  ) -> anyhow::Result<()> {
    self.connection.execute(
      r#"
      INSERT INTO log_sync_states (
        scope_key, bucket_key, status, sync_mode, last_attempt_at, last_success_at,
        last_error, failure_count, next_retry_at
      )
      VALUES (?, ?, 'syncing', ?, ?, 0, '', 0, 0)
      ON CONFLICT(scope_key, bucket_key) DO UPDATE SET
        status = excluded.status,
        sync_mode = excluded.sync_mode,
        last_attempt_at = excluded.last_attempt_at,
        last_error = '',
        next_retry_at = 0
      "#,
      params![scope_key, bucket_key, sync_mode, started_at],
    )?;

    Ok(())
  }

  pub fn record_sync_success(
    &self,
    scope_key: &str,
    bucket_key: &str,
    sync_mode: &str,
    attempted_at: i64,
    synced_at: i64,
  ) -> anyhow::Result<()> {
    self.connection.execute(
      r#"
      INSERT INTO log_sync_states (
        scope_key, bucket_key, status, sync_mode, last_attempt_at, last_success_at,
        last_error, failure_count, next_retry_at
      )
      VALUES (?, ?, 'ready', ?, ?, ?, '', 0, 0)
      ON CONFLICT(scope_key, bucket_key) DO UPDATE SET
        status = excluded.status,
        sync_mode = excluded.sync_mode,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_error = '',
        failure_count = 0,
        next_retry_at = 0
      "#,
      params![scope_key, bucket_key, sync_mode, attempted_at, synced_at],
    )?;

    Ok(())
  }

  pub fn record_sync_failure(
    &self,
    scope_key: &str,
    bucket_key: &str,
    sync_mode: &str,
    attempted_at: i64,
    next_retry_at: i64,
    error_message: &str,
  ) -> anyhow::Result<CacheSyncState> {
    let current = self
      .get_sync_state(scope_key, bucket_key)?
      .unwrap_or_else(|| CacheSyncState {
        scope_key: scope_key.to_string(),
        bucket_key: bucket_key.to_string(),
        ..CacheSyncState::default()
      });

    let failure_count = current.failure_count + 1;
    let status = if next_retry_at > attempted_at {
      "backoff"
    } else {
      "error"
    };

    self.connection.execute(
      r#"
      INSERT INTO log_sync_states (
        scope_key, bucket_key, status, sync_mode, last_attempt_at, last_success_at,
        last_error, failure_count, next_retry_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, bucket_key) DO UPDATE SET
        status = excluded.status,
        sync_mode = excluded.sync_mode,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        failure_count = excluded.failure_count,
        next_retry_at = excluded.next_retry_at
      "#,
      params![
        scope_key,
        bucket_key,
        status,
        sync_mode,
        attempted_at,
        current.last_success_at.max(current.synced_at),
        error_message.trim(),
        failure_count,
        next_retry_at
      ],
    )?;

    Ok(CacheSyncState {
      scope_key: scope_key.to_string(),
      bucket_key: bucket_key.to_string(),
      status: status.to_string(),
      sync_mode: sync_mode.to_string(),
      last_attempt_at: attempted_at,
      last_success_at: current.last_success_at.max(current.synced_at),
      synced_at: current.synced_at,
      last_error: error_message.trim().to_string(),
      failure_count,
      next_retry_at,
    })
  }

  pub fn get_sync_state(
    &self,
    scope_key: &str,
    bucket_key: &str,
  ) -> anyhow::Result<Option<CacheSyncState>> {
    let synced_at = self
      .get_log_cache_synced_at(scope_key, bucket_key)?
      .unwrap_or_default();

    let row = self
      .connection
      .query_row(
        r#"
        SELECT status, sync_mode, last_attempt_at, last_success_at, last_error, failure_count, next_retry_at
        FROM log_sync_states
        WHERE scope_key = ?
          AND bucket_key = ?
        "#,
        params![scope_key, bucket_key],
        |row| {
          Ok(CacheSyncState {
            scope_key: scope_key.to_string(),
            bucket_key: bucket_key.to_string(),
            status: row.get::<_, String>(0)?,
            sync_mode: row.get::<_, String>(1)?,
            last_attempt_at: row.get(2)?,
            last_success_at: row.get(3)?,
            synced_at,
            last_error: row.get::<_, String>(4)?,
            failure_count: row.get(5)?,
            next_retry_at: row.get(6)?,
          })
        },
      )
      .optional()?;

    if row.is_some() {
      return Ok(row);
    }

    if synced_at > 0 {
      return Ok(Some(CacheSyncState {
        scope_key: scope_key.to_string(),
        bucket_key: bucket_key.to_string(),
        status: "ready".to_string(),
        sync_mode: "full".to_string(),
        last_attempt_at: synced_at,
        last_success_at: synced_at,
        synced_at,
        last_error: String::new(),
        failure_count: 0,
        next_retry_at: 0,
      }));
    }

    Ok(None)
  }

  pub fn get_logs_page(
    &self,
    scope_key: &str,
    page: i64,
    page_size: i64,
    model_name: Option<&str>,
    token_name: Option<&str>,
    request_id: Option<&str>,
    start_ts: Option<i64>,
    end_ts: i64,
  ) -> anyhow::Result<LogPage> {
    let (where_clause, values) =
      build_where_clause(scope_key, model_name, token_name, request_id, start_ts, Some(end_ts));

    let total_sql = format!("SELECT COUNT(*) FROM log_items{where_clause}");
    let total: i64 = self
      .connection
      .query_row(&total_sql, params_from_iter(values.iter()), |row| row.get(0))?;

    let mut paged_values = values.clone();
    paged_values.push(Value::Integer(page_size));
    paged_values.push(Value::Integer((page - 1).max(0) * page_size));

    let data_sql = format!(
      "SELECT * FROM log_items{where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?"
    );
    let mut statement = self.connection.prepare(&data_sql)?;
    let rows = statement.query_map(params_from_iter(paged_values.iter()), map_log_item)?;

    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(LogPage {
      page,
      page_size,
      total,
      items,
    })
  }

  pub fn get_logs_for_export(
    &self,
    scope_key: &str,
    model_name: Option<&str>,
    token_name: Option<&str>,
    request_id: Option<&str>,
    start_ts: Option<i64>,
    end_ts: i64,
  ) -> anyhow::Result<Vec<LogItem>> {
    let (where_clause, values) =
      build_where_clause(scope_key, model_name, token_name, request_id, start_ts, Some(end_ts));

    let sql = format!("SELECT * FROM log_items{where_clause} ORDER BY created_at DESC");
    let mut statement = self.connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values.iter()), map_log_item)?;
    let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
  }

  pub fn get_filter_options(&self, scope_key: &str) -> anyhow::Result<FilterOptions> {
    let available_models = self.get_distinct_values(scope_key, "model_name")?;
    let available_tokens = self.get_distinct_values(scope_key, "token_name")?;

    Ok(FilterOptions {
      available_models,
      available_tokens,
    })
  }

  pub fn get_cache_hit_rate_stats(
    &self,
    scope_key: &str,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<CacheHitRateStats> {
    let mut statement = self.connection.prepare(
      r#"
      SELECT prompt_tokens, other
      FROM log_items
      WHERE scope_key = ?
        AND created_at >= ?
        AND created_at <= ?
      "#,
    )?;

    let mut stats = CacheHitRateStats::default();
    let mut rows = statement.query(params![scope_key, start_ts, end_ts])?;

    while let Some(row) = rows.next()? {
      let prompt_tokens: i64 = row.get("prompt_tokens")?;
      let other_raw: String = row.get::<_, Option<String>>("other")?.unwrap_or_default();

      stats.prompt_tokens += prompt_tokens;

      if other_raw.trim().is_empty() {
        continue;
      }

      if let Ok(other) = serde_json::from_str::<OtherInfo>(&other_raw) {
        stats.cache_read_tokens += other.cache_tokens;
        stats.cache_write_tokens += other.cache_write_tokens;
      }
    }

    Ok(stats)
  }

  pub fn get_cache_overview(&self, scope_key: &str) -> anyhow::Result<CacheOverviewPayload> {
    let total_logs: i64 = self.connection.query_row(
      "SELECT COUNT(*) FROM log_items WHERE scope_key = ?",
      params![scope_key],
      |row| row.get(0),
    )?;

    let last_snapshot_at: i64 = self
      .connection
      .query_row(
        "SELECT MAX(fetched_at) FROM snapshots WHERE scope_key = ?",
        params![scope_key],
        |row| row.get::<_, Option<i64>>(0),
      )?
      .unwrap_or_default();

    let mut statement = self.connection.prepare(
      r#"
      SELECT bucket_key, range_start, range_end, synced_at
      FROM log_cache_ranges
      WHERE scope_key = ?
      ORDER BY synced_at DESC, range_end DESC
      "#,
    )?;

    let rows = statement.query_map(params![scope_key], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, i64>(2)?,
        row.get::<_, i64>(3)?,
      ))
    })?;

    let mut ranges = Vec::new();

    for row in rows {
      let (bucket_key, range_start, range_end, synced_at) = row?;
      let (item_count, newest_log_at, oldest_log_at) =
        self.get_range_stats(scope_key, range_start, range_end)?;
      let sync_state = self
        .get_sync_state(scope_key, &bucket_key)?
        .unwrap_or_else(|| CacheSyncState {
          scope_key: scope_key.to_string(),
          bucket_key: bucket_key.clone(),
          status: if synced_at > 0 {
            "ready".to_string()
          } else {
            "idle".to_string()
          },
          sync_mode: "full".to_string(),
          last_attempt_at: synced_at,
          last_success_at: synced_at,
          synced_at,
          last_error: String::new(),
          failure_count: 0,
          next_retry_at: 0,
        });

      ranges.push(CacheRangeInfo {
        bucket_key,
        range_start,
        range_end,
        synced_at,
        item_count,
        newest_log_at,
        oldest_log_at,
        sync_state,
      });
    }

    Ok(CacheOverviewPayload {
      scope_key: scope_key.to_string(),
      total_logs,
      range_count: ranges.len() as i64,
      last_snapshot_at,
      ranges,
    })
  }

  pub fn clear_scope_cache(&mut self, scope_key: &str) -> anyhow::Result<ClearCacheResult> {
    let transaction = self.connection.transaction()?;

    let deleted_logs = transaction.execute(
      "DELETE FROM log_items WHERE scope_key = ?",
      params![scope_key],
    )? as i64;
    let deleted_ranges = transaction.execute(
      "DELETE FROM log_cache_ranges WHERE scope_key = ?",
      params![scope_key],
    )? as i64;

    transaction.execute(
      "DELETE FROM log_sync_states WHERE scope_key = ?",
      params![scope_key],
    )?;
    transaction.execute(
      "DELETE FROM snapshots WHERE scope_key = ?",
      params![scope_key],
    )?;

    transaction.commit()?;

    Ok(ClearCacheResult {
      cleared_at: chrono::Utc::now().timestamp(),
      deleted_logs,
      deleted_ranges,
    })
  }

  fn get_distinct_values(&self, scope_key: &str, column: &str) -> anyhow::Result<Vec<String>> {
    let sql = format!(
      "SELECT DISTINCT {column} FROM log_items WHERE scope_key = ? AND {column} != '' ORDER BY {column} COLLATE NOCASE ASC"
    );

    let mut statement = self.connection.prepare(&sql)?;
    let rows = statement.query_map(params![scope_key], |row| row.get::<_, String>(0))?;
    let values = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
  }

  fn get_range_stats(
    &self,
    scope_key: &str,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<(i64, i64, i64)> {
    let (item_count, newest_log_at, oldest_log_at) = self.connection.query_row(
      r#"
      SELECT
        COUNT(*),
        MAX(created_at),
        MIN(created_at)
      FROM log_items
      WHERE scope_key = ?
        AND created_at >= ?
        AND created_at <= ?
      "#,
      params![scope_key, start_ts, end_ts],
      |row| {
        Ok((
          row.get::<_, i64>(0)?,
          row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
          row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
        ))
      },
    )?;

    Ok((item_count, newest_log_at, oldest_log_at))
  }

  fn upsert_logs_in_transaction(
    transaction: &Transaction<'_>,
    scope_key: &str,
    items: &[LogItem],
    sync_ts: i64,
  ) -> anyhow::Result<()> {
    let mut upsert = transaction.prepare(
      r#"
      INSERT INTO log_items (
        scope_key, remote_id, user_id, created_at, type, content, username, token_name,
        token_id, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream,
        channel, channel_name, group_name, ip, request_id, other, last_synced_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(scope_key, remote_id) DO UPDATE SET
        user_id = excluded.user_id,
        created_at = excluded.created_at,
        type = excluded.type,
        content = excluded.content,
        username = excluded.username,
        token_name = excluded.token_name,
        token_id = excluded.token_id,
        model_name = excluded.model_name,
        quota = excluded.quota,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        use_time = excluded.use_time,
        is_stream = excluded.is_stream,
        channel = excluded.channel,
        channel_name = excluded.channel_name,
        group_name = excluded.group_name,
        ip = excluded.ip,
        request_id = excluded.request_id,
        other = excluded.other,
        last_synced_at = excluded.last_synced_at
      "#,
    )?;

    for item in items {
      upsert.execute(params![
        scope_key,
        item.id,
        item.user_id,
        item.created_at,
        item.r#type,
        item.content,
        item.username,
        item.token_name,
        item.token_id,
        item.model_name,
        item.quota,
        item.prompt_tokens,
        item.completion_tokens,
        item.use_time,
        if item.is_stream { 1 } else { 0 },
        item.channel,
        item.channel_name,
        item.group,
        item.ip,
        item.request_id,
        item.other,
        sync_ts
      ])?;
    }

    Ok(())
  }

  fn save_cache_range_exact(
    transaction: &Transaction<'_>,
    scope_key: &str,
    bucket_key: &str,
    start_ts: i64,
    end_ts: i64,
    sync_ts: i64,
  ) -> anyhow::Result<()> {
    transaction.execute(
      r#"
      INSERT INTO log_cache_ranges (scope_key, bucket_key, range_start, range_end, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, bucket_key) DO UPDATE SET
        range_start = excluded.range_start,
        range_end = excluded.range_end,
        synced_at = excluded.synced_at
      "#,
      params![scope_key, bucket_key, start_ts, end_ts, sync_ts],
    )?;

    Ok(())
  }

  fn save_cache_range_merged(
    transaction: &Transaction<'_>,
    scope_key: &str,
    bucket_key: &str,
    start_ts: i64,
    end_ts: i64,
    sync_ts: i64,
  ) -> anyhow::Result<()> {
    transaction.execute(
      r#"
      INSERT INTO log_cache_ranges (scope_key, bucket_key, range_start, range_end, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, bucket_key) DO UPDATE SET
        range_start = MIN(log_cache_ranges.range_start, excluded.range_start),
        range_end = MAX(log_cache_ranges.range_end, excluded.range_end),
        synced_at = excluded.synced_at
      "#,
      params![scope_key, bucket_key, start_ts, end_ts, sync_ts],
    )?;

    Ok(())
  }
}

fn build_where_clause(
  scope_key: &str,
  model_name: Option<&str>,
  token_name: Option<&str>,
  request_id: Option<&str>,
  start_ts: Option<i64>,
  end_ts: Option<i64>,
) -> (String, Vec<Value>) {
  let mut clauses = vec!["scope_key = ?".to_string()];
  let mut values = vec![Value::Text(scope_key.to_string())];

  if let Some(model_name) = model_name.filter(|value| !value.trim().is_empty()) {
    clauses.push("model_name = ?".to_string());
    values.push(Value::Text(model_name.trim().to_string()));
  }

  if let Some(token_name) = token_name.filter(|value| !value.trim().is_empty()) {
    clauses.push("token_name = ?".to_string());
    values.push(Value::Text(token_name.trim().to_string()));
  }

  if let Some(request_id) = request_id.filter(|value| !value.trim().is_empty()) {
    clauses.push("request_id LIKE ?".to_string());
    values.push(Value::Text(format!("%{}%", request_id.trim())));
  }

  if let Some(start_ts) = start_ts {
    clauses.push("created_at >= ?".to_string());
    values.push(Value::Integer(start_ts));
  }

  if let Some(end_ts) = end_ts {
    clauses.push("created_at <= ?".to_string());
    values.push(Value::Integer(end_ts));
  }

  (format!(" WHERE {}", clauses.join(" AND ")), values)
}

fn map_log_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LogItem> {
  Ok(LogItem {
    id: row.get("remote_id")?,
    user_id: row.get("user_id")?,
    created_at: row.get("created_at")?,
    r#type: row.get("type")?,
    content: row.get::<_, Option<String>>("content")?.unwrap_or_default(),
    username: row.get::<_, Option<String>>("username")?.unwrap_or_default(),
    token_name: row.get::<_, Option<String>>("token_name")?.unwrap_or_default(),
    token_id: row.get("token_id")?,
    model_name: row.get::<_, Option<String>>("model_name")?.unwrap_or_default(),
    quota: row.get("quota")?,
    prompt_tokens: row.get("prompt_tokens")?,
    completion_tokens: row.get("completion_tokens")?,
    use_time: row.get("use_time")?,
    is_stream: row.get::<_, i64>("is_stream")? == 1,
    channel: row.get("channel")?,
    channel_name: row.get::<_, Option<String>>("channel_name")?.unwrap_or_default(),
    group: row.get::<_, Option<String>>("group_name")?.unwrap_or_default(),
    ip: row.get::<_, Option<String>>("ip")?.unwrap_or_default(),
    request_id: row.get::<_, Option<String>>("request_id")?.unwrap_or_default(),
    other: row.get::<_, Option<String>>("other")?.unwrap_or_default(),
  })
}
