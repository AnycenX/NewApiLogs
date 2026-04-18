use anyhow::{anyhow, bail, Context};
use reqwest::{header, Client, Url};

use crate::models::{ApiEnvelope, AppConfig, LogItem, LogPage, LogStat, UserInfo};

#[derive(Clone)]
pub struct NewApiClient {
  client: Client,
}

impl NewApiClient {
  pub fn new() -> anyhow::Result<Self> {
    let client = Client::builder()
      .user_agent("WebApiLogs/0.1.0")
      .build()
      .context("无法初始化 HTTP 客户端")?;

    Ok(Self { client })
  }

  pub async fn verify_token(&self, config: &AppConfig) -> anyhow::Result<()> {
    let url = self.make_url(&config.base_url, "/api/user/self")?;
    let _: UserInfo = self
      .get_json(config, url)
      .await?;
    Ok(())
  }

  pub async fn get_user_info(&self, config: &AppConfig) -> anyhow::Result<UserInfo> {
    let url = self.make_url(&config.base_url, "/api/user/self")?;
    self.get_json(config, url).await
  }

  pub async fn get_log_stat(
    &self,
    config: &AppConfig,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<LogStat> {
    let mut url = self.make_url(&config.base_url, "/api/log/self/stat")?;
    url
      .query_pairs_mut()
      .append_pair("type", "0")
      .append_pair("token_name", "")
      .append_pair("model_name", "")
      .append_pair("start_timestamp", &start_ts.to_string())
      .append_pair("end_timestamp", &end_ts.to_string())
      .append_pair("group", "");

    self.get_json(config, url).await
  }

  pub async fn get_logs(
    &self,
    config: &AppConfig,
    page: i64,
    page_size: i64,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<LogPage> {
    let mut url = self.make_url(&config.base_url, "/api/log/self")?;
    url
      .query_pairs_mut()
      .append_pair("p", &page.to_string())
      .append_pair("page_size", &page_size.to_string())
      .append_pair("type", "0")
      .append_pair("token_name", "")
      .append_pair("model_name", "")
      .append_pair("start_timestamp", &start_ts.to_string())
      .append_pair("end_timestamp", &end_ts.to_string())
      .append_pair("group", "")
      .append_pair("request_id", "");

    self.get_json(config, url).await
  }

  pub async fn fetch_all_logs(
    &self,
    config: &AppConfig,
    start_ts: i64,
    end_ts: i64,
  ) -> anyhow::Result<Vec<LogItem>> {
    let mut items = Vec::new();
    let mut page = 1;
    let page_size = 100;

    loop {
      let payload = self.get_logs(config, page, page_size, start_ts, end_ts).await?;
      if payload.items.is_empty() {
        break;
      }

      items.extend(payload.items);

      if page * page_size >= payload.total {
        break;
      }

      page += 1;
    }

    Ok(items)
  }

  fn make_url(&self, base_url: &str, path_or_url: &str) -> anyhow::Result<Url> {
    if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
      return Url::parse(path_or_url).context("接口地址格式无效");
    }

    let base = Url::parse(base_url).context("服务地址格式无效")?;
    base.join(path_or_url).context("无法拼接接口地址")
  }

  async fn get_json<T>(&self, config: &AppConfig, url: Url) -> anyhow::Result<T>
  where
    T: serde::de::DeserializeOwned,
  {
    let response = self
      .client
      .get(url.clone())
      .header(
        header::AUTHORIZATION,
        format!("Bearer {}", config.token.trim()),
      )
      .header("New-Api-User", config.user_id.trim())
      .send()
      .await
      .with_context(|| format!("无法连接到 {}", url))?;

    let status = response.status();
    let body = response.text().await.context("无法读取服务响应")?;

    if !status.is_success() {
      bail!("服务返回错误（{}）：{}", status, simplify_message(&body));
    }

    let payload: ApiEnvelope<T> =
      serde_json::from_str(&body).context("服务响应不是有效的 JSON")?;

    if !payload.success {
      let message = payload.message.trim();
      if message.is_empty() {
        return Err(anyhow!("接口返回失败"));
      }
      bail!("{message}");
    }

    payload
      .data
      .ok_or_else(|| anyhow!("服务返回成功，但缺少 data 字段"))
  }
}

fn simplify_message(raw: &str) -> String {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return "空响应".to_string();
  }

  let shortened: String = trimmed.chars().take(160).collect();
  if trimmed.chars().count() > 160 {
    format!("{shortened}...")
  } else {
    shortened
  }
}
