import { it } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, applyNegativePromotionLimits } from '../scripts/assemble-scored.ts';
const h = (url: string, score: number, negative = false) => ({ score, article: { url, negative_impact: negative } });
it('moves a promoted negative from D1 or D2 to D3 without relying on LLM metadata', () => {
  for (const index of [0, 1]) {
    const trio = [h('a', 95), h('b', 90)];
    trio.splice(index, 0, h('negative', 64, true));
    const selection = { highlights: [...trio, h('displaced', 80), h('reserve', 70)] };
    const before = JSON.stringify(selection);
    const out = assemble(selection, {});
    assert.deepEqual(out.highlights.map(x => x.article?.url), ['a', 'b', 'negative', 'displaced', 'reserve']);
    assert.deepEqual(out.highlights.map(x => x.rank), [1, 2, 3, 4, 5]);
    assert.equal(JSON.stringify(selection), before);
    assert.equal(applyNegativePromotionLimits(out), out);
  }
});
it('preserves order at exactly 15 points and for a negative selected by merit', () => {
  for (const score of [65, 81, 100]) {
    const out = assemble({ highlights: [h('negative', score, true), h('a', 95), h('b', 90), h('c', 80)] }, {});
    assert.equal(out.highlights[0].article?.url, 'negative');
  }
});
it('uses the displaced score from all_scored when the model omits the reserve', () => {
  const out = assemble({ highlights: [h('negative', 60, true), h('a', 95), h('b', 90)], negative_impact_promoted: { promoted_url: 'negative', demoted_url: 'c' } }, { all_scored: [{ url: 'c', score: 80 }] });
  assert.equal(out.highlights[2].article?.url, 'negative');
});
it('does not reorder nonnegative items or use missing and duplicated scores', () => {
  const selection = { highlights: [h('a', 60), h('b', 95), h('c', 90), h('d', 80)] };
  assert.equal(assemble(selection, {}).highlights[0].article?.url, 'a');
  const out = assemble({ highlights: [h('negative', 60, true), h('b', 95), h('c', 90), h('b', 95)] }, {});
  assert.equal(out.highlights[0].article?.url, 'negative');
});
