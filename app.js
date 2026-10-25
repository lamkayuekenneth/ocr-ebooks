'use strict';

/* =========================================================
 * OCR eBooks — 書本掃描記事
 * 純前端 static app：GitHub API 做 repo 檔案儲存，OpenRouter API 做 AI 分析
 * 相片只喺瀏覽器記憶體處理，分析完唔會儲存任何地方。
 * ========================================================= */

/* ---------- 小工具 ---------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let _uid = 0;
const uid = () => 'r' + (++_uid) + '_' + Date.now().toString(36);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* highlight matched words：將 q 命中的子串包 <mark>，其餘 esc */
function hl(text, q) {
  const s = String(text ?? '');
  if (!q) return esc(s);
  const low = s.toLowerCase(), ql = q.toLowerCase();
  if (!low.includes(ql)) return esc(s);
  let out = '', i = 0;
  while (true) {
    const j = low.indexOf(ql, i);
    if (j < 0) { out += esc(s.slice(i)); break; }
    out += esc(s.slice(i, j)) + '<mark>' + esc(s.slice(j, j + ql.length)) + '</mark>';
    i = j + ql.length;
  }
  return out;
}

function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const overlay = $('#loading-overlay');
  if (busyCount > 0) {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
  $$('.btn').forEach(b => b.disabled = busyCount > 0);
}

/* 更新 loading 遮罩文字（例如「分析緊第 2 / 3 張…」） */
function setLoadingText(text) {
  $('#loading-text').textContent = text || '處理中…';
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('讀取圖片失敗'));
    r.readAsDataURL(file);
  });
}

/* 將圖片縮細到 maxSide 以內（JPEG），慳 API 流量同避免圖片太大被 AI API 拒／超時 */
function resizeImageDataUrl(dataUrl, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1) { resolve(dataUrl); return; }
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => reject(new Error('圖片處理失敗'));
    img.src = dataUrl;
  });
}

/* =========================================================
 * 設定（優先序：預設 → repo settings.json → 本機 localStorage）
 * ========================================================= */
const DEFAULT_SETTINGS = {
  github_owner: 'lamkayuekenneth',
  github_repo: 'ocr-ebooks',
  github_branch: 'main',
  github_token: '',
  ai_model: 'deepseek/deepseek-v4.1-flash',
  base_url: 'https://openrouter.ai/api/v1',
  api_key: '',
  title_model: 'deepseek/deepseek-v4.1-flash',
  title_api_key: ''
};

let settings = { ...DEFAULT_SETTINGS };

function getSettings() { return settings; }

function loadLocalSettings() {
  try {
    const raw = localStorage.getItem('ocreb_settings');
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* 忽略損壞資料 */ }
}

function saveLocalSettings() {
  try { localStorage.setItem('ocreb_settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

/* =========================================================
 * GitHub Contents API
 * ========================================================= */
function repoBase() {
  return `/repos/${encodeURIComponent(settings.github_owner)}/${encodeURIComponent(settings.github_repo)}`;
}

async function gh(path, opts = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {})
  };
  if (settings.github_token) headers['Authorization'] = 'Bearer ' + settings.github_token;
  const res = await fetch('https://api.github.com' + path, { ...opts, headers, cache: 'no-store' });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); msg = e.message || msg; } catch (e) { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getFileContent(path) {
  try {
    const d = await gh(`${repoBase()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(settings.github_branch)}`);
    if (!d || !d.content) return null;
    const bin = atob(d.content.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return { content: new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''), sha: d.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function writeFile(path, content, message) {
  if (!settings.github_token) throw new Error('請先喺設定頁輸入 GitHub Token');
  const existing = await getFileContent(path);
  const payload = {
    message: message || `Update ${path}`,
    content: utf8ToBase64(content),
    branch: settings.github_branch
  };
  if (existing && existing.sha) payload.sha = existing.sha;
  const put = async () => gh(repoBase() + '/contents/' + encodeURIComponent(path), { method: 'PUT', body: JSON.stringify(payload) });
  try {
    await put();
  } catch (e) {
    /* 409 = SHA 衝突（例如跨 tab 並發寫入）：重新讀最新 sha 再試一次 */
    if (e.status === 409) {
      const latest = await getFileContent(path);
      payload.sha = (latest && latest.sha) || undefined;
      await put();
    } else {
      throw e;
    }
  }
}

/* 攞 repo 最新 push（commit）時間 + sha，用嚟顯示版本 */
async function getLastPushInfo() {
  try {
    const commits = await gh(`${repoBase()}/commits?per_page=1&sha=${encodeURIComponent(settings.github_branch)}`);
    if (!Array.isArray(commits) || !commits.length || !commits[0].commit) return null;
    const c = commits[0];
    const dateStr = (c.commit.committer && c.commit.committer.date) || '';
    const sha = (c.sha || '').slice(0, 7);
    const msg = (c.commit.message || '').split('\n')[0];
    return { date: dateStr, sha, msg };
  } catch (e) {
    return null;
  }
}

/* 列出 repo「books/」folder 入面所有書本 json */
async function listJsonFiles() {
  const d = await gh(`${repoBase()}/contents/books?ref=${encodeURIComponent(settings.github_branch)}`);
  return (Array.isArray(d) ? d : [])
    .filter(f => f.type === 'file' && /\.json$/i.test(f.name))
    .map(f => 'books/' + f.name)
    .sort((a, b) => a.localeCompare(b));
}

/* 刪除 repo 入面一個檔案 */
async function deleteFile(path, message) {
  if (!settings.github_token) throw new Error('請先喺設定頁輸入 GitHub Token');
  const existing = await getFileContent(path);
  if (!existing || !existing.sha) return;
  const payload = {
    message: message || `Delete ${path}`,
    sha: existing.sha,
    branch: settings.github_branch
  };
  await gh(repoBase() + '/contents/' + encodeURIComponent(path), { method: 'DELETE', body: JSON.stringify(payload) });
}

/* =========================================================
 * AI（OpenRouter 兼容 /chat/completions）
 * ========================================================= */
async function aiComplete(messages, { json = true, maxTokens = 4096, key, model } = {}) {
  const k = key || settings.api_key;
  const m = model || settings.ai_model;
  if (!k) throw new Error('請先喺設定頁輸入 API Key');
  const url = settings.base_url.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: m, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + k,
        'HTTP-Referer': 'https://github.com/' + settings.github_owner + '/' + settings.github_repo,
        'X-Title': 'OCR eBooks'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); msg = (e.error && (e.error.message || JSON.stringify(e.error))) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return extractJSON(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 請求超時（60 秒），請再試一次');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extractJSON(text) {
  if (!text) throw new Error('AI 冇返回內容');
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  throw new Error('AI 返回唔係有效 JSON：' + t.slice(0, 160));
}

/* =========================================================
 * 內容後處理：除去「冇標點符號分隔」嘅換行（排版 reflow）
 * - 段落空行（\n\n）一定保留
 * - 行尾有標點（。，；：？！、…」』））》等）→ 當做分段，輸出雙換行（空行）
 * - 行尾冇標點 → 刪除換行，將下一行接落嚟
 * - 下一行以數字／英文字母開頭（如頁碼、條目）→ 當做分段，輸出雙換行
 * ========================================================= */
const LINE_END_PUNCT = /[。，；：？！、…」』"')）》】]/;
const LINE_START_KEEP = /[A-Za-z0-9·•\-–—]/;

function reflowContent(text) {
  if (!text) return '';
  const paragraphs = String(text).split(/\n{2,}/);   // 以空行拆段
  return paragraphs.map(p => {
    const lines = p.split('\n');
    const out = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (!out.length) { out.push(l); continue; }
      const prev = out[out.length - 1];
      const lastCh = prev.slice(-1);
      const nextFirst = l.charAt(0);
      if (LINE_END_PUNCT.test(lastCh) || LINE_START_KEEP.test(nextFirst)) {
        out.push(l);                     // 分段 → 保留，加多一個 endline（空行）
      } else {
        out[out.length - 1] = prev + l;  // 冇標點 → 合併
      }
    }
    return out.join('\n\n');
  }).join('\n\n');
}

/* 分析一頁書（返回 {topic, content, chapter, page}） */
async function analyzePage(imageDataUrl) {
  return aiComplete([{
    role: 'user',
    content: [
      { type: 'text', text: 'You are a book page transcription assistant. Read the photo of a printed book page and return ONLY valid JSON, with no other text: {"topic":"title/subject of this page, empty string if none","content":"verbatim transcription of the page body text","chapter":"chapter name if present in the page header/footer, otherwise empty string","page":"page number if present in the page header/footer, otherwise empty string"}. TOPIC RULE: the topic is the page\'s main heading — usually the largest text on the page, which may be written vertically (top-to-bottom, characters stacked). Read the COMPLETE heading character by character and NEVER drop any character from it. TRANSCRIPTION RULES (STRICT): the printed text wraps across many lines, so you MUST collapse every printed line break and make the content read as one continuous text flow — never end a line where the printed text merely wraps to the next printed line. Insert a single "\\n" ONLY between genuine paragraphs (the original page shows a clear paragraph break, e.g. first-line indentation or a blank line gap). Never insert newlines for line wrapping, column layout, spacing, headers, footers or page numbers. Keep the original wording verbatim.' },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]
  }]);
}

/* 認書名及作者（返回 {book_title, author}）——用「書名專用」API Key / Model（未設則 fallback 一般） */
async function recognizeBook(imageDataUrl) {
  return aiComplete([{
    role: 'user',
    content: [
      { type: 'text', text: 'You are a book cover reader. Read ONLY the book title and the author name printed on this cover photo. Rules: (1) book_title = the largest, most prominent text on the cover — a cover ALWAYS has a title, so if you can see a large heading (horizontal, or vertical with characters stacked top-to-bottom), transcribe it in full and join the stacked characters into one continuous title with NO spaces; do not leave book_title empty unless there is genuinely no readable title; (2) author = the short person name (usually 2-4 characters) marked with "著" / "著者" / "by" / "written by", usually printed in a corner of the cover; read each character very carefully because the name may be small or vertical; if you are not confident about the exact characters, return an empty string for author; (3) IGNORE every other cover element: year numbers, dates, publisher names, slogans, blurbs, background decorations and small text; (4) NEVER guess from memory or general knowledge — only read what is actually printed in this photo. Return ONLY valid JSON, with no other text: {"book_title":"","author":""}.' },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]
  }], { key: settings.title_api_key || settings.api_key, model: settings.title_model || settings.ai_model });
}

/* =========================================================
 * 狀態
 * ========================================================= */
const pageImages = [];   // {id, url} 只喺記憶體，唔會儲存
const results = [];      // {id, topic, content, chapter, page}
let detailFile = null;
let detailRows = [];     // {id, topic, content, chapter, page}
let detailDirty = false; // 有未儲存修改（關閉此書時要確認）
function markDetailDirty() { detailDirty = true; }

/* 有無未儲存內容——refresh / F5 / 關頁面前要攔截 */
function hasUnsavedChanges() {
  if (fullEditTarget) return true;                          /* 全屏編輯 popup 開緊（內容未撳完成） */
  if (savingLock) return true;                              /* 儲存寫入緊 repo，唔好打斷 */
  if (detailDirty) return true;                             /* 書本詳情改咗未儲存 */
  if (results.some(r => r.chapter || r.topic || r.page || r.content)) return true;  /* 掃描頁有未確認內容卡 */
  const mp = $('#book-meta-modal');
  if (mp && !mp.classList.contains('hidden')) return true;  /* 書本 meta（改名／作者）編輯開緊 */
  return false;
}
window.addEventListener('beforeunload', e => {
  if (hasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = '';   /* 觸發瀏覽器原生「確定要離開頁面嗎？」確認 */
  }
});
let hoverZone = 'page';  // 貼上圖片時去邊度

/* =========================================================
 * Tab 切換
 * ========================================================= */
function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  if (name === 'library') { refreshLibrary(); }
}

/* =========================================================
 * 圖片加入（掃描頁）
 * ========================================================= */
async function addPageFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;
  for (const f of files) {
    try {
      const url = await readFileAsDataURL(f);
      pageImages.push({ id: uid(), url });
    } catch (e) { toast(e.message, 'error'); }
  }
  renderThumbs();
  toast('已加入 ' + files.length + ' 張書頁相片');
}

function renderThumbs() {
  const grid = $('#thumb-grid');
  grid.innerHTML = '';
  pageImages.forEach(img => {
    const d = document.createElement('div');
    d.className = 'thumb';
    const im = document.createElement('img');
    im.src = img.url;
    im.alt = '書頁';
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.title = '移除';
    rm.onclick = () => {
      if (!confirm('確定移除呢張相？')) return;
      const i = pageImages.findIndex(x => x.id === img.id);
      if (i >= 0) pageImages.splice(i, 1);
      renderThumbs();
    };
    d.appendChild(im); d.appendChild(rm);
    grid.appendChild(d);
  });
}

/* =========================================================
 * AI 分析
 * ========================================================= */
async function runAnalysis() {
  if (!pageImages.length) { toast('未有相片，請先加入書頁相片', 'warn'); return; }
  results.length = 0;
  setBusy(true);
  try {
    const total = pageImages.length;
    for (let i = 0; i < total; i++) {
      setLoadingText(`🤖 分析緊第 ${i + 1} / ${total} 張...`);
      const img = pageImages[0];   // 永遠處理第一張（處理完即清走）
      try {
        const aiUrl = await resizeImageDataUrl(img.url, 1600);   // 縮細先送 AI，避免圖片太大超時/被拒
        const r = await analyzePage(aiUrl);
        results.push({
          id: uid(),
          topic: r.topic || '',
          content: r.content ? reflowContent(r.content) : '',
          chapter: r.chapter || '',
          page: r.page || ''
        });
      } catch (e) {
        results.push({ id: uid(), topic: '', content: `⚠️ 分析失敗：${e.message}`, chapter: '', page: '' });
        toast('第 ' + (i + 1) + ' 張分析失敗：' + e.message, 'error');
      }
      /* 分析完即刻清除該張相（唔會留喺 UI / 任何地方） */
      const idx = pageImages.findIndex(x => x.id === img.id);
      if (idx >= 0) pageImages.splice(idx, 1);
      renderThumbs();
      renderResultCards();
    }
    setLoadingText('✅ 分析完成，請逐張核對後儲存。');
    toast('分析完成');
  } finally {
    setBusy(false);
  }
}

/* 令 textarea 自動增高，顯示成段內容（唔使喺框內捲動） */
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = (el.scrollHeight + 2) + 'px';
}

/* =========================================================
 * 全屏內容編輯：撳 content textarea 彈大編輯框
 * ========================================================= */
let fullEditTarget = null;   /* {el: textarea} 或 {row, key}（filter 檢視模式） */

function openFullEdit(target) {
  fullEditTarget = target;
  $('#full-edit-text').value = target.el ? target.el.value : (target.row[target.key] || '');
  $('#full-edit-overlay').classList.remove('hidden');
  const t = $('#full-edit-text');
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);   /* 游標去到尾 */
}

function closeFullEdit() {
  if (!fullEditTarget) return;
  const v = $('#full-edit-text').value;
  let isDetail = false;
  if (fullEditTarget.el) {
    const el = fullEditTarget.el;
    el.value = v;
    autosize(el);
    /* 同步返 row 數據 + 標記未儲存（唔可以淨係改 DOM，否則儲存時用返舊 data） */
    const rid = el.dataset && el.dataset.rid;
    if (rid) {
      const row = detailRows.find(x => x.id === rid);
      const key = el.classList.contains('topic-input') ? 'topic' : 'content';
      if (row) { row[key] = v; markDetailDirty(); isDetail = !!detailFile; }
    }
  } else {
    fullEditTarget.row[fullEditTarget.key] = v;
    markDetailDirty();
    isDetail = !!detailFile;
  }
  fullEditTarget = null;
  $('#full-edit-overlay').classList.add('hidden');
  /* filter 檢視模式：寫返入 row 之後 re-render，highlight 即時更新 */
  const dc = $('#book-detail-card');
  if (dc && !dc.classList.contains('hidden') && typeof renderDetailRows === 'function') renderDetailRows();
  /* 書本詳情模式：撳「完成」直接將內容更新儲存落 repo JSON（掃描頁 card 模式照舊等用戶撳確認儲存） */
  if (isDetail) saveDetail();
}

function bindFullEdit() {
  /* 任何 .content-text textarea 撳入去 → 彈全屏（event delegation，唔使每次 render 綁） */
  document.addEventListener('click', e => {
    const t = e.target;
    if (t && t.tagName === 'TEXTAREA' && t.classList.contains('content-text')) {
      openFullEdit({ el: t });
    }
  });
  $('#full-edit-close').addEventListener('click', closeFullEdit);
  $('#full-edit-discard').addEventListener('click', discardFullEdit);
  /* 只可撳「✓ 完成」關閉：唔畀撳背景或 Esc 關閉，避免唔小心整冇編輯內容 */
}

/* 捨棄變更：唔同步返 row / textarea，直接關閉（需用戶確認） */
function discardFullEdit() {
  if (!fullEditTarget) return;
  if (!confirm('確定捨棄今次嘅變更？')) return;
  fullEditTarget = null;
  $('#full-edit-overlay').classList.add('hidden');
  /* filter 檢視模式：內容冇變，但 re-render 以恢復正常檢視 */
  const dc = $('#book-detail-card');
  if (dc && !dc.classList.contains('hidden') && typeof renderDetailRows === 'function') renderDetailRows();
}

/* 辨識結果：每張相一個獨立直排 card（chapter → topic → page → content），各有儲存/捨棄掣
 * 唔經 AI 都常駐一張空卡供手動輸入；捨棄 button 有內容先顯示；只剩一張捨棄後自動補新卡 */
function renderResultCards() {
  const wrap = $('#result-cards');
  wrap.innerHTML = '';
  if (!results.length) pushEmptyCard();          /* 初始／全部捨棄／全部儲存後：至少一張空卡供手動輸入 */
  results.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';

    const mk = (tag, key, ph, label) => {
      const lab = document.createElement('label');
      lab.className = 'rc-field';
      const span = document.createElement('span');
      span.className = 'rc-label';
      span.textContent = label;
      const el = document.createElement(tag);
      el.value = r[key] || '';
      el.placeholder = ph || '';
      if (tag === 'textarea') el.classList.add('content-text');   /* 撳入去彈全屏編輯 */
      el.addEventListener('input', () => {
        r[key] = el.value;
        if (tag === 'textarea') autosize(el);
        updateDiscardButton(card, r);
      });
      lab.appendChild(span);
      lab.appendChild(el);
      return lab;
    };

    const head = document.createElement('div');
    head.className = 'rc-head';
    const title = document.createElement('span');
    title.textContent = `第 ${i + 1} 張`;
    const discard = document.createElement('button');
    discard.className = 'btn small danger';
    discard.textContent = '🗑 捨棄';
    discard.title = '唔要呢張結果';
    discard.onclick = () => {
      if (!confirm('確定捨棄「第 ' + (i + 1) + ' 張」嘅結果？')) return;
      const idx = results.findIndex(x => x.id === r.id);
      if (idx >= 0) results.splice(idx, 1);
      renderResultCards();                        /* 若已清空，render 會自動補一張空卡 */
    };
    head.appendChild(title);
    head.appendChild(discard);
    card.appendChild(head);
    updateDiscardButton(card, r);                /* 初始：冇內容 → 隱藏捨棄 */

    card.appendChild(mk('input', 'chapter', '章節', 'Chapter'));
    card.appendChild(mk('input', 'topic', '主題', 'Topic'));
    card.appendChild(mk('input', 'page', '頁碼', 'Page'));
    card.appendChild(mk('textarea', 'content', '正文', 'Content'));

    const act = document.createElement('div');
    act.className = 'rc-actions';
    const save = document.createElement('button');
    save.className = 'btn success';
    save.textContent = '💾 確認儲存';
    save.onclick = () => saveSingleRow(r);
    act.appendChild(save);
    card.appendChild(act);

    wrap.appendChild(card);
  });
  wrap.querySelectorAll('textarea').forEach(autosize);
}

/* 捨棄 button：卡片有任何欄位輸入過內容先顯示 */
function updateDiscardButton(card, r) {
  const has = !!(r.chapter || r.topic || r.page || r.content);
  const btn = card.querySelector('.danger');
  if (btn) btn.style.display = has ? '' : 'none';
}

/* 新增一張空嘅手動輸入卡 */
function pushEmptyCard() {
  results.push({ id: uid(), chapter: '', topic: '', page: '', content: '' });
}

/* =========================================================
 * 現有檔案 popup（揀選後 append）
 * ========================================================= */
let filePickerData = [];   // [{file, book_title, author, count}]

async function openFilePicker() {
  const overlay = $('#file-picker-modal');
  overlay.classList.remove('hidden');
  $('#fp-filter-file').value = '';
  $('#fp-filter-title').value = '';
  $('#fp-filter-author').value = '';
  filePickerData = [];
  setBusy(true);
  try {
    /* 合併 books.json 註冊表 + repo 根目錄所有書本 json */
    const byFile = {};
    try {
      const raw = await getFileContent('books.json');
      const reg = (raw && raw.content) ? JSON.parse(raw.content) : [];
      if (Array.isArray(reg)) reg.forEach(b => { if (b.file) byFile[b.file] = { file: b.file, book_title: b.book_title || '', author: b.author || '' }; });
    } catch (e) { /* ignore */ }
    try {
      const files = await listJsonFiles();
      files.forEach(f => { if (!byFile[f]) byFile[f] = { file: f, book_title: '', author: '' }; });
    } catch (e) { /* ignore */ }
    filePickerData = Object.values(byFile).sort((a, b) => a.file.localeCompare(b.file));
    /* 非同步補條目數 */
    filePickerData.forEach(entry => {
      getFileContent(entry.file).then(raw => {
        if (raw && raw.content) {
          try { entry.count = (JSON.parse(raw.content).rows || []).length; } catch (e) { entry.count = 0; }
          if (!overlay.classList.contains('hidden')) renderFilePicker();
        }
      }).catch(() => { /* ignore */ });
    });
  } catch (e) {
    toast('載入檔案列表失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
  renderFilePicker();
}

function closeFilePicker() {
  $('#file-picker-modal').classList.add('hidden');
}

function renderFilePicker() {
  const fFile = $('#fp-filter-file').value.trim().toLowerCase();
  const fTitle = $('#fp-filter-title').value.trim().toLowerCase();
  const fAuthor = $('#fp-filter-author').value.trim().toLowerCase();
  const rows = filePickerData.filter(e =>
    (!fFile || (e.file || '').toLowerCase().includes(fFile)) &&
    (!fTitle || (e.book_title || '').toLowerCase().includes(fTitle)) &&
    (!fAuthor || (e.author || '').toLowerCase().includes(fAuthor))
  );
  const tbody = $('#file-picker-table tbody');
  tbody.innerHTML = '';
  rows.forEach(e => {
    const tr = document.createElement('tr');
    const tdFile = document.createElement('td');
    const fileBtn = document.createElement('button');
    fileBtn.className = 'btn-link';
    fileBtn.innerHTML = hl(String(e.file).replace(/^books\//, ''), fFile);   /* 唔顯示 books/ 前綴 + matched 高亮 */
    fileBtn.title = '撳入去揀選 ' + e.file;
    fileBtn.onclick = () => pickExistingFile(e.file);
    tdFile.appendChild(fileBtn);
    const tdTitle = document.createElement('td');
    const titleBtn = document.createElement('button');
    titleBtn.className = 'btn-link';
    titleBtn.innerHTML = hl(e.book_title || '—', fTitle);
    titleBtn.title = '撳入去揀選 ' + e.file;
    titleBtn.onclick = () => pickExistingFile(e.file);
    tdTitle.appendChild(titleBtn);
    const tdAuthor = document.createElement('td');
    tdAuthor.innerHTML = hl(e.author || '—', fAuthor);
    const tdCount = document.createElement('td');
    tdCount.className = 'row-num';
    tdCount.textContent = e.count != null ? String(e.count) : '—';
    tr.appendChild(tdFile); tr.appendChild(tdTitle); tr.appendChild(tdAuthor); tr.appendChild(tdCount);
    tbody.appendChild(tr);
  });
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="4" class="hint" style="text-align:center">冇相符嘅書檔</td></tr>';
  $('#fp-hint').textContent = '共 ' + rows.length + ' 本書檔（直接撳檔名 / 書名即可揀選，新內容 append 喺後面）';
}

async function pickExistingFile(file) {
  closeFilePicker();
  $('#file-name').value = file;
  try {
    const raw = await getFileContent(file);
    if (raw && raw.content) {
      const b = JSON.parse(raw.content);
      if (b.book_title && !$('#book-title').value.trim()) $('#book-title').value = b.book_title;
      if (b.author && !$('#book-author').value.trim()) $('#book-author').value = b.author;
      toast(`已選擇 ${file}，新內容會 append 喺後面（現有 ${(b.rows || []).length} 條）`);
    } else {
      toast('已選擇 ' + file);
    }
  } catch (e) { toast('讀取 ' + file + ' 失敗：' + e.message, 'error'); }
}

/* =========================================================
 * 儲存書內容（每張相獨立：append 入 xxxx.json + 更新 books.json）
 * 注意：用 savingLock 防止連撳多張時並發寫入撞 SHA（GitHub 409）
 * ========================================================= */
let savingLock = false;

async function saveSingleRow(row) {
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  const bookTitle = $('#book-title').value.trim();
  const author = $('#book-author').value.trim();
  let fileName = $('#file-name').value.trim();
  if (!fileName) { toast('請輸入儲存檔名（例如 physics），或撳「📂 選擇現有檔案」', 'warn'); return; }
  if (!/\.json$/i.test(fileName)) fileName += '.json';
  if (!fileName.startsWith('books/')) fileName = 'books/' + fileName;   /* 書本 json 一律放 books/ folder */

  const data = { topic: (row.topic || '').trim(), content: (row.content || '').trim(), chapter: (row.chapter || '').trim(), page: (row.page || '').trim() };
  if (!data.topic && !data.content) { toast('呢張冇內容（topic 或 content 至少一樣）', 'warn'); return; }

  savingLock = true;
  setBusy(true);
  try {
    const existingData = await getFileContent(fileName);
    let book;
    if (existingData && existingData.content) {
      try { book = JSON.parse(existingData.content); } catch (e) { book = { rows: [] }; }
      book.book_title = bookTitle || book.book_title || '';
      book.author = author || book.author || '';
      book.rows = (Array.isArray(book.rows) ? book.rows : []).concat(data);
    } else {
      book = { book_title: bookTitle, author, rows: [data] };
    }

    /* books.json 註冊表：{file, book_title, author} */
    const regRaw = await getFileContent('books.json');
    let reg = [];
    if (regRaw && regRaw.content) { try { reg = JSON.parse(regRaw.content); } catch (e) { reg = []; } }
    if (!Array.isArray(reg)) reg = [];
    const idx = reg.findIndex(b => b.file === fileName);
    if (idx >= 0) {
      reg[idx].book_title = bookTitle || reg[idx].book_title || '';
      reg[idx].author = author || reg[idx].author || '';
    } else {
      reg.push({ file: fileName, book_title: bookTitle, author });
    }

    await writeFile(fileName, JSON.stringify(book, null, 2), `Add book content to ${fileName}`);
    await writeFile(csvPathFor(fileName), buildBookCSV(book, book.book_title, book.author), `Sync CSV for ${csvPathFor(fileName)}`);   /* 每次儲存同步 books_csv */
    await writeFile('books.json', JSON.stringify(reg, null, 2), 'Update books registry');
    toast('已儲存到 ' + fileName + '（而家共 ' + book.rows.length + ' 條）', 'success');

    /* 儲存成功後，將呢張相喺結果區移除（唔會重複儲存） */
    const ridx = results.findIndex(x => x.id === row.id);
    if (ridx >= 0) results.splice(ridx, 1);
    renderResultCards();
  } catch (e) {
    toast('儲存失敗：' + e.message, 'error');
  } finally {
    savingLock = false;
    setBusy(false);
  }
}

/* =========================================================
 * 書庫
 * ========================================================= */
async function refreshLibrary() {
  const filter = $('#lib-filter').value.trim().toLowerCase();
  let reg = [];
  try {
    const raw = await getFileContent('books.json');
    if (raw && raw.content) { try { reg = JSON.parse(raw.content); } catch (e) { reg = []; } }
  } catch (e) { /* 未有 token */ }
  if (!Array.isArray(reg)) reg = [];

  /* 確保 repo 入面所有書本 json 都顯示（即使未喺 registry） */
  try {
    const files = await listJsonFiles();
    const known = new Set(reg.map(b => b.file));
    files.forEach(f => { if (!known.has(f)) reg.push({ file: f, book_title: '', author: '' }); });
  } catch (e) { /* ignore */ }

  const rows = reg.filter(b =>
    !filter ||
    (b.file || '').toLowerCase().includes(filter) ||
    (b.book_title || '').toLowerCase().includes(filter) ||
    (b.author || '').toLowerCase().includes(filter)
  );

  const tbody = $('#lib-table tbody');
  tbody.innerHTML = '';
  rows.forEach(b => {
    const tr = document.createElement('tr');
    const tdFile = document.createElement('td');
    const fileWrap = document.createElement('div');
    fileWrap.className = 'title-wrap';
    const btnImport = document.createElement('button');
    btnImport.className = 'btn small';
    btnImport.textContent = '⇧ 匯入';
    btnImport.title = '上載 csv/json 取代呢個 json 檔案（會同步更新 books_csv）';
    btnImport.onclick = () => importBookFile(b.file);
    const fileBtn = document.createElement('button');
    fileBtn.className = 'btn-link';
    fileBtn.innerHTML = hl(String(b.file).replace(/^books\//, ''), filter);   /* 唔顯示 books/ 前綴 + matched 高亮 */
    fileBtn.title = b.file + '（撳入去編輯書名 / 作者 / 檔名）';
    fileBtn.onclick = () => openBookMetaPopup(b.file);
    fileWrap.appendChild(btnImport);
    fileWrap.appendChild(fileBtn);
    tdFile.appendChild(fileWrap);
    const tdTitle = document.createElement('td');
    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn small';
    editBtn.textContent = '✏️ 編輯';
    editBtn.title = '開啟內容編輯';
    editBtn.onclick = () => openBook(b.file);
    const titleBtn = document.createElement('button');
    titleBtn.className = 'btn-link';
    titleBtn.innerHTML = hl(b.book_title || '—', filter);
    titleBtn.title = '喺新視窗閱讀呢本書';
    titleBtn.onclick = () => openReader(b.file);
    titleWrap.appendChild(editBtn);
    titleWrap.appendChild(titleBtn);
    tdTitle.appendChild(titleWrap);
    const tdAuthor = document.createElement('td');
    tdAuthor.innerHTML = hl(b.author || '—', filter);
    const tdCount = document.createElement('td');
    tdCount.className = 'row-num';
    tdCount.textContent = '—';
    const tdAct = document.createElement('td');
    tdAct.className = 'open-cell';
    const btnCsv = document.createElement('button');
    btnCsv.className = 'btn small';
    btnCsv.textContent = '⬇ CSV';
    btnCsv.title = '匯出成 CSV 下載';
    btnCsv.onclick = () => exportBookCSV(b.file, b.book_title, b.author);
    const btnJson = document.createElement('button');
    btnJson.className = 'btn small';
    btnJson.textContent = '⬇ JSON';
    btnJson.title = '下載現存嘅 json 檔案';
    btnJson.onclick = () => exportBookJSON(b.file);
    const btnDel = document.createElement('button');
    btnDel.className = 'btn small danger';
    btnDel.textContent = '刪除';
    btnDel.title = '刪除成個 json 檔案';
    btnDel.onclick = () => deleteBookFile(b.file);
    tdAct.appendChild(btnCsv);
    tdAct.appendChild(btnJson);
    tdAct.appendChild(btnDel);
    tr.appendChild(tdFile); tr.appendChild(tdTitle); tr.appendChild(tdAuthor); tr.appendChild(tdCount); tr.appendChild(tdAct);
    tbody.appendChild(tr);
    /* 非同步補條目數 */
    getFileContent(b.file).then(raw => {
      if (raw && raw.content) {
        try {
          const bk = JSON.parse(raw.content);
          tdCount.textContent = String((bk.rows || []).length);
        } catch (e) { /* ignore */ }
      }
    }).catch(() => { /* ignore */ });
  });
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center">未有書。去「掃描」頁加入新書，或檢查設定頁嘅 GitHub 資料。</td></tr>';
  $('#lib-hint').textContent = '共 ' + rows.length + ' 本書';
}

/* 書本 JSON → CSV 字串（format 同 template 一致：BOM＋book_title/author 兩行 meta＋header＋每節一行，RFC4180 quote） */
function buildBookCSV(book, bookTitle, author) {
  const rows = Array.isArray(book.rows) ? book.rows : [];
  const q = v => {   /* RFC4180：含逗號／引號／換行先 quote，引號加倍 */
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  lines.push('\uFEFFbook_title,' + q(bookTitle || book.book_title || '') + ',,');
  lines.push('author,' + q(author || book.author || '') + ',,');
  lines.push('chapter,page,topic,content');
  rows.forEach(r => {
    lines.push([q(r.chapter), q(r.page), q(r.topic), q(r.content)].join(','));
  });
  return lines.join('\r\n');
}

/* books/xxx.json → books_csv/xxx.csv */
function csvPathFor(file) {
  return String(file).replace(/^books\//, 'books_csv/').replace(/\.json$/i, '.csv');
}

/* 匯出 CSV：由 book JSON 生成 CSV 並下載（格式同 books_csv 入面嘅同步 CSV 一致） */
function exportBookCSV(file, bookTitle, author) {
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  getFileContent(file).then(raw => {
    if (!raw || !raw.content) { toast('讀取 ' + file + ' 失敗', 'error'); return; }
    let book;
    try { book = JSON.parse(raw.content); } catch (e) { toast(file + ' 唔係有效 JSON', 'error'); return; }
    const csv = buildBookCSV(book, bookTitle, author);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(file).replace(/^books\//, '').replace(/\.json$/i, '') + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已匯出 ' + a.download + '（' + (book.rows || []).length + ' 節）', 'success');
  }).catch(e => toast('匯出失敗：' + e.message, 'error'));
}

/* 匯出 JSON：由 repo 下載現存嗰本書嘅 json 檔案 */
function exportBookJSON(file) {
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  getFileContent(file).then(raw => {
    if (!raw || !raw.content) { toast('讀取 ' + file + ' 失敗', 'error'); return; }
    const blob = new Blob([raw.content], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(file).replace(/^books\//, '');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已下載 ' + a.download, 'success');
  }).catch(e => toast('下載失敗：' + e.message, 'error'));
}

/* 匯入：上載 csv/json 取代現存 json。前端做 format validation，
 * 通過後再叫用戶確認先寫入 repo；唔通過就報原因、可以再上載。 */
function importBookFile(file) {
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,.csv,application/json,text/csv';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    let text;
    try { text = await f.text(); } catch (e) { toast('讀唔到檔案：' + e.message, 'error'); inp.value = ''; return; }
    const v = validateBookFile(text, f.name);
    if (!v.ok) {
      /* 唔通過：話俾用戶知原因，input 清空等佢再上載 retry */
      toast('匯入失敗：' + v.error, 'error');
      inp.value = '';
      return;
    }
    if (!confirm('將用上載嘅「' + f.name + '」（' + v.info + '）取代現存「' + file + '」？\n呢個動作會覆蓋 repo 上嘅檔案。')) { inp.value = ''; return; }
    setBusy(true);
    try {
      const imported = JSON.parse(v.content);   /* 已驗證，必然 parse 到 */
      await writeFile(file, v.content, 'Import ' + f.name + ' → ' + file);
      await writeFile(csvPathFor(file), buildBookCSV(imported, imported.book_title, imported.author), `Sync CSV for ${csvPathFor(file)}`);
      toast('已匯入並取代 ' + file + '（' + v.rows + ' 節）', 'success');
      refreshLibrary();
    } catch (e) {
      toast('匯入失敗：' + e.message, 'error');
    } finally {
      setBusy(false);
      inp.value = '';
    }
  };
  inp.click();
}

/* 書本 csv/json 格式驗證（前端）：
 * 返回 {ok, error?, content?, info?, rows?}——content 係要寫入 repo 嘅 JSON 字串（UTF-8） */
function validateBookFile(text, filename) {
  const isCsv = /\.csv$/i.test(filename);
  const isJson = /\.json$/i.test(filename);
  if (!isCsv && !isJson) return { ok: false, error: '只支援 .csv 或 .json 檔案（你上載咗：' + (filename || '?') + '）' };
  const clean = text.replace(/^\uFEFF/, '');   /* 有 BOM 就去 BOM（UTF-8 BOM / 無 BOM 都接受） */

  if (isJson) {
    let obj;
    try { obj = JSON.parse(clean); } catch (e) { return { ok: false, error: 'JSON 格式無效：' + e.message }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'JSON 必須係一個書本物件（{book_title, author, rows:[...]}）' };
    if (!Array.isArray(obj.rows)) return { ok: false, error: 'JSON 缺少 rows 陣列——需要 {"rows":[{chapter,page,topic,content},...]}' };
    for (let n = 0; n < obj.rows.length; n++) {
      const r = obj.rows[n];
      if (!r || typeof r !== 'object') return { ok: false, error: 'rows 第 ' + (n + 1) + ' 項唔係物件' };
      if (r.chapter == null || String(r.chapter).trim() === '') return { ok: false, error: 'rows 第 ' + (n + 1) + ' 項缺少 chapter 欄位' };
    }
    const content = JSON.stringify(obj, null, 2);
    return { ok: true, content, rows: obj.rows.length, info: obj.rows.length + ' 節，直接以 JSON 儲存' };
  }

  /* CSV：可選頭兩行 meta（book_title,<名>, ／ author,<名>,）＋ header chapter,page,topic,content ＋ 每節一行 */
  const lines = clean.replace(/\r\n?/g, '\n').split('\n');
  const meta = { book_title: '', author: '' };
  let i = 0;
  if (lines[0] && /^book_title\s*,/i.test(lines[0].trim())) {
    const p0 = parseCSVLine(lines[0]).fields;
    meta.book_title = String(p0[1] || '').trim();
    i = 1;
    if (lines[1] && /^author\s*,/i.test(lines[1].trim())) {
      const p1 = parseCSVLine(lines[1]).fields;
      meta.author = String(p1[1] || '').trim();
      i = 2;
    }
  }
  if (!(i < lines.length) || !/^chapter\s*,page\s*,topic\s*,content\s*$/i.test(lines[i].trim())) {
    return { ok: false, error: 'CSV 缺少表頭行 chapter,page,topic,content（開頭可選 book_title／author 兩行 meta）' };
  }
  i++;
  const rows = [];
  let buf = null, rn = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() && !buf) continue;
    const parsed = parseCSVLine(buf ? buf + '\n' + line : line);
    if (parsed.inQ) { buf = (buf ? buf + '\n' : '') + line; continue; }   /* quoted 欄位跨行：繼續合併 */
    buf = null;
    rn++;
    const p = parsed.fields;
    if (p.length < 4) return { ok: false, error: 'CSV 第 ' + rn + ' 行資料欄位不足（需要 chapter,page,topic,content 4 欄）' };
    const chapter = String(p[0]).trim();
    if (!chapter) return { ok: false, error: 'CSV 第 ' + rn + ' 行 chapter 係空' };
    rows.push({ chapter, page: String(p[1]).trim(), topic: String(p[2]).trim(), content: String(p[3]) });
  }
  if (!rows.length) return { ok: false, error: 'CSV 冇任何資料行' };
  const obj = { book_title: meta.book_title || '', author: meta.author || '', rows };
  return { ok: true, content: JSON.stringify(obj, null, 2), rows: rows.length, info: rows.length + ' 節，已轉換為 JSON 儲存' };
}

/* 簡易 RFC4180 CSV 行 parser：支援 quoted fields（"" 轉義） */
function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return { fields: out, inQ };
}

/* 刪除成個書本 json（連 books.json 註冊表一齊更新） */
async function deleteBookFile(file) {
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  if (!confirm(`確定要刪除「${file}」成個檔案？\n呢個動作無法復原。`)) return;
  savingLock = true;
  setBusy(true);
  try {
    await deleteFile(file, `Delete ${file}`);
    /* 同步喺 books.json 移除記錄 */
    const regRaw = await getFileContent('books.json');
    let reg = [];
    if (regRaw && regRaw.content) { try { reg = JSON.parse(regRaw.content); } catch (e) { reg = []; } }
    if (Array.isArray(reg)) {
      const next = reg.filter(b => b.file !== file);
      await writeFile('books.json', JSON.stringify(next, null, 2), 'Update books registry');
    }
    toast('已刪除 ' + file, 'success');
    refreshLibrary();
  } catch (e) {
    toast('刪除失敗：' + e.message, 'error');
  } finally {
    savingLock = false;
    setBusy(false);
  }
}

/* 實體「貼上」button：直接讀剪貼簿圖片（target: 'book' 封面 / 'meta' 書庫 popup / 其他=頁面） */
async function pasteFromClipboard(target) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) { toast('呢個瀏覽器唔支援讀剪貼簿', 'warn'); return; }
    const items = await navigator.clipboard.read();
    let picked = false;
    for (const it of items) {
      const t = (it.types || []).find(x => x && x.startsWith('image/'));
      if (t) {
        const blob = await it.getType(t);
        const file = new File([blob], 'paste.png', { type: t });
        if (target === 'book') addBookImage(file);
        else if (target === 'meta') addBookMetaImage(file);
        else addPageFiles([file]);
        picked = true;
        break;
      }
    }
    if (!picked) toast('剪貼簿入面冇圖片', 'warn');
  } catch (e) {
    toast('讀取剪貼簿失敗：' + e.message, 'error');
  }
}

/* 書庫：編輯書名 / 作者 popup（可影相 / 上傳 / 拖放 / 貼上封面 AI 認） */
let bookMetaFile = null;

async function openBookMetaPopup(file) {
  bookMetaFile = file;
  $('#book-meta-file').textContent = file;
  $('#book-meta-filename').value = String(file).replace(/^books\//, '');
  /* 用現有記錄填返書名 / 作者 */
  let title = '', author = '';
  try {
    const regRaw = await getFileContent('books.json');
    if (regRaw && regRaw.content) {
      const reg = JSON.parse(regRaw.content);
      const b = (Array.isArray(reg) ? reg : []).find(x => x.file === file);
      if (b) { title = b.book_title || ''; author = b.author || ''; }
    }
  } catch (e) { /* ignore */ }
  $('#book-meta-title').value = title;
  $('#book-meta-author').value = author;
  $('#book-meta-status').textContent = '';
  $('#book-meta-modal').classList.remove('hidden');
}

function closeBookMetaPopup() {
  bookMetaFile = null;
  $('#book-meta-modal').classList.add('hidden');
}

async function saveBookMeta() {
  if (!bookMetaFile) return;
  if (savingLock) { toast('上一個儲存未完成，請稍候…', 'warn'); return; }
  const title = $('#book-meta-title').value.trim();
  const author = $('#book-meta-author').value.trim();
  const oldFile = bookMetaFile;
  /* 檔名可以重新命名（自動補 .json / books/ 前綴） */
  let newName = $('#book-meta-filename').value.trim();
  if (newName && !/\.json$/i.test(newName)) newName += '.json';
  const newFile = newName ? (newName.startsWith('books/') ? newName : 'books/' + newName) : oldFile;
  savingLock = true;
  setBusy(true);
  try {
    /* 更新書檔入面嘅 book_title / author */
    const raw = await getFileContent(oldFile);
    const book = (raw && raw.content) ? JSON.parse(raw.content) : { rows: [] };
    book.book_title = title;
    book.author = author;
    if (newFile === oldFile) {
      await writeFile(oldFile, JSON.stringify(book, null, 2), `Update book meta for ${oldFile}`);
      await writeFile(csvPathFor(oldFile), buildBookCSV(book, title, author), `Sync CSV for ${csvPathFor(oldFile)}`);
    } else {
      /* rename：新檔名寫入新 path，再刪舊 path（csv 同步 rename） */
      await writeFile(newFile, JSON.stringify(book, null, 2), `Rename ${oldFile} to ${newFile}`);
      await writeFile(csvPathFor(newFile), buildBookCSV(book, title, author), `Sync CSV for ${csvPathFor(newFile)}`);
      await deleteFile(oldFile, `Delete old file ${oldFile} after rename`);
      await deleteFile(csvPathFor(oldFile), `Delete old CSV ${csvPathFor(oldFile)} after rename`);
    }

    /* 同步更新 books.json 註冊表 */
    const regRaw = await getFileContent('books.json');
    let reg = [];
    if (regRaw && regRaw.content) { try { reg = JSON.parse(regRaw.content); } catch (e) { reg = []; } }
    if (!Array.isArray(reg)) reg = [];
    const idx = reg.findIndex(b => b.file === oldFile);
    if (idx >= 0) { reg[idx].file = newFile; reg[idx].book_title = title; reg[idx].author = author; }
    else reg.push({ file: newFile, book_title: title, author });
    await writeFile('books.json', JSON.stringify(reg, null, 2), 'Update books registry');

    $('#book-meta-status').textContent = '✅ 已儲存書名 / 作者' + (newFile !== oldFile ? '（檔名已改為 ' + newFile + '）' : '');
    toast(newFile !== oldFile ? '已儲存並重新命名做 ' + newFile : '已儲存書名 / 作者', 'success');
    closeBookMetaPopup();
    refreshLibrary();
  } catch (e) {
    $('#book-meta-status').textContent = '❌ 儲存失敗：' + e.message;
    toast('儲存失敗：' + e.message, 'error');
  } finally {
    savingLock = false;
    setBusy(false);
  }
}

/* 書庫 popup：封面相 → AI 認書名 */
async function addBookMetaImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const url = await readFileAsDataURL(file);
    setBusy(true);
    $('#book-meta-status').textContent = '🤖 認書名及作者中...';
    const aiUrl = await resizeImageDataUrl(url, 1600);
    const r = await recognizeBook(aiUrl);
    if (r.book_title) $('#book-meta-title').value = r.book_title;
    if (r.author) $('#book-meta-author').value = r.author;
    $('#book-meta-status').textContent = r.book_title ? '✅ 已自動填入，請核對後儲存' : '⚠️ AI 未能確定，可以手動輸入';
  } catch (e) {
    $('#book-meta-status').textContent = '❌ 認書名失敗：' + e.message;
    toast('認書名失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* Page 排序：先數字後文字 */
function pageSortKey(p) {
  const s = String(p || '');
  const m = s.match(/\d+/);
  return m ? [0, parseInt(m[0], 10), s] : [1, 0, s];
}

/* 喺新視窗開閱讀器（paper-like 書本觀感：chapter 導航、字體縮放、搜尋 highlight + 前後跳） */
function openReader(file) {
  window.open('reader.html?file=' + encodeURIComponent(file), '_blank');
}

async function openBook(file) {
  setBusy(true);
  try {
    const raw = await getFileContent(file);
    const book = (raw && raw.content) ? JSON.parse(raw.content) : { rows: [] };
    detailFile = file;
    detailRows = (Array.isArray(book.rows) ? book.rows : []).map(r => ({
      id: uid(), topic: r.topic || '', content: r.content || '', chapter: r.chapter || '', page: r.page || ''
    }));
    detailRows.sort((a, b) => {
      const ka = pageSortKey(a.page), kb = pageSortKey(b.page);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });
    detailDirty = false;
    $('#df-topic').value = ''; $('#df-chapter').value = ''; $('#df-content').value = '';
    $('#book-detail-title').textContent = `${book.book_title || '（無書名）'}${book.author ? ' — ' + book.author : ''} ・ ${file}`;
    $('#book-detail-card').classList.remove('hidden');
    renderDetailRows();
    $('#book-detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast('開啟失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
}

function renderDetailRows() {
  const tbody = $('#book-detail-table tbody');
  tbody.innerHTML = '';
  /* detail filter：topic / chapter / content */
  const fTopic = $('#df-topic').value.trim().toLowerCase();
  const fChap = $('#df-chapter').value.trim().toLowerCase();
  const fCont = $('#df-content').value.trim().toLowerCase();
  const hasFilter = !!(fTopic || fChap || fCont);
  detailRows.forEach((r, i) => {
    const mT = !fTopic || (r.topic || '').toLowerCase().includes(fTopic);
    const mC = !fChap || (r.chapter || '').toLowerCase().includes(fChap);
    const mCo = !fCont || (r.content || '').toLowerCase().includes(fCont);
    if (hasFilter && !(mT && mC && mCo)) return;   /* 唔匹配 → 隱藏 */
    const tr = document.createElement('tr');

    /* Topic cell：正常 = textarea + chapter/page inputs；filter 檢視 = mark 高亮（撳入彈全屏） */
    const topicTd = document.createElement('td');
    if (hasFilter) {
      const tv = document.createElement('div');
      tv.className = 'topic-view';
      tv.innerHTML =
        '<div class="topic-view-main">' + hl(r.topic, fTopic) + '</div>' +
        '<div class="meta-pair">' +
          '<span class="meta-chip">' + hl(r.chapter, fChap) + '</span>' +
          '<span class="meta-chip">頁 ' + esc(r.page) + '</span>' +
        '</div>';
      tv.title = '撳入去編輯';
      tv.addEventListener('click', () => openFullEdit({ row: r, key: 'topic' }));
      topicTd.appendChild(tv);
    } else {
      const tc = document.createElement('div');
      tc.className = 'topic-cell';
      const tInput = document.createElement('textarea');
      tInput.value = r.topic || '';
      tInput.placeholder = '主題';
      tInput.className = 'topic-input';
      tInput.rows = 1;
      tInput.addEventListener('input', () => { r.topic = tInput.value; autosize(tInput); markDetailDirty(); });
      const mp = document.createElement('div');
      mp.className = 'meta-pair';
      const ch = document.createElement('input');
      ch.value = r.chapter || '';
      ch.placeholder = '章節';
      ch.className = 'meta-input';
      ch.addEventListener('input', () => { r.chapter = ch.value; markDetailDirty(); });
      const pg = document.createElement('input');
      pg.value = r.page || '';
      pg.placeholder = '頁碼';
      pg.className = 'meta-input page-input';
      pg.addEventListener('input', () => { r.page = pg.value; markDetailDirty(); });
      mp.appendChild(ch);
      mp.appendChild(pg);
      tc.appendChild(tInput);
      tc.appendChild(mp);
      topicTd.appendChild(tc);
    }
    tr.appendChild(topicTd);

    /* Content cell：正常 = textarea；filter 檢視 = mark 高亮（撳入彈全屏） */
    const contentTd = document.createElement('td');
    if (hasFilter) {
      const cv = document.createElement('div');
      cv.className = 'content-view';
      cv.innerHTML = hl(r.content, fCont);
      cv.title = '撳入去編輯';
      cv.addEventListener('click', () => openFullEdit({ row: r, key: 'content' }));
      contentTd.appendChild(cv);
    } else {
      const cw = document.createElement('textarea');
      cw.value = r.content || '';
      cw.placeholder = '正文';
      cw.className = 'content-text';   /* 撳入去彈全屏編輯 */
      cw.dataset.rid = r.id;           /* 全屏編輯「完成」時同步返 row */
      cw.addEventListener('input', () => { r.content = cw.value; autosize(cw); markDetailDirty(); });
      contentTd.appendChild(cw);
    }
    tr.appendChild(contentTd);

    const act = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn danger small';
    del.textContent = '✕';
    del.title = '刪除呢行';
    del.onclick = () => {
      if (!confirm('確定刪除呢行（未儲存）？')) return;
      const idx = detailRows.findIndex(x => x.id === r.id);
      if (idx >= 0) detailRows.splice(idx, 1);
      markDetailDirty();
      renderDetailRows();
    };
    act.appendChild(del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('textarea').forEach(autosize);
  if (!hasFilter && !detailRows.length) tbody.innerHTML = '<tr><td colspan="3" class="hint" style="text-align:center">呢本書未有內容。</td></tr>';
  if (hasFilter && !tbody.querySelectorAll('tr').length) tbody.innerHTML = '<tr><td colspan="3" class="hint" style="text-align:center">冇相符嘅內容，調整篩選條件。</td></tr>';
  /* 篩選模式唔顯示「手動新增一行」（新 row 會畀 filter 隱藏，容易誤會） */
  const addBtn = $('#btn-detail-add-row');
  if (addBtn) addBtn.style.display = hasFilter ? 'none' : '';
}

/* 喺表格最底手動加一 row（空，供手動輸入） */
function addDetailRow() {
  if (!detailFile) return;
  detailRows.push({ id: uid(), topic: '', content: '', chapter: '', page: '' });
  markDetailDirty();
  renderDetailRows();
  const rows = $('#book-detail-table tbody tr');
  if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveDetail() {
  if (!detailFile) return;
  setBusy(true);
  try {
    const raw = await getFileContent(detailFile);
    const book = (raw && raw.content) ? JSON.parse(raw.content) : {};
    book.rows = detailRows
      .filter(r => (r.topic && r.topic.trim()) || (r.content && r.content.trim()))
      .map(r => ({ topic: (r.topic || '').trim(), content: (r.content || '').trim(), chapter: (r.chapter || '').trim(), page: (r.page || '').trim() }));
    await writeFile(detailFile, JSON.stringify(book, null, 2), `Update book content in ${detailFile}`);
    await writeFile(csvPathFor(detailFile), buildBookCSV(book, book.book_title, book.author), `Sync CSV for ${csvPathFor(detailFile)}`);
    detailDirty = false;
    toast('已儲存 ' + detailFile + '（' + book.rows.length + ' 條）', 'success');
    refreshLibrary();
  } catch (e) {
    toast('儲存失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* =========================================================
 * 設定頁
 * ========================================================= */
const SETTING_MAP = {
  owner: 'github_owner', repo: 'github_repo', branch: 'github_branch',
  'gh-token': 'github_token', model: 'ai_model', 'base-url': 'base_url', 'api-key': 'api_key',
  'title-model': 'title_model', 'title-api-key': 'title_api_key'
};

function bindSettingsForm() {
  Object.entries(SETTING_MAP).forEach(([id, key]) => {
    const el = $('#set-' + id);
    if (el) el.value = settings[key] ?? '';
  });
}

function saveGitSettings() {
  settings.github_owner = $('#set-owner').value.trim();
  settings.github_repo = $('#set-repo').value.trim();
  settings.github_branch = $('#set-branch').value.trim() || 'main';
  settings.github_token = $('#set-gh-token').value.trim();
  saveLocalSettings();
  const msg = 'Git 設定已儲存（只存喺本機瀏覽器 localStorage，唔會寫入 repo）';
  $('#test-result-gh').textContent = msg;
  $('#test-result-gh').className = 'status success';
  toast(msg, 'success');
  renderStatusCheck();
}

function saveTitleSettings() {
  settings.title_model = $('#set-title-model').value.trim() || DEFAULT_SETTINGS.title_model;
  settings.title_api_key = $('#set-title-api-key').value.trim();
  saveLocalSettings();
  const msg = '認書名設定已儲存（唔填 API Key 就自動用「認書內容」嗰組）';
  $('#test-result-title').textContent = msg;
  $('#test-result-title').className = 'status success';
  toast(msg, 'success');
  renderStatusCheck();
}

function saveContentSettings() {
  settings.ai_model = $('#set-model').value.trim() || DEFAULT_SETTINGS.ai_model;
  settings.base_url = $('#set-base-url').value.trim() || DEFAULT_SETTINGS.base_url;
  settings.api_key = $('#set-api-key').value.trim();
  saveLocalSettings();
  const msg = '認書內容設定已儲存';
  $('#test-result-ai').textContent = msg;
  $('#test-result-ai').className = 'status success';
  toast(msg, 'success');
  renderStatusCheck();
}

/* =========================================================
 * 狀態檢查 & 連線測試
 * ========================================================= */
function maskKey(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 4) return '****';
  return '...' + s.slice(-4);
}

function renderStatusCheck() {
  const set = (id, text, ok) => {
    const el = $('#' + id);
    if (!el) return;
    el.textContent = text;
    el.className = 'st-value ' + (ok ? 'ok' : 'no');
  };
  set('st-gh-token', settings.github_token ? '✓ 已設定（尾4位：' + maskKey(settings.github_token) + '）' : '✗ 未設定', !!settings.github_token);
  set('st-gh-repo', (settings.github_owner && settings.github_repo) ? '✓ ' + settings.github_owner + ' / ' + settings.github_repo : '✗ 未設定', !!(settings.github_owner && settings.github_repo));
  set('st-api-key', settings.api_key ? '✓ 已設定（尾4位：' + maskKey(settings.api_key) + '）' : '✗ 未設定', !!settings.api_key);
  set('st-model', settings.ai_model || '—', !!settings.ai_model);
  set('st-title-api-key', settings.title_api_key ? '✓ 已設定（尾4位：' + maskKey(settings.title_api_key) + '）' : '（未設，用一般 API Key）', !!settings.title_api_key);
  set('st-title-model', settings.title_model || '—', !!settings.title_model);
  set('st-base-url', settings.base_url || '—', !!settings.base_url);
}

function setTestResult(text, type, id) {
  const out = $('#' + (id || 'test-result-ai'));
  if (!out) return;
  out.textContent = text;
  out.className = 'status' + (type ? ' ' + type : '');
}

/* 測試 AI API（讀內容）：發一個極短請求驗證 key + 模型 + base URL */
async function testAI() {
  if (!settings.api_key) { setTestResult('❌ 未設定 API Key，請先喺「認書內容設定」填寫', 'error', 'test-result-ai'); return; }
  if (!settings.ai_model) { setTestResult('❌ 未設定 AI Model', 'error', 'test-result-ai'); return; }
  setTestResult('⏳ 測試中，請稍候...', '', 'test-result-ai');
  setBusy(true);
  try {
    const url = settings.base_url.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.api_key,
        'HTTP-Referer': 'https://github.com/' + settings.github_owner + '/' + settings.github_repo,
        'X-Title': 'OCR eBooks'
      },
      body: JSON.stringify({ model: settings.ai_model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); msg = (e.error && (e.error.message || JSON.stringify(e.error))) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    setTestResult('✅ API Key 有效！模型「' + settings.ai_model + '」回應：' + (reply.trim() ? reply.trim() : '(空)'), 'success', 'test-result-ai');
  } catch (e) {
    setTestResult('❌ AI 測試失敗：' + e.message, 'error', 'test-result-ai');
  } finally {
    setBusy(false);
  }
}

/* 測試書名 AI（認書名）：用書名專用 key/model（未設則 fallback 一般） */
async function testTitleAI() {
  const k = settings.title_api_key || settings.api_key;
  const m = settings.title_model || settings.ai_model;
  if (!k) { setTestResult('❌ 未設定 API Key（書名專用或一般都得）', 'error', 'test-result-title'); return; }
  if (!m) { setTestResult('❌ 未設定 AI Model', 'error', 'test-result-title'); return; }
  setTestResult('⏳ 測試中（用「' + m + '」），請稍候...', '', 'test-result-title');
  setBusy(true);
  try {
    const url = settings.base_url.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + k,
        'HTTP-Referer': 'https://github.com/' + settings.github_owner + '/' + settings.github_repo,
        'X-Title': 'OCR eBooks'
      },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const e = await res.json(); msg = (e.error && (e.error.message || JSON.stringify(e.error))) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    setTestResult('✅ 書名 AI 有效！模型「' + m + '」回應：' + (reply.trim() ? reply.trim() : '(空)'), 'success', 'test-result-title');
  } catch (e) {
    setTestResult('❌ 書名 AI 測試失敗：' + e.message, 'error', 'test-result-title');
  } finally {
    setBusy(false);
  }
}

/* 測試 GitHub：驗證 token 有效 + repo 可訪問 */
async function testGitHub() {
  if (!settings.github_token) { setTestResult('❌ 未設定 GitHub Token', 'error', 'test-result-gh'); return; }
  if (!settings.github_owner || !settings.github_repo) { setTestResult('❌ 未設定 GitHub Owner / Repo', 'error', 'test-result-gh'); return; }
  setTestResult('⏳ 測試中，請稍候...', '', 'test-result-gh');
  setBusy(true);
  try {
    const repo = await gh(repoBase());
    const listing = await gh(repoBase() + '/contents/?ref=' + encodeURIComponent(settings.github_branch));
    const n = Array.isArray(listing) ? listing.length : 0;
    setTestResult('✅ GitHub Token 有效，repo「' + settings.github_owner + '/' + settings.github_repo + '」可訪問（' + (repo.default_branch ? 'default branch: ' + repo.default_branch + '，' : '') + '根目錄 ' + n + ' 個項目）', 'success', 'test-result-gh');
  } catch (e) {
    let hint = '';
    if (e.status === 401 || String(e.message).includes('Bad credentials')) hint = '（Token 無效或已過期）';
    else if (e.status === 403) hint = '（權限不足，需要 Contents 讀寫權限）';
    else if (e.status === 404) hint = '（repo 唔存在，或 token 睇唔到佢）';
    setTestResult('❌ GitHub 測試失敗：' + e.message + hint, 'error', 'test-result-gh');
  } finally {
    setBusy(false);
  }
}

/* =========================================================
 * 書名辨識（封面 / 書名頁）
 * ========================================================= */
async function addBookImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const url = await readFileAsDataURL(file);
    setBusy(true);
    toast('🤖 認書名及作者中...');
    const aiUrl = await resizeImageDataUrl(url, 1600);   // 縮細先送 AI
    const r = await recognizeBook(aiUrl);
    if (r.book_title) $('#book-title').value = r.book_title;
    if (r.author) $('#book-author').value = r.author;
    toast(r.book_title ? '已自動填入書名及作者，請核對' : 'AI 未能確定書名/作者，可以手動輸入', 'success');
  } catch (e) {
    toast('認書名失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* =========================================================
 * 事件綁定
 * ========================================================= */
function bindEvents() {
  /* Tabs */
  $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  /* 掃描頁：書頁相片 */
  $('#btn-browse').addEventListener('click', () => $('#page-file-input').click());
  $('#btn-camera').addEventListener('click', () => $('#page-camera-input').click());
  $('#btn-page-paste').addEventListener('click', () => pasteFromClipboard('page'));
  $('#page-file-input').addEventListener('change', e => { addPageFiles(e.target.files); e.target.value = ''; });
  $('#page-camera-input').addEventListener('change', e => { addPageFiles(e.target.files); e.target.value = ''; });

  const pageDz = $('#page-dropzone');
  pageDz.addEventListener('dragover', e => { e.preventDefault(); pageDz.classList.add('over'); hoverZone = 'page'; });
  pageDz.addEventListener('dragleave', () => pageDz.classList.remove('over'));
  pageDz.addEventListener('drop', e => {
    e.preventDefault();
    pageDz.classList.remove('over');
    addPageFiles(e.dataTransfer.files);
  });

  /* 掃描頁：書名相片 */
  $('#btn-book-browse').addEventListener('click', () => $('#book-file-input').click());
  $('#btn-book-camera').addEventListener('click', () => $('#book-camera-input').click());
  $('#btn-book-paste').addEventListener('click', () => pasteFromClipboard('book'));
  $('#book-file-input').addEventListener('change', e => { addBookImage(e.target.files[0]); e.target.value = ''; });
  $('#book-camera-input').addEventListener('change', e => { addBookImage(e.target.files[0]); e.target.value = ''; });

  const bookDz = $('#book-dropzone');
  bookDz.addEventListener('dragover', e => { e.preventDefault(); bookDz.classList.add('over'); hoverZone = 'book'; });
  bookDz.addEventListener('dragleave', () => bookDz.classList.remove('over'));
  bookDz.addEventListener('drop', e => {
    e.preventDefault();
    bookDz.classList.remove('over');
    addBookImage(e.dataTransfer.files[0]);
  });
  /* 滑鼠進入書名區（包括 input focus）→ 貼上當封面 */
  bookDz.addEventListener('mouseenter', () => { hoverZone = 'book'; });
  bookDz.addEventListener('mouseleave', () => { hoverZone = 'page'; });
  ['book-title', 'book-author'].forEach(id => {
    $('#' + id).addEventListener('focus', () => { hoverZone = 'book'; });
    $('#' + id).addEventListener('blur', () => { hoverZone = 'page'; });
  });

  /* Clipboard 貼上圖片 */
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          if (hoverZone === 'book') addBookImage(file);
          else if (hoverZone === 'meta') addBookMetaImage(file);
          else addPageFiles([file]);
        }
        e.preventDefault();
        return;
      }
    }
  });

  /* AI 分析 */
  $('#btn-analyze').addEventListener('click', runAnalysis);

  /* 現有檔案 popup */
  $('#btn-pick-existing').addEventListener('click', openFilePicker);
  $('#file-picker-close').addEventListener('click', closeFilePicker);
  $('#file-picker-modal').addEventListener('click', e => { if (e.target === $('#file-picker-modal')) closeFilePicker(); });
  ['fp-filter-file', 'fp-filter-title', 'fp-filter-author'].forEach(id => {
    $('#' + id).addEventListener('input', renderFilePicker);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#file-picker-modal').classList.contains('hidden')) closeFilePicker(); });

  /* 書庫 */
  $('#lib-filter').addEventListener('input', refreshLibrary);
  $('#btn-detail-save').addEventListener('click', saveDetail);
  $('#btn-detail-add-row').addEventListener('click', addDetailRow);
  $('#btn-detail-back').addEventListener('click', () => {
    if (detailDirty && !confirm('有未儲存嘅修改，確定捨棄？')) return;
    $('#book-detail-card').classList.add('hidden');
    detailFile = null;
    detailDirty = false;
    refreshLibrary();
    window.scrollTo({ top: 0 });
  });
  ['df-topic', 'df-chapter', 'df-content'].forEach(id => {
    $('#' + id).addEventListener('input', renderDetailRows);
  });
  $('#btn-clear-detail-filters').addEventListener('click', () => {
    $('#df-topic').value = ''; $('#df-chapter').value = ''; $('#df-content').value = '';
    renderDetailRows();
  });

  /* 書庫：編輯書名 / 作者 popup */
  $('#book-meta-close').addEventListener('click', closeBookMetaPopup);
  $('#btn-book-meta-cancel').addEventListener('click', closeBookMetaPopup);
  $('#btn-book-meta-save').addEventListener('click', saveBookMeta);
  $('#btn-book-meta-camera').addEventListener('click', () => $('#book-meta-camera-input').click());
  $('#btn-book-meta-browse').addEventListener('click', () => $('#book-meta-file-input').click());
  $('#btn-book-meta-paste').addEventListener('click', () => pasteFromClipboard('meta'));
  $('#book-meta-file-input').addEventListener('change', e => { addBookMetaImage(e.target.files[0]); e.target.value = ''; });
  $('#book-meta-camera-input').addEventListener('change', e => { addBookMetaImage(e.target.files[0]); e.target.value = ''; });
  const bmDz = $('#book-meta-dropzone');
  bmDz.addEventListener('dragover', e => { e.preventDefault(); bmDz.classList.add('over'); hoverZone = 'meta'; });
  bmDz.addEventListener('dragleave', () => bmDz.classList.remove('over'));
  bmDz.addEventListener('drop', e => {
    e.preventDefault();
    bmDz.classList.remove('over');
    addBookMetaImage(e.dataTransfer.files[0]);
  });
  bmDz.addEventListener('mouseenter', () => { hoverZone = 'meta'; });
  bmDz.addEventListener('mouseleave', () => { hoverZone = 'page'; });
  ['book-meta-title', 'book-meta-author'].forEach(id => {
    $('#' + id).addEventListener('focus', () => { hoverZone = 'meta'; });
    $('#' + id).addEventListener('blur', () => { hoverZone = 'page'; });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#book-meta-modal').classList.contains('hidden')) closeBookMetaPopup();
  });

  /* 設定 */
  $('#btn-save-git').addEventListener('click', saveGitSettings);
  $('#btn-save-title').addEventListener('click', saveTitleSettings);
  $('#btn-save-content').addEventListener('click', saveContentSettings);
  $('#btn-test-ai').addEventListener('click', testAI);
  $('#btn-test-title-ai').addEventListener('click', testTitleAI);
  $('#btn-test-gh').addEventListener('click', testGitHub);
}

/* =========================================================
 * 初始化
 * ========================================================= */
async function init() {
  loadLocalSettings();          /* localStorage 優先 */
  bindEvents();
  bindFullEdit();
  bindSettingsForm();

  /* 讀取 repo 入面嘅 settings.json 做非敏感預設（localStorage 會覆蓋）
   * 注意：github_token / api_key 屬於敏感欄位，永遠唔會由 repo 讀入，
   * 就算有人喺 repo 放咗 key 都一律忽略 —— key 只可以存喺本機 localStorage。 */
  try {
    const raw = await getFileContent('settings.json');
    if (raw && raw.content) {
      const repo = JSON.parse(raw.content);
      const { github_token, api_key, title_api_key, ...safeRepo } = repo;
      settings = { ...DEFAULT_SETTINGS, ...safeRepo };
      loadLocalSettings();      /* 再套 local 覆蓋 */
      bindSettingsForm();
    }
  } catch (e) { /* 離線 / private / 冇 token */ }

  showTab('scan');
  renderResultCards();          /* 掃描頁初始即出一張空卡，唔需 AI 分析就可以手動輸入 */
  renderStatusCheck();
  refreshLibrary();
  renderVersionInfo();
}

/* 顯示版本（最後 push 時間） */
async function renderVersionInfo() {
  const el = $('#ver-info');
  const info = await getLastPushInfo();
  if (!info || !info.date) { el.textContent = ''; el.title = '未能讀取版本'; return; }
  const d = new Date(info.date);
  const pad = n => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  el.textContent = '· v' + local;
  el.title = `最後 push：${local}（${info.sha}）\n${info.msg || ''}\n\n重新載入頁面即可更新到最新版本`;
}

document.addEventListener('DOMContentLoaded', init);
