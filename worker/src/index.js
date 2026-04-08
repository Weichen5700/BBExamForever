/**
 * exam-sync-worker — Cloudflare Worker 後端
 *
 * 環境變數（Secrets）：
 *   API_TOKEN  — 自行設定的長密碼，前端 Token 欄位填一樣的值
 *
 * Bindings（wrangler.toml）：
 *   DB     — D1 database (exam-sync-db)
 *   IMAGES — R2 bucket  (exam-note-images)
 *
 * API 路由：
 *   GET  /sync                   — 拉取所有 localStorage 快照
 *   PUT  /sync                   — 推送 localStorage 快照
 *   GET  /notes?sourceKey=...    — 讀取某題庫的所有題目筆記
 *   PUT  /notes                  — 儲存單題筆記
 *   POST /note-images            — 上傳題目附圖（FormData）
 *   DELETE /note-images/:id      — 刪除題目附圖
 *   GET  /note-images/serve/:id  — 公開讀取圖片（不需 Token）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 && token === env.API_TOKEN;
}

// ── GET /sync ────────────────────────────────────────────
async function handleSyncGet(env) {
  const { results } = await env.DB.prepare(
    'SELECT key, value, updated_at FROM sync_entries'
  ).all();

  const data = {};
  let maxTs = 0;
  for (const row of results) {
    data[row.key] = row.value;
    if (row.updated_at > maxTs) maxTs = row.updated_at;
  }
  data._ts = maxTs * 1000; // 轉為毫秒，與前端 Date.now() 一致
  return jsonResponse(data);
}

// ── PUT /sync ────────────────────────────────────────────
async function handleSyncPut(request, env) {
  const body = await request.json();
  // eslint-disable-next-line no-unused-vars
  const { _ts, ...rest } = body;

  const entries = Object.entries(rest);
  if (entries.length === 0) return jsonResponse({ ok: true });

  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    'INSERT OR REPLACE INTO sync_entries (key, value, updated_at) VALUES (?, ?, ?)'
  );
  // D1 batch 最多 1000 條，分批處理
  const BATCH = 500;
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = entries.slice(i, i + BATCH);
    await env.DB.batch(chunk.map(([key, value]) => stmt.bind(key, value, now)));
  }

  return jsonResponse({ ok: true });
}

// ── GET /notes?sourceKey=... ─────────────────────────────
async function handleNotesGet(url, env) {
  const sourceKey = url.searchParams.get('sourceKey');
  if (!sourceKey) return jsonResponse({ error: 'sourceKey 為必填' }, 400);

  const [{ results: notes }, { results: images }] = await Promise.all([
    env.DB.prepare(
      'SELECT question_class, question_sn, note_text FROM question_notes WHERE source_key = ?'
    ).bind(sourceKey).all(),
    env.DB.prepare(
      'SELECT id, question_class, question_sn FROM note_images WHERE source_key = ?'
    ).bind(sourceKey).all(),
  ]);

  const workerOrigin = new URL(url.href).origin;
  const notesMap = {};

  for (const note of notes) {
    const key = `${note.question_class}::${note.question_sn}`;
    notesMap[key] = { noteText: note.note_text, images: [] };
  }
  for (const image of images) {
    const key = `${image.question_class}::${image.question_sn}`;
    if (!notesMap[key]) notesMap[key] = { noteText: '', images: [] };
    notesMap[key].images.push({ id: image.id, url: `${workerOrigin}/note-images/serve/${image.id}` });
  }

  return jsonResponse({ notes: notesMap });
}

// ── PUT /notes ───────────────────────────────────────────
async function handleNotesPut(request, env) {
  const { sourceKey, questionClass, questionSn, noteText = '' } = await request.json();

  if (!sourceKey || !questionClass || !questionSn) {
    return jsonResponse({ error: 'sourceKey / questionClass / questionSn 為必填' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO question_notes (source_key, question_class, question_sn, note_text, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_key, question_class, question_sn)
     DO UPDATE SET note_text = excluded.note_text, updated_at = excluded.updated_at`
  ).bind(sourceKey, questionClass, questionSn, noteText, now).run();

  return jsonResponse({ ok: true });
}

// ── 工具：ArrayBuffer → base64 ─────────────────────────
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── POST /note-images ────────────────────────────────────
async function handleNoteImagePost(request, env) {
  const form = await request.formData();
  const sourceKey     = form.get('sourceKey');
  const questionClass = form.get('questionClass');
  const questionSn    = form.get('questionSn');
  const file          = form.get('file');

  if (!sourceKey || !questionClass || !questionSn || !file) {
    return jsonResponse({ error: 'sourceKey / questionClass / questionSn / file 為必填' }, 400);
  }

  const allowedMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mimeType = allowedMime.includes(file.type) ? file.type : 'image/jpeg';

  const buffer = await file.arrayBuffer();
  const imageData = arrayBufferToBase64(buffer);

  const now = Math.floor(Date.now() / 1000);
  const { meta } = await env.DB.prepare(
    `INSERT INTO note_images (source_key, question_class, question_sn, image_data, mime_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sourceKey, questionClass, questionSn, imageData, mimeType, now).run();

  const id = meta.last_row_id;
  const imageUrl = `${new URL(request.url).origin}/note-images/serve/${id}`;

  return jsonResponse({ id, url: imageUrl });
}

// ── DELETE /note-images/:id ──────────────────────────────
async function handleNoteImageDelete(imageId, env) {
  const { results } = await env.DB.prepare(
    'SELECT id FROM note_images WHERE id = ?'
  ).bind(imageId).all();

  if (!results.length) return jsonResponse({ error: '找不到此圖片' }, 404);

  await env.DB.prepare('DELETE FROM note_images WHERE id = ?').bind(imageId).run();

  return jsonResponse({ ok: true });
}

// ── GET /note-images/serve/:id  （公開，不需 Token）───────
async function handleNoteImageServe(imageId, env) {
  const { results } = await env.DB.prepare(
    'SELECT image_data, mime_type FROM note_images WHERE id = ?'
  ).bind(imageId).all();

  if (!results.length) return new Response('Not Found', { status: 404 });

  const { image_data, mime_type } = results[0];
  const binary = atob(image_data);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

  return new Response(bytes, {
    headers: {
      'Content-Type': mime_type || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...CORS_HEADERS,
    },
  });
}

// ── Main entry ───────────────────────────────────────────
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // 公開路由：圖片讀取（<img> 標籤不會帶 Authorization）
    const serveMatch = path.match(/^\/note-images\/serve\/(\d+)$/);
    if (serveMatch && request.method === 'GET') {
      return handleNoteImageServe(serveMatch[1], env).catch(err =>
        new Response(err.message, { status: 500 })
      );
    }

    // 其餘路由需要驗證
    if (!authenticate(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    try {
      if (path === '/sync') {
        if (request.method === 'GET') return handleSyncGet(env);
        if (request.method === 'PUT') return handleSyncPut(request, env);
      }

      if (path === '/notes') {
        if (request.method === 'GET') return handleNotesGet(url, env);
        if (request.method === 'PUT') return handleNotesPut(request, env);
      }

      if (path === '/note-images' && request.method === 'POST') {
        return handleNoteImagePost(request, env);
      }

      const deleteMatch = path.match(/^\/note-images\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return handleNoteImageDelete(deleteMatch[1], env);
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};
