# receipt-freee

レシート画像をAI（Gemini）で解析し、freee会計に経費として登録するデスクトップアプリ

## 機能

- レシート画像の読み込み（JPEG, PNG, WebP, PDF対応）
- Gemini 2.0 FlashによるAI解析（店舗名、日付、金額、勘定科目を自動抽出）
- **複数明細対応**（異なる税率8%/10%や異なる勘定科目を1レシートで処理）
- **非課税対応**（収入印紙、役所手数料など0%税率）
- freee会計への取引登録（OAuth認証）
- 一括解析・個別確認・修正機能
- 固定資産の警告（10万円以上のPC等）+ 確認必須

## セットアップ

### 1. 必要なもの

- Node.js 20以上
- Rust（最新の stable）
- Gemini APIキー（[Google AI Studio](https://aistudio.google.com/)で取得）
- freeeアカウント

### 2. freee OAuthアプリの作成

1. [freee開発者ページ](https://app.secure.freee.co.jp/developers/applications)にアクセス
2. 「アプリを作成」
3. コールバックURL: `http://localhost:17890/callback`
4. Client IDとClient Secretをメモ

### 3. 環境変数の設定

```bash
cp .env.example .env
# .envを編集してClient IDとSecretを設定
```

### 4. 依存関係のインストール

```bash
npm install
```

## 開発

### 開発モードで起動

```bash
npm run tauri:dev
```

### 型チェック

```bash
npm run check        # TypeScript + Rust
npm run check:ts     # TypeScriptのみ
npm run check:rust   # Rustのみ
```

### Lintとテスト

```bash
npm run lint         # Cargo clippy
npm run test         # Cargo test
```

### ビルド

```bash
npm run tauri:build
```

生成物:

- macOS: `src-tauri/target/release/bundle/macos/receipt-freee.app`
- DMG: `src-tauri/target/release/bundle/dmg/receipt-freee_*.dmg`

## 使い方

1. 起動後、設定画面でGemini APIキーを入力
2. 「freee認証」ボタンでfreeeにログイン
3. 事業所を選択
4. メイン画面で「選択」からレシート画像を追加
5. 「一括解析」でAI解析
6. 結果を確認・修正し、「承認してfreeeに登録」

## ファイル構成

```
receipt-freee/
├── src/                    # フロントエンド（React + TypeScript）
│   ├── App.tsx             # メインコンポーネント
│   ├── types.ts            # 型定義
│   └── index.css           # Tailwind CSS
├── src-tauri/              # バックエンド（Rust）
│   ├── src/
│   │   ├── lib.rs          # Tauriコマンド
│   │   ├── config.rs       # 設定管理
│   │   ├── freee.rs        # freee APIクライアント
│   │   ├── gemini.rs       # Gemini APIクライアント
│   │   └── oauth_server.rs # OAuthコールバック
│   └── Cargo.toml
├── .env.example            # 環境変数サンプル
└── package.json
```

## 技術スタック

- **フレームワーク**: Tauri v2
- **フロントエンド**: React 19, TypeScript, Tailwind CSS v4
- **バックエンド**: Rust
- **AI**: Google Gemini 2.0 Flash
- **認証**: OAuth 2.0

## ライセンス

MIT License
