import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sameEvent, recurringEventThemes } from '../scripts/lib/event-dedup.ts';
import { sameContentCopy, copyComparisonTitle } from '../scripts/lib/content-copy.ts';
import { dedup } from '../scripts/dedup.ts';
import { filterDateWindow } from '../scripts/filter-date-window.ts';
import { renderLine } from '../scripts/render-categorized-md.ts';
import { checkDedupRecurrence, formatRepeatedDestaqueMessage } from '../scripts/lib/invariant-checks/stage-4.ts';
import { findRepeatedDestaques } from '../scripts/lib/destaque-upgrade.ts';
import { extractThemesFromApproved } from '../scripts/refresh-past-editions.ts';

const ipo = 'Anthropic prices initial public offering';
const past = 'Anthropic estreia na bolsa e levanta US$ 119,5 bi';
const release = 'A Cora apresenta seis dicas para pequenos negócios usarem inteligência artificial na rotina. A primeira é organizar as finanças e acompanhar os pagamentos dos clientes. A segunda consiste em planejar campanhas e revisar mensagens antes do envio. Outra recomendação envolve analisar o estoque e comparar fornecedores para reduzir custos sem perder qualidade no atendimento aos consumidores.';
describe('#13923 regressões de recorrência', () => {
  it('normaliza IPO em inglês e português sem casar entidade genérica', () => {
    assert.ok(sameEvent(ipo, past)?.removable);
    assert.equal(sameEvent(ipo, 'Anthropic lança nova ferramenta'), null);
    assert.equal(sameEvent(ipo, 'Google estreia na bolsa'), null);
    assert.deepEqual(recurringEventThemes('Anthropic'), []);
    assert.equal(dedup([{url:'https://anthropic.com/ipo',title:ipo}],new Set(),.85,[past]).kept.length,0);
  });
  it('clusteriza três cópias Cora com títulos divergentes, preservando fontes', () => {
    const result = dedup([
      {url:'https://topfmsp.com/cora',title:'6 dicas práticas para usar IA na rotina de pequenos negócios - Top FM',summary:release},
      {url:'https://correiobraziliense.com.br/cora',title:'Inteligência artificial ajuda pequenos empreendedores',summary:release.replace('apresenta','reúne')},
      {url:'https://portaledicase.com/cora',title:'Como usar tecnologia para organizar seu negócio',summary:release},
    ],new Set(),.85);
    assert.equal(copyComparisonTitle('Modelo novo - preço reduzido', 'TechCrunch', 'https://techcrunch.com/a'), 'Modelo novo - preço reduzido');
    assert.equal(result.kept.length,1);
    assert.equal((result.kept[0].cluster_sources as unknown[]).length,2);
    assert.equal(sameContentCopy({summary:'resumo curto igual'},{summary:'resumo curto igual'}),false);
    assert.equal(sameContentCopy({summary:release},{summary:release.split(' ').reverse().join(' ')}),false);
    assert.equal(dedup([{url:'https://a.com/a',title:'6 dicas práticas para usar IA na rotina de pequenos negócios - Top FM',source:'Top FM'}, {url:'https://b.com/a',title:'6 dicas práticas para usar IA na rotina de pequenos negócios'}],new Set(),.85).kept.length,1);
  });
  it('mantém upgrades Google Search e Shirudo sem fonte nova apenas com aviso existente', () => {
    for (const title of ['Google Search personal intelligence','Shirudo (OpenAI/Cisco)']) {
      const url = 'https://example.com/'+encodeURIComponent(title);
      const warnings = findRepeatedDestaques([{article:{url,title,dedup_destaque_only:'upgrade'}}],new Map([[url,[{date:'2026-11-24',section:'RADAR'}]]]),u=>u);
      assert.equal(warnings.length,1);
      assert.equal(warnings[0].newerSources,0);
      assert.match(formatRepeatedDestaqueMessage(warnings[0]),/Nenhuma fonte nova/);
    }
  });
  it('mostra 8 dias isento por sender no gate e warning de tema em até 10 dias', () => {
    const root=mkdtempSync(resolve(tmpdir(),'recurrence-'));
    try {
      const editions=resolve(root,'data/editions'), current=resolve(editions,'261125'), old=resolve(editions,'261123');
      mkdirSync(resolve(current,'_internal'),{recursive:true}); mkdirSync(old,{recursive:true});
      const url='https://anthropic.com/ipo';
      const filtered=filterDateWindow({radar:[{url,title:ipo,date:'2026-11-17',always_consider:true}]},'2026-11-25',4);
      const item=filtered.kept.radar[0];
      assert.match(String(item.date_window_warning),/8 dias, isento por sender/);
      assert.match(renderLine({ url: item.url, title: item.title, date: item.date ?? undefined, date_window_warning: item.date_window_warning }),/8 dias, isento por sender/);
      writeFileSync(resolve(current,'_internal/01-approved.json'),JSON.stringify({radar:[item]}));
      writeFileSync(resolve(current,'02-reviewed.md'),`**📡 RADAR**\n\n${ipo}\n${url}\nResumo.\n`);
      writeFileSync(resolve(old,'02-reviewed.md'),`**DESTAQUE 1**\n\n**[${past}](https://example.com/past)**\n`);
      assert.ok(extractThemesFromApproved('261123',past,root).includes('IPO anthropic'));
      const warnings=checkDedupRecurrence(current,editions);
      assert.equal(warnings.length,2); assert.ok(warnings.every(v=>v.severity==='warning'));
      assert.match(warnings[1].message,/261123/);
      // D2 também alimenta o tema, mesmo sem IPO no assunto da edição.
      assert.ok(extractThemesFromApproved('261123','Outra notícia',root).includes('IPO anthropic'));
      const boundary=resolve(editions,'261115'); mkdirSync(boundary,{recursive:true});
      writeFileSync(resolve(boundary,'02-reviewed.md'),`**DESTAQUE 2**\n\n**[${past}](https://example.com/boundary)**\n`);
      assert.equal(checkDedupRecurrence(current,editions).length,3);
      const outside=resolve(editions,'261114'); mkdirSync(outside,{recursive:true});
      writeFileSync(resolve(outside,'02-reviewed.md'),`**DESTAQUE 2**\n\n**[${past}](https://example.com/outside)**\n`);
      assert.equal(checkDedupRecurrence(current,editions).length,3);
      const recent=filterDateWindow({radar:[{url,date:'2026-11-18',always_consider:true}]},'2026-11-25',4);
      assert.equal(recent.kept.radar[0].date_window_warning,undefined);
      writeFileSync(resolve(current,'02-reviewed.md'),'**📡 RADAR**\n\nAnthropic lança ferramenta\nhttps://example.com/new\nResumo.\n');
      assert.equal(checkDedupRecurrence(current,editions).length,0);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
