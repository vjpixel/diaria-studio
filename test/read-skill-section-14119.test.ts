import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { run } from '../scripts/read-skill-section.ts';
import { extractAnchoredSection, listAnchors, SkillSectionError } from '../scripts/lib/skill-section.ts';

const SAMPLE = [
  '# Skill',
  '',
  'intro',
  '',
  '<!-- anchor: passo-1 -->',
  '## Passo 1 — Um',
  '',
  'corpo 1',
  '',
  '```bash',
  '# comentário de shell, não é título',
  '## nem este',
  '```',
  '',
  'fim do 1',
  '',
  '<!-- anchor: passo-2 -->',
  '## Passo 2 — Dois',
  '',
  '<!-- anchor: passo-2a -->',
  '### 2a. Sub A',
  '',
  'corpo 2a',
  '',
  '<!-- anchor: passo-2b -->',
  '### 2b. Sub B',
  '',
  'corpo 2b',
  '',
  '## Passo 3 — Sem âncora',
  '',
  'corpo 3',
  '',
].join('\n');

test('extrai exatamente a seção e para no próximo título de mesmo nível (#14119)', () => {
  const s1 = extractAnchoredSection(SAMPLE, 'passo-1');
  assert.equal(
    s1,
    ['## Passo 1 — Um', '', 'corpo 1', '', '```bash', '# comentário de shell, não é título', '## nem este', '```', '', 'fim do 1', ''].join('\n'),
  );
  assert.doesNotMatch(s1, /anchor: passo-2/);
});

test('seção de nível 2 inclui as subseções; subseção para na irmã (#14119)', () => {
  const s2 = extractAnchoredSection(SAMPLE, 'passo-2');
  assert.match(s2, /### 2a\. Sub A[\s\S]*corpo 2a[\s\S]*### 2b\. Sub B[\s\S]*corpo 2b/);
  assert.doesNotMatch(s2, /Passo 3/);
  const s2a = extractAnchoredSection(SAMPLE, 'passo-2a');
  assert.equal(s2a, '### 2a. Sub A\n\ncorpo 2a\n');
  const s2b = extractAnchoredSection(SAMPLE, 'passo-2b');
  assert.equal(s2b, '### 2b. Sub B\n\ncorpo 2b\n');
});

test('CRLF é normalizado', () => {
  assert.equal(extractAnchoredSection(SAMPLE.replace(/\n/g, '\r\n'), 'passo-2a'), '### 2a. Sub A\n\ncorpo 2a\n');
});

test('âncora inexistente lança com a lista das existentes, nunca devolve vazio', () => {
  assert.throws(() => extractAnchoredSection(SAMPLE, 'passo-9'), (e: unknown) =>
    e instanceof SkillSectionError && /passo-9/.test(e.message) && /passo-1, passo-2, passo-2a, passo-2b/.test(e.message));
});

test('âncora duplicada ou longe do título é erro', () => {
  assert.throws(() => listAnchors('<!-- anchor: a -->\n## A\n<!-- anchor: a -->\n## B\n'), /duplicada/);
  assert.throws(() => listAnchors('<!-- anchor: a -->\n\n## A\n'), /imediatamente antes/);
  // âncora dentro de bloco de código é texto, não âncora
  assert.deepEqual(listAnchors('```\n<!-- anchor: a -->\n```\n'), []);
});

test('CLI: exit 1 sem stdout para âncora inexistente; exit 2 para skill inválida', () => {
  const r = run(['--skill', 'diaria-stack', '--section', 'nao-existe']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /âncora não encontrada: nao-existe/);
  assert.equal(run(['--skill', '../etc', '--section', 'x']).code, 2);
  assert.equal(run(['--skill', 'skill-que-nao-existe', '--section', 'x']).code, 2);
  assert.equal(run(['--skill', 'diaria-stack']).code, 2);
});

test('CLI: várias seções na ordem pedida', () => {
  const r = run(['--skill', 'diaria-stack', '--section', 'passo-4,passo-3']);
  assert.equal(r.code, 0);
  const i4 = r.stdout.indexOf('## Passo 4 —');
  const i3 = r.stdout.indexOf('## Passo 3 —');
  assert.ok(i4 >= 0 && i3 > i4, 'passo-4 antes de passo-3');
  assert.doesNotMatch(r.stdout, /## Passo 5 —/);
});

// --- Paridade: o pacote semanal só cita âncoras que existem (#14119) ---

const pacote = readFileSync(new URL('../.claude/skills/diaria-pacote-semanal/SKILL.md', import.meta.url), 'utf8');
const skillMd = (s: string) => readFileSync(new URL(`../.claude/skills/${s}/SKILL.md`, import.meta.url), 'utf8');

/** Linhas da tabela "Citado abaixo como | --skill | --section". */
function anchorTable(): Array<{ label: string; skill: string; sections: string[] }> {
  const rows: Array<{ label: string; skill: string; sections: string[] }> = [];
  for (const line of pacote.split('\n')) {
    const m = line.match(/^\| (.+?) \| `(diaria-[a-z-]+)` \| `([a-z0-9,-]+)` \|$/);
    if (m) rows.push({ label: m[1], skill: m[2], sections: m[3].split(',') });
  }
  return rows;
}

test('toda âncora da tabela do pacote existe na skill de destino e marca o passo citado', () => {
  const rows = anchorTable();
  assert.ok(rows.length >= 14, `tabela de âncoras com ${rows.length} linhas`);
  for (const { label, skill, sections } of rows) {
    const md = skillMd(skill);
    for (const sec of sections) {
      const body = extractAnchoredSection(md, sec); // lança se sumiu
      const step = sec.replace(/^passo-/, '');
      const heading = body.split('\n')[0];
      assert.match(heading, new RegExp(`(Passo ${step} —|^### ${step}\\.)`), `${skill} ${sec}: título "${heading}"`);
      assert.ok(body.length > heading.length + 50, `${skill} ${sec}: seção vazia`);
    }
    assert.match(label, /Passo/);
  }
});

test('todo "Passo N de /diaria-X" citado no pacote tem linha na tabela', () => {
  const flat = pacote.replace(/\s+/g, ' ');
  const covered = new Set(anchorTable().flatMap((r) => r.sections.map((s) => `${r.skill}:${s}`)));
  const alias: Record<string, string> = { 'diaria-retro-semanal:passo-2a': 'diaria-retro-semanal:passo-2b' };
  const linkedinAt = (n: string) => (/^8[abc]$/.test(n) ? 'passo-8' : `passo-${n}`);
  const found: string[] = [];
  const re = /Passos? (\d+[a-z]?)(?:(?: a |-)(\d+[a-z]?))?(?: e (\d+[a-z]?))? (?:de `?\/(diaria-(?:retro-semanal|linkedin-semanal|stack))`?|(?:da skill )?do LinkedIn)/g;
  for (const m of flat.matchAll(re)) {
    const skill = m[4] ?? 'diaria-linkedin-semanal';
    for (const n of [m[1], m[2], m[3]].filter(Boolean) as string[]) {
      const key = `${skill}:${skill === 'diaria-linkedin-semanal' ? linkedinAt(n) : `passo-${n}`}`;
      found.push(key);
      assert.ok(covered.has(alias[key] ?? key), `"${m[0]}" sem âncora na tabela (${key})`);
    }
  }
  assert.ok(found.length >= 15, `achou ${found.length} citações`);
});
