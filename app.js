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
  $$('.btn').forEach(b => b.disabled = busyCount > 0);
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
    throw new Error(msg);
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
    if (String(e.message).includes('404')) return null;
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

/* 分析一頁書（返回 {topic, content, chapter, page}） */
async function analyzePage(imageDataUrl) {
  return aiComplete([{
    role: 'user',
    content: [
      { type: 'text', text: '你係書籍頁面文字識別助理。請從呢張書本頁面照片中提取以下欄位，只輸出 JSON，唔好加任何其他文字：{"topic":"本頁主題/標題，若無則空字串","content":"頁面正文完整如實轉錄成純文字，保留段落","chapter":"章節名稱，若頁首/頁尾有章節資訊就填，否則空字串","page":"頁碼，若頁首/頁尾有頁碼就填，否則空字串"}' },
      { type: 'image_url', image_url: { url: imageDataUrl } }
    ]
  }]);
}

/* 認書名及作者（返回 {book_title, author}） */
async function recognizeBook(imageDataUrl) {
  return aiComplete([{
    role: 'user',
    content: [
      { type: 'text', text: '你係書籍封面識別助理。請根據呢張書籍封面/書名頁照片識別書名及作者，只輸出 JSON：{"book_title":"書名","author":"作者"}。如果無法確定就留空字串，唔好加任何其他文字。' },
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
  renderResults();
  const prog = $('#progress');
  prog.classList.remove('hidden');
  setBusy(true);
  try {
    for (let i = 0; i < pageImages.length; i++) {
      prog.textContent = `🤖 分析緊第 ${i + 1} / ${pageImages.length} 張...`;
      try {
        const r = await analyzePage(pageImages[i].url);
        results.push({
          id: uid(),
          topic: r.topic || '',
          content: r.content || '',
          chapter: r.chapter || '',
          page: r.page || ''
        });
      } catch (e) {
        results.push({ id: uid(), topic: '', content: `⚠️ 分析失敗：${e.message}`, chapter: '', page: '' });
        toast('第 ' + (i + 1) + ' 張分析失敗：' + e.message, 'error');
      }
      renderResults();
    }
    prog.textContent = '✅ 分析完成，請核對以下結果（可直接編輯），再撳「確認並儲存」。';
    toast('分析完成');
  } finally {
    setBusy(false);
  }
}

function renderResults() {
  const tbody = $('#result-table tbody');
  tbody.innerHTML = '';
  results.forEach((r, i) => {
    const tr = document.createElement('tr');
    const mk = (tag, key, ph) => {
      const td = document.createElement('td');
      const el = document.createElement(tag);
      el.value = r[key] || '';
      el.placeholder = ph || '';
      el.addEventListener('input', () => { r[key] = el.value; });
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
      const idx = results.findIndex(x => x.id === r.id);
      if (idx >= 0) results.splice(idx, 1);
      renderResults();
    };
    act.appendChild(del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });
  if (!results.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint" style="text-align:center">未有任何結果。加入書頁相片後撳「🤖 AI 分析」。</td></tr>';
  }
}

/* =========================================================
 * 現有檔案 dropdown
 * ========================================================= */
async function refreshExistingFiles() {
  const sel = $('#file-existing');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 新檔案 —</option>';
  try {
    const files = await listJsonFiles();
    files.forEach(f => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      sel.appendChild(o);
    });
    if (prev && files.includes(prev)) sel.value = prev;
  } catch (e) { /* 未有 token 或 network 問題 */ }
}

async function onExistingFileChange() {
  const v = $('#file-existing').value;
  if (!v) return;
  $('#file-name').value = v;
  try {
    const raw = await getFileContent(v);
    if (raw && raw.content) {
      const b = JSON.parse(raw.content);
      if (b.book_title && !$('#book-title').value.trim()) $('#book-title').value = b.book_title;
      if (b.author && !$('#book-author').value.trim()) $('#book-author').value = b.author;
      toast(`已選擇 ${v}，新內容會 append 喺後面（現有 ${(b.rows || []).length} 條）`);
    }
  } catch (e) { toast('讀取 ' + v + ' 失敗：' + e.message, 'error'); }
}

/* =========================================================
 * 儲存書內容（xxxx.json + books.json）
 * ========================================================= */
async function saveBook() {
  const bookTitle = $('#book-title').value.trim();
  const author = $('#book-author').value.trim();
  let fileName = $('#file-name').value.trim();
  const existing = $('#file-existing').value;
  if (!fileName && existing) fileName = existing;
  if (!fileName) { toast('請輸入儲存檔名（xxxx.json）', 'warn'); return; }
  if (!/\.json$/i.test(fileName)) fileName += '.json';

  const rows = results
    .filter(r => (r.topic && r.topic.trim()) || (r.content && r.content.trim()))
    .map(r => ({ topic: (r.topic || '').trim(), content: (r.content || '').trim(), chapter: (r.chapter || '').trim(), page: (r.page || '').trim() }));
  if (!rows.length) { toast('冇可儲存嘅資料（至少要有 topic 或 content）', 'warn'); return; }

  setBusy(true);
  try {
    const existingData = await getFileContent(fileName);
    let book;
    if (existingData && existingData.content) {
      try { book = JSON.parse(existingData.content); } catch (e) { book = { rows: [] }; }
      book.book_title = bookTitle || book.book_title || '';
      book.author = author || book.author || '';
      book.rows = (Array.isArray(book.rows) ? book.rows : []).concat(rows);
    } else {
      book = { book_title: bookTitle, author, rows };
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
    await refreshExistingFiles();
    toast('已儲存到 ' + fileName + '（共 ' + book.rows.length + ' 條）', 'success');
  } catch (e) {
    toast('儲存失敗：' + e.message, 'error');
  } finally {
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
      el.addEventListener('input', () => { r[key] = el.value; });
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

  /* AI 分析 / 儲存 / 清空 */
  $('#btn-analyze').addEventListener('click', runAnalysis);
  $('#btn-save').addEventListener('click', saveBook);
  $('#btn-clear').addEventListener('click', () => { results.length = 0; renderResults(); toast('已清空結果'); });
  $('#btn-clear-photos').addEventListener('click', () => { pageImages.length = 0; renderThumbs(); toast('已清除相片（記憶體內）'); });

  /* 檔案名 / 現有檔案 */
  $('#file-existing').addEventListener('change', onExistingFileChange);

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
  refreshExistingFiles();
  refreshLibrary();
}

document.addEventListener('DOMContentLoaded', init);
