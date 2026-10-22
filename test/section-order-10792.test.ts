import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTop3Merit, STAGE_1_RULES } from '../scripts/lib/invariant-checks/stage-1.ts';
import { STAGE_4_RULES } from '../scripts/lib/invariant-checks/stage-4.ts';
import { classifyNewsletterDiff } from '../scripts/derive-editor-requests.ts';

const h = (id: string, score: number, bucket = 'radar') => ({ score, bucket, article: { url: `https://example.com/${id}`, title: id } });
function fixture(run: (dir: string, save: (name: string, data: unknown) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'section-order-'));
  mkdirSync(join(dir, '_internal'));
  try { run(dir, (name, data) => writeFileSync(join(dir, '_internal', name), JSON.stringify(data))); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
it('warns for the 92-point research outside a 72/85/80 trio, including equal scores', () => fixture((dir, save) => {
  const top = [h('muse', 72), h('launch', 85), h('third', 80)];
  for (const score of [92, 85]) {
    save('tmp-scored.json', { highlights: [...top, h('research', score)] });
    const before = JSON.stringify(top);
    const warnings = checkTop3Merit(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.match(warnings[0].message, /research/);
    assert.equal(JSON.stringify(top), before);
  }
}));
it('compares against the maximum, excludes selected URLs and ineligible tutorials', () => fixture((dir, save) => {
  save('tmp-scored.json', { highlights: [h('first', 92), h('second', 80), h('third', 72)], all_scored: [h('first', 92), h('reserve', 91), h('tutorial', 100, 'use_melhor')] });
  assert.deepEqual(checkTop3Merit(dir), []);
}));
it('uses the approved trio and the full scored pool, with deduplicated warnings', () => fixture((dir, save) => {
  const research = h('research', 92);
  save('tmp-scored.json', { highlights: [research], all_scored: [research] });
  save('01-approved.json', { highlights: [h('a', 85), h('b', 80), h('c', 72)] });
  assert.equal(checkTop3Merit(dir)[0].message.match(/research/g)?.length, 1);
  save('01-approved.json', { highlights: [research, h('b', 80), h('c', 72)] });
  assert.deepEqual(checkTop3Merit(dir), []);
}));
it('skips absent or unusable scores and registers the same warning at both gates', () => fixture((dir, save) => {
  assert.deepEqual(checkTop3Merit(dir), []);
  save('tmp-scored.json', { highlights: [h('a', 90), { article: { url: 'https://example.com/b' } }] });
  assert.deepEqual(checkTop3Merit(dir), []);
  for (const rules of [STAGE_1_RULES, STAGE_4_RULES]) assert.equal(rules.find(r => r.id === 'top3-merit-warning')?.run, checkTop3Merit);
}));
it('PARA ENCERRAR text edits default to other, outside section-order recurrence', () => {
  const section = (text: string) => `---\n\n**PARA ENCERRAR**\n\n${text}\n\n---\n`;
  const out = classifyNewsletterDiff(section('Uma reflexão sobre IA e nossas escolhas.'), section('Uma reflexão sobre IA e nossas decisões.'));
  assert.equal(out.length, 1);
  assert.equal(out[0].request_type, 'other');
});
