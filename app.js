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
  api_key: ''
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
  const res = await fetch('https://api.github.com' + path, { ...opts, headers });
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
    return { content: new TextDecoder('utf-8').decode(bytes), sha: d.sha };
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
  await gh(repoBase() + '/contents/' + encodeURIComponent(path), { method: 'PUT', body: JSON.stringify(payload) });
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

/* 列出 repo 根目錄所有書本 json（唔包 settings.json / books.json） */
async function listJsonFiles() {
  const d = await gh(`${repoBase()}/contents/?ref=${encodeURIComponent(settings.github_branch)}`);
  return (Array.isArray(d) ? d : [])
    .filter(f => f.type === 'file' && /\.json$/i.test(f.name) && f.name !== 'settings.json' && f.name !== 'books.json')
    .map(f => f.name)
    .sort((a, b) => a.localeCompare(b));
}

/* =========================================================
 * AI（OpenRouter 兼容 /chat/completions）
 * ========================================================= */
async function aiComplete(messages, { json = true, maxTokens = 4096 } = {}) {
  if (!settings.api_key) throw new Error('請先喺設定頁輸入 API Key');
  const url = settings.base_url.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: settings.ai_model, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.api_key,
      'HTTP-Referer': 'https://github.com/' + settings.github_owner + '/' + settings.github_repo,
      'X-Title': 'OCR eBooks'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); msg = (e.error && (e.error.message || JSON.stringify(e.error))) || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return extractJSON(text);
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

/* 認書名及作者（返回 {book_title, author}） */
async function recognizeBook(imageDataUrl) {
  return aiComplete([{
    role: 'user',
    content: [
      { type: 'text', text: 'You are a book cover reader. Read ONLY the book title and the author name printed on this cover photo. Rules: (1) book_title = the largest, most prominent text on the cover; it may be written vertically (top-to-bottom) or horizontally — combine the stacked parts into one continuous title with NO spaces between them; (2) author = the short person name (usually 2-4 characters) marked with "著" / "著者" / "by" / "written by", usually printed in a corner of the cover; read each character very carefully because the name may be small and vertical; (3) IGNORE every other cover element: year numbers, dates, publisher names, slogans, blurbs, background decorations and small text; (4) NEVER guess from memory or general knowledge — only read what is actually printed in this photo; (5) if you are not confident about the exact characters of the author name, return an empty string instead of guessing. Return ONLY valid JSON, with no other text: {"book_title":"","author":""}.' },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]
  }]);
}

/* =========================================================
 * 狀態
 * ========================================================= */
const pageImages = [];   // {id, url} 只喺記憶體，唔會儲存
const results = [];      // {id, topic, content, chapter, page}
let detailFile = null;
let detailRows = [];     // {id, topic, content, chapter, page}
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
  renderResultCards();
  setBusy(true);
  try {
    const total = pageImages.length;
    for (let i = 0; i < total; i++) {
      setLoadingText(`🤖 分析緊第 ${i + 1} / ${total} 張...`);
      const img = pageImages[0];   // 永遠處理第一張（處理完即清走）
      try {
        const r = await analyzePage(img.url);
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

/* 辨識結果：每張相一個獨立直排 card（chapter → topic → page → content），各有儲存/捨棄掣 */
function renderResultCards() {
  const wrap = $('#result-cards');
  wrap.innerHTML = '';
  if (!results.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.textAlign = 'center';
    p.textContent = '未有任何結果。加入書頁相片後撳「🤖 AI 分析」。';
    wrap.appendChild(p);
    return;
  }
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
      el.addEventListener('input', () => { r[key] = el.value; if (tag === 'textarea') autosize(el); });
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
      const idx = results.findIndex(x => x.id === r.id);
      if (idx >= 0) results.splice(idx, 1);
      renderResultCards();
    };
    head.appendChild(title);
    head.appendChild(discard);
    card.appendChild(head);

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
    tdFile.textContent = e.file;
    const tdTitle = document.createElement('td');
    tdTitle.textContent = e.book_title || '—';
    const tdAuthor = document.createElement('td');
    tdAuthor.textContent = e.author || '—';
    const tdCount = document.createElement('td');
    tdCount.className = 'row-num';
    tdCount.textContent = e.count != null ? String(e.count) : '—';
    const tdAct = document.createElement('td');
    tdAct.className = 'open-cell';
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = '揀選';
    btn.onclick = () => pickExistingFile(e.file);
    tdAct.appendChild(btn);
    tr.appendChild(tdFile); tr.appendChild(tdTitle); tr.appendChild(tdAuthor); tr.appendChild(tdCount); tr.appendChild(tdAct);
    tbody.appendChild(tr);
  });
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center">冇相符嘅書檔</td></tr>';
  $('#fp-hint').textContent = '共 ' + rows.length + ' 本書檔（揀選後會設定為儲存目標，新內容 append 喺後面）';
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
    tdFile.textContent = b.file;
    const tdTitle = document.createElement('td');
    tdTitle.textContent = b.book_title || '—';
    const tdAuthor = document.createElement('td');
    tdAuthor.textContent = b.author || '—';
    const tdCount = document.createElement('td');
    tdCount.className = 'row-num';
    tdCount.textContent = '—';
    const tdAct = document.createElement('td');
    tdAct.className = 'open-cell';
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = '開啟';
    btn.onclick = () => openBook(b.file);
    tdAct.appendChild(btn);
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

/* Page 排序：先數字後文字 */
function pageSortKey(p) {
  const s = String(p || '');
  const m = s.match(/\d+/);
  return m ? [0, parseInt(m[0], 10), s] : [1, 0, s];
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
  detailRows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const mk = (tag, key, ph) => {
      const td = document.createElement('td');
      const el = document.createElement(tag);
      el.value = r[key] || '';
      el.placeholder = ph || '';
      el.addEventListener('input', () => { r[key] = el.value; if (tag === 'textarea') autosize(el); });
      td.appendChild(el);
      return td;
    };
    const num = document.createElement('td');
    num.className = 'row-num';
    num.textContent = String(i + 1);
    tr.appendChild(num);
    tr.appendChild(mk('input', 'topic', '主題'));
    tr.appendChild(mk('textarea', 'content', '正文'));
    tr.appendChild(mk('input', 'chapter', '章節'));
    tr.appendChild(mk('input', 'page', '頁碼'));
    const act = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'btn danger small';
    del.textContent = '✕';
    del.title = '刪除呢行';
    del.onclick = () => {
      const idx = detailRows.findIndex(x => x.id === r.id);
      if (idx >= 0) detailRows.splice(idx, 1);
      renderDetailRows();
    };
    act.appendChild(del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('textarea').forEach(autosize);
  if (!detailRows.length) tbody.innerHTML = '<tr><td colspan="6" class="hint" style="text-align:center">呢本書未有內容。</td></tr>';
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
  'gh-token': 'github_token', model: 'ai_model', 'base-url': 'base_url', 'api-key': 'api_key'
};

function bindSettingsForm() {
  Object.entries(SETTING_MAP).forEach(([id, key]) => {
    const el = $('#set-' + id);
    if (el) el.value = settings[key] ?? '';
  });
}

function saveSettings() {
  settings.github_owner = $('#set-owner').value.trim();
  settings.github_repo = $('#set-repo').value.trim();
  settings.github_branch = $('#set-branch').value.trim() || 'main';
  settings.github_token = $('#set-gh-token').value.trim();
  settings.ai_model = $('#set-model').value.trim() || DEFAULT_SETTINGS.ai_model;
  settings.base_url = $('#set-base-url').value.trim() || DEFAULT_SETTINGS.base_url;
  settings.api_key = $('#set-api-key').value.trim();
  saveLocalSettings();
  const msg = '設定已儲存（只存喺本機瀏覽器 localStorage，唔會寫入 repo）';
  $('#settings-status').textContent = msg;
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
  set('st-base-url', settings.base_url || '—', !!settings.base_url);
}

function setTestResult(text, type) {
  const out = $('#test-result');
  out.textContent = text;
  out.className = 'status' + (type ? ' ' + type : '');
}

/* 測試 AI API：發一個極短請求驗證 key + 模型 + base URL */
async function testAI() {
  if (!settings.api_key) { setTestResult('❌ 未設定 API Key，請先喺上面填寫', 'error'); return; }
  if (!settings.ai_model) { setTestResult('❌ 未設定 AI Model', 'error'); return; }
  setTestResult('⏳ 測試中，請稍候...');
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
    setTestResult('✅ API Key 有效！模型「' + settings.ai_model + '」回應：' + (reply.trim() ? reply.trim() : '(空)'), 'success');
  } catch (e) {
    setTestResult('❌ AI 測試失敗：' + e.message, 'error');
  } finally {
    setBusy(false);
  }
}

/* 測試 GitHub：驗證 token 有效 + repo 可訪問 */
async function testGitHub() {
  if (!settings.github_token) { setTestResult('❌ 未設定 GitHub Token', 'error'); return; }
  if (!settings.github_owner || !settings.github_repo) { setTestResult('❌ 未設定 GitHub Owner / Repo', 'error'); return; }
  setTestResult('⏳ 測試中，請稍候...');
  setBusy(true);
  try {
    const repo = await gh(repoBase());
    const listing = await gh(repoBase() + '/contents/?ref=' + encodeURIComponent(settings.github_branch));
    const n = Array.isArray(listing) ? listing.length : 0;
    setTestResult('✅ GitHub Token 有效，repo「' + settings.github_owner + '/' + settings.github_repo + '」可訪問（' + (repo.default_branch ? 'default branch: ' + repo.default_branch + '，' : '') + '根目錄 ' + n + ' 個項目）', 'success');
  } catch (e) {
    let hint = '';
    if (e.status === 401 || String(e.message).includes('Bad credentials')) hint = '（Token 無效或已過期）';
    else if (e.status === 403) hint = '（權限不足，需要 Contents 讀寫權限）';
    else if (e.status === 404) hint = '（repo 唔存在，或 token 睇唔到佢）';
    setTestResult('❌ GitHub 測試失敗：' + e.message + hint, 'error');
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
    const r = await recognizeBook(url);
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
  $('#btn-detail-back').addEventListener('click', () => {
    $('#book-detail-card').classList.add('hidden');
    detailFile = null;
    refreshLibrary();
    window.scrollTo({ top: 0 });
  });

  /* 設定 */
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-test-ai').addEventListener('click', testAI);
  $('#btn-test-gh').addEventListener('click', testGitHub);
}

/* =========================================================
 * 初始化
 * ========================================================= */
async function init() {
  loadLocalSettings();          /* localStorage 優先 */
  bindEvents();
  bindSettingsForm();

  /* 讀取 repo 入面嘅 settings.json 做非敏感預設（localStorage 會覆蓋）
   * 注意：github_token / api_key 屬於敏感欄位，永遠唔會由 repo 讀入，
   * 就算有人喺 repo 放咗 key 都一律忽略 —— key 只可以存喺本機 localStorage。 */
  try {
    const raw = await getFileContent('settings.json');
    if (raw && raw.content) {
      const repo = JSON.parse(raw.content);
      const { github_token, api_key, ...safeRepo } = repo;
      settings = { ...DEFAULT_SETTINGS, ...safeRepo };
      loadLocalSettings();      /* 再套 local 覆蓋 */
      bindSettingsForm();
    }
  } catch (e) { /* 離線 / private / 冇 token */ }

  showTab('scan');
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
