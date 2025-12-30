use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const GEMINI_API_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/// 明細1行分の情報
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptDetail {
    pub amount: i64,
    pub tax_rate: i32, // 8 or 10
    pub account_item_name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptAnalysis {
    pub store_name: Option<String>,
    pub date: Option<String>,
    /// 複数明細（税率・勘定科目ごとに分割）
    pub details: Vec<ReceiptDetail>,
    /// レシート全体の合計金額（検証用）
    pub total_amount: Option<i64>,
    pub confidence: f64,
    pub is_fixed_asset_warning: bool,
    pub fixed_asset_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct GeminiRequest {
    contents: Vec<Content>,
    generation_config: GenerationConfig,
}

#[derive(Debug, Serialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Part {
    Text { text: String },
    InlineData { inline_data: InlineData },
}

#[derive(Debug, Serialize)]
struct InlineData {
    mime_type: String,
    data: String,
}

#[derive(Debug, Serialize)]
struct GenerationConfig {
    response_mime_type: String,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<Candidate>>,
}

#[derive(Debug, Deserialize)]
struct Candidate {
    content: CandidateContent,
}

#[derive(Debug, Deserialize)]
struct CandidateContent {
    parts: Vec<ResponsePart>,
}

#[derive(Debug, Deserialize)]
struct ResponsePart {
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ParsedDetail {
    amount: Option<i64>,
    tax_rate: Option<i32>,
    account_item_name: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ParsedReceipt {
    store_name: Option<String>,
    date: Option<String>,
    details: Option<Vec<ParsedDetail>>,
    total_amount: Option<i64>,
    confidence: Option<f64>,
    is_fixed_asset: Option<bool>,
    fixed_asset_reason: Option<String>,
}

pub struct GeminiClient {
    api_key: String,
    client: reqwest::Client,
}

impl GeminiClient {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: reqwest::Client::new(),
        }
    }

    pub async fn analyze_receipt(
        &self,
        image_path: &str,
        account_item_names: &[String],
    ) -> Result<ReceiptAnalysis> {
        let path = Path::new(image_path);
        let image_data = fs::read(path)?;
        let base64_data = STANDARD.encode(&image_data);

        let mime_type = match path.extension().and_then(|e| e.to_str()) {
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("png") => "image/png",
            Some("webp") => "image/webp",
            Some("pdf") => "application/pdf",
            _ => "image/jpeg",
        };

        let account_items_list = if account_item_names.is_empty() {
            "交際費, 会議費, 旅費交通費, 消耗品費, 通信費, 新聞図書費, 雑費".to_string()
        } else {
            account_item_names.join(", ")
        };

        let prompt = format!(
            r#"このレシート画像を解析して、以下の情報をJSON形式で抽出してください。

★★★ 最重要ルール ★★★
同じ税率・同じ勘定科目の商品は、内訳に関わらず必ず合計金額の1行にまとめてください。
例: タクシー代（運賃4,500円+高速500円）→ 1行で5,000円
例: コンビニで食料品3点 → 1行で合計金額
税率または勘定科目が異なる場合のみ複数行に分けてください。
★★★★★★★★★★★★★

【出力項目】

- store_name: 店舗名（文字列）
  レシートに記載された店舗名・会社名を抽出。

- date: 日付（YYYY-MM-DD形式）

- details: 明細行の配列
  各明細には以下を含める:
  - amount: 金額（税込、整数）。割引・ポイント使用後の金額。
  - tax_rate: 消費税率（0, 8, 10の整数）
    - 0%（非課税）: 収入印紙、証紙、役所への手数料（免許更新、住民票発行など）
    - 8%（軽減税率）: 食料品、飲料（酒類除く）、定期購読の新聞
    - 10%（標準税率）: 上記以外すべて（外食、酒類、日用品、サービス等）
  - account_item_name: 勘定科目（以下から選択: {account_items_list}）
  - description: カテゴリレベルの簡単な説明（例: 食料品、文房具、タクシー代）。具体的な商品名は不要。

【勘定科目ルール】
- 居酒屋、バー、高級レストラン、宴会など会食・接待 → 交際費
- コンビニの食べ物、カフェ、ファストフード、定食、弁当など日常の食事 → 会議費
- 文房具、日用品など食べ物以外 → 消耗品費
- 切手、はがき、郵便関連 → 通信費
- 収入印紙 → 租税公課

【1行にまとめる例】
- タクシー代（運賃+高速代）→ 全て10%・旅費交通費なので1行
- コンビニで化粧品とタバコ → 全て10%・消耗品費なので1行
- コンビニで食料品3点 → 全て8%・会議費なので1行

【複数行に分ける例】
- コンビニで食料品(8%)と日用品(10%) → 税率が異なるので2行
- 書籍(新聞図書費)と文房具(消耗品費) → 勘定科目が異なるので2行

例1: タクシー代5,000円 → details: [{{amount: 5000, tax_rate: 10, account_item_name: "旅費交通費", description: "タクシー代"}}]
例2: コンビニで食料品(8%)300円と文房具(10%)200円 → details: [{{amount: 300, tax_rate: 8, account_item_name: "会議費", description: "食料品"}}, {{amount: 200, tax_rate: 10, account_item_name: "消耗品費", description: "文房具"}}]

- total_amount: レシート全体の合計金額（税込、整数）
  割引・ポイント使用後の最終支払金額。「残高」「電子マネー残額」は無視。

- confidence: 解析の確信度（0.0〜1.0）

- is_fixed_asset: 固定資産の可能性（boolean）
  10万円以上かつ1年以上使用する有形資産（PC、モニター、カメラ、家具、家電、車両など）の場合はtrue。
  食料品、消耗品、サービス（飲食代、交通費等）は金額問わずfalse。

- fixed_asset_reason: 固定資産と判断した理由（該当時のみ、品目名と金額を記載）

読み取れない項目はnullを返してください。
JSONのみを返し、他のテキストは含めないでください。"#
        );

        let request = GeminiRequest {
            contents: vec![Content {
                parts: vec![
                    Part::Text { text: prompt },
                    Part::InlineData {
                        inline_data: InlineData {
                            mime_type: mime_type.to_string(),
                            data: base64_data,
                        },
                    },
                ],
            }],
            generation_config: GenerationConfig {
                response_mime_type: "application/json".to_string(),
            },
        };

        let url = format!("{}?key={}", GEMINI_API_URL, self.api_key);
        let response = self.client.post(&url).json(&request).send().await?;

        if !response.status().is_success() {
            let error_text = response.text().await?;
            return Err(anyhow::anyhow!("Gemini API error: {}", error_text));
        }

        let gemini_response: GeminiResponse = response.json().await?;

        let text = gemini_response
            .candidates
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.content.parts.into_iter().next())
            .and_then(|p| p.text)
            .ok_or_else(|| anyhow::anyhow!("No response from Gemini"))?;

        // Geminiが配列で返す場合があるので両方に対応
        let parsed: ParsedReceipt = if text.trim().starts_with('[') {
            let arr: Vec<ParsedReceipt> = serde_json::from_str(&text).map_err(|e| {
                anyhow::anyhow!("Failed to parse Gemini response: {}. Response: {}", e, text)
            })?;
            arr.into_iter()
                .next()
                .ok_or_else(|| anyhow::anyhow!("Empty array from Gemini"))?
        } else {
            serde_json::from_str(&text).map_err(|e| {
                anyhow::anyhow!("Failed to parse Gemini response: {}. Response: {}", e, text)
            })?
        };

        // 明細をReceiptDetailに変換
        let details: Vec<ReceiptDetail> = parsed
            .details
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| {
                Some(ReceiptDetail {
                    amount: d.amount?,
                    tax_rate: d.tax_rate.unwrap_or(10),
                    account_item_name: d.account_item_name,
                    description: d.description,
                })
            })
            .collect();

        Ok(ReceiptAnalysis {
            store_name: parsed.store_name,
            date: parsed.date,
            details,
            total_amount: parsed.total_amount,
            confidence: parsed.confidence.unwrap_or(0.0),
            is_fixed_asset_warning: parsed.is_fixed_asset.unwrap_or(false),
            fixed_asset_reason: parsed.fixed_asset_reason,
        })
    }
}
