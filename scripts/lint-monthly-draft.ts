/**
 * lint-monthly-draft.ts (#423)
 *
 * Valida limites de caracteres por destaque no digest mensal:
 *   D1 ≤ 1.500 chars, D2/D3 ≤ 1.200 chars
 *
 * Contagem: do primeiro parágrafo de prosa até o fim do "O fio condutor:",
 * excluindo a linha de cabeçalho (DESTAQUE N | TEMA), a linha de título
 * e os URLs de links ancorados [texto](url) — conta só o texto âncora.
 *
 * Uso:
 *   npx tsx scripts/lint-monthly-draft.ts <YYMM>
 *   npx tsx scripts/lint-monthly-draft.ts 2604
 *
 * Exit codes:
 *   0  Sempre (lint é advisory — não bloqueia pipeline)
 *   2  Erro de I/O (draft não encontrado)
 */

import { readFileSync } from "node:fs";

const LIMITS: Record<string, number> = { D1: 1500, D2: 1200, D3: 1200 };

function stripInlineLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function extractBody(section: string): string {
  const lines = section.trim().split("\n");
  // line 0: "DESTAQUE N | TEMA", line 1: blank, line 2: título — skip both
  const start = lines.findIndex((l, i) => i >= 2 && l.trim() !== "");
  if (start === -1) return "";

  const body = lines.slice(start);

  // Find end: last non-empty line that is part of "O fio condutor:" block
  let fioStart = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].startsWith("O fio condutor:")) { fioStart = i; break; }
  }
  if (fioStart === -1) return body.join("\n");

  // Include fio condutor label + its paragraph (next non-empty block)
  let end = fioStart + 1;
  while (end < body.length && body[end].trim() !== "") end++;

  return body.slice(0, end).join("\n");
}

function main(): void {
  const yymm = process.argv[2];
  if (!yymm) {
    console.error("Uso: npx tsx scripts/lint-monthly-draft.ts <YYMM>");
    process.exit(2);
  }

  const path = `data/monthly/${yymm}/draft.md`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[lint-monthly] Erro lendo ${path}: ${(e as Error).message}`);
    process.exit(2);
  }

  const sections = text.split("\n---\n");
  const targets = [
    { label: "D1", prefix: "DESTAQUE 1 |" },
    { label: "D2", prefix: "DESTAQUE 2 |" },
    { label: "D3", prefix: "DESTAQUE 3 |" },
  ];

  let hasWarning = false;

  for (const { label, prefix } of targets) {
    const section = sections.find(s => s.trim().startsWith(prefix));
    if (!section) {
      console.log(`[lint-monthly] ${label}: não encontrado no draft`);
      continue;
    }
    const body = extractBody(section);
    const prose = stripInlineLinks(body);
    const chars = prose.replace(/\r/g, "").length;
    const limit = LIMITS[label];
    const ok = chars <= limit;
    console.log(`[lint-monthly] ${label}: ${chars} chars / ${limit} ${ok ? "✓" : "⚠  EXCEDE"}`);
    if (!ok) hasWarning = true;
  }

  if (hasWarning) {
    console.log("[lint-monthly] Um ou mais destaques excedem o limite — revisar antes de publicar.");
  }

  process.exit(0);
}

main();
