#!/usr/bin/env node
/**
 * extract-pdf-rows.mjs
 *
 * Extracts raw row data from the investment-exam PDFs and writes two output files
 * per PDF into the input/ directory:
 *
 *   input/<stem>.rows.jsonl   — machine-readable: one JSON object per row
 *   input/<stem>.rows.txt     — human-readable: shows the three-column layout
 *
 * The .rows.jsonl can be edited manually to fix layout issues, and will be picked
 * up automatically by convert-investment-pdf.mjs on the next run (instead of
 * re-parsing the PDF).
 *
 * Usage:
 *   node tools/extract-pdf-rows.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PDFS = [
  "input/投資型第一科經典考題_11205.pdf",
  "input/投資型第二科經典考題11205.pdf"
];

main().catch((e) => { console.error("[extract-rows] Failed:", e); process.exitCode = 1; });

async function main() {
  for (const relPdf of PDFS) {
    const pdfPath = path.join(ROOT, relPdf);
    const stem = path.basename(relPdf, ".pdf");
    const jsonlPath = path.join(ROOT, "input", `${stem}.rows.jsonl`);
    const txtPath  = path.join(ROOT, "input", `${stem}.rows.txt`);

    console.log(`[extract-rows] Reading: ${relPdf}`);
    const rows = await extractRows(pdfPath);

    // --- Write .rows.jsonl ---
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.writeFile(jsonlPath, jsonl, "utf8");
    console.log(`[extract-rows] Wrote ${rows.length} rows → ${path.relative(ROOT, jsonlPath)}`);

    // --- Write .rows.txt (human-readable table) ---
    const txtLines = [];
    let lastPage = 0;
    for (const row of rows) {
      if (row.pageNumber !== lastPage) {
        txtLines.push(`\n===== PAGE ${row.pageNumber} =====`);
        lastPage = row.pageNumber;
      }
      // Format: y=NNN  [LEFT_COL]  MIDDLE_COL  |ANSWER
      const y    = String(Math.round(row.y)).padStart(4);
      const left = (row.left  || "").padEnd(6);
      const ans  = row.right ? ` | ${row.right}` : "";
      txtLines.push(`y=${y}  [${left}]  ${row.middle}${ans}`);
    }
    await fs.writeFile(txtPath, txtLines.join("\n") + "\n", "utf8");
    console.log(`[extract-rows] Wrote human-readable → ${path.relative(ROOT, txtPath)}`);
  }
  console.log("[extract-rows] Done. You can now edit the .rows.jsonl files and re-run convert-investment-pdf.mjs.");
}

async function extractRows(pdfPath) {
  const raw = await fs.readFile(pdfPath);
  const loadingTask = getDocument({ data: new Uint8Array(raw), useSystemFonts: true });
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
  return rows;
}

function groupItemsToRows(items, pageNumber) {
  const sorted = items
    .filter((it) => typeof it.str === "string" && it.str.trim() !== "")
    .map((it) => ({ x: it.transform?.[4] ?? 0, y: it.transform?.[5] ?? 0, str: it.str }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rowMap = [];
  const tolerance = 2.2;
  for (const item of sorted) {
    let row = rowMap.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (!row) { row = { y: item.y, items: [] }; rowMap.push(row); }
    row.items.push(item);
  }

  return rowMap
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const arranged = row.items.sort((a, b) => a.x - b.x);
      const left   = joinTokens(arranged.filter((it) => it.x < 100));
      const middle = joinTokens(arranged.filter((it) => it.x >= 100 && it.x < 510));
      const right  = joinTokens(arranged.filter((it) => it.x >= 510));
      return { pageNumber, y: row.y, left, middle, right };
    })
    .filter((row) => row.left || row.middle || row.right);
}

function joinTokens(items) {
  return items.map((it) => it.str).join("").replace(/\u00A0/g, "").replace(/\u3000/g, "").trim();
}
