use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::config::{get_freee_client_id, get_freee_client_secret};

const FREEE_API_BASE: &str = "https://api.freee.co.jp";
const FREEE_AUTH_URL: &str = "https://accounts.secure.freee.co.jp/public_api/authorize";
const FREEE_TOKEN_URL: &str = "https://accounts.secure.freee.co.jp/public_api/token";
const OAUTH_CALLBACK_PORT: u16 = 17890;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub token_type: String,
    pub scope: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub id: i64,
    pub name: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompaniesResponse {
    pub companies: Vec<Company>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountItem {
    pub id: i64,
    pub name: String,
    pub shortcut: Option<String>,
    pub shortcut_num: Option<String>,
    pub categories: Option<Vec<String>>,
    pub account_category: Option<String>,
    pub account_category_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountItemsResponse {
    pub account_items: Vec<AccountItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tax {
    pub code: i64,
    pub name: String,
    pub name_ja: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxesResponse {
    pub taxes: Vec<Tax>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Walletable {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub walletable_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletablesResponse {
    pub walletables: Vec<Walletable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealDetail {
    pub account_item_id: i64,
    pub tax_code: i64,
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vat: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealPayment {
    pub from_walletable_type: String,
    pub from_walletable_id: i64,
    pub date: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDealRequest {
    pub company_id: i64,
    pub issue_date: String,
    #[serde(rename = "type")]
    pub deal_type: String,
    pub details: Vec<DealDetail>,
    pub payments: Option<Vec<DealPayment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealResponse {
    pub deal: Deal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deal {
    pub id: i64,
    pub company_id: i64,
    pub issue_date: String,
    #[serde(rename = "type")]
    pub deal_type: String,
}

pub struct FreeeClient {
    client: reqwest::Client,
    access_token: String,
}

impl FreeeClient {
    pub fn new(access_token: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            access_token,
        }
    }

    pub fn get_auth_url() -> Result<String> {
        let client_id =
            get_freee_client_id().ok_or_else(|| anyhow::anyhow!("FREEE_CLIENT_ID not set"))?;
        let redirect_uri = format!("http://127.0.0.1:{}/callback", OAUTH_CALLBACK_PORT);
        let url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&prompt=select_company",
            FREEE_AUTH_URL,
            client_id,
            urlencoding::encode(&redirect_uri)
        );
        Ok(url)
    }

    pub async fn exchange_code(code: &str) -> Result<TokenResponse> {
        let client_id =
            get_freee_client_id().ok_or_else(|| anyhow::anyhow!("FREEE_CLIENT_ID not set"))?;
        let client_secret = get_freee_client_secret()
            .ok_or_else(|| anyhow::anyhow!("FREEE_CLIENT_SECRET not set"))?;
        let redirect_uri = format!("http://127.0.0.1:{}/callback", OAUTH_CALLBACK_PORT);

        let client = reqwest::Client::new();
        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ];

        let response = client.post(FREEE_TOKEN_URL).form(&params).send().await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Token exchange failed: {}", error_text));
        }

        let token: TokenResponse = response.json().await?;
        Ok(token)
    }

    pub async fn refresh_token(refresh_token: &str) -> Result<TokenResponse> {
        let client_id =
            get_freee_client_id().ok_or_else(|| anyhow::anyhow!("FREEE_CLIENT_ID not set"))?;
        let client_secret = get_freee_client_secret()
            .ok_or_else(|| anyhow::anyhow!("FREEE_CLIENT_SECRET not set"))?;

        let client = reqwest::Client::new();
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ];

        let response = client.post(FREEE_TOKEN_URL).form(&params).send().await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Token refresh failed: {}", error_text));
        }

        let token: TokenResponse = response.json().await?;
        Ok(token)
    }

    pub async fn get_companies(&self) -> Result<Vec<Company>> {
        let url = format!("{}/api/1/companies", FREEE_API_BASE);
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to get companies: {}", error_text));
        }

        let data: CompaniesResponse = response.json().await?;
        Ok(data.companies)
    }

    pub async fn get_account_items(&self, company_id: i64) -> Result<Vec<AccountItem>> {
        let url = format!(
            "{}/api/1/account_items?company_id={}",
            FREEE_API_BASE, company_id
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!(
                "Failed to get account items: {}",
                error_text
            ));
        }

        let data: AccountItemsResponse = response.json().await?;
        Ok(data.account_items)
    }

    pub async fn get_taxes(&self, company_id: i64) -> Result<Vec<Tax>> {
        let url = format!(
            "{}/api/1/taxes/codes?company_id={}",
            FREEE_API_BASE, company_id
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to get taxes: {}", error_text));
        }

        let data: TaxesResponse = response.json().await?;
        Ok(data.taxes)
    }

    pub async fn get_walletables(&self, company_id: i64) -> Result<Vec<Walletable>> {
        let url = format!(
            "{}/api/1/walletables?company_id={}&with_balance=false",
            FREEE_API_BASE, company_id
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to get walletables: {}", error_text));
        }

        let data: WalletablesResponse = response.json().await?;
        Ok(data.walletables)
    }

    pub async fn create_deal(&self, request: CreateDealRequest) -> Result<Deal> {
        let url = format!("{}/api/1/deals", FREEE_API_BASE);
        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.access_token)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Failed to create deal: {}", error_text));
        }

        let data: DealResponse = response.json().await?;
        Ok(data.deal)
    }
}
