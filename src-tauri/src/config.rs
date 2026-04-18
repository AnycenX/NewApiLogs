use std::path::Path;

use anyhow::Context;

use crate::models::AppConfig;

pub fn load_config(config_path: &Path) -> AppConfig {
  let content = std::fs::read_to_string(config_path);
  match content {
    Ok(text) => serde_json::from_str::<AppConfig>(&text)
      .map(AppConfig::sanitized)
      .unwrap_or_default(),
    Err(_) => AppConfig::default(),
  }
}

pub fn save_config(config_path: &Path, config: &AppConfig) -> anyhow::Result<()> {
  if let Some(parent) = config_path.parent() {
    std::fs::create_dir_all(parent).context("无法创建配置目录")?;
  }

  let payload = serde_json::to_string_pretty(config).context("无法序列化配置")?;
  std::fs::write(config_path, payload).context("无法写入配置文件")?;
  Ok(())
}
