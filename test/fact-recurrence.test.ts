import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFactRecurrences } from '../scripts/lib/fact-recurrence.ts';
const past = `## 2026-10-23 — "Falhas no PHP colocam a internet em alerta global"
Temas cobertos:
- PHP
`;
const items = [
  { kind: 'radar', url: 'https://terra.com.br/falha', title: "Falha de segurança revelada por IA provoca 'apagão' em sites ao redor do mundo", summary: 'Falha no PHP descoberta pela Wiz afetou tribunais e a Anatel.' },
  { kind: 'radar', url: 'https://theguardian.com/black-october', title: "'Black October': cybersecurity experts sound the alarm over new era of AI-enabled hacking", summary: 'Wiz identificou falhas no PHP exploradas pelo CyberCartel.' },
];
test('261026 Terra e Guardian repetem o incidente PHP de 261023 apesar das URLs e títulos diferentes', () => {
  const warnings = findFactRecurrences(items, past, '261026');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(w => w.matched_edition === '261023' && w.score === 1 && w.shared_entities.includes('php')));
  assert.match(warnings[0].possible_new_fact, /tribunais e a Anatel/);
});
test('todos os buckets, janela de 30 dias, sem self-match ou futuro', () => {
  for (const kind of ['highlight', 'radar', 'lancamento', 'use_melhor']) {
    assert.equal(findFactRecurrences([{ ...items[0], kind }], past, '261026').length, 1);
  }
  for (const edition of ['261023', '261022', '261124']) assert.deepEqual(findFactRecurrences(items, past, edition), []);
});
test('entidade isolada e incidente genérico não bastam; não juntar evidências de fatos distintos', () => {
  const unrelated = [
    { title: 'PHP ganha novo compilador', url: 'https://php.net/new' },
    { title: 'Falha no Gemini expõe conversas', url: 'https://example.com/gemini' },
    { title: 'Claude projetou proteínas contra veneno de escorpião', url: 'https://anthropic.com/scorpion' },
    { title: 'Mistral lança Voxtral 3', url: 'https://mistral.ai/voxtral' },
  ];
  assert.deepEqual(findFactRecurrences(unrelated, past, '261026'), []);
  assert.deepEqual(findFactRecurrences(items, '## 2026-10-23 — "Falha no Gemini"\nTemas cobertos:\n- PHP', '261026'), []);
});

test('Stage 4 registrado como warning e verifica o conteúdo atual do markdown', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { checkFactRecurrence, STAGE_4_RULES } = await import('../scripts/lib/invariant-checks/stage-4.ts');
  assert.ok(STAGE_4_RULES.some(r => r.id === 'fact-recurrence' && r.stage === 4));
  const dir = mkdtempSync(join(tmpdir(), 'fact-'));
  try {
    const editionDir = join(dir, '261026');
    mkdirSync(editionDir);
    const file = join(editionDir, '02-reviewed.md');
    writeFileSync(file, ['DESTAQUES', 'LANÇAMENTOS', 'USE MELHOR', 'RADAR'].map((section, i) => `# ${section}\n\n[Falha no PHP](https://example.com/${i}) afetou tribunais.`).join('\n\n'));
    const warnings = checkFactRecurrence(editionDir, past);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every(w => w.severity === 'warning' && /261023/.test(w.message)));
    writeFileSync(file, '[Mistral lança Voxtral 3](https://mistral.ai/voxtral)');
    assert.deepEqual(checkFactRecurrence(editionDir, past), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#11109: 1 entidade comum (não sigla) não basta, nem palavra que abre frase', () => {
  const pastMs = '## 2026-10-21 — "Microsoft sofre ataque de ransomware"\nTemas cobertos:\n- Microsoft\n';
  // Cenário da issue: fatos diferentes, só "Microsoft" em comum (e abrindo a frase).
  assert.deepEqual(findFactRecurrences([{ title: 'Microsoft corrige falha no Teams', url: 'https://ms.com/teams' }], pastMs, '261026'), []);
  // Microsoft no meio da frase ainda é 1 entidade comum só: peso 1 < 2.
  assert.deepEqual(findFactRecurrences([{ title: 'Usuários relatam que a Microsoft corrigiu falha no Teams', url: 'https://ms.com/t2' }], pastMs, '261026'), []);
  // Parágrafo inteiro (Stage 4): inícios de frase não viram entidade.
  const pastPesq = '## 2026-10-21 — "Pesquisadores acham falha em Copilot da Microsoft"\n';
  const para = 'Segundo relatório, ataque atingiu bancos. Pesquisadores alertam. Estudo aponta falha [link](https://x.com/a).';
  assert.deepEqual(findFactRecurrences([{ title: para, url: 'https://x.com/a' }], pastPesq, '261026'), []);
});

test('#11109: 2 entidades comuns ou sigla/termo com dígito ainda avisam', () => {
  const pastMs = '## 2026-10-21 — "Microsoft sofre ataque de ransomware no Azure"\n';
  const two = findFactRecurrences([{ title: 'Ransomware: ataque contra a Microsoft derruba o Azure de novo', url: 'https://ms.com/azure' }], pastMs, '261026');
  assert.equal(two.length, 1);
  assert.deepEqual(two[0].shared_entities.sort(), ['azure', 'microsoft']);
  assert.equal(two[0].score, 1);
  // Sigla abrindo a frase é forte e não é descartada.
  const pastCve = '## 2026-10-21 — "Falha CVE-2026-1234 expõe servidores"\n';
  assert.equal(findFactRecurrences([{ title: 'CVE-2026-1234 volta a ser explorada em ataque', url: 'https://x.com/cve' }], pastCve, '261026').length, 1);
});

test('#11163: sigla genérica (API, CEO, LLM, AWS, GPU, SDK) sozinha não dispara o aviso', () => {
  // Cenário da issue: item de segurança cita "API"; título de 20 dias atrás tem termo de incidente e "API".
  const pastApi = '## 2026-10-06 — "Falha em API expõe dados de clientes"\nTemas cobertos:\n- Ataque a API de bancos\n';
  assert.deepEqual(findFactRecurrences([{ title: 'Pesquisadores acham vulnerabilidade na API do Copilot', url: 'https://x.com/copilot' }], pastApi, '261026'), []);
  for (const sigla of ['CEO', 'LLM', 'AWS', 'GPU', 'SDK', 'APIs']) {
    const past = `## 2026-10-06 — "Ataque mira ${sigla} de empresas"\n`;
    assert.deepEqual(findFactRecurrences([{ title: `Nova falha atinge ${sigla} de startups`, url: `https://x.com/${sigla}` }], past, '261026'), [], sigla);
  }
  // Sigla distintiva junto com a genérica continua avisando, e a genérica não entra em shared_entities.
  const pastPhp = '## 2026-10-23 — "Falha no PHP afeta API de tribunais"\n';
  const w = findFactRecurrences([{ title: 'Nova falha no PHP derruba API de bancos', url: 'https://x.com/php' }], pastPhp, '261026');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].shared_entities, ['php']);
});
