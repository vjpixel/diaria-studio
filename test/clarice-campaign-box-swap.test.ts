import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClariceBox } from '../scripts/lib/mensal/monthly-render.ts';
import { listCampaignBoxes, prepareBoxSwap, applyBoxSwap, applyStoredBoxSwap, saveBoxSwap, boxSwapPath } from '../scripts/lib/clarice-campaign-box-swap.ts';

test('campaign-scoped snapshot survives reapply, preserves every other byte and nested CTA tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'box-swap-'));
  try {
    const first = renderClariceBox('LIVROS\n\n**Livro**\n\n[CTA](https://example.com)', 'Livros');
    const second = renderClariceBox('CLARICE\n\n**Conversar com a Clarice**\n\nCorpo\n\n[Conversar](https://example.com)', 'Clarice');
    const html = 'header' + first + '\n' + second + 'footer';
    assert.equal(listCampaignBoxes(html).length, 2);
    const snippet = join(dir, 'coupon.md');
    writeFileSync(snippet, '<!-- nome: interno -->\n**Cupom**\n\nOferta\n\n[Comprar](https://www.amazon.com.br/dp/TEST?tag=diaria-20)');
    const swap = prepareBoxSwap(html, 'Conversar com a Clarice', snippet);
    assert.deepEqual(prepareBoxSwap(html, '2', snippet), swap);
    const expected = 'header' + first + '\n' + swap.html + 'footer';
    assert.equal(applyBoxSwap(html, swap), expected);
    assert.match(swap.html, /claricenews-20/);
    assert.doesNotMatch(swap.html, /interno/);
    assert.match(swap.html, /<h3[^>]*>Cupom<\/h3>/);
    assert.equal(existsSync(boxSwapPath(dir, 394)), false);
    saveBoxSwap(dir, 394, swap);
    writeFileSync(snippet, '**Changed**');
    assert.equal(applyStoredBoxSwap(html, dir, 394), expected);
    assert.equal(applyStoredBoxSwap(html, dir, 395), html);
    assert.throws(() => applyStoredBoxSwap(html.replace('Conversar com a Clarice', 'Outro'), dir, 394), /draft atual/);
    assert.throws(() => prepareBoxSwap(html + second, 'Conversar com a Clarice', snippet), /exatamente um/);
    assert.throws(() => prepareBoxSwap(html, '3', snippet), /exatamente um/);
    writeFileSync(snippet, '<!-- vazio -->');
    assert.throws(() => prepareBoxSwap(html, '2', snippet), /vazio/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects incomplete swaps before any network request', async () => {
  const { main } = await import('../scripts/clarice-reapply-scheduled-html.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('NETWORK MUST NOT RUN'); };
  try {
    for (const flags of [
      ['--swap-box', '2'],
      ['--with', 'a.md', '--campaign-id', '394'],
      ['--swap-box=2', '--with=a.md'],
      ['--swap-box', '2', '--with', 'a.md', '--campaign-id', '394', '--reschedule-suspended', '--scheduled-at', '2026-11-06T09:00:00Z'],
    ]) await assert.rejects(main(['--cycle', '2610-11', ...flags]), /--swap-box/);
  } finally { globalThis.fetch = originalFetch; }
});
