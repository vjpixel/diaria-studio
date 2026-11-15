import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const skill = readFileSync(new URL('../.claude/skills/diaria-pacote-semanal/SKILL.md', import.meta.url), 'utf8');
const step = (n: number) => skill.split(`## Passo ${n} —`)[1]?.split('## Passo ')[0] ?? '';

test('preflight descobre Chrome e gate avisa antes da aprovação (#13053)', () => {
  assert.match(step(0), /ferramentas disponíveis[\s\S]*chromeAvailable/);
  assert.match(step(0), /Ausência desde o preflight não é desconexão MCP/);
  assert.match(step(6), /chromeAvailable: false[\s\S]*Paste e auditoria[\s\S]*Neo/);
});

test('pós-gate sem Chrome entrega handoff sem alegar paste concluído', () => {
  assert.match(step(7), /chromeAvailable: false[\s\S]*não tentar o paste/);
  assert.match(step(7), /chromeAvailable: true[\s\S]*Passos 8a a 8c/);
  assert.match(step(8), /somente se executado com auditoria aceita/);
  assert.match(step(8), /ln-chrome-handoff\.txt/);
  assert.match(step(8), /não entregar placeholders/);
  assert.match(step(8), /I:\\Meu Drive\\diaria-studio-data\\weekly\\\{cycle\}\\ln-\{cycle\}\.html/);
  assert.match(step(8), /Título do artigo \(literal\): \{headlines\[0\]\.title\}/);
});

test('handoff preserva fonte final, auditoria de âncoras e gate humano', () => {
  const handoff = step(8);
  for (const pattern of [/Não re-renderizar/, /8a:/, /8b:/, /8c:/, /<p>&nbsp;<\/p>/,
    /auditLinkedinPaste/, /#10385, #13049/, /WORDMARK_HREF_REWRITE_HINT/, /no máximo 2/,
    /não autoriza colar de novo/, /agendamento são\nmanuais/, /depois da aprovação do editor/,
    /não gerar instrução para repetir o paste/]) assert.match(handoff, pattern);
});
