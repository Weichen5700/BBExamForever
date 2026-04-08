#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const TARGET_CATEGORY = "投資型考試";
const MANIFEST_PATH = path.join(ROOT, "data", "manifest.json");
const REPORT_PATH = path.join(ROOT, "data", TARGET_CATEGORY, "_conversion-report.json");

const SOURCE_CONFIGS = [
  {
    inputPdf: "input/投資型第一科經典考題_11205.pdf",
    className: "第一科",
    dataOutput: "data/投資型考試/01_第一科經典考題_11205.txt",
    sampleOutput: "sample/投資型_01_第一科經典考題_11205.txt",
    manifestFile: "01_第一科經典考題_11205.txt",
    manifestLabel: "第一科經典考題_11205"
  },
  {
    inputPdf: "input/投資型第二科經典考題11205.pdf",
    className: "第二科",
    dataOutput: "data/投資型考試/02_第二科經典考題_11205.txt",
    sampleOutput: "sample/投資型_02_第二科經典考題_11205.txt",
    manifestFile: "02_第二科經典考題_11205.txt",
    manifestLabel: "第二科經典考題_11205"
  }
];

main().catch((error) => {
  console.error("[convert:investment] Failed:", error);
  process.exitCode = 1;
});

async function main() {
  const reportFiles = [];

  for (const config of SOURCE_CONFIGS) {
    const pdfPath = path.join(ROOT, config.inputPdf);
    const dataPath = path.join(ROOT, config.dataOutput);
    const samplePath = path.join(ROOT, config.sampleOutput);

    const extracted = await extractPdfRows(pdfPath);
    const parsed = parseQuestionsFromRows(extracted.rows, config.className);
    const built = buildSampleRecords(parsed.rawQuestions, config.className);

    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    await fs.mkdir(path.dirname(samplePath), { recursive: true });

    const jsonl = `${built.records.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await fs.writeFile(dataPath, jsonl, "utf8");
    await fs.writeFile(samplePath, jsonl, "utf8");

    const dataValidation = await validateJsonl(dataPath);
    const sampleValidation = await validateJsonl(samplePath);

    reportFiles.push({
      inputPdf: config.inputPdf,
      className: config.className,
      outputs: {
        data: config.dataOutput,
        sample: config.sampleOutput
      },
      totals: {
        pagesExtracted: extracted.pageCount,
        rowsExtracted: extracted.rows.length,
        questionsParsed: built.records.length,
        questionsWithAnswer: built.meta.filter((m) => m.hasAnswer).length,
        questionsMissingAnswer: built.meta.filter((m) => !m.hasAnswer).length
      },
      missingAnswerSns: built.meta.filter((m) => !m.hasAnswer).map((m) => m.sn),
      parseWarnings: [...parsed.warnings, ...built.warnings],
      validation: {
        data: dataValidation,
        sample: sampleValidation
      }
    });
  }

  await updateManifest();

  const summary = {
    generatedAt: new Date().toISOString(),
    category: TARGET_CATEGORY,
    totals: {
      files: reportFiles.length,
      questions: reportFiles.reduce((n, f) => n + f.totals.questionsParsed, 0),
      questionsWithAnswer: reportFiles.reduce((n, f) => n + f.totals.questionsWithAnswer, 0),
      questionsMissingAnswer: reportFiles.reduce((n, f) => n + f.totals.questionsMissingAnswer, 0)
    }
  };

  await fs.writeFile(REPORT_PATH, `${JSON.stringify({ summary, files: reportFiles }, null, 2)}\n`, "utf8");

  console.log("[convert:investment] Completed.");
  for (const file of reportFiles) {
    console.log(`- ${file.className}: ${file.totals.questionsParsed} 題，缺答案 ${file.totals.questionsMissingAnswer} 題`);
  }
  console.log(`- report: ${toRepoPath(REPORT_PATH)}`);
}

async function extractPdfRows(pdfPath) {
  // If a pre-extracted .rows.jsonl file exists alongside the PDF, use it instead
  // of re-parsing the PDF.  This lets you inspect and hand-edit the rows file and
  // then re-run the converter without touching the PDF again.
  const rowsJsonlPath = pdfPath.replace(/\.pdf$/i, ".rows.jsonl");
  try {
    await fs.access(rowsJsonlPath);
    const content = await fs.readFile(rowsJsonlPath, "utf8");
    const rows = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const pages = new Set(rows.map((r) => r.pageNumber));
    console.log(`[convert] Using pre-extracted rows: ${path.relative(ROOT, rowsJsonlPath)} (${rows.length} rows, ${pages.size} pages)`);
    return { pageCount: pages.size, rows };
  } catch {
    // Fall back to PDF extraction
  }

  const raw = await fs.readFile(pdfPath);
  const loadingTask = getDocument({
    data: new Uint8Array(raw),
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;

  const rows = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      rows.push(...groupItemsToRows(textContent.items, pageNumber));
    }
  } finally {
    await loadingTask.destroy();
  }

  return { pageCount: pdf.numPages, rows };
}

function groupItemsToRows(items, pageNumber) {
  const sorted = items
    .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
    .map((it) => ({
      x: it.transform?.[4] ?? 0,
      y: it.transform?.[5] ?? 0,
      str: it.str
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  const tolerance = 2.2;
  for (const item of sorted) {
    let row = rows.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const arranged = row.items.sort((a, b) => a.x - b.x);
      const left = joinRowTokens(arranged.filter((it) => it.x < 100));
      const middle = joinRowTokens(arranged.filter((it) => it.x >= 100 && it.x < 510));
      const right = joinRowTokens(arranged.filter((it) => it.x >= 510));
      return { pageNumber, y: row.y, left, middle, right };
    })
    .filter((row) => row.left || row.middle || row.right);
}

function joinRowTokens(items) {
  return items
    .map((it) => it.str)
    .join("")
    .replace(/\u00A0/g, "")
    .replace(/\u3000/g, "")
    .trim();
}

function parseQuestionsFromRows(rows, className) {
  const warnings = [];
  const normalizedRows = rows
    .filter((row) => !isTitleRow(row))
    .map((row, rowIndex) => ({
      rowIndex,
      pageNumber: row.pageNumber || 0,
      y: row.y || 0,
      questionNo: parseQuestionNo(row.left),
      answerLabel: parseAnswerLabel(row.right),
      segment: normalizeSegment(row.middle)
    }));

  const anchors = normalizedRows.filter((r) => r.questionNo !== null);
  if (anchors.length === 0) {
    return { rawQuestions: [], warnings: [`[${className}] 找不到題號欄位。`] };
  }

  const sortedAnchors = [...anchors].sort((a, b) => a.rowIndex - b.rowIndex);
  const groupedByAnchor = sortedAnchors.map((anchor) => ({
    anchor,
    segments: []
  }));

  normalizedRows.forEach((row) => {
    if (!row.segment) return;
    const anchorIndex = findNearestAnchorIndex(row, sortedAnchors);
    if (anchorIndex < 0) return;
    groupedByAnchor[anchorIndex].segments.push(row.segment);
  });

  const buckets = new Map();

  groupedByAnchor.forEach(({ anchor, segments }) => {
    const text = segments.join("");
    if (!text) return;

    if (!buckets.has(anchor.questionNo)) {
      buckets.set(anchor.questionNo, {
        sourceQuestionNo: anchor.questionNo,
        answerLabel: anchor.answerLabel || null,
        text
      });
      return;
    }

    const existing = buckets.get(anchor.questionNo);
    existing.text += text;
    if (!existing.answerLabel && anchor.answerLabel) {
      existing.answerLabel = anchor.answerLabel;
    }
    warnings.push(`[${className}] 題號 ${anchor.questionNo} 重複，已合併。`);
  });

  const rawQuestions = Array.from(buckets.values())
    .sort((a, b) => a.sourceQuestionNo - b.sourceQuestionNo)
    .filter((q) => q.text);

  return { rawQuestions, warnings };
}

function findNearestAnchorIndex(row, anchors) {
  if (anchors.length === 0) return -1;
  const { rowIndex, segment } = row;

  let low = 0;
  let high = anchors.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const anchorRow = anchors[mid].rowIndex;
    if (anchorRow === rowIndex) return mid;
    if (anchorRow < rowIndex) low = mid + 1;
    else high = mid - 1;
  }

  const next = low;
  const prev = low - 1;
  if (prev < 0) return next;
  if (next >= anchors.length) return prev;

  const distPrev = Math.abs(rowIndex - anchors[prev].rowIndex);
  const distNext = Math.abs(anchors[next].rowIndex - rowIndex);
  if (distPrev < distNext) return prev;
  if (distNext < distPrev) return next;

  // tie: keep continuation lines in previous question; only move to next on clear new-question lead.
  return looksLikeNewQuestionLead(segment) ? next : prev;
}

function looksLikeNewQuestionLead(segment) {
  const text = normalizeDigits(segment || "").replace(/\s+/g, "");
  const hasFirstOption = /[（(]1[）)]/.test(text);
  if (!hasFirstOption) return false;
  return /^(下列|有關|關於|若|請問|何者|在|對於|我國|台灣|王|李|張|陳|小王|小張|投資者|保險公司|名目年利率|假設|某|老張|李小姐|王先生|保戶|壽險|金融|根據|依規|依據|依|甲公司)/.test(text);
}

function isTitleRow(row) {
  if (row.left.includes("題號") || row.middle.includes("題目") || row.right.includes("解答")) return true;
  if (row.middle.includes("投資型第一科經典考題") || row.middle.includes("投資型第二科經典考題")) return true;
  return false;
}

function parseQuestionNo(text) {
  const digits = normalizeDigits(text).replace(/[^\d]/g, "");
  if (!digits || digits.length > 3) return null;
  const value = Number(digits);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parseAnswerLabel(text) {
  const compact = normalizeDigits(text).replace(/[^0-9A-Za-z甲乙丙丁戊]/g, "");
  if (compact.length !== 1) return null;
  return normalizeOptionLabel(compact);
}

function normalizeSegment(text) {
  return normalizeDigits(text)
    .replace(/\s+/g, "")
    .replace(/題號答案題目解答/g, "")
    .trim();
}

function buildSampleRecords(rawQuestions, className) {
  const records = [];
  const meta = [];
  const warnings = [];

  rawQuestions.forEach((raw, index) => {
    const split = splitQuestion(raw.text);
    let options = split.options.map((opt) => ({
      option: opt.text,
      answer: false
    }));

    if (raw.answerLabel) {
      if (split.isCombo) {
        // For combo questions the answerLabel is a digit 1-4 matching the combo choice label
        options = options.map((opt, i) => ({
          ...opt,
          answer: split.options[i].label === raw.answerLabel
        }));
      } else {
        options = options.map((opt, i) => ({
          ...opt,
          answer: split.options[i].label === raw.answerLabel
        }));
      }
    }

    if (options.length < 2) {
      warnings.push(`[${className}] sn ${formatSn(index + 1)} 選項過少。`);
    }

    const row = {
      sn: formatSn(index + 1),
      class: className,
      question: split.stem || raw.text,
      options,
      remark: "",
      felo: "",
      pic: ""
    };
    records.push(row);
    meta.push({
      sn: row.sn,
      sourceQuestionNo: raw.sourceQuestionNo,
      optionCount: options.length,
      hasAnswer: options.some((opt) => opt.answer)
    });
  });

  repairCrossQuestionSpillover(records);

  return { records, meta, warnings };
}

// Matches a "combo-selector" suffix: （1）...（2）...（3）...（4）...[。]
// seen when options ask "which combination is correct?" with choices like A、B or ABC
const COMBO_SELECTOR_RE =
  /[（(]1[）)][、，\s]?[A-D甲乙丙丁、，與和及\s僅四者均對]+[（(]2[）)][、，\s]?[A-D甲乙丙丁、，與和及\s僅四者均對]+[（(]3[）)][、，\s]?[A-D甲乙丙丁、，與和及\s僅四者均對]+[（(]4[）)][、，\s]?[A-D甲乙丙丁、，與和及\s僅四者均對]+[。.]?$/;

/**
 * If `text` ends with a combo-selector, strip it and return the four combo choices.
 * e.g. "…（1）A、B（2）B、C（3）A、C（4）ABCD。"
 * returns { base: "…", combos: [{label:"1",text:"A、B"}, ...] }
 * otherwise returns null.
 *
 * The input text is assumed to have already been through normalizeForOptions (spaces stripped,
 * full-width digits normalized, bracket variants unified).
 */
function extractComboSelector(text) {
  // Allow combo choice text to be anything not containing another （N） marker
  const m = text.match(
    /^([\s\S]*?)[（(]1[）)]([^（(）)]*?)[（(]2[）)]([^（(）)]*?)[（(]3[）)]([^（(）)]*?)[（(]4[）)]([^（(）)]*?)[。.]?\s*$/
  );
  if (!m) return null;
  // Validate: every captured combo text should contain at least one A-D or 甲乙丙丁 letter
  // or be a Chinese phrase like 四者皆有/僅有A
  const choiceRe = /[A-D甲乙丙丁]/;
  const choices = [m[2], m[3], m[4], m[5]];
  if (!choices.every((c) => choiceRe.test(c) || /[者均四皆]/. test(c))) return null;
  const base = m[1].replace(/[。.]\s*$/, "").trim();
  return {
    base,
    combos: [
      { label: "1", text: cleanup(m[2]) },
      { label: "2", text: cleanup(m[3]) },
      { label: "3", text: cleanup(m[4]) },
      { label: "4", text: cleanup(m[5]) }
    ]
  };
}

function splitQuestion(text) {
  const source = normalizeForOptions(text);
  const marker = /[（(]\s*([1-5A-E甲乙丙丁戊])\s*[）)]/g;
  const marks = Array.from(source.matchAll(marker));

  if (marks.length < 2) {
    return { stem: cleanup(source), options: [] };
  }

  // Determine if the first option marker uses numeric (1-4) or letter (A-D/甲乙丙丁) labels.
  const firstLabel = normalizeOptionLabel(marks[0][1]);
  const isNumericFirst = firstLabel && /^[1-4]$/.test(firstLabel);

  // When the markers are A/B/C/D (letter labels), check if the final portion of the text
  // contains a combo-selector ( (1)…(2)…(3)…(4)… ) that represents sub-choices.
  const letterMarkers = marks.filter((m2) => /^[A-E]$/.test(normalizeOptionLabel(m2[1]) || "") || /^[甲乙丙丁戊]$/.test(m2[1]));
  const numericMarkers = marks.filter((m2) => /^[1-4]$/.test(normalizeOptionLabel(m2[1]) || ""));

  // Determine primary option set
  let primaryMarks;
  let extractedCombos = null;

  if (!isNumericFirst && letterMarkers.length >= 2) {
    // Options are letter-based; numeric markers may be a combo-selector suffix
    primaryMarks = letterMarkers.slice(0, 5);
  } else {
    primaryMarks = marks.slice(0, 4);
  }

  const stem = cleanup(source.slice(0, primaryMarks[0].index));
  const options = [];

  for (let i = 0; i < primaryMarks.length; i += 1) {
    const current = primaryMarks[i];
    const next = primaryMarks[i + 1];
    const label = normalizeOptionLabel(current[1]);
    if (!label) continue;

    const start = current.index + current[0].length;
    const end = next ? next.index : source.length;
    let value = cleanup(source.slice(start, end).replace(/^[、，,。.;；:：]+/, ""));

    if (i === primaryMarks.length - 1) {
      // For the last option, check for a combo-selector suffix
      const combo = extractComboSelector(value);
      if (combo) {
        value = combo.base;
        extractedCombos = combo.combos;
      } else {
        value = trimLastOptionTail(value);
      }
    }
    if (!value) continue;
    options.push({ label, text: value });
  }

  // If the question uses a combo-selector, replace options with the combo choices
  // so the digit answer label (1-4) correctly maps to one of the combo options.
  if (extractedCombos && extractedCombos.every((c) => c.text)) {
    const namedItems = options.map((o) => `${o.label}、${o.text}`).join("；");
    const newStem = stem ? `${stem}（${namedItems}）` : `（${namedItems}）`;
    return { stem: newStem, options: extractedCombos, isCombo: true };
  }

  return { stem: stem || cleanup(source), options };
}

function normalizeForOptions(text) {
  return normalizeDigits(text)
    .replace(/[\u2474\u2776\u2460]/g, "（1）")
    .replace(/[\u2475\u2777\u2461]/g, "（2）")
    .replace(/[\u2476\u2778\u2462]/g, "（3）")
    .replace(/[\u2477\u2779\u2463]/g, "（4）")
    .replace(/[\u2478\u277A\u2464]/g, "（5）")
    .replace(/[〈<﹙〔［\[]/g, "（")
    .replace(/[〉>﹚〕］\]]/g, "）")
    // OCR sometimes reads "1" as lowercase "l" in contexts like (l) meaning (1)
    .replace(/\(l\)/g, "（1）")
    .replace(/（l）/g, "（1）")
    .replace(/\s+/g, "");
}

function trimLastOptionTail(text) {
  // Case 1: text contains 。 followed by content that looks like a new question
  const firstPeriod = text.indexOf("。");
  if (firstPeriod >= 0) {
    const tail = text.slice(firstPeriod + 1);
    if (tail && looksLikeContinuedQuestion(tail)) {
      return text.slice(0, firstPeriod + 1);
    }
  }
  return text;
}

/**
 * Returns true when `text` appears to be the beginning or continuation of a new question,
 * i.e. it should NOT be included as part of the current option text.
 */
function looksLikeContinuedQuestion(text) {
  // Strong signal: contains （1）which starts the first option of a new question
  if (/[（(]1[）)]/.test(text)) return true;
  // Starts with a typical question-opening keyword
  return looksLikeQuestionStart(text);
}

function repairCrossQuestionSpillover(records) {
  for (let i = 0; i < records.length - 1; i += 1) {
    const current = records[i];
    const next = records[i + 1];
    if (!current?.options?.length) continue;

    const lastOptionIndex = current.options.length - 1;
    const rawOption = current.options[lastOptionIndex].option || "";
    const spill = splitTrailingQuestionLead(rawOption);
    if (!spill) continue;

    current.options[lastOptionIndex].option = spill.current;
    const dedupe = spill.next.slice(0, 10);
    if (!next.question.startsWith(dedupe)) {
      next.question = `${spill.next}${next.question}`;
    }
  }
}

function splitTrailingQuestionLead(optionText) {
  const match = optionText.match(/^([\s\S]*?[。！？!?])([\s\S]+)$/);
  if (!match) return null;

  const current = cleanup(match[1]);
  const next = cleanup(match[2]);
  if (!current || !next || next.length < 4) return null;
  if (!looksLikeQuestionStart(next)) return null;
  return { current, next };
}

function looksLikeQuestionStart(text) {
  return /^(下列|有關|關於|若|請問|何者|在計算|在與|王|李|張|陳|老張|李小姐|王先生|投資者|保險公司|我國|台灣|假設|小王|小張|名目年利率|陳太太|李四|張三|當利率|保戶|壽險|金融|根據|依規|依據|依|對於|以下|下面|下述|甲公司|乙|丙)/.test(
    text
  );
}

function hasOptionMarker(text) {
  return /[（(][1-4A-D甲乙丙丁][）)]/.test(text);
}

function normalizeOptionLabel(raw) {
  const compact = normalizeDigits(raw).replace(/[\s()（）.、]/g, "").trim();
  if (/^[1-5]$/.test(compact)) return compact;
  const up = compact.toUpperCase();
  if (/^[A-E]$/.test(up)) return up;
  if (/^[甲乙丙丁戊]$/.test(compact)) return compact;
  return null;
}

function normalizeDigits(text) {
  return text.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
}

function cleanup(text) {
  return text.replace(/\s+/g, "").trim();
}

async function validateJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const issues = [];
  const histogram = {};

  lines.forEach((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      issues.push(`line ${index + 1}: JSON.parse 失敗 (${error.message})`);
      return;
    }

    const expectedSn = formatSn(index + 1);
    if (row.sn !== expectedSn) {
      issues.push(`line ${index + 1}: sn 非連續（預期 ${expectedSn}）`);
    }
    if (!Array.isArray(row.options)) {
      issues.push(`line ${index + 1}: options 非陣列`);
      return;
    }

    const count = row.options.length;
    histogram[count] = (histogram[count] || 0) + 1;
    if (count < 2) issues.push(`line ${index + 1}: options 數量過少 (${count})`);
    if (count > 7) issues.push(`line ${index + 1}: options 數量異常 (${count})`);
  });

  return {
    lineCount: lines.length,
    issueCount: issues.length,
    optionCountHistogram: histogram,
    issues
  };
}

async function updateManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  const entry = {
    category: TARGET_CATEGORY,
    files: SOURCE_CONFIGS.map((cfg) => ({
      file: cfg.manifestFile,
      label: cfg.manifestLabel
    }))
  };

  const index = manifest.findIndex((item) => item.category === TARGET_CATEGORY);
  if (index >= 0) manifest[index] = entry;
  else manifest.push(entry);

  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function formatSn(value) {
  return String(value).padStart(3, "0");
}

function toRepoPath(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, "/");
}
