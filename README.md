# 證照考試工具 (Certification Exam Tool)

一套用於證照考試準備的靜態網頁工具組，涵蓋題目編輯、模擬考試與複習三大核心功能。

## 最新更新（2026-04-07）

- 新增 `投資型考試` 類別到 `data/manifest.json`
- 新增兩份可直接載入的投資型題庫：
  - `data/投資型考試/01_第一科經典考題_11205.txt`
  - `data/投資型考試/02_第二科經典考題_11205.txt`
- `info.html` 入口已改為相對路徑（`./考試.html`、`./複習.html`），不再綁定舊站網址
- 保留 PDF 轉檔工具：`tools/convert-investment-pdf.mjs`（可重跑產出題庫）
- 已加入 `.gitignore`，`node_modules/` 不會進入版本庫

## 主要功能模組

### 📝 編輯（編輯.html）
- 逐題審閱與編輯題目內容（題目、選項、備註、筆記、圖片）
- 新增 / 刪除題目
- 類別統計與快速跳轉
- 匯出為 `.txt`（JSONL 格式）

### 📋 考試（考試.html）
- 模擬考試系統，支援從 GitHub Pages 或本機 `.txt` 載入試題
- 可依類別、關鍵字、備註、筆記、題型等條件篩選
- 支援隨機出題、隨機選項排列、按類別比例分配題數
- 計時功能與成績圓餅圖
- 錯題收集、匯出與複製
- 題目總覽（答題狀態圓點一覽）

### 📖 複習（複習.html）
- 複習模式瀏覽所有題目，支援顯示/隱藏答案
- 難度星等標記（1～3 顆星），紀錄至 localStorage
- 複習燈號（紅/綠/黃）追蹤複習進度
- 關鍵字標示、答案篩選、星等篩選、燈號篩選
- 夜間模式
- 支援複製題目至 GPT / Felo 查詢
- 匯出篩選結果

### ☁️ 雲端同步（Cloudflare D1）
- 前端仍以 localStorage 作為即時狀態來源，但可自動同步到 Cloudflare D1
- 使用者可直接在畫面輸入並保存 `API URL` 與 `API Token`
- `js/cloud-sync-config.js` 改為選用的預設值，不再是唯一設定入口
- Worker 後端改為 D1 逐筆儲存 `localStorage` 的 key / value，而不是整包塞進 KV

### 📝 雲端註記與圖片（Cloudflare D1 + R2）
- 題目註記可依「題庫來源 + 類別 + 題號」存到 D1，跨裝置可帶著跑
- 註記區支援圖片貼上與上傳
- 上傳的圖片會存進 Cloudflare R2，並自動綁到對應題目
- 匯出 JSONL 時，會把雲端註記與圖片 URL 一起合併進輸出

### 🏠 起始頁面（info.html）
- 功能入口導覽（考試 / 複習）
- 工具使用說明與公告

## 資料格式

試題以 **JSONL**（每行一筆 JSON）儲存於 `.txt` 檔案中：

```json
{
  "sn": "001",
  "class": "存匯",
  "question": "題目內容",
  "options": [
    { "option": "選項A", "answer": true },
    { "option": "選項B", "answer": false },
    { "option": "選項C", "answer": false }
  ],
  "remark": "【法規來源】",
  "felo": "個人筆記",
  "pic": "圖片URL1,圖片URL2"
}
```

| 欄位 | 說明 |
|------|------|
| `sn` | 題號（同類別內流水號，三碼補零） |
| `class` | 類別（如：存匯、放款、外匯…） |
| `question` | 題目文字 |
| `options` | 選項陣列，每項含 `option`（文字）與 `answer`（是否正確） |
| `remark` | 備註（通常標記法規來源） |
| `felo` | 個人筆記 / 網路查詢結果 |
| `pic` | 補充圖片 URL，多張以逗號分隔（可留空，改用本機圖片資料夾） |

## 本機圖片對應規則

系統會依照「**載入的資料檔路徑**」自動對應 `img/` 子資料夾，圖片以題目 `sn` 命名，**不需修改 JSON**，圖片存在就顯示，不存在靜默隱藏。

### 資料夾命名規則

```
data/{考試類別}/{資料檔}.txt
  ↓
img/{考試類別}/{資料檔}/{sn}.jpg
```

### 範例

載入 `data/領組考試/01_考古題.txt` 時，自動對應：

```
img/
└── 領組考試/
    └── 01_考古題/
        ├── 001.jpg   ← 第 001 題的補充圖
        ├── 042.jpg   ← 第 042 題
        └── 379.jpg   ← 第 379 題
```

- 只需放上想補充的題目圖片，**其他題目不受影響**
- 若同時在 JSON `pic` 欄位填有 URL，也會一併顯示（兩者並存）
- **考試頁面**：圖片僅在「試題分析（複習模式）」時顯示，作答期間隱藏
- **複習頁面**：圖片位於「圖片」區塊，可透過設定選單中的「隱藏 Pic」開關控制

### 手動上傳 `.txt` 時

若使用手動上傳（不是從 GitHub Pages 載入），圖片路徑會回退為 `img/{sn}.jpg`（直接放在 `img/` 根目錄下）。

## 檔案結構

```
├── info.html          # 起始頁面
├── 編輯.html          # 題目編輯系統
├── 考試.html          # 模擬考試系統
├── 複習.html          # 複習系統
├── 複習計畫.html      # 複習計畫頁面
├── uploadfile.txt     # 考古題資料（JSONL）
├── uploadfile_s.txt   # 去年筆記資料（JSONL）
├── 心智圖素材.txt     # 心智圖素材
├── img/               # 圖片資源
└── README.md
```

## 使用方式

1. 直接在瀏覽器中開啟 `info.html`（或任一 HTML 檔案）
2. 進入「考試」或「複習」後，先在頁面上方選擇考試類別（如 `領組考試` 或 `投資型考試`）
3. 載入試題：點選該類別按鈕，或手動選擇本機 `.txt` 檔案
4. 若部署到 GitHub Pages，請確保 `data/`、`img/`、HTML 檔都一併上傳
5. 不需安裝任何伺服器，純前端靜態頁面即可運作

### 重新轉檔（可選）

若你要重新從 `input/` 的投資型 PDF 轉檔：

```bash
npm install
npm run convert:investment
```

轉檔完成後會更新：

- `data/投資型考試/*.txt`
- `sample/投資型_*.txt`
- `data/投資型考試/_conversion-report.json`
- `data/manifest.json`

## Cloudflare 同步設定

> 雲端同步為**選用功能**。不設定的話，所有資料僅存在瀏覽器 localStorage，離線也能正常使用。  
> 圖片以 base64 格式存入 D1，**不需要 R2**，Cloudflare 免費方案即可使用。

### 方法一：全程透過 Cloudflare 儀表板（不需安裝任何工具）

頁面內「☁️ 雲端設定 → 初次設定教學」也有相同的步驟說明，並提供一鍵複製 SQL 的按鈕。

> **名稱說明**：下方步驟中的 `exam-sync-db`（D1 資料庫）與 `exam-sync-worker`（Worker）是**建議預設名稱**，與 `worker/wrangler.toml` 的設定一致。  
> 若想改用其他名稱，需同步修改 `wrangler.toml` 中的 `database_name`（對應 D1 名稱）與 `name`（對應 Worker 名稱），否則方法二的 Wrangler CLI 部署會找不到對應資源。

#### 1. 建立 D1 資料庫

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左側 → **Storage & Databases → D1 → Create database**
3. 名稱填 `exam-sync-db`，點 Create
4. 進入資料庫 → 索引標籤切到 **Console**
5. 貼入以下 SQL，按 **Execute**：

```sql
CREATE TABLE IF NOT EXISTS sync_entries (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS question_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key     TEXT    NOT NULL,
  question_class TEXT    NOT NULL,
  question_sn    TEXT    NOT NULL,
  note_text      TEXT    NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source_key, question_class, question_sn)
);

CREATE TABLE IF NOT EXISTS note_images (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key     TEXT    NOT NULL,
  question_class TEXT    NOT NULL,
  question_sn    TEXT    NOT NULL,
  image_data     TEXT    NOT NULL,
  mime_type      TEXT    NOT NULL DEFAULT 'image/jpeg',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
```

#### 2. 建立 Worker 並貼上程式碼

1. 左側 → **Workers & Pages → Create → Create Worker**
2. 名稱填 `exam-sync-worker`，點 **Deploy**
3. 點 **Edit code** 進入線上編輯器
4. 全選預設程式碼刪除，貼入 [worker/src/index.js](worker/src/index.js) 的完整內容
5. 點 **Deploy**

#### 3. 綁定 D1

1. 回到 Worker → **Settings → Bindings → Add → D1 Database**
2. Variable name = `DB`，選 `exam-sync-db`
3. 點 **Deploy** 讓綁定生效

#### 4. 設定 API Token

1. Worker → **Settings → Variables and Secrets → Add → Secret**
2. 名稱固定填 `API_TOKEN`，值請自訂一串長密碼並**記下來**
3. 點 **Deploy**

#### 5. 填入前端完成設定

Worker 頁面取得網址（`https://exam-sync-worker.<subdomain>.workers.dev`）  
打開 `複習.html` → 點右上角「**☁️ 雲端設定**」：

| 欄位 | 填入 |
|------|------|
| API URL | Worker 網址 |
| Token | 第 4 步設定的密碼 |

點「**儲存並測試**」，顯示 `✓ 設定已保存並同步` 即完成。

---

### 方法二：使用 Wrangler CLI（開發者 / CI 自動化）

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create exam-sync-db
```

把 `d1 create` 回傳的 `database_id` 填進 [worker/wrangler.toml](worker/wrangler.toml)，再執行：

```bash
npx wrangler secret put API_TOKEN
npx wrangler d1 migrations apply exam-sync-db --remote
npx wrangler deploy
```

> Worker 主程式位於 [worker/src/index.js](worker/src/index.js)。  
> 圖片以 base64 存入 D1，不需要 R2，Cloudflare 免費方案即可完整使用。

## 技術棧

- HTML / CSS / JavaScript（純前端，無框架）
- Tailwind CSS（樣式）
- Google Charts（考試成績圖表）
- localStorage（畫面即時狀態）
- Cloudflare Workers + D1（雲端同步）
