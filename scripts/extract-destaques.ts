#!/usr/bin/env node
// Usage:
//   npx tsx scripts/extract-destaques.ts <path-to-02-reviewed.md>
//
// Parses a reviewed newsletter and extracts the 3 destaques as structured JSON.
// Replaces LLM-based parsing in publish-newsletter (saves tokens, zero ambiguity).
//
// Expected input format (regular, enforced by writer.md + Clarice inline review):
//
//   DESTAQUE 1 | CATEGORIA
//   Título escolhido
//
//   Corpo (1–N parágrafos)...
//
//   Por que isso importa:
//   Explicação (1–N parágrafos)...
//
//   https://url-da-fonte
//
//   ---
//   DESTAQUE 2 | CATEGORIA
//   ...

import fs from 'fs';

// ── Shared types & parsing (also used by render-newsletter-html.ts) ───

export interface Destaque {
  n: 1 | 2 | 3;
  category: string;
  title: string;
  body: string;          // paragraphs before "Por que isso importa:"
  why: string;           // paragraphs after "Por que isso importa:"
  url: string;
}

/**
 * Parse destaques from the reviewed newsletter text.
 * Exported so render-newsletter-html.ts can reuse the same logic.
 */
export function parseDestaques(raw: string): Destaque[] {
  const sections = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
  const destaques: Destaque[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^DESTAQUE\s+([123])\s*\|\s*(.+)$/m);
    if (!headerMatch) continue;

    const n = parseInt(headerMatch[1], 10) as 1 | 2 | 3;
    const category = headerMatch[2].trim();

    // Remove the header line; work with the remaining content.
    const afterHeader = section.replace(/^DESTAQUE.*$/m, '').trim();
    const lines = afterHeader.split(/\r?\n/);

    // Title = first non-empty line after header.
    const titleIdx = lines.findIndex(l => l.trim().length > 0);
    if (titleIdx === -1) continue;
    const title = lines[titleIdx].trim();

    // Find "Por que isso importa:" marker.
    const whyIdx = lines.findIndex(l => /^Por que isso importa:/i.test(l.trim()));

    // URL = last non-empty line that starts with http.
    const urlIdx = lines.map((l, i) => /^https?:\/\//.test(l.trim()) ? i : -1)
                         .filter(i => i !== -1)
                         .pop() ?? -1;

    const body = whyIdx !== -1
      ? lines.slice(titleIdx + 1, whyIdx).join('\n').trim()
      : lines.slice(titleIdx + 1, urlIdx !== -1 ? urlIdx : undefined).join('\n').trim();

    const why = whyIdx !== -1
      ? lines.slice(whyIdx + 1, urlIdx !== -1 ? urlIdx : undefined)
             .join('\n').trim()
      : '';

    const url = urlIdx !== -1 ? lines[urlIdx].trim() : '';

    destaques.push({ n, category, title, body, why, url });
  }

  // Sort by n to guarantee d1, d2, d3 order.
  destaques.sort((a, b) => a.n - b.n);
  return destaques;
}

/**
 * Build subtitle from D2 and D3 titles.
 * Exported so render-newsletter-html.ts uses the same logic.
 */
export function buildSubtitle(d2title: string, d3title: string): string {
  const combined = `${d2title} | ${d3title}`;
  if (combined.length <= 80) return combined;
  if (d2title.length <= 80) return d2title;
  return d2title.slice(0, 77) + '...';
}

// ── CLI entry point ──────────────────────────────────────────────────

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npx tsx scripts/extract-destaques.ts <path>');
    process.exit(2);
  }

  const raw = fs.readFileSync(path, 'utf8');
  const destaques = parseDestaques(raw);

  if (destaques.length !== 3) {
    console.error(`Expected 3 destaques, got ${destaques.length}. Check formatting in ${path}.`);
    process.exit(1);
  }

  // Every destaque must have a source URL — publish-newsletter depends on it for
  // the "Ler mais" link. URL is the last line starting with http inside the block;
  // an empty value means the writer forgot it or the block is malformed.
  const missingUrl = destaques.filter(d => !d.url);
  if (missingUrl.length > 0) {
    const which = missingUrl.map(d => `D${d.n} ("${d.title}")`).join(', ');
    console.error(`Destaque(s) sem URL de fonte: ${which}. Adicione a URL como última linha do bloco em ${path}.`);
    process.exit(1);
  }

  const [d1, d2, d3] = destaques;
  const output = {
    title: d1.title,
    subtitle: buildSubtitle(d2.title, d3.title),
    destaques,
  };

  console.log(JSON.stringify(output, null, 2));
}

// Only run CLI when executed directly (not when imported)
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('extract-destaques');
if (isDirectRun) {
  main();
}
