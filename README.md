# 📖 OCR eBooks

免費、純前端嘅書本掃描記事 WebApp。影低書頁 → AI 自動抽出 (topic, content, chapter, page) → 核對後存入 GitHub repo 嘅 `xxxx.json`。可以直接用 GitHub Pages 免費托管，或者直接開 `index.html` 用。

## ✨ 功能

1. **Desktop / Mobile 自適應 UI**（手機底部導航、大按鈕、可橫向捲動表格）
2. **四種方式加入書頁相片**：📸 即時影相、🖼 瀏覽上傳、Drag & Drop、Clipboard Paste（Ctrl+V）
3. 書頁照片會經 AI 讀出 `topic / content / chapter / page`（頁首頁尾嘅章節、頁碼會自動抽）；轉錄規則：**唔跟相片排版，只跟段落**——正文連續輸出，只有原文明顯分段先至用換行分隔（所有 AI prompt 用英文撰寫）
4. 經用戶喺直排結果卡核對（可直接編輯）後，儲存做 `books/xxxx.json`（檔案名由用戶輸入，唔使打 `.json`）；可以揀 repo 入面已存在嘅書檔，**新內容會 append 喺後面**
5. 每張相嘅結果以獨立直排卡顯示（Chapter → Topic → Page → Content），卡片上方有書名及作者輸入欄（會一併寫入 `xxxx.json` 同 `books.json`）；每張卡有獨立「確認儲存」/「捨棄」
6. **認書名介面**：手動輸入之外，仲可以影相 / 上傳 / 拖放 / 貼上封面圖片，AI 自動認書名及作者並填入輸入框；書名及作者存喺單一 `books.json`（`book_title, author`），書內容存喺各自嘅 `books/xxxx.json`
7. **相片私隱**：相片只會喺瀏覽器記憶體入面處理（以 base64 data URL 送入 AI API），**分析完唔會儲存去 repo 或任何地方**，刷新頁面即消失
8. **書庫頁**：表格列出 repo `books/` folder 中所有書檔、書名、作者，頂頭有 filter 可以篩選；每本書可以「開啟」或者「**刪除**」（刪除需要確認）
9. 撳書庫中任何一本書 → 用同一種表格方式顯示內容（**按 page 排序**），每條 row 都可以**編輯 / 刪除**（刪除需要確認），撳「儲存修改」寫返入 repo
10. **設定頁**：可設定 AI model（預設 `deepseek/deepseek-v4.1-flash`）、base URL（預設 `https://openrouter.ai/api/v1`）、API Key、GitHub repo / token；**key 只存喺瀏覽器 localStorage，唔會寫入 repo**（repo 入面嘅 `settings.json` 只保留非敏感預設）

## 🚀 部署

### 方法 A：GitHub Pages（免費托管）
1. 將本 repo push 上 GitHub（已經做咗）
2. GitHub 網頁 → repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch → main / (root)** → Save
3. 完成後網址：`https://<username>.github.io/ocr-ebooks/`

### 方法 B：本地直接用
直接雙撳開 `index.html` 就得（GitHub API 同 OpenRouter API 都支援 CORS，file:// 都用到）。

## ⚙️ 設定

開 App 之後去「⚙️ 設定」頁：

| 欄位 | 說明 |
|---|---|
| GitHub Owner / Repo / Branch | 預設已填 `lamkayuekenneth` / `ocr-ebooks` / `main` |
| GitHub Token | Fine-grained PAT，需要 **Contents: Read and write** 權限；用嚟讀寫 repo 入面嘅 json |
| AI Model | 需要**支援圖片輸入 (vision)** 嘅模型，預設 `deepseek/deepseek-v4.1-flash` |
| Base URL | 預設 `https://openrouter.ai/api/v1`（OpenAI 兼容 `/chat/completions` 都得） |
| API Key | OpenRouter / 對應 provider 嘅 key |

設定儲存：**所有 key（GitHub Token / API Key）只存喺本機瀏覽器 localStorage**，唔會寫入 repo。

## 🔐 安全設計（重要）

- 呢個 repo 係 **public**，所以設定採用「**key 只存本機**」設計：
  - **GitHub Token 同 API Key 只會存喺你自己瀏覽器嘅 localStorage**，永遠唔會寫入 repo。
  - repo 入面嘅 `settings.json` 只係非敏感預設（owner / repo / branch / model / base URL），key 欄位一律留空。
  - 就算 repo 係 public，都唔會洩漏任何 key。
- 換瀏覽器 / 清 cookies 之後要喺設定頁重新輸入 key（其他資料照舊喺 repo）。

## 📁 資料格式

**`books.json`**（書名 / 作者註冊表，存喺 repo 根目錄）：
```json
[
  { "file": "books/physics.json", "book_title": "Physics", "author": "xxx" }
]
```

**`books/xxxx.json`**（書內容，存喺 repo 嘅 `books/` folder，`topic+content` 為 1 row）：
```json
{
  "book_title": "Physics",
  "author": "xxx",
  "rows": [
    { "topic": "力學", "content": "...", "chapter": "第1章", "page": "12" }
  ]
}
```

**`settings.json`**：
```json
{
  "github_owner": "...",
  "github_repo": "...",
  "github_branch": "main",
  "github_token": "",
  "ai_model": "deepseek/deepseek-v4.1-flash",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key": ""
}
```

## 🖼 相片私隱

相片上傳後只會喺瀏覽器記憶體（JS 變數）入面暫存做預覽及送入 AI API，**唔會上傳去任何圖床、唔會寫入 repo、唔會寫入 localStorage**。重新整理頁面即清除。
