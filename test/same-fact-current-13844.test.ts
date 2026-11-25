import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { removeCurrentHighlightRepeats } from '../scripts/apply-same-fact-removal.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/same-fact-13844/261123.json', import.meta.url), 'utf8'));
it('261123: removes all three bilingual IPO coverages against the final highlight, with restorable entries', () => {
  const before = structuredClone(fixture);
  const result = removeCurrentHighlightRepeats(fixture, '261123');
  assert.deepEqual(result.approved.radar, []);
  assert.equal(result.removed.length, 3);
  assert.deepEqual(result.removed.map(r => r.item), fixture.radar);
  assert.ok(result.removed.every(r => r.matched_edition === '261123'));
  assert.deepEqual(result.approved.highlights, fixture.highlights);
  assert.deepEqual(fixture, before);
});
it('preserves every editor pin format, including nested article flags', () => {
  for (const pin of [{flag:'editor_submitted'}, {flag:'editor_added'}, {editor_submitted:true}, {source:'editor: incluído no gate'}]) {
    for (const nested of [false, true]) {
      const a = {...fixture.radar[0], ...pin};
      const item = nested ? {article:a} : a;
      const result = removeCurrentHighlightRepeats({...fixture, radar:[item]}, '261123');
      assert.deepEqual(result.approved.radar, [item]);
      assert.equal(result.removed.length, 0);
    }
  }
});
it('covers every pool bucket; unrelated company or fact survives; retries are stable', () => {
  const unrelated = {url:'https://example.com/claude', title:'Anthropic launches Claude 9'};
  const other = {url:'https://example.com/ipo', title:'OpenAI prices its IPO'};
  for (const bucket of ['radar', 'lancamento', 'use_melhor']) {
    const result = removeCurrentHighlightRepeats({highlights:fixture.highlights, [bucket]:[fixture.radar[0], unrelated, other]}, '261123');
    assert.deepEqual(result.approved[bucket], [unrelated, other]);
    assert.equal(result.removed.length, 1);
    assert.equal(removeCurrentHighlightRepeats(result.approved, '261123').removed.length, 0);
  }
});
it('CLI preserves the removal audit and complete items on repeated runs', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'same-fact-13844-'));
  try {
    const approved = join(dir, 'approved.json');
    const log = join(dir, 'removed.json');
    writeFileSync(approved, JSON.stringify(fixture));
    const prior = {bucket:'radar', url:'https://example.com/past', title:'Historical removal'};
    writeFileSync(log, JSON.stringify({removed:[prior]}));
    for (let i = 0; i < 2; i++) {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/apply-same-fact-removal.ts', '--approved', approved, '--current-edition', '261123', '--out-log', log], {stdio:'pipe'});
      const entries = JSON.parse(readFileSync(log, 'utf8')).removed;
      assert.equal(entries.length, 4);
      assert.deepEqual(entries[0], prior);
      assert.deepEqual(entries.slice(1).map((r: {item:unknown}) => r.item), fixture.radar);
      assert.deepEqual(JSON.parse(readFileSync(approved, 'utf8')).radar, []);
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
