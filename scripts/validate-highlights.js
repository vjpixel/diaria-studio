#!/usr/bin/env node
// Usage: node scripts/validate-highlights.js <path-to-edition-md>
// Valida o comprimento dos 3 destaques. Conta: parágrafos do corpo + "Por que isso importa:" + parágrafo de impacto.
// Ignora: cabeçalho DESTAQUE, 1 ou 3 linhas de título, e a URL canônica
// (na linha logo após o bloco de títulos no formato novo #172, ou na última
// linha do bloco no legacy). URLs bare em parágrafos do body são contadas
// (defesa: não esconder limite quando editor cola URL inline).
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

const URL_RE = /^\s*https?:\/\//;

for (const block of blocks) {
  const headerMatch = block.match(/^\s*DESTAQUE\s+(\d)\s*\|/m);
  if (!headerMatch) continue;
  const key = `d${headerMatch[1]}`;
  if (!(key in limits)) continue;

  const lines = block.split('\n');
  const headerIdx = lines.findIndex(l => /^\s*DESTAQUE\s+\d+\s*\|/.test(l));

  // Pular linhas de título consecutivas após o header (1 a 3 linhas
  // não-vazias até bater a primeira linha em branco ou URL). Após a
  // poda do editor o destaque tem 1 título; antes da poda tem 3.
  let i = headerIdx + 1;
  while (i < lines.length && lines[i].trim() !== '') {
    if (URL_RE.test(lines[i])) break;
    i++;
  }

  // Pula a URL canônica do formato novo (#172): se a 1ª linha não-vazia
  // após o bloco de títulos é URL, é a canônica — não conta no body.
  const skipIndices = new Set();
  if (i < lines.length && URL_RE.test(lines[i])) {
    skipIndices.add(i);
    i++;
  }
  // Pula a URL canônica do formato legacy: última http-line do bloco.
  // Se já marcamos a do formato novo, esse passo é no-op (mesma URL ou
  // não há outra). Se há outra URL adiante (= layout legacy), ela é a
  // canônica e deve ser pulada também.
  for (let j = lines.length - 1; j >= i; j--) {
    if (URL_RE.test(lines[j])) {
      skipIndices.add(j);
      break;
    }
  }

  // Coletar o corpo, ignorando apenas as URLs canônicas marcadas.
  // URLs inline em parágrafos do body permanecem (validação fica
  // conservadora — editor não consegue burlar limite escondendo
  // texto atrás de URL).
  const bodyLines = [];
  for (; i < lines.length; i++) {
    if (skipIndices.has(i)) continue;
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
