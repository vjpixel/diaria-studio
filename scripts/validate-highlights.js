#!/usr/bin/env node
// Usage: node scripts/validate-highlights.js <path-to-edition-md>
// Valida o comprimento dos 3 destaques. Conta: parágrafos do corpo + "Por que isso importa:" + parágrafo de impacto.
// Ignora: cabeçalho DESTAQUE, 3 opções de título, URL final.
// Limites: d1 ≤ 1200, d2/d3 ≤ 1000. Tolerância de 5% vira warning; acima disso, erro.
// Exit code: 0 se ok/warning apenas, 1 se erro.

import fs from 'fs';

const [filePath] = process.argv.slice(2);
if (!filePath) {
  console.error('Usage: node scripts/validate-highlights.js <path>');
  process.exit(2);
}

const text = fs.readFileSync(filePath, 'utf8');
const blocks = text.split(/\n---\n/);

const limits = { d1: 1200, d2: 1000, d3: 1000 };
const result = {
  d1: null, d2: null, d3: null,
  any_error: false,
  warnings: [],
  errors: []
};

for (const block of blocks) {
  const headerMatch = block.match(/^\s*DESTAQUE\s+(\d)\s*\|/m);
  if (!headerMatch) continue;
  const key = `d${headerMatch[1]}`;
  if (!(key in limits)) continue;

  const lines = block.split('\n');
  const headerIdx = lines.findIndex(l => /^\s*DESTAQUE\s+\d+\s*\|/.test(l));

  // Pular as 3 linhas de opção de título (primeiras 3 não-vazias após o header).
  let i = headerIdx + 1;
  let titlesSeen = 0;
  while (i < lines.length && titlesSeen < 3) {
    if (lines[i].trim() !== '') titlesSeen++;
    i++;
  }

  // Coletar o corpo (incluindo "Por que isso importa:" + parágrafo) até bater uma linha URL.
  const bodyLines = [];
  for (; i < lines.length; i++) {
    if (/^\s*https?:\/\//.test(lines[i])) break;
    bodyLines.push(lines[i]);
  }
  const body = bodyLines.join('\n').trim();
  const chars = Array.from(body).length;

  const limit = limits[key];
  const hardLimit = Math.floor(limit * 1.05);
  let status;
  if (chars <= limit) status = 'ok';
  else if (chars <= hardLimit) status = 'warning';
  else status = 'error';

  result[key] = { chars, limit, hard_limit: hardLimit, status };

  if (status === 'warning') {
    result.warnings.push(`${key}: ${chars} chars (limite ${limit}, tolerância até ${hardLimit}) — acima do limite mas dentro da tolerância de 5%.`);
  }
  if (status === 'error') {
    result.any_error = true;
    result.errors.push(`${key}: ${chars} chars excede ${limit} + 5% (máx tolerado: ${hardLimit}). Reescreva o destaque para caber.`);
  }
}

for (const k of ['d1', 'd2', 'd3']) {
  if (!result[k]) {
    result.any_error = true;
    result.errors.push(`${k} não encontrado no arquivo`);
  }
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.any_error ? 1 : 0);
