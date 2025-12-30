mod config;
mod freee;
mod gemini;
mod oauth_server;

use config::Config;
use freee::{
    AccountItem, Company, CreateDealRequest, Deal, DealDetail, DealPayment, FreeeClient, Tax,
    Walletable,
};
use gemini::{GeminiClient, ReceiptAnalysis};
use sha2::{Digest, Sha256};
use std::fs;

#[tauri::command]
async fn get_config() -> Result<Config, String> {
    Config::load().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_config(config: Config) -> Result<(), String> {
    config.save().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_freee_auth_url() -> Result<String, String> {
    FreeeClient::get_auth_url().map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_oauth_and_get_token() -> Result<Config, String> {
    // OAuthサーバーを別スレッドで起動してコードを待機
    let code = tokio::task::spawn_blocking(|| oauth_server::start_oauth_server())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // コードをトークンに交換
    let token = FreeeClient::exchange_code(&code)
        .await
        .map_err(|e| e.to_string())?;

    // 設定を更新
    let mut config = Config::load().map_err(|e| e.to_string())?;
    config.freee_access_token = Some(token.access_token);
    config.freee_refresh_token = Some(token.refresh_token);
    config.freee_token_expires_at = Some(token.created_at + token.expires_in);
    config.save().map_err(|e| e.to_string())?;

    Ok(config)
}

#[tauri::command]
async fn refresh_freee_token() -> Result<Config, String> {
    let mut config = Config::load().map_err(|e| e.to_string())?;

    let refresh_token = config
        .freee_refresh_token
        .as_ref()
        .ok_or("No refresh token available")?;

    let token = FreeeClient::refresh_token(refresh_token)
        .await
        .map_err(|e| e.to_string())?;

    config.freee_access_token = Some(token.access_token);
    config.freee_refresh_token = Some(token.refresh_token);
    config.freee_token_expires_at = Some(token.created_at + token.expires_in);
    config.save().map_err(|e| e.to_string())?;

    Ok(config)
}

#[tauri::command]
async fn get_freee_companies() -> Result<Vec<Company>, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let access_token = config
        .freee_access_token
        .ok_or("Not authenticated with freee")?;

    let client = FreeeClient::new(access_token);
    client.get_companies().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_freee_account_items(company_id: i64) -> Result<Vec<AccountItem>, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let access_token = config
        .freee_access_token
        .ok_or("Not authenticated with freee")?;

    let client = FreeeClient::new(access_token);
    client
        .get_account_items(company_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_freee_taxes(company_id: i64) -> Result<Vec<Tax>, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let access_token = config
        .freee_access_token
        .ok_or("Not authenticated with freee")?;

    let client = FreeeClient::new(access_token);
    client
        .get_taxes(company_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_freee_walletables(company_id: i64) -> Result<Vec<Walletable>, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let access_token = config
        .freee_access_token
        .ok_or("Not authenticated with freee")?;

    let client = FreeeClient::new(access_token);
    client
        .get_walletables(company_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn analyze_receipt(
    image_path: String,
    account_item_names: Vec<String>,
) -> Result<ReceiptAnalysis, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let api_key = config.gemini_api_key.ok_or("Gemini API key not set")?;

    let client = GeminiClient::new(api_key);
    client
        .analyze_receipt(&image_path, &account_item_names)
        .await
        .map_err(|e| e.to_string())
}

/// 明細1行の入力パラメータ
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DealDetailInput {
    pub account_item_id: i64,
    pub tax_code: i64,
    pub amount: i64,
    pub description: Option<String>,
}

#[tauri::command]
async fn register_freee_deal(
    company_id: i64,
    issue_date: String,
    details: Vec<DealDetailInput>,
    walletable_type: String,
    walletable_id: i64,
) -> Result<Deal, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    let access_token = config
        .freee_access_token
        .ok_or("Not authenticated with freee")?;

    let client = FreeeClient::new(access_token);

    // 合計金額を計算
    let total_amount: i64 = details.iter().map(|d| d.amount).sum();

    // 明細をAPIフォーマットに変換
    let deal_details: Vec<DealDetail> = details
        .into_iter()
        .map(|d| DealDetail {
            account_item_id: d.account_item_id,
            tax_code: d.tax_code,
            amount: d.amount,
            description: d.description,
            vat: None,
        })
        .collect();

    let request = CreateDealRequest {
        company_id,
        issue_date: issue_date.clone(),
        deal_type: "expense".to_string(),
        details: deal_details,
        payments: Some(vec![DealPayment {
            from_walletable_type: walletable_type,
            from_walletable_id: walletable_id,
            date: issue_date,
            amount: total_amount,
        }]),
    };

    client.create_deal(request).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn calculate_image_hash(image_path: String) -> Result<String, String> {
    let data = fs::read(&image_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

#[tauri::command]
async fn read_image_base64(image_path: String) -> Result<String, String> {
    let data = fs::read(&image_path).map_err(|e| e.to_string())?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &data,
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_freee_auth_url,
            start_oauth_and_get_token,
            refresh_freee_token,
            get_freee_companies,
            get_freee_account_items,
            get_freee_taxes,
            get_freee_walletables,
            analyze_receipt,
            register_freee_deal,
            calculate_image_hash,
            read_image_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
