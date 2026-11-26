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
  assert.match(p0, /--saturday \{S\} --mode\s+highlights --time/);
  assert.match(p0, /--saturday \{S\} --mode\s+clicked/);
});

test('topo do gate (Passo 6) avisa quando o slot vence antes da aprovação (#13822)', () => {
  const p6 = pacoteStep(6);
  const item1 = p6.split('\n1. ')[1]?.split('\n2. ')[0] ?? '';
  assert.match(item1, /slotCurto/);
  assert.match(item1, /vence antes da aprovação/);
});

test('Passo 7 do pacote agenda em duas chamadas quando há slotCurto (#13822)', () => {
  const p7 = pacoteStep(7);
  assert.match(p7, /slotCurto[\s\S]*--mode highlights --time \{HH:MM alternativo\} --schedule/);
  assert.match(p7, /--mode clicked --shared-selection \{arquivo\} --schedule/);
  // As duas chamadas levam --saturday (sem ele o script sai 1).
  assert.match(p7, /publish-weekly-social\.ts --saturday \{S\} --mode highlights --time \{HH:MM alternativo\} --schedule/);
  assert.match(p7, /publish-weekly-social\.ts --saturday \{S\} --mode clicked --shared-selection/);
  assert.match(p7, /--day-offset N/);
  // #10305: teste rotativo encerrado (25/11/2026) — sem registro de fim de
  // semana a gravar; o horário fixo é 19:00.
  assert.doesNotMatch(p7, /--kind weekend/);
  assert.match(p7, /19:00/);
});

test('Passo 0 e gate descrevem o --check-slot com too-soon, não só vencido (#13822)', () => {
  assert.match(pacoteStep(0), /`expired`\/`too-soon`, exit 2/);
  assert.match(pacoteStep(6), /`expired`\/`too-soon`/);
  assert.doesNotMatch(pacoteStep(0), /só acusa slot já vencido/);
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
  assert.match(p3, /publish-circle-stack\.ts --publish-monday \{M\} --video-auto --reselect/);
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
  // Recolar exige esvaziar o corpo antes, senão o artigo duplica.
  assert.match(c, /esvaziar o corpo já colado antes de colar de novo/);
  assert.match(c, /`textContent\.length` ficou 0/);
  assert.match(c, /pelo snippet acima/);
  // A regra geral de ok === false exclui o split da âncora do vídeo.
  const okFalse = c.split('`result.ok === false`')[1] ?? '';
  assert.match(okFalse, /\*\*exceto\*\* quando o issue é o\s+`TRAILING_WORDMARK_SPLIT_HINT` da âncora do vídeo/);
  assert.doesNotMatch(c, /Corrigir assim:\s+selecionar o texto inteiro da âncora por `Range`/);
});
