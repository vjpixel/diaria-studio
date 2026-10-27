import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyNewsletterDiff, classifyPoolDiff, rederiveStage2FileRequests } from '../scripts/derive-editor-requests.ts';

const press = 'https://canaltech.com.br/seguranca/hackers-claude-grok';
const primary = 'https://straiker.ai/blog/inside-carliy0s';
const body = 'Hackers usaram Claude e Grok para atacar bancos e automatizar operações contra instituições financeiras.';
const md = (url: string, title: string, text = body) => `**DESTAQUE 1 | NOTÍCIAS**\n\n**[${title}](${url})**\n\n${text}\n`;
const oldMd = md(press, 'Claude e Grok viram equipe de hackers contra bancos');
const newMd = md(primary, 'Hackers usam Claude e Grok contra bancos');
const selection = { before: new Map([['d1', press]]), after: new Map([['d1', press]]) };

it('261026: rederive reconhece fonte trocada só no markdown com approved inalterado', () => {
  const dir = mkdtempSync(join(tmpdir(), 'derive-11170-'));
  try {
    const snap = join(dir, '_internal/editor-request-snapshots/stage2-post-gate');
    mkdirSync(join(snap, '_internal'), { recursive: true });
    const approved = JSON.stringify({ highlights: [{ url: press, article: { url: press } }] });
    writeFileSync(join(snap, '_internal/01-approved.json'), approved);
    writeFileSync(join(dir, '_internal/01-approved.json'), approved);
    writeFileSync(join(snap, '02-reviewed.md'), oldMd);
    writeFileSync(join(dir, '02-reviewed.md'), newMd);
    const out = rederiveStage2FileRequests(dir)!;
    assert.equal(out.length, 1);
    assert.equal(out[0].request_type, 'link-swap');
    assert.equal(out[0].context?.change_kind, 'fonte-trocada');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('mantém destaque-swap sem approved, com corpo diferente ou seleção alterada', () => {
  for (const out of [
    classifyNewsletterDiff(oldMd, newMd),
    classifyNewsletterDiff(oldMd, md(primary, 'Outra história', 'Um novo modelo de imagens chega hoje ao mercado brasileiro.'), undefined, selection),
    classifyNewsletterDiff(oldMd, newMd, undefined, { ...selection, after: new Map([['d1', primary]]) }),
    classifyNewsletterDiff(oldMd, newMd, undefined, { ...selection, before: new Map([...selection.before, ['d2', primary]]) }),
  ]) assert.equal(out[0].request_type, 'destaque-swap');
});

it('261021: espelho no radar com fonte trocada e destaque reordenado não entra nem sai do pool', () => {
  const oldItem = { url: 'https://canaltech.com.br/openai-cripto', title: 'Modelo de IA da OpenAI rouba criptomoedas' };
  const newItem = { ...oldItem, url: 'https://alignment.openai.com/misalignment-reports/crypto' };
  const other = { url: 'https://example.com/other' };
  const oldJson = { highlights: [other, other, oldItem], radar: [oldItem] };
  const newJson = { highlights: [newItem, other, other], radar: [newItem] };
  assert.deepEqual(classifyPoolDiff(oldJson, newJson), []);
  // Itens genuínos do pool continuam reportados.
  const out = classifyPoolDiff({ ...oldJson, radar: [...oldJson.radar, { url: 'https://example.com/cut' }] },
    { ...newJson, radar: [...newJson.radar, { url: 'https://example.com/add' }] });
  assert.deepEqual(out.map(r => r.request_type), ['pool-cut', 'pool-add']);
});
