import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyNegativeHighlightPolicy } from '../scripts/lib/negative-highlight-policy.ts';
import type { PublishedDestaque } from '../scripts/lib/same-fact-demotion.ts';
const h = (title: string, score: number, negative = false) => ({ score, article: { title, url: `https://example.com/${score}`, negative_impact: negative, summary: '' } });
const merit = [h('Pesquisa proteínas',92), h('Nubank nota',88), h('Mistral voz',85)];
test('#10795: processo e checagem não tomam a cota de dano concreto', () => {
  for (const title of ['Empresa acusada de fraude', 'Checagem de deepfake eleitoral']) {
    const result = applyNegativeHighlightPolicy([h(title,90,true), ...merit, h('Óculos gravaram sem comando',78,true)], [], '261022');
    assert.equal(result.highlights[2].article.title, 'Óculos gravaram sem comando');
    assert.ok(!result.highlights.slice(0,3).some(x => x.article.title === title));
  }
});
test('#10795: diferença >15 impõe D3, exatamente 15 permite D1', () => {
  for (const score of [69,70]) {
    const neg = h('Óculos gravaram sem comando',score,true);
    const result = applyNegativeHighlightPolicy([neg,...merit], [], '261022');
    assert.equal(result.highlights[score === 69 ? 2 : 0].article.title, neg.article.title);
    assert.equal(result.highlights.length,4);
    assert.equal(neg.article.negative_impact,true);
  }
});
test('#10795: entidade+tema recente sai, dia 15 e outro tema permanecem', () => {
  const neg = h('OpenAI vazou conversas privadas',80,true);
  for (const [date, text, excluded] of [['261008','OpenAI vazou conversas privadas',true], ['261007','OpenAI vazou conversas privadas',false], ['261008','OpenAI lança pesquisa de proteínas',false]] as const) {
    const past: PublishedDestaque[] = [{aammdd:date,n:1,title:text,text:'',url:'https://old.example/news'}];
    const result = applyNegativeHighlightPolicy([neg,...merit],past,'261022');
    assert.equal(result.highlights[0].article.title !== neg.article.title, excluded);
  }
});
test('#10795: pool sem digno avisa, sem inventar tag e sem mutar input', () => {
  const input = [h('Processo contra empresa',90,true),...merit];
  const before = JSON.stringify(input);
  const result = applyNegativeHighlightPolicy(input,[], '261022');
  assert.ok(result.notes.some(n => n.includes('pool sem negativo elegível')));
  assert.equal(JSON.stringify(input),before);
});
test('#10795: prompts de scoring/seleção e regra editorial preservam as três decisões', () => {
  for (const path of ['.claude/agents/scorer.md','.claude/agents/scorer-chunk.md','.claude/agents/scorer-select.md','context/editorial-rules.md']) {
    const text = readFileSync(path,'utf8');
    for (const rule of ['processo/acusação e checagem de deepfake','últimos 14 dias','mais de 15 pontos abaixo','D3','≥1 negativo (#3916)']) assert.ok(text.includes(rule), `${path}: ${rule}`);
  }
});
test('#10795: Muse repetido sai mesmo sem versão ou cifras; outro dano real ocupa a cota', () => {
  const muse = h('O Muse da Meta vaza links privados',72,true);
  const clean = h('Óculos gravaram sem comando',80,true);
  const past: PublishedDestaque[] = [{aammdd:'261008',n:1,title:'O Muse da Meta coleta dados privados',text:'',url:'https://old.example/muse'}];
  const result = applyNegativeHighlightPolicy([muse,...merit,clean],past,'261022');
  assert.ok(!result.highlights.slice(0,3).some(x => x.article.title === muse.article.title));
  assert.ok(result.highlights.slice(0,3).some(x => x.article.title === clean.article.title));
});
