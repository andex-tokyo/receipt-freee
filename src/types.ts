export interface Config {
  gemini_api_key?: string;
  freee_access_token?: string;
  freee_refresh_token?: string;
  freee_token_expires_at?: number;
  freee_company_id?: number;
  freee_company_name?: string;
  default_account_item_id?: number;
  default_tax_code?: number;
  default_walletable_id?: number;
  default_walletable_type?: string;
  candidate_account_item_ids?: number[];
}

export interface Company {
  id: number;
  name?: string;
  display_name: string;
}

export interface AccountItem {
  id: number;
  name: string;
  shortcut?: string;
  shortcut_num?: string;
  categories?: string[];
  account_category?: string;
  account_category_id?: number;
}

export interface Tax {
  code: number;
  name: string;
  name_ja: string;
}

export interface Walletable {
  id: number;
  name: string;
  type: string;
}

export interface ReceiptDetailAnalysis {
  amount: number;
  tax_rate: number; // 8 or 10
  account_item_name?: string;
  description?: string;
}

export interface ReceiptAnalysis {
  store_name?: string;
  date?: string;
  details: ReceiptDetailAnalysis[];
  total_amount?: number;
  confidence: number;
  is_fixed_asset_warning: boolean;
  fixed_asset_reason?: string;
}

/** 編集可能な明細1行 */
export interface ReceiptDetail {
  id: string; // 明細ごとの一意ID
  amount: number;
  taxRate: number; // 8 or 10
  accountItemId?: number;
  taxCode?: number;
  description?: string;
}

export interface Receipt {
  id: string;
  imagePath: string;
  imageHash: string;
  imageBase64?: string;
  status: "pending" | "analyzing" | "analyzed" | "registered" | "error";
  analysis?: ReceiptAnalysis;
  errorMessage?: string;
  // 編集可能なフィールド
  storeName?: string;
  date?: string;
  /** 複数明細 */
  details: ReceiptDetail[];
  /** 合計金額（検証用） */
  totalAmount?: number;
  /** 固定資産警告を確認済みか */
  fixedAssetConfirmed?: boolean;
}

export interface Deal {
  id: number;
  company_id: number;
  issue_date: string;
  type: string;
}
