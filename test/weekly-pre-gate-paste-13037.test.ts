import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const skill = readFileSync(new URL('../.claude/skills/diaria-pacote-semanal/SKILL.md', import.meta.url), 'utf8');
const step = (n: number) => skill.split(`## Passo ${n} —`)[1]?.split('## Passo ')[0] ?? '';

test('paste depende do render e auditoria real aparece no gate', () => {
  assert.match(step(5), /assim que o render do LinkedIn terminar,[\s\S]*enquanto os outros renders rodam/);
  assert.match(step(5), /chromeAvailable: true[\s\S]*sem\n`--no-gates`[\s\S]*Passos 8a a 8c/);
  assert.match(step(5), /rascunho reversível/);
  assert.match(step(6), /Status do paste[\s\S]*ok: false[\s\S]*resultado real do Passo 5/);
});

test('swap e pick invalidam artigo alterado e exigem nova auditoria antes do gate', () => {
  assert.match(step(6), /depois de `--swap` ou `--pick`[\s\S]*HTML ou título[\s\S]*defasado[\s\S]*paste e à auditoria do Passo 5 antes de\nreapresentar o gate/);
  assert.match(step(6), /sem duplicá-lo/);
  assert.match(step(6), /Troca só\nno clicked que não muda o artigo não exige recolar/);
});

test('aprovação reaproveita paste atual e mantém falhas pendentes', () => {
  assert.match(step(7), /reaproveitar o paste e a auditoria do Passo 5/);
  assert.match(step(7), /sem mudança no artigo não repete paste/);
  assert.match(step(7), /Só se estiver defasado[\s\S]*Passos 8a a 8c/);
  assert.match(step(7), /anterior falha continua pendente/);
  assert.match(step(8), /somente capa e agendamento do LinkedIn/);
});
