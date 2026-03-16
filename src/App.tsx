import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { SearchableSelect } from "./components/SearchableSelect";
import type {
  Config,
  Company,
  AccountItem,
  Tax,
  Walletable,
  Receipt,
  ReceiptDetail,
  ReceiptAnalysis,
} from "./types";

type View = "main" | "settings";

function App() {
  const [view, setView] = useState<View>("main");
  const [config, setConfig] = useState<Config>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [accountItems, setAccountItems] = useState<AccountItem[]>([]);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [walletables, setWalletables] = useState<Walletable[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(
    null,
  );
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [zoomPos, setZoomPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const selectedReceipt = receipts.find((r) => r.id === selectedReceiptId);

  // 設定を読み込み
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke<Config>("get_config");
      setConfig(cfg);
      return cfg;
    } catch (e) {
      console.error("Failed to load config:", e);
      return {};
    }
  }, []);

  // マスタデータを読み込み
  const loadMasterData = useCallback(async (companyId: number) => {
    try {
      const [items, taxList, wallets] = await Promise.all([
        invoke<AccountItem[]>("get_freee_account_items", { companyId }),
        invoke<Tax[]>("get_freee_taxes", { companyId }),
        invoke<Walletable[]>("get_freee_walletables", { companyId }),
      ]);
      setAccountItems(items);
      setTaxes(taxList);
      setWalletables(wallets);
    } catch (e) {
      console.error("Failed to load master data:", e);
      setError("マスタデータの読み込みに失敗しました");
    }
  }, []);

  // ファイルパスからレシートを追加する共通関数
  const addReceiptsFromPaths = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0) return;

    // 現在のレシートのハッシュを取得（関数型更新でアクセス）
    const processedReceipts: Receipt[] = [];
    const processedHashes = new Set<string>();
    let skippedCount = 0;

    for (const file of filePaths) {
      // 拡張子チェック
      const ext = file.split(".").pop()?.toLowerCase();
      if (!["jpg", "jpeg", "png", "webp", "pdf"].includes(ext || "")) {
        continue;
      }

      try {
        const hash = await invoke<string>("calculate_image_hash", {
          imagePath: file,
        });

        // 今回処理中のファイルで重複チェック
        if (processedHashes.has(hash)) {
          skippedCount++;
          continue;
        }

        const base64 = await invoke<string>("read_image_base64", {
          imagePath: file,
        });

        processedReceipts.push({
          id: crypto.randomUUID(),
          imagePath: file,
          imageHash: hash,
          imageBase64: base64,
          status: "pending",
          details: [],
        });
        processedHashes.add(hash);
      } catch (e) {
        console.error(`Failed to load file: ${file}`, e);
      }
    }

    if (processedReceipts.length > 0) {
      // 関数型更新で既存のレシートと重複チェック
      setReceipts((prev) => {
        const existingHashes = new Set(prev.map((r) => r.imageHash));
        const newReceipts = processedReceipts.filter(
          (r) => !existingHashes.has(r.imageHash),
        );
        const duplicateCount = processedReceipts.length - newReceipts.length;

        if (duplicateCount > 0) {
          setSuccessMessage(
            `${newReceipts.length}件追加しました（${duplicateCount + skippedCount}件は重複のためスキップ）`,
          );
        } else if (skippedCount > 0) {
          setSuccessMessage(
            `${newReceipts.length}件追加しました（${skippedCount}件は重複のためスキップ）`,
          );
        } else {
          setSuccessMessage(`${newReceipts.length}件追加しました`);
        }

        return [...prev, ...newReceipts];
      });
    }
  }, []);

  // 初期化
  useEffect(() => {
    (async () => {
      const cfg = await loadConfig();
      if (cfg.freee_company_id) {
        await loadMasterData(cfg.freee_company_id);
      }
    })();
  }, [loadConfig, loadMasterData]);

  // ドラッグ&ドロップイベントのリスナー
  const isProcessingDrop = useRef(false);

  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenHover: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;
    let isMounted = true;

    const setupListeners = async () => {
      unlistenHover = await listen<{ paths: string[] }>(
        "tauri://drag-over",
        () => {
          if (isMounted) setIsDragging(true);
        },
      );

      unlistenCancel = await listen("tauri://drag-leave", () => {
        if (isMounted) setIsDragging(false);
      });

      unlistenDrop = await listen<{ paths: string[] }>(
        "tauri://drag-drop",
        async (event) => {
          if (!isMounted) return;
          setIsDragging(false);

          // 重複実行を防ぐ
          if (isProcessingDrop.current) return;
          isProcessingDrop.current = true;

          try {
            if (event.payload.paths && event.payload.paths.length > 0) {
              await addReceiptsFromPaths(event.payload.paths);
            }
          } finally {
            isProcessingDrop.current = false;
          }
        },
      );
    };

    setupListeners();

    return () => {
      isMounted = false;
      unlistenDrop?.();
      unlistenHover?.();
      unlistenCancel?.();
    };
  }, [addReceiptsFromPaths]);

  // freee認証
  const handleFreeeAuth = async () => {
    try {
      setIsAuthenticating(true);
      setError(null);

      // 認証URLを取得してブラウザで開く
      const authUrl = await invoke<string>("get_freee_auth_url");
      await openUrl(authUrl);

      // コールバックを待ってトークンを取得
      const newConfig = await invoke<Config>("start_oauth_and_get_token");
      setConfig(newConfig);

      // 事業所一覧を取得
      const companyList = await invoke<Company[]>("get_freee_companies");
      setCompanies(companyList);

      setSuccessMessage("freee認証が完了しました");
    } catch (e) {
      setError(`認証に失敗しました: ${e}`);
    } finally {
      setIsAuthenticating(false);
    }
  };

  // 事業所を選択
  const handleSelectCompany = async (companyId: number) => {
    const company = companies.find((c) => c.id === companyId);
    if (!company) return;

    // マスタデータを取得
    const [items, taxList, wallets] = await Promise.all([
      invoke<AccountItem[]>("get_freee_account_items", { companyId }),
      invoke<Tax[]>("get_freee_taxes", { companyId }),
      invoke<Walletable[]>("get_freee_walletables", { companyId }),
    ]);
    setAccountItems(items);
    setTaxes(taxList);
    setWalletables(wallets);

    // デバッグ: APIから取得したデータをログ出力
    console.log("=== freee API Data ===");
    console.log("Account Items (全件):", items.length, items);
    console.log(
      "Account Items (費用カテゴリ):",
      items.filter((i) => i.categories?.includes("経費")),
    );
    console.log("Taxes:", taxList);
    console.log("Walletables:", wallets);

    // デフォルト勘定科目: 交際費 > 費用カテゴリの最初 > 全体の最初
    const expenseItems = items.filter((item) =>
      item.categories?.includes("経費"),
    );
    const targetItems = expenseItems.length > 0 ? expenseItems : items;
    const defaultAccountItem =
      targetItems.find((item) => item.name === "交際費") ||
      targetItems.find((item) => item.name.includes("交際")) ||
      targetItems[0];

    // デフォルト税区分: 課対仕入10% > 10%を含むもの > 最初
    const defaultTax =
      taxList.find((t) => t.name_ja === "課対仕入10%") ||
      taxList.find(
        (t) => t.name_ja.includes("課対仕入") && t.name_ja.includes("10"),
      ) ||
      taxList.find((t) => t.name_ja.includes("10%")) ||
      taxList[0];

    // デフォルト支払元: 現金 > wallet typeの最初
    const defaultWalletable =
      wallets.find((w) => w.name === "現金") ||
      wallets.find((w) => w.name.includes("現金")) ||
      wallets.find((w) => w.type === "wallet") ||
      wallets[0];

    const newConfig = {
      ...config,
      freee_company_id: companyId,
      freee_company_name: company.display_name,
      default_account_item_id: defaultAccountItem?.id,
      default_tax_code: defaultTax?.code,
      default_walletable_id: defaultWalletable?.id,
      default_walletable_type: defaultWalletable?.type,
    };
    setConfig(newConfig);
    await invoke("save_config", { config: newConfig });
  };

  // レシート画像を選択
  const handleSelectReceipts = async () => {
    try {
      const files = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["jpg", "jpeg", "png", "webp", "pdf"],
          },
        ],
      });

      if (!files || files.length === 0) return;
      await addReceiptsFromPaths(files);
    } catch (e) {
      setError(`ファイル選択に失敗しました: ${e}`);
    }
  };

  // 単一レシートを解析
  const analyzeReceipt = async (receipt: Receipt) => {
    if (!config.gemini_api_key) {
      setError("Gemini APIキーが設定されていません");
      return;
    }

    // 勘定科目候補の名前リストを作成
    const candidateIds = config.candidate_account_item_ids || [];
    const candidateNames =
      candidateIds.length > 0
        ? accountItems
            .filter((item) => candidateIds.includes(item.id))
            .map((item) => item.name)
        : accountItems
            .filter((item) => item.categories?.includes("経費"))
            .map((item) => item.name);

    setReceipts((prev) =>
      prev.map((r) =>
        r.id === receipt.id ? { ...r, status: "analyzing" as const } : r,
      ),
    );

    try {
      const analysis = await invoke<ReceiptAnalysis>("analyze_receipt", {
        imagePath: receipt.imagePath,
        accountItemNames: candidateNames,
      });

      // 解析結果の明細をReceiptDetail形式に変換
      const details: ReceiptDetail[] = analysis.details.map((d) => {
        // 勘定科目名からIDを解決
        const accountItem = accountItems.find(
          (item) => item.name === d.account_item_name,
        );
        // 税率から税区分コードを解決
        let taxCode: number | undefined;
        if (d.tax_rate === 0) {
          // 非課税
          taxCode =
            taxes.find((t) => t.name_ja.includes("非課仕入"))?.code ||
            taxes.find((t) => t.name_ja.includes("非課税"))?.code;
        } else if (d.tax_rate === 8) {
          taxCode =
            taxes.find(
              (t) => t.name_ja.includes("課対仕入") && t.name_ja.includes("8%"),
            )?.code || taxes.find((t) => t.name_ja.includes("8%"))?.code;
        } else {
          taxCode =
            taxes.find(
              (t) =>
                t.name_ja.includes("課対仕入") && t.name_ja.includes("10%"),
            )?.code || taxes.find((t) => t.name_ja.includes("10%"))?.code;
        }

        return {
          id: crypto.randomUUID(),
          amount: d.amount,
          taxRate: d.tax_rate,
          accountItemId: accountItem?.id || config.default_account_item_id,
          taxCode: taxCode || config.default_tax_code,
          description: d.description,
        };
      });

      // 明細がない場合はデフォルトで1行作成
      if (details.length === 0) {
        details.push({
          id: crypto.randomUUID(),
          amount: analysis.total_amount || 0,
          taxRate: 10,
          accountItemId: config.default_account_item_id,
          taxCode: config.default_tax_code,
          description: undefined,
        });
      }

      setReceipts((prev) =>
        prev.map((r) =>
          r.id === receipt.id
            ? {
                ...r,
                status: "analyzed" as const,
                analysis,
                storeName: analysis.store_name,
                date: analysis.date,
                details,
                totalAmount: analysis.total_amount,
              }
            : r,
        ),
      );
    } catch (e) {
      setReceipts((prev) =>
        prev.map((r) =>
          r.id === receipt.id
            ? {
                ...r,
                status: "error" as const,
                errorMessage: String(e),
                details: [],
              }
            : r,
        ),
      );
    }
  };

  // 一括解析
  const handleAnalyzeAll = async () => {
    const pendingReceipts = receipts.filter((r) => r.status === "pending");
    for (const receipt of pendingReceipts) {
      await analyzeReceipt(receipt);
    }
  };

  // freeeに登録
  const handleRegisterToFreee = async (receipt: Receipt) => {
    if (!config.freee_company_id || !receipt.date) {
      setError("必須項目が不足しています");
      return;
    }

    // 固定資産警告の確認チェック
    if (
      receipt.analysis?.is_fixed_asset_warning &&
      !receipt.fixedAssetConfirmed
    ) {
      setError(
        "固定資産の可能性があります。確認ボタンを押してから登録してください。",
      );
      return;
    }

    // 明細のバリデーション
    if (receipt.details.length === 0) {
      setError("明細がありません");
      return;
    }

    for (const detail of receipt.details) {
      if (!detail.accountItemId || !detail.taxCode || !detail.amount) {
        setError("明細に必須項目が不足しています");
        return;
      }
    }

    const walletableId = config.default_walletable_id;
    const walletableType = config.default_walletable_type || "wallet";

    if (!walletableId) {
      setError("支払元が設定されていません");
      return;
    }

    try {
      // 明細をAPI形式に変換（備考に「店舗名 + 説明 + 1/n」形式を追加）
      const totalDetails = receipt.details.length;
      const details = receipt.details.map((d, index) => {
        const parts: string[] = [];
        if (receipt.storeName) parts.push(receipt.storeName);
        if (d.description) parts.push(d.description);
        if (totalDetails > 1) parts.push(`${index + 1}/${totalDetails}`);

        return {
          account_item_id: d.accountItemId,
          tax_code: d.taxCode,
          amount: d.amount,
          description: parts.length > 0 ? parts.join(" ") : null,
        };
      });

      await invoke("register_freee_deal", {
        companyId: config.freee_company_id,
        issueDate: receipt.date,
        details,
        walletableType,
        walletableId,
      });

      setReceipts((prev) =>
        prev.map((r) =>
          r.id === receipt.id ? { ...r, status: "registered" as const } : r,
        ),
      );
      setSuccessMessage("freeeに登録しました");
    } catch (e) {
      setError(`登録に失敗しました: ${e}`);
    }
  };

  // レシートを削除
  const handleDeleteReceipt = (id: string) => {
    setReceipts((prev) => prev.filter((r) => r.id !== id));
    if (selectedReceiptId === id) {
      setSelectedReceiptId(null);
    }
  };

  // 設定を保存
  const handleSaveConfig = async () => {
    try {
      await invoke("save_config", { config });
      setSuccessMessage("設定を保存しました");
    } catch (e) {
      setError(`設定の保存に失敗しました: ${e}`);
    }
  };

  // レシートフィールドを更新
  const updateReceiptField = (id: string, field: keyof Receipt, value: any) => {
    setReceipts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  // 明細フィールドを更新
  const updateDetailField = (
    receiptId: string,
    detailId: string,
    field: keyof ReceiptDetail,
    value: any,
  ) => {
    setReceipts((prev) =>
      prev.map((r) =>
        r.id === receiptId
          ? {
              ...r,
              details: r.details.map((d) =>
                d.id === detailId ? { ...d, [field]: value } : d,
              ),
            }
          : r,
      ),
    );
  };

  // 明細を追加
  const addDetail = (receiptId: string) => {
    const newDetail: ReceiptDetail = {
      id: crypto.randomUUID(),
      amount: 0,
      taxRate: 10,
      accountItemId: config.default_account_item_id,
      taxCode: config.default_tax_code,
      description: undefined,
    };
    setReceipts((prev) =>
      prev.map((r) =>
        r.id === receiptId ? { ...r, details: [...r.details, newDetail] } : r,
      ),
    );
  };

  // 明細を削除
  const removeDetail = (receiptId: string, detailId: string) => {
    setReceipts((prev) =>
      prev.map((r) =>
        r.id === receiptId
          ? { ...r, details: r.details.filter((d) => d.id !== detailId) }
          : r,
      ),
    );
  };

  // 経費カテゴリの勘定科目のみフィルタ
  const expenseAccountItems = accountItems.filter((item) =>
    item.categories?.includes("経費"),
  );

  // ステータスバッジ
  const StatusBadge = ({ status }: { status: Receipt["status"] }) => {
    const styles = {
      pending: "bg-gray-200 text-gray-700",
      analyzing: "bg-blue-200 text-blue-700",
      analyzed: "bg-green-200 text-green-700",
      registered: "bg-purple-200 text-purple-700",
      error: "bg-red-200 text-red-700",
    };
    const labels = {
      pending: "未解析",
      analyzing: "解析中...",
      analyzed: "解析済み",
      registered: "登録済み",
      error: "エラー",
    };
    return (
      <span
        className={`px-2 py-1 rounded text-xs font-medium ${styles[status]}`}
      >
        {labels[status]}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* ヘッダー */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold text-gray-900">
            レシート管理 - freee連携
          </h1>
          <div className="flex gap-2">
            <button
              onClick={() => setView(view === "main" ? "settings" : "main")}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded"
            >
              {view === "main" ? "設定" : "戻る"}
            </button>
          </div>
        </div>
      </header>

      {/* エラー・成功メッセージ */}
      {error && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
            {error}
            <button
              className="absolute top-0 right-0 px-4 py-3"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {successMessage && (
        <div className="max-w-7xl mx-auto px-4 mt-4">
          <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative">
            {successMessage}
            <button
              className="absolute top-0 right-0 px-4 py-3"
              onClick={() => setSuccessMessage(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-6">
        {view === "settings" ? (
          /* 設定画面 */
          <div className="bg-white rounded-lg shadow p-6 space-y-6">
            <h2 className="text-lg font-bold">設定</h2>

            {/* Gemini API Key */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Gemini APIキー
              </label>
              <input
                type="password"
                value={config.gemini_api_key || ""}
                onChange={(e) =>
                  setConfig({ ...config, gemini_api_key: e.target.value })
                }
                className="w-full border rounded px-3 py-2"
                placeholder="AIzaSy..."
              />
            </div>

            {/* freee認証 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                freee連携
              </label>
              {config.freee_access_token ? (
                <div className="flex items-center gap-4">
                  <span className="text-green-600">✓ 認証済み</span>
                  {config.freee_company_name && (
                    <span className="text-gray-600">
                      ({config.freee_company_name})
                    </span>
                  )}
                  <button
                    onClick={handleFreeeAuth}
                    className="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm"
                  >
                    再認証
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleFreeeAuth}
                  disabled={isAuthenticating}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                >
                  {isAuthenticating ? "認証中..." : "freee認証"}
                </button>
              )}
            </div>

            {/* 事業所選択 */}
            {companies.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  事業所
                </label>
                <select
                  value={config.freee_company_id || ""}
                  onChange={(e) => handleSelectCompany(Number(e.target.value))}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="">選択してください</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* デフォルト勘定科目 */}
            {expenseAccountItems.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  デフォルト勘定科目
                </label>
                <SearchableSelect
                  options={expenseAccountItems.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                  value={config.default_account_item_id}
                  onChange={(value) => {
                    setConfig({
                      ...config,
                      default_account_item_id: value,
                    });
                  }}
                  placeholder="選択してください"
                />
              </div>
            )}

            {/* デフォルト税区分 */}
            {taxes.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  デフォルト税区分
                </label>
                <SearchableSelect
                  options={taxes.map((tax) => ({
                    value: tax.code,
                    label: tax.name_ja,
                  }))}
                  value={config.default_tax_code}
                  onChange={(value) => {
                    setConfig({
                      ...config,
                      default_tax_code: value,
                    });
                  }}
                  placeholder="選択してください"
                />
              </div>
            )}

            {/* デフォルト支払元 */}
            {walletables.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  デフォルト支払元
                </label>
                <select
                  value={
                    config.default_walletable_id
                      ? `${config.default_walletable_type}:${config.default_walletable_id}`
                      : ""
                  }
                  onChange={(e) => {
                    const [type, id] = e.target.value.split(":");
                    setConfig({
                      ...config,
                      default_walletable_type: type,
                      default_walletable_id: Number(id),
                    });
                  }}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="">選択してください</option>
                  {walletables.map((w) => (
                    <option
                      key={`${w.type}:${w.id}`}
                      value={`${w.type}:${w.id}`}
                    >
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* AI解析用勘定科目候補 */}
            {expenseAccountItems.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  AI解析用の勘定科目候補（複数選択可）
                </label>
                <div className="border rounded p-3 max-h-48 overflow-y-auto space-y-1">
                  {expenseAccountItems.map((item) => (
                    <label key={item.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={
                          config.candidate_account_item_ids?.includes(
                            item.id,
                          ) || false
                        }
                        onChange={(e) => {
                          const ids = config.candidate_account_item_ids || [];
                          if (e.target.checked) {
                            setConfig({
                              ...config,
                              candidate_account_item_ids: [...ids, item.id],
                            });
                          } else {
                            setConfig({
                              ...config,
                              candidate_account_item_ids: ids.filter(
                                (id) => id !== item.id,
                              ),
                            });
                          }
                        }}
                      />
                      <span className="text-sm">{item.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={handleSaveConfig}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              設定を保存
            </button>
          </div>
        ) : (
          /* メイン画面 */
          <div className="flex gap-6">
            {/* 左: レシート一覧 */}
            <div className="w-1/3 bg-white rounded-lg shadow p-4 relative">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold">レシート一覧</h2>
                <div className="flex gap-2">
                  <button
                    onClick={handleSelectReceipts}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
                  >
                    選択
                  </button>
                  <button
                    onClick={handleAnalyzeAll}
                    disabled={
                      !config.gemini_api_key ||
                      !receipts.some((r) => r.status === "pending")
                    }
                    className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-sm disabled:opacity-50"
                  >
                    一括解析
                  </button>
                </div>
              </div>

              {receipts.length === 0 ? (
                <div
                  ref={dropZoneRef}
                  className={`border-2 border-dashed rounded-lg py-12 text-center transition-colors ${
                    isDragging
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-300 hover:border-gray-400"
                  }`}
                >
                  <div className="text-gray-500">
                    <svg
                      className="mx-auto h-12 w-12 text-gray-400"
                      stroke="currentColor"
                      fill="none"
                      viewBox="0 0 48 48"
                    >
                      <path
                        d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <p className="mt-2">
                      {isDragging
                        ? "ここにドロップしてください"
                        : "レシート画像をドラッグ&ドロップ"}
                    </p>
                    <p className="text-xs mt-1">
                      または「選択」ボタンをクリック
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* ドラッグ中のオーバーレイ */}
                  {isDragging && (
                    <div className="absolute inset-0 bg-blue-500 bg-opacity-20 border-2 border-dashed border-blue-500 rounded-lg z-10 flex items-center justify-center">
                      <p className="text-blue-700 font-medium text-lg">
                        ここにドロップして追加
                      </p>
                    </div>
                  )}
                  <ul className="space-y-2 max-h-[600px] overflow-y-auto">
                    {receipts.map((receipt) => (
                      <li
                        key={receipt.id}
                        onClick={() => setSelectedReceiptId(receipt.id)}
                        className={`p-3 rounded cursor-pointer border ${
                          selectedReceiptId === receipt.id
                            ? "border-blue-500 bg-blue-50"
                            : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {receipt.storeName ||
                                receipt.imagePath.split("/").pop()}
                            </p>
                            {receipt.date && (
                              <p className="text-xs text-gray-500">
                                {receipt.date}
                              </p>
                            )}
                            {receipt.details.length > 0 && (
                              <p className="text-sm font-bold">
                                ¥
                                {receipt.details
                                  .reduce((sum, d) => sum + d.amount, 0)
                                  .toLocaleString()}
                                {receipt.details.length > 1 && (
                                  <span className="text-xs text-gray-500 ml-1">
                                    ({receipt.details.length}件)
                                  </span>
                                )}
                              </p>
                            )}
                          </div>
                          <StatusBadge status={receipt.status} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {/* 右: レシート詳細 */}
            <div className="flex-1 bg-white rounded-lg shadow p-4">
              {selectedReceipt ? (
                <div className="flex gap-6">
                  {/* 画像プレビュー */}
                  <div className="w-1/2">
                    <h3 className="text-lg font-bold mb-2">レシート画像</h3>
                    {selectedReceipt.imageBase64 && (
                      <div className="relative overflow-hidden border rounded">
                        <img
                          ref={imageRef}
                          src={`data:image/jpeg;base64,${selectedReceipt.imageBase64}`}
                          alt="Receipt"
                          className="max-w-full max-h-[500px] object-contain cursor-crosshair"
                          onMouseMove={(e) => {
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            const x =
                              ((e.clientX - rect.left) / rect.width) * 100;
                            const y =
                              ((e.clientY - rect.top) / rect.height) * 100;
                            setZoomPos({ x, y });
                          }}
                          onMouseLeave={() => setZoomPos(null)}
                        />
                        {zoomPos && (
                          <div
                            className="absolute pointer-events-none border-2 border-blue-500 rounded-lg shadow-lg overflow-hidden"
                            style={{
                              width: "200px",
                              height: "200px",
                              top: "10px",
                              right: "10px",
                              backgroundImage: `url(data:image/jpeg;base64,${selectedReceipt.imageBase64})`,
                              backgroundSize: "400%",
                              backgroundPosition: `${zoomPos.x}% ${zoomPos.y}%`,
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>

                  {/* 編集フォーム */}
                  <div className="w-1/2 space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-bold">詳細</h3>
                      <button
                        onClick={() => handleDeleteReceipt(selectedReceipt.id)}
                        className="px-2 py-1 text-red-600 hover:bg-red-50 rounded text-sm"
                      >
                        削除
                      </button>
                    </div>

                    {selectedReceipt.status === "pending" && (
                      <button
                        onClick={() => analyzeReceipt(selectedReceipt)}
                        disabled={!config.gemini_api_key}
                        className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50"
                      >
                        解析する
                      </button>
                    )}

                    {selectedReceipt.status === "analyzing" && (
                      <p className="text-blue-600">解析中...</p>
                    )}

                    {selectedReceipt.status === "error" && (
                      <p className="text-red-600">
                        エラー: {selectedReceipt.errorMessage}
                      </p>
                    )}

                    {selectedReceipt.analysis?.is_fixed_asset_warning && (
                      <div
                        className={`px-3 py-2 rounded text-sm ${
                          selectedReceipt.fixedAssetConfirmed
                            ? "bg-green-100 border border-green-400 text-green-800"
                            : "bg-red-100 border border-red-400 text-red-800"
                        }`}
                      >
                        {selectedReceipt.fixedAssetConfirmed ? (
                          <>
                            ✓ 固定資産確認済み
                            <button
                              onClick={() =>
                                updateReceiptField(
                                  selectedReceipt.id,
                                  "fixedAssetConfirmed",
                                  false,
                                )
                              }
                              className="ml-2 text-xs underline"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <p className="font-bold">
                              ⚠️ 固定資産の可能性があります
                            </p>
                            {selectedReceipt.analysis.fixed_asset_reason && (
                              <p className="text-xs mt-1">
                                {selectedReceipt.analysis.fixed_asset_reason}
                              </p>
                            )}
                            <button
                              onClick={() =>
                                updateReceiptField(
                                  selectedReceipt.id,
                                  "fixedAssetConfirmed",
                                  true,
                                )
                              }
                              className="mt-2 px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs"
                            >
                              固定資産ではないことを確認
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {(selectedReceipt.status === "analyzed" ||
                      selectedReceipt.status === "registered") && (
                      <>
                        {/* 店舗名・日付 */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              店舗名
                            </label>
                            <input
                              type="text"
                              value={selectedReceipt.storeName || ""}
                              onChange={(e) =>
                                updateReceiptField(
                                  selectedReceipt.id,
                                  "storeName",
                                  e.target.value,
                                )
                              }
                              className="w-full border rounded px-3 py-2"
                              disabled={selectedReceipt.status === "registered"}
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700">
                              日付
                            </label>
                            <input
                              type="date"
                              value={selectedReceipt.date || ""}
                              onChange={(e) =>
                                updateReceiptField(
                                  selectedReceipt.id,
                                  "date",
                                  e.target.value,
                                )
                              }
                              className="w-full border rounded px-3 py-2"
                              disabled={selectedReceipt.status === "registered"}
                            />
                          </div>
                        </div>

                        {/* 明細一覧 */}
                        <div>
                          <div className="flex justify-between items-center mb-2">
                            <label className="block text-sm font-medium text-gray-700">
                              明細 ({selectedReceipt.details.length}件)
                            </label>
                            {selectedReceipt.status !== "registered" && (
                              <button
                                onClick={() => addDetail(selectedReceipt.id)}
                                className="px-2 py-1 text-blue-600 hover:bg-blue-50 rounded text-sm"
                              >
                                + 追加
                              </button>
                            )}
                          </div>

                          <div className="space-y-3 max-h-[300px] overflow-y-auto">
                            {selectedReceipt.details.map((detail, index) => (
                              <div
                                key={detail.id}
                                className="border rounded p-3 bg-gray-50 space-y-2"
                              >
                                <div className="flex justify-between items-center">
                                  <span className="text-xs font-medium text-gray-500">
                                    {index + 1}/{selectedReceipt.details.length}
                                  </span>
                                  {selectedReceipt.status !== "registered" &&
                                    selectedReceipt.details.length > 1 && (
                                      <button
                                        onClick={() =>
                                          removeDetail(
                                            selectedReceipt.id,
                                            detail.id,
                                          )
                                        }
                                        className="text-red-500 hover:text-red-700 text-xs"
                                      >
                                        削除
                                      </button>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <label className="block text-xs text-gray-500">
                                      金額
                                    </label>
                                    <input
                                      type="number"
                                      value={detail.amount || ""}
                                      onChange={(e) =>
                                        updateDetailField(
                                          selectedReceipt.id,
                                          detail.id,
                                          "amount",
                                          Number(e.target.value),
                                        )
                                      }
                                      className="w-full border rounded px-2 py-1 text-sm"
                                      disabled={
                                        selectedReceipt.status === "registered"
                                      }
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-500">
                                      税率
                                    </label>
                                    <select
                                      value={detail.taxRate}
                                      onChange={(e) =>
                                        updateDetailField(
                                          selectedReceipt.id,
                                          detail.id,
                                          "taxRate",
                                          Number(e.target.value),
                                        )
                                      }
                                      className="w-full border rounded px-2 py-1 text-sm"
                                      disabled={
                                        selectedReceipt.status === "registered"
                                      }
                                    >
                                      <option value={0}>0%（非課税）</option>
                                      <option value={8}>8%（軽減）</option>
                                      <option value={10}>10%（標準）</option>
                                    </select>
                                  </div>
                                </div>

                                <div>
                                  <label className="block text-xs text-gray-500">
                                    勘定科目
                                  </label>
                                  <SearchableSelect
                                    options={expenseAccountItems.map(
                                      (item) => ({
                                        value: item.id,
                                        label: item.name,
                                      }),
                                    )}
                                    value={detail.accountItemId}
                                    onChange={(value) =>
                                      updateDetailField(
                                        selectedReceipt.id,
                                        detail.id,
                                        "accountItemId",
                                        value,
                                      )
                                    }
                                    placeholder="選択"
                                    disabled={
                                      selectedReceipt.status === "registered"
                                    }
                                  />
                                </div>

                                <div>
                                  <label className="block text-xs text-gray-500">
                                    税区分
                                  </label>
                                  <SearchableSelect
                                    options={taxes.map((tax) => ({
                                      value: tax.code,
                                      label: tax.name_ja,
                                    }))}
                                    value={detail.taxCode}
                                    onChange={(value) =>
                                      updateDetailField(
                                        selectedReceipt.id,
                                        detail.id,
                                        "taxCode",
                                        value,
                                      )
                                    }
                                    placeholder="選択"
                                    disabled={
                                      selectedReceipt.status === "registered"
                                    }
                                  />
                                </div>

                                <div>
                                  <label className="block text-xs text-gray-500">
                                    備考
                                  </label>
                                  <input
                                    type="text"
                                    value={detail.description || ""}
                                    onChange={(e) =>
                                      updateDetailField(
                                        selectedReceipt.id,
                                        detail.id,
                                        "description",
                                        e.target.value,
                                      )
                                    }
                                    className="w-full border rounded px-2 py-1 text-sm"
                                    placeholder="商品・サービスの説明"
                                    disabled={
                                      selectedReceipt.status === "registered"
                                    }
                                  />
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* 合計金額 */}
                          <div className="mt-3 pt-3 border-t flex justify-between items-center">
                            <span className="text-sm font-medium text-gray-700">
                              合計
                            </span>
                            <span className="text-lg font-bold">
                              ¥
                              {selectedReceipt.details
                                .reduce((sum, d) => sum + d.amount, 0)
                                .toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {selectedReceipt.analysis && (
                          <p className="text-xs text-gray-500">
                            確信度:{" "}
                            {(
                              selectedReceipt.analysis.confidence * 100
                            ).toFixed(0)}
                            %
                          </p>
                        )}

                        {selectedReceipt.status === "analyzed" && (
                          <button
                            onClick={() =>
                              handleRegisterToFreee(selectedReceipt)
                            }
                            className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded"
                          >
                            承認してfreeeに登録
                          </button>
                        )}

                        {selectedReceipt.status === "registered" && (
                          <p className="text-center text-purple-600 font-medium">
                            ✓ freeeに登録済み
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-center py-20">
                  左のリストからレシートを選択してください
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
