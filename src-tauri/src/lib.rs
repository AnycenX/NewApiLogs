mod commands;
mod config;
mod database;
mod models;
mod new_api;
mod windowing;

use std::{path::PathBuf, sync::Arc};

use anyhow::Context;
use new_api::NewApiClient;
use tauri::{LogicalSize, Manager};
use tokio::sync::Mutex;

pub struct AppState {
  pub config_path: PathBuf,
  pub db_path: PathBuf,
  pub api_client: NewApiClient,
  pub log_sync_lock: Arc<Mutex<()>>,
}

fn build_app_state(app: &tauri::AppHandle) -> anyhow::Result<AppState> {
  let config_dir = app
    .path()
    .app_config_dir()
    .context("无法解析配置目录")?;
  let data_dir = app.path().app_data_dir().context("无法解析数据目录")?;

  std::fs::create_dir_all(&config_dir).context("无法创建配置目录")?;
  std::fs::create_dir_all(&data_dir).context("无法创建数据目录")?;

  let config_path = config_dir.join("config.json");
  let db_path = data_dir.join("data.db");

  database::Database::initialize(&db_path)?;

  Ok(AppState {
    config_path,
    db_path,
    api_client: NewApiClient::new()?,
    log_sync_lock: Arc::new(Mutex::new(())),
  })
}

fn apply_main_window_layout(app: &tauri::AppHandle) -> anyhow::Result<()> {
  let Some(window) = app.get_webview_window("main") else {
    return Ok(());
  };

  let metrics = windowing::main_window_metrics();
  window.set_size(LogicalSize::new(metrics.width, metrics.height))?;
  window.set_min_size(Some(LogicalSize::new(metrics.min_width, metrics.min_height)))?;

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let state = build_app_state(app.handle())?;
      app.manage(state);
      apply_main_window_layout(app.handle())?;

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::load_bootstrap,
      commands::verify_login,
      commands::save_config,
      commands::logout,
      commands::open_settings_window,
      commands::open_float_window,
      commands::close_window,
      commands::start_window_drag,
      commands::fetch_status,
      commands::query_logs,
      commands::export_logs,
      commands::get_cache_overview,
      commands::clear_local_cache
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
