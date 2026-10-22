import { it } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentPublishedDestaques } from '../scripts/demote-same-fact-highlights.ts';
import assert from 'node:assert/strict';
import { curatePool, lowSignalFormat, POOL_PAST_WINDOW } from '../scripts/lib/pool-quality.ts';
import { applyStage2Caps } from '../scripts/lib/apply-stage2-caps.ts';
import { classifyNewsletterDiff } from '../scripts/derive-editor-requests.ts';

it('B: format filters, inbox exception and adjacent legitimate URLs', () => {
  for (const url of ['https://x.com/zuck/status/123?s=1', 'https://twitter.com/a/status/12', 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash']) {
    assert.ok(lowSignalFormat({ url }));
    assert.equal(lowSignalFormat({ url, editor_submitted: true }), null);
    assert.equal(lowSignalFormat({ url, flag: 'editor_submitted' }), null);
  }
  assert.equal(lowSignalFormat({ title: '6 melhores IAs para o Enem' }), 'listicle');
  for (const url of ['https://huggingface.co/blog/launch', 'https://huggingface.co/spaces/demo', 'https://x.com/zuck', 'https://example.com/a/status/123']) assert.equal(lowSignalFormat({ url }), null);
  const input = { radar: [{ url: 'https://x.com/a/status/1' }], use_melhor: [{ title: '6 melhores ferramentas' }] };
  const out = curatePool(input);
  assert.equal(out.radar?.length, 0);
  assert.equal(out.use_melhor?.length, 1);
  assert.equal(input.radar.length, 1);
});

it('A: same-fact matcher spans current highlights, current pool and history without losing candidates', () => {
  assert.equal(POOL_PAST_WINDOW, 7);
  const article = (url: string) => ({ url, title: 'OpenAI anuncia 554 casos e 379 vítimas', summary: 'OpenAI identificou 554 casos e 379 vítimas.' });
  const out = curatePool({ highlights: [{ article: article('https://a.com/h') }], radar: [article('https://b.com/secondary')] });
  assert.equal(out.radar?.length, 0);
  assert.equal((out.pool_reserve as unknown[]).length, 1);
  const current = curatePool({ lancamento: [article('https://a.com/l')], radar: [article('https://b.com/r')] });
  assert.equal(current.lancamento?.length, 1);
  assert.equal(current.radar?.length, 0);
  const past = [{ aammdd: '261013', n: 1, ...article('https://a.com/p'), text: '' }];
  assert.equal(curatePool({ radar: [article('https://b.com/r')] }, past).radar?.length, 0);
});

it('A/B: caps backfill with the next candidate and preserve reserve in output', () => {
  const radar = Array.from({ length: 8 }, (_, i) => ({ url: `https://source${i}.com/item`, title: `Report ${i}`, score: 80 - i }));
  const out = applyStage2Caps({ radar: [{ url: 'https://x.com/a/status/123', score: 99 }, ...radar] }).approved;
  assert.ok(out.radar?.some(a => a.url === radar[0].url));
  assert.ok(out.radar?.every(a => !a.url?.includes('x.com')));
  assert.equal((out.pool_reserve as unknown[]).length, 1);
});

it('D: promotion from radar to D1 emits neither pool-cut nor pool-add', () => {
  const item = '**[OpenAI rouba criptomoedas](https://example.com/crypto)**\nDescrição.\n';
  const before = '**📡 RADAR**\n\n' + item + '\n---\n';
  const after = '**DESTAQUE 1 | NOTÍCIAS**\n\n' + item + '\n---\n**📡 RADAR**\n\n---\n';
  const result = classifyNewsletterDiff(before, after);
  assert.ok(result.every(r => !['pool-cut', 'pool-add'].includes(r.request_type)));
});

// Reduced bilingual evidence from the seven pairs enumerated in the trusted
// issue analysis. No live data/ dependency: these run on a fresh CI checkout.
const pairs = [
  ['261014 Enter', 'OAB-SP processa a startup Enter por substituir advogados', 'Caso Enter opõe OAB à advocacia por IA'],
  ['261016 Android', 'Google Circle to Search checks text messages for scams', 'Google: Android protege mensagens e combate golpes'],
  ['261020 fund', 'Anthropic investing shares in the public benefit fund', 'Anthropic commits shares to a public benefit fund'],
  ['261013 Gemini', 'Gemini at Work: Introducing Gemini agent', 'Gemini está virando copiloto do trabalho dentro dos apps'],
  ['261019 states', 'Eight states accuse OpenAI of coaching children in lawsuit', 'States bring lawsuits against OpenAI over kids online safety'],
  ['261021 employment', 'How employment is changing at Anthropic: restructuring work and hiring', 'Anthropic workforce has become less junior and spends time in meetings'],
  ['261021 explainers', 'Build live dashboards and animate explainers with Claude', 'Claude cria vídeos explicativos a partir dos dados da empresa'],
];
for (const [label, previous, title] of pairs) it(`A historical fixture: ${label}`, () => {
  const out = curatePool({ radar: [{ url: 'https://secondary.com/article', title }] }, [
    { aammdd: '261013', n: 1, url: 'https://primary.com/article', title: previous, text: '' },
  ]);
  assert.equal(out.radar?.length, 0);
  assert.equal((out.pool_reserve as unknown[]).length, 1);
});
it('A does not demote unrelated coverage of the same companies', () => {
  const out = curatePool({ radar: [{ url: 'https://a.com/new', title: 'OpenAI launches a new coding tool' }] }, [
    { aammdd: '261013', n: 1, url: 'https://b.com/old', title: 'States sue OpenAI over kids safety', text: '' },
  ]);
  assert.equal(out.radar?.length, 1);
});

it('A: history includes exactly the seven prior editions, never the current or future edition', () => {
  const root = mkdtempSync(join(tmpdir(), 'pool-history-'));
  try {
    for (let day = 10; day <= 19; day++) {
      const dir = join(root, `2610${day}`);
      mkdirSync(dir);
      writeFileSync(join(dir, '01-approved.json'), JSON.stringify({ highlights: [{ title: `News ${day}`, url: `https://source.com/${day}` }] }));
    }
    const past = readRecentPublishedDestaques(root, POOL_PAST_WINDOW, '261018');
    assert.deepEqual([...new Set(past.map(p => p.aammdd))].sort(), ['261011','261012','261013','261014','261015','261016','261017']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('C: both daily scorers keep the same explicit penalty and exclusion boundary', () => {
  const policies = ['scorer.md', 'scorer-chunk.md'].map(name => {
    const text = readFileSync(new URL(`../.claude/agents/${name}`, import.meta.url), 'utf8');
    const policy = text.split('\n').find(line => line.includes('Anúncio corporativo de baixa afinidade (#10794)'));
    assert.ok(policy);
    for (const word of ['infraestrutura', 'parceria', 'nuvem/região', 'filing financeiro', 'corporate_announcement:-10', 'nunca exclusão']) assert.ok(policy.includes(word), word);
    return policy;
  });
  assert.equal(policies[0], policies[1]);
});
