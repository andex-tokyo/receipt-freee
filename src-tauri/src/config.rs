use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub gemini_api_key: Option<String>,
    pub freee_access_token: Option<String>,
    pub freee_refresh_token: Option<String>,
    pub freee_token_expires_at: Option<i64>,
    pub freee_company_id: Option<i64>,
    pub freee_company_name: Option<String>,
    pub default_account_item_id: Option<i64>,
    pub default_tax_code: Option<i64>,
    pub default_walletable_id: Option<i64>,
    pub default_walletable_type: Option<String>,
    pub candidate_account_item_ids: Option<Vec<i64>>,
}

impl Config {
    pub fn config_path() -> Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Failed to get config directory"))?;
        let app_dir = config_dir.join("com.receipt-freee.app");
        fs::create_dir_all(&app_dir)?;
        Ok(app_dir.join("config.json"))
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let config: Config = serde_json::from_str(&content)?;
            Ok(config)
        } else {
            Ok(Config::default())
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        let content = serde_json::to_string_pretty(self)?;
        fs::write(&path, content)?;
        Ok(())
    }
}

// ビルド時に埋め込まれる環境変数
pub fn get_freee_client_id() -> Option<String> {
    option_env!("FREEE_CLIENT_ID").map(|s| s.to_string())
}

pub fn get_freee_client_secret() -> Option<String> {
    option_env!("FREEE_CLIENT_SECRET").map(|s| s.to_string())
}
