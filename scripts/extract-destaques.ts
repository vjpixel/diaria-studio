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
//   https://url-da-fonte    ← #172: URL imediatamente abaixo do título
//
//   Corpo (1–N parágrafos)...
//
//   Por que isso importa:
//   Explicação (1–N parágrafos)...
//
//   ---
//   DESTAQUE 2 | CATEGORIA
//   ...
//
// Backward compat: layout legacy (pré-#172) tinha URL como última linha do
// bloco. O parser aceita ambos: URL é o primeiro `^https?://` dentro do
// bloco, em qualquer posição (linha 2 ou final).
//
// #14001: a lógica de parse (tipos, parseDestaques, replaceDestaqueTitleInMd,
// buildSubtitle) mora em `scripts/lib/destaques-parse.ts`. Este arquivo é a
// casca do CLI (argv + validação + JSON no stdout) e reexporta a lib para os
// importadores que já usam este caminho. Código de `scripts/lib/` importa a
// lib direto (regra 5 de `test/lib-boundary.test.ts`).

import fs from 'fs';
import { isMainModule } from "./lib/cli-args.ts";
import { parseDestaques, buildSubtitle } from "./lib/destaques-parse.ts";

export * from "./lib/destaques-parse.ts";

// ── CLI entry point ──────────────────────────────────────────────────

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npx tsx scripts/extract-destaques.ts <path>');
    process.exit(2);
  }

  const raw = fs.readFileSync(path, 'utf8');
  const destaques = parseDestaques(raw);

  // #2316: aceita 2–3 destaques (editorial legítimo: editor demove D3 para Radar).
  if (destaques.length < 2 || destaques.length > 3) {
    console.error(`Expected 2–3 destaques, got ${destaques.length}. Check formatting in ${path}.`);
    process.exit(1);
  }

  // Every destaque must have a source URL — publish-newsletter depends on it for
  // the "Ler mais" link. URL fica imediatamente abaixo do título (formato novo,
  // #172) ou na última linha do bloco (legacy). Empty = writer esqueceu ou
  // bloco malformado.
  const missingUrl = destaques.filter(d => !d.url);
  if (missingUrl.length > 0) {
    const which = missingUrl.map(d => `D${d.n} ("${d.title}")`).join(', ');
    console.error(`Destaque(s) sem URL de fonte: ${which}. Adicione a URL na linha imediatamente abaixo do título em ${path}.`);
    process.exit(1);
  }

  const d1 = destaques[0];
  const d2 = destaques[1];
  const d3 = destaques[2]; // undefined para edições com 2 destaques
  const subtitle = d3 !== undefined
    ? buildSubtitle(d2.title, d3.title)
    : d2.title.slice(0, 200);
  const output = {
    title: d1.title,
    subtitle,
    destaques,
  };

  console.log(JSON.stringify(output, null, 2));
}

// Only run CLI when executed directly (not when imported, e.g. from tests
// or render-newsletter-html.ts). Match the script file name precisely
// instead of substring — `extract-destaques.test.ts` was triggering CLI mode.
const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  main();
}
