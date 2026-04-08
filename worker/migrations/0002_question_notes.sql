-- 題目雲端筆記表
CREATE TABLE IF NOT EXISTS question_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key     TEXT    NOT NULL,
  question_class TEXT    NOT NULL,
  question_sn    TEXT    NOT NULL,
  note_text      TEXT    NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (source_key, question_class, question_sn)
);

-- 題目附圖表（圖片以 base64 直接存於 D1）
CREATE TABLE IF NOT EXISTS note_images (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key     TEXT    NOT NULL,
  question_class TEXT    NOT NULL,
  question_sn    TEXT    NOT NULL,
  image_data     TEXT    NOT NULL,  -- base64 encoded
  mime_type      TEXT    NOT NULL DEFAULT 'image/jpeg',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
