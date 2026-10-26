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
  assert.ok(warnings.every(w => w.matched_edition === '261023' && w.score === 0.8));
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
