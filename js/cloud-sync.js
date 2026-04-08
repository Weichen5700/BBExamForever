/**
 * cloud-sync.js — 雲端同步模組
 *
 * 使用方式：頁面載入完成後呼叫 CloudSync.init()
 * 會自動：
 *   - 攔截 localStorage 寫入，標記 dirty
 *   - 切換到背景或關閉頁面時自動 push
 *   - 頁面載入時自動 pull（若已設定 token 且 API 可用）
 *
 * API 位址解析順序：
 *   1. 畫面儲存的 API URL
 *   2. js/cloud-sync-config.js 的 window.CLOUD_SYNC_CONFIG.apiBaseUrl
 *   3. 同網域部署時的 location.origin
 *
 * 公開 API:
 *   CloudSync.init()          初始化
 *   CloudSync.pull()          從雲端拉取
 *   CloudSync.push()          推送到雲端
 *   CloudSync.sync()          先 pull 再 push
 *   CloudSync.isConnected()   是否已設定連線
 *   CloudSync.renderUI(containerId)  渲染設定介面
 */

const CloudSync = (() => {
  const STORAGE_PREFIX = '_cs_';
  const TOKEN_STORAGE_KEY = STORAGE_PREFIX + 'token';
  const API_URL_STORAGE_KEY = STORAGE_PREFIX + 'apiUrl';
  const DEBOUNCE_MS = 10_000;

  let apiUrl = '';
  let token = '';
  let dirty = false;
  let syncing = false;
  let pushTimer = null;

  function notifyStatusChange() {
    window.dispatchEvent(
      new CustomEvent('cloudsync:status', {
        detail: {
          apiUrl,
          hasApiUrl: hasApiUrl(),
          connected: isConnected(),
        },
      })
    );
  }

  function trimTrailingSlashes(value) {
    return (value || '').trim().replace(/\/+$/, '');
  }

  function canUseSameOrigin() {
    if (!['http:', 'https:'].includes(location.protocol)) return false;
    if (/\.github\.io$/i.test(location.hostname)) return false;
    return true;
  }

  function getConfiguredApiUrl() {
    const configuredUrl =
      window.CLOUD_SYNC_CONFIG?.apiBaseUrl || window.CLOUD_SYNC_API_BASE_URL || '';
    return trimTrailingSlashes(configuredUrl);
  }

  // ---- 加密工具 (AES-GCM) ----
  async function deriveKey() {
    const raw = navigator.userAgent + '|exam-tool-2026';
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(raw)
    );
    return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function encrypt(plaintext) {
    if (!plaintext) return '';
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    const buffer = new Uint8Array(iv.length + ciphertext.byteLength);
    buffer.set(iv, 0);
    buffer.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...buffer));
  }

  async function decrypt(b64) {
    if (!b64) return '';
    try {
      const key = await deriveKey();
      const buffer = Uint8Array.from(atob(b64), char => char.charCodeAt(0));
      const iv = buffer.slice(0, 12);
      const ciphertext = buffer.slice(12);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return '';
    }
  }

  // ---- 不同步的 key ----
  function isInternalKey(key) {
    return String(key || '').startsWith(STORAGE_PREFIX);
  }

  async function resolveApiUrl() {
    const savedValue = localStorage.getItem(API_URL_STORAGE_KEY) || '';
    if (savedValue) {
      return trimTrailingSlashes(await decrypt(savedValue));
    }

    const configured = getConfiguredApiUrl();
    if (configured) return configured;
    if (canUseSameOrigin()) return trimTrailingSlashes(location.origin);
    return '';
  }

  // ---- 讀取設定 ----
  async function loadConfig() {
    apiUrl = await resolveApiUrl();
    token = await decrypt(localStorage.getItem(TOKEN_STORAGE_KEY) || '');
  }

  async function saveConfig() {
    if (apiUrl) {
      localStorage.setItem(API_URL_STORAGE_KEY, await encrypt(apiUrl));
    } else {
      localStorage.removeItem(API_URL_STORAGE_KEY);
    }

    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, await encrypt(token));
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    notifyStatusChange();
  }

  async function clearToken() {
    token = '';
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    notifyStatusChange();
  }

  function hasApiUrl() {
    return !!apiUrl;
  }

  function isConnected() {
    return !!(apiUrl && token);
  }

  function getApiEndpointLabel() {
    if (!apiUrl) return '未設定';
    try {
      return new URL(apiUrl).host;
    } catch {
      return apiUrl;
    }
  }

  // ---- 收集 localStorage 資料 ----
  function collectData() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!isInternalKey(key)) {
        data[key] = localStorage.getItem(key);
      }
    }
    data._ts = Date.now();
    return data;
  }

  // ---- API 呼叫 ----
  async function apiFetch(method, body) {
    if (!hasApiUrl()) throw new Error('尚未設定同步 API 位址');
    if (!token) throw new Error('請先填寫 API Token');

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${apiUrl}/sync`, options);
    } catch {
      throw new Error('無法連線到同步 API');
    }

    if (response.status === 401) throw new Error('API Token 無效');
    if (response.status === 404) throw new Error('找不到 /sync，同步 API 尚未部署');
    if (!response.ok) throw new Error(`同步失敗 (${response.status})`);

    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('同步 API 回傳非 JSON，請確認 API 位址');
    }

    return response.json();
  }

  async function request(path, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      formData,
      requireAuth = true,
    } = options;

    if (!hasApiUrl()) throw new Error('尚未設定同步 API 位址');
    if (requireAuth && !token) throw new Error('請先填寫 API Token');

    const finalHeaders = new Headers(headers);
    if (requireAuth) {
      finalHeaders.set('Authorization', `Bearer ${token}`);
    }

    const requestOptions = { method, headers: finalHeaders };

    if (formData) {
      requestOptions.body = formData;
    } else if (body !== undefined) {
      if (!finalHeaders.has('Content-Type')) {
        finalHeaders.set('Content-Type', 'application/json');
      }
      requestOptions.body =
        typeof body === 'string' ? body : JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${apiUrl}${path}`, requestOptions);
    } catch {
      throw new Error('無法連線到同步 API');
    }

    if (response.status === 401) throw new Error('API Token 無效');
    if (response.status === 404) throw new Error(`找不到 ${path}`);
    if (!response.ok) {
      let message = `請求失敗 (${response.status})`;
      try {
        const payload = await response.clone().json();
        if (payload?.error) {
          message = payload.error;
        }
      } catch {}
      throw new Error(message);
    }

    return response;
  }

  async function requestJson(path, options = {}) {
    const response = await request(path, options);
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('同步 API 回傳非 JSON');
    }
    return response.json();
  }

  // ---- Pull: 雲端 → localStorage ----
  async function pull() {
    if (!isConnected()) return;

    const data = await apiFetch('GET');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    const { _ts, ...rest } = data;
    const remoteKeys = new Set(Object.keys(rest));
    const hasRemoteSnapshot = remoteKeys.size > 0 || (Number(_ts) || 0) > 0;

    if (!hasRemoteSnapshot) {
      return data;
    }

    const keysToDelete = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!isInternalKey(key) && !remoteKeys.has(key)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => {
      _origRemoveItem.call(localStorage, key);
    });

    for (const [key, value] of Object.entries(rest)) {
      if (!isInternalKey(key)) {
        _origSetItem.call(localStorage, key, value);
      }
    }

    return data;
  }

  // ---- Push: localStorage → 雲端 ----
  async function push() {
    if (!isConnected() || syncing) return;
    syncing = true;
    try {
      await apiFetch('PUT', collectData());
      dirty = false;
    } finally {
      syncing = false;
    }
  }

  // ---- Sync: pull 再 push ----
  async function sync() {
    if (!isConnected() || syncing) return;
    syncing = true;
    try {
      await pull();
      await apiFetch('PUT', collectData());
      dirty = false;
    } finally {
      syncing = false;
    }
  }

  // ---- 攔截 localStorage.setItem / removeItem ----
  const _origSetItem = localStorage.setItem;
  const _origRemoveItem = localStorage.removeItem;

  function patchLocalStorage() {
    localStorage.setItem = function (key, value) {
      _origSetItem.call(localStorage, key, value);
      if (!isInternalKey(key) && isConnected()) {
        dirty = true;
        schedulePush();
      }
    };

    localStorage.removeItem = function (key) {
      _origRemoveItem.call(localStorage, key);
      if (!isInternalKey(key) && isConnected()) {
        dirty = true;
        schedulePush();
      }
    };
  }

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      if (dirty) push().catch(console.error);
    }, DEBOUNCE_MS);
  }

  // ---- 頁面事件 ----
  function bindEvents() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && dirty && isConnected()) {
        push().catch(console.error);
      }
    });

    window.addEventListener('beforeunload', () => {
      if (!dirty || !isConnected()) return;
      fetch(`${apiUrl}/sync`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(collectData()),
        keepalive: true,
      }).catch(() => {});
    });
  }

  // ---- UI 渲染 ----
  function renderUI(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    function rerenderQuestionIfPossible() {
      if (typeof renderQuestion === 'function') {
        renderQuestion();
      }
    }

    function getPreferredUrlForDisplay() {
      return apiUrl || getConfiguredApiUrl() || (canUseSameOrigin() ? trimTrailingSlashes(location.origin) : '');
    }

    const SQL_INIT = `CREATE TABLE IF NOT EXISTS sync_entries (
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
);`;

    function renderBeginnerGuide() {
      const sqlDisplay = SQL_INIT.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <details style="margin-top:0.65rem; border:1px solid #dbeafe; border-radius:0.6rem; background:#f8fbff; padding:0.55rem 0.7rem;" ${isConnected() ? '' : 'open'}>
          <summary style="cursor:pointer; font-weight:700; color:#1d4ed8;">☁️ 初次設定教學（全程在 Cloudflare 網頁介面完成，不需安裝任何工具）</summary>
          <div style="margin-top:0.6rem; display:flex; flex-direction:column; gap:0.6rem; font-size:0.83rem; color:#334155;">
            <div style="padding:0.5rem 0.65rem; border-left:4px solid #f59e0b; background:#fffbeb; border-radius:0.4rem; font-size:0.8rem;">
              <strong>API URL</strong> = 你部署的 Worker 網址 &nbsp;｜&nbsp; <strong>Token</strong> = 你在 Worker 自訂的 <code>API_TOKEN</code> 密碼<br>
              與 Cloudflare 帳號密碼或 Global API Key <strong>無關</strong>。
            </div>
            <div style="padding:0.5rem 0.65rem; border:1px solid #e2e8f0; border-radius:0.4rem; background:#fff;">
              <div style="font-weight:700; color:#1e40af; margin-bottom:0.35rem;">Step 1 ── 建立 D1 資料庫</div>
              <ol style="margin:0; padding-left:1.1rem; line-height:1.8;">
                <li>登入 <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener" style="color:#2563eb;">Cloudflare Dashboard</a></li>
                <li>左側 → <strong>Storage &amp; Databases → D1 → Create database</strong></li>
                <li>名稱填 <code>exam-sync-db</code>，點 Create</li>
                <li>進入資料庫 → 索引標籤切到 <strong>Console</strong></li>
                <li>點下方「複製 SQL」按鈕 → 貼入 Console → 按 <strong>Execute</strong></li>
              </ol>
              <pre id="_cs_sqlPre" style="margin-top:0.4rem; font-size:0.72rem; background:#f1f5f9; padding:0.4rem 0.5rem; border-radius:0.35rem; overflow:auto; max-height:7rem; white-space:pre; line-height:1.5;">${sqlDisplay}</pre>
              <button id="_cs_copySqlBtn" style="margin-top:0.3rem; padding:0.2rem 0.65rem; font-size:0.78rem; border:1px solid #2563eb; background:#eff6ff; color:#1d4ed8; border-radius:0.35rem; cursor:pointer;">複製 SQL</button>
            </div>
            <div style="padding:0.5rem 0.65rem; border:1px solid #e2e8f0; border-radius:0.4rem; background:#fff;">
              <div style="font-weight:700; color:#1e40af; margin-bottom:0.35rem;">Step 2 ── 建立 Worker 並貼上程式碼</div>
              <ol style="margin:0; padding-left:1.1rem; line-height:1.8;">
                <li>左側 → <strong>Workers &amp; Pages → Create → Create Worker</strong></li>
                <li>名稱填 <code>exam-sync-worker</code>，點 Deploy</li>
                <li>點 <strong>Edit code</strong> 進入線上編輯器</li>
                <li>全選預設程式碼刪除，貼入 <code>worker/src/index.js</code> 的完整內容</li>
                <li>點 <strong>Deploy</strong></li>
              </ol>
            </div>
            <div style="padding:0.5rem 0.65rem; border:1px solid #e2e8f0; border-radius:0.4rem; background:#fff;">
              <div style="font-weight:700; color:#1e40af; margin-bottom:0.35rem;">Step 3 ── 綁定 D1</div>
              <ol style="margin:0; padding-left:1.1rem; line-height:1.8;">
                <li>回到 Worker → <strong>Settings → Bindings → Add → D1 Database</strong></li>
                <li>Variable name = <code>DB</code>，選 <code>exam-sync-db</code></li>
                <li>點 <strong>Deploy</strong> 讓綁定生效</li>
              </ol>
            </div>
            <div style="padding:0.5rem 0.65rem; border:1px solid #e2e8f0; border-radius:0.4rem; background:#fff;">
              <div style="font-weight:700; color:#1e40af; margin-bottom:0.35rem;">Step 4 ── 設定 API Token</div>
              <ol style="margin:0; padding-left:1.1rem; line-height:1.8;">
                <li>Worker → <strong>Settings → Variables and Secrets → Add → Secret</strong></li>
                <li>名稱固定填 <code>API_TOKEN</code></li>
                <li>值請自訂一串長密碼並<strong>記下來</strong>（等一下填入下方 Token 欄位）</li>
                <li>點 <strong>Deploy</strong></li>
              </ol>
            </div>
            <div style="padding:0.5rem 0.65rem; border-left:4px solid #16a34a; background:#f0fdf4; border-radius:0.4rem;">
              <strong>Step 5 ── 填入上方欄位，完成！</strong><br>
              Worker 頁面取得網址（<code>https://exam-sync-worker.xxx.workers.dev</code>）→ 貼到 <strong>API URL</strong><br>
              Step 4 的密碼 → 填到 <strong>Token</strong> → 按「<strong>儲存並測試</strong>」
            </div>
          </div>
        </details>`;
    }

    function bindBeginnerGuideEvents() {
      const btn = document.getElementById('_cs_copySqlBtn');
      if (!btn) return;
      btn.onclick = () => {
        navigator.clipboard.writeText(SQL_INIT).then(() => {
          btn.textContent = '✓ 已複製';
          setTimeout(() => { btn.textContent = '複製 SQL'; }, 2000);
        }).catch(() => {
          const pre = document.getElementById('_cs_sqlPre');
          if (pre) {
            const range = document.createRange();
            range.selectNodeContents(pre);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
          btn.textContent = '請手動選取上方 SQL 複製';
          setTimeout(() => { btn.textContent = '複製 SQL'; }, 3000);
        });
      };
    }

    function renderConfigFields() {
      return `
        <div style="display:flex; flex-direction:column; gap:0.45rem; margin-top:0.4rem;">
          <div style="display:flex; flex-direction:column; gap:0.2rem;">
            <label for="_cs_urlInput" style="font-size:0.8rem; color:#475569; font-weight:600;">API URL</label>
            <input id="_cs_urlInput" class="form-control" type="text"
              placeholder="https://your-worker.your-subdomain.workers.dev"
              style="font-size:0.85rem; padding:0.3rem 0.5rem;">
          </div>
          <div style="display:flex; flex-direction:column; gap:0.2rem;">
            <label for="_cs_tokenInput" style="font-size:0.8rem; color:#475569; font-weight:600;">Token</label>
            <input id="_cs_tokenInput" class="form-control" type="password" placeholder="API_TOKEN"
              style="font-size:0.85rem; padding:0.3rem 0.5rem;">
          </div>
        </div>`;
    }

    function populateConfigFields() {
      const urlInput = document.getElementById('_cs_urlInput');
      const tokenInput = document.getElementById('_cs_tokenInput');
      if (urlInput) urlInput.value = getPreferredUrlForDisplay();
      if (tokenInput) tokenInput.value = token;
    }

    async function saveSettingsFromInput({ syncAfterSave = false } = {}) {
      const status = document.getElementById('_cs_status');
      const urlInput = document.getElementById('_cs_urlInput');
      const tokenInput = document.getElementById('_cs_tokenInput');
      if (!status || !urlInput || !tokenInput) return false;

      const inputUrl = trimTrailingSlashes(urlInput.value);
      const fallbackUrl = getConfiguredApiUrl() || (canUseSameOrigin() ? trimTrailingSlashes(location.origin) : '');
      const nextUrl = inputUrl || fallbackUrl;
      const nextToken = tokenInput.value.trim();
      const previousUrl = apiUrl;
      const previousToken = token;

      if (!nextUrl) {
        status.textContent = '請填寫 API URL';
        return false;
      }

      apiUrl = nextUrl;
      token = nextToken;

      try {
        await saveConfig();
        populateConfigFields();

        if (!token) {
          status.textContent = '✓ 已保存 API URL，請再填 Token';
          return true;
        }

        status.textContent = syncAfterSave ? '測試連線並同步中…' : '測試連線…';
        await apiFetch('GET');
        if (syncAfterSave) {
          await sync();
        }
        status.textContent = syncAfterSave ? '✓ 設定已保存並同步' : '✓ 設定已保存';
        return true;
      } catch (error) {
        apiUrl = previousUrl;
        token = previousToken;
        await saveConfig();
        populateConfigFields();
        status.textContent = '✗ ' + error.message;
        return false;
      }
    }

    function renderConnectedState() {
      container.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.4rem; margin-top:0.4rem;">
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <span style="color:#22c55e; font-weight:600;">✓ 已連線</span>
            <span style="font-size:0.8rem; color:#6b7280;">端點：${getApiEndpointLabel()}</span>
          </div>
          ${renderConfigFields()}
          <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
            <button class="btn btn-secondary" id="_cs_saveSettingsBtn"
              style="padding:0.25rem 0.6rem; font-size:0.85rem;">儲存設定</button>
            <button class="btn btn-primary" id="_cs_syncBtn"
              style="padding:0.25rem 0.6rem; font-size:0.85rem;">同步</button>
            <button class="btn btn-danger" id="_cs_disconnBtn"
              style="padding:0.25rem 0.6rem; font-size:0.85rem;">清除 Token</button>
            <span id="_cs_status" style="font-size:0.8rem; color:#6b7280;"></span>
          </div>
          ${renderBeginnerGuide()}
        </div>`;

      populateConfigFields();

      document.getElementById('_cs_saveSettingsBtn').onclick = async () => {
        await saveSettingsFromInput();
      };

      document.getElementById('_cs_syncBtn').onclick = async () => {
        const status = document.getElementById('_cs_status');
        try {
          const saved = await saveSettingsFromInput();
          if (!saved || !isConnected()) return;
          status.textContent = '同步中…';
          await sync();
          status.textContent = '✓ 同步完成 ' + new Date().toLocaleTimeString();
          rerenderQuestionIfPossible();
        } catch (error) {
          status.textContent = '✗ ' + error.message;
        }
      };

      document.getElementById('_cs_disconnBtn').onclick = async () => {
        await clearToken();
        dirty = false;
        render();
      };
      bindBeginnerGuideEvents();
    }

    function renderDisconnectedState() {
      container.innerHTML = `
        <div style="margin-top:0.4rem; display:flex; flex-direction:column; gap:0.35rem;">
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <span style="color:#b45309; font-weight:600;">尚未完成連線</span>
            <span style="font-size:0.8rem; color:#6b7280;">
              ${hasApiUrl() ? `目前端點：${getApiEndpointLabel()}` : '請先填 API URL 與 Token'}
            </span>
          </div>
          ${renderConfigFields()}
          <div style="display:flex; gap:0.3rem; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-primary" id="_cs_connectBtn"
              style="padding:0.25rem 0.6rem; font-size:0.85rem;">儲存並測試</button>
            <span id="_cs_status" style="font-size:0.8rem; color:#6b7280;"></span>
          </div>
          ${renderBeginnerGuide()}
        </div>`;

      populateConfigFields();

      document.getElementById('_cs_connectBtn').onclick = async () => {
        try {
          const saved = await saveSettingsFromInput({ syncAfterSave: true });
          if (!saved) return;
          render();
          rerenderQuestionIfPossible();
        } catch {}
      };
      bindBeginnerGuideEvents();
    }

    function render() {
      if (isConnected()) {
        renderConnectedState();
      } else {
        renderDisconnectedState();
      }
    }

    render();
  }

  // ---- 初始化 ----
  async function init() {
    await loadConfig();
    patchLocalStorage();
    bindEvents();
    notifyStatusChange();

    if (isConnected()) {
      pull()
        .then(() => {
          if (typeof renderQuestion === 'function') {
            renderQuestion();
          }
        })
        .catch(console.error);
    }
  }

  return {
    init,
    pull,
    push,
    sync,
    isConnected,
    renderUI,
    request,
    requestJson,
    hasApiUrl,
    getApiBaseUrl: () => apiUrl,
  };
})();

// const 宣告不會自動掛到 window，手動補上讓其他 script 能用 window.CloudSync
window.CloudSync = CloudSync;
