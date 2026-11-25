/**
 * #13822 / #13820 / #13818 / #13821 — playbooks dos semanais.
 *
 * Trava a prosa que o pacote semanal e o LinkedIn semanal precisam ter
 * depois das mudanças de código já mergeadas (override do vídeo #13857, vídeo
 * como 1º item e frase fixa nova, âncora "YouTube") e o aviso de slot curto
 * do highlights, que é só prosa (o `--check-slot` acusa slot vencido, não
 * folga curta).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const pacote = readFileSync(new URL('../.claude/skills/diaria-pacote-semanal/SKILL.md', import.meta.url), 'utf8');
const linkedin = readFileSync(new URL('../.claude/skills/diaria-linkedin-semanal/SKILL.md', import.meta.url), 'utf8');
const pacoteStep = (n: number) => pacote.split(`## Passo ${n} —`)[1]?.split('## Passo ')[0] ?? '';
const lnStep = (n: string) => linkedin.split(`## Passo ${n} —`)[1]?.split('\n## Passo ')[0] ?? '';

test('Passo 0 do pacote trata slot do highlights com folga < 120 min como slotCurto (#13822)', () => {
  const p0 = pacoteStep(0);
  assert.match(p0, /slotCurto/);
  assert.match(p0, /minutesFromNow/);
  assert.match(p0, /120\s+min/);
  assert.match(p0, /--time HH:MM/);
  // Com --no-gates aplica sozinho; o alternativo não pode mover o clicked junto.
  assert.match(p0, /--no-gates`?, aplicar o alternativo sozinho/);
  assert.match(p0, /--mode highlights --time/);
});

test('topo do gate (Passo 6) avisa quando o slot vence antes da aprovação (#13822)', () => {
  const p6 = pacoteStep(6);
  const item1 = p6.split('\n1. ')[1]?.split('\n2. ')[0] ?? '';
  assert.match(item1, /slotCurto/);
  assert.match(item1, /vence antes da aprovação/);
});

test('Passo 3 do pacote documenta a troca do vídeo da semana por flag (#13820)', () => {
  const p3 = pacoteStep(3);
  assert.match(p3, /Trocar o vídeo da semana \(#13820\)/);
  assert.match(p3, /select-linkedin-weekly\.ts[^\n]*--video-edition AAMMDD/);
  assert.match(p3, /publish-circle-stack\.ts[^\n]*--video-edition AAMMDD/);
  assert.match(p3, /videoOverride/);
  assert.match(p3, /--require-approved/);
  assert.match(p3, /não editar `video` à\s+mão/);
  assert.match(p3, /--video-auto/);
});

test('Passo 7 do LinkedIn: vídeo como 1º item, título no cabeçalho e frase fixa nova (#13818, #13821)', () => {
  const p7 = lnStep('7');
  assert.match(p7, /1º item do artigo/);
  assert.match(p7, /título do vídeo/);
  assert.match(p7, /"Eu comento esta\s+notícia no YouTube\."/);
  assert.doesNotMatch(p7, /"Eu comento o\s+destaque acima/);
});

test('Passo 8c não manda mais corrigir a âncora do vídeo pela toolbar (#13821)', () => {
  const p8 = lnStep('8');
  const c = p8.split('### 8c.')[1]?.split('### 8d.')[0] ?? '';
  assert.match(c, /não tentar a\s+correção pela toolbar/);
  assert.match(c, /Passo 9/);
  assert.doesNotMatch(c, /Corrigir assim:\s+selecionar o texto inteiro da âncora por `Range`/);
});
