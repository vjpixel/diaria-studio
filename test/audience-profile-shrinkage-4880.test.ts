/**
 * test/audience-profile-shrinkage-4880.test.ts (#4880)
 *
 * O #4840 introduziu o encolhimento empírico-Bayes (`shrinkCtr` +
 * `classifyCtrBand`) em `context/audience-profile.md`, mas só aplicou às
 * seções "By category" e "By domain". As seções "Destaques por categoria +
 * origem" (`byCatOrigin`) e "Engajamento por origem" (`byOrigin`) continuaram
 * ranqueando por CTR bruto — e `byCatOrigin` subdivide ainda mais que
 * `byCategory` (interseção categoria×origem), então o `n` típico ali é
 * MENOR, tornando o problema estatístico do #4840 ainda mais grave.
 *
 * Regra #633: cobre explicitamente os dois regimes exigidos pela issue —
 *   (a) n alto: comportamento pouco alterado pelo encolhimento (taxa
 *       encolhida fica perto da bruta, banda pode ser classificada com
 *       confiança quando há diferença real);
 *   (b) n baixo: mesmo com CTR bruto dramático, a taxa encolhida cai perto
 *       da média global e a banda colapsa em "sem_sinal" — nunca afirma
 *       ranking que o n não sustenta.
 *
 * Mesmo padrão de `test/audience-profile-shrinkage-4840.test.ts`: testa as
 * funções puras (`shrinkCtr`/`classifyCtrBand`) aplicadas sobre os mapas
 * `byCatOrigin`/`byOrigin` retornados por `parseCtrFromCsv`, espelhando
 * exatamente o que `scripts/update-audience.ts` agora faz nessas duas
 * seções (achado #4880, review consolidado 260810).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shrinkCtr,
  classifyCtrBand,
  parseCtrFromCsv,
} from "../scripts/update-audience.ts";

const CTR_HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";

describe("integração #4880: byCatOrigin — combinação de alto volume vs. de n baixo no mesmo CSV", () => {
  const today = new Date("2026-08-10");

  it("combinação categoria×origem com muitos links/aberturas é classificada com confiança; combinação de n baixo cai em sem_sinal mesmo com CTR bruto maior", () => {
    const rows: string[] = [CTR_HEADER];

    // 2 combinações de volume alto com CTR mais baixo — diversificam a média
    // global (mesmo racional do teste #4840: evita que a média global seja
    // trivialmente definida pela própria combinação dominante).
    rows.push("2026-08-10,Edição,Seção,Título Mercado,https://m1.com/x,m1.com,40000,400,400,1.00,Mercado,BR");
    rows.push("2026-08-10,Edição,Seção,Título Estratégia,https://e1.com/x,e1.com,40000,600,600,1.50,Estratégia,BR");

    // "Treinamento|BR": volume alto (40k aberturas) e CTR real acima da
    // média — encolhimento não deve alterar muito a taxa observada.
    rows.push("2026-08-10,Edição,Seção,Título Treinamento,https://t1.com/x,t1.com,40000,1200,1200,3.00,Treinamento,BR");

    // "Curiosidade|INT": só 3 links com poucas aberturas (n=45 total), CTR
    // bruto dramaticamente maior que a média — mas n baixo o suficiente pra
    // colapsar em "sem_sinal" na classificação por banda.
    for (let i = 0; i < 3; i++) {
      rows.push(
        `2026-08-09,Edição c${i},Seção,Título c${i},https://c${i}.com/y,c${i}.com,15,3,3,20.00,Curiosidade,INT`,
      );
    }

    const csv = rows.join("\n");
    const parsed = parseCtrFromCsv(csv, today)!;
    assert.ok(parsed);

    const totalClicks = [...parsed.byCatOrigin.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...parsed.byCatOrigin.values()].reduce((s, a) => s + a.opens, 0);
    const globalRate = totalClicks / totalOpens;

    const treinamentoBr = parsed.byCatOrigin.get("Treinamento|BR")!;
    const curiosidadeInt = parsed.byCatOrigin.get("Curiosidade|INT")!;
    assert.ok(treinamentoBr);
    assert.ok(curiosidadeInt);

    const shrunkTreinamento = shrinkCtr(treinamentoBr.clicks, treinamentoBr.opens, globalRate);
    const shrunkCuriosidade = shrinkCtr(curiosidadeInt.clicks, curiosidadeInt.opens, globalRate);

    const bandTreinamento = classifyCtrBand(shrunkTreinamento, globalRate);
    const bandCuriosidade = classifyCtrBand(shrunkCuriosidade, globalRate);

    assert.equal(
      bandTreinamento,
      "acima",
      `Treinamento|BR (n alto, CTR real acima da média) deveria ser 'acima', obtido ${bandTreinamento}`,
    );
    assert.equal(
      bandCuriosidade,
      "sem_sinal",
      `Curiosidade|INT (n baixo, CTR bruto dramático) deveria colapsar pra 'sem_sinal', obtido ${bandCuriosidade}`,
    );

    // A combinação de n baixo continua tendo o n publicado — a issue exige
    // nunca omitir o n, só suprimir a AFIRMAÇÃO de ranking (mesma garantia
    // do #4840 aplicada aqui).
    assert.equal(curiosidadeInt.count, 3);
    assert.ok(curiosidadeInt.opens > 0);

    // Ranking por CTR ENCOLHIDO (o que scripts/update-audience.ts agora usa
    // pra ordenar "Destaques por categoria + origem") não deve colocar a
    // combinação de n baixo (CTR bruto 20%) acima da de n alto (CTR real
    // 3%) — o CTR bruto sozinho colocaria "Curiosidade|INT" no topo.
    assert.ok(
      shrunkTreinamento.rate > shrunkCuriosidade.rate,
      `CTR encolhido de Treinamento|BR (${shrunkTreinamento.rate}) deveria superar Curiosidade|INT (${shrunkCuriosidade.rate}) — CTR bruto invertia essa ordem (3% vs 20%)`,
    );
  });
});

describe("integração #4880: byOrigin — origem de alto volume vs. origem de n baixo no mesmo CSV", () => {
  const today = new Date("2026-08-10");

  it("origem com muitos links/aberturas é classificada com confiança; origem de n baixo cai em sem_sinal mesmo com CTR bruto maior", () => {
    const rows: string[] = [CTR_HEADER];

    // "BR": volume alto (40k aberturas), CTR abaixo da média — usado só pra
    // compor uma média global não-trivial (evita que a média seja
    // trivialmente definida pela origem dominante).
    rows.push("2026-08-10,Edição,Seção,Título BR,https://b1.com/x,b1.com,40000,800,800,2.00,Mercado,BR");

    // "INT": volume alto (50k aberturas) com CTR real acima da média — o
    // encolhimento não deve alterar muito a taxa observada.
    rows.push("2026-08-10,Edição,Seção,Título INT,https://i1.com/x,i1.com,50000,2500,2500,5.00,Mercado,INT");

    // Terceira origem sintética "XX": 1 único link com pouquíssimas
    // aberturas (n=10) e CTR bruto dramático (50%) — deve colapsar em
    // "sem_sinal" apesar do CTR bruto extremo, exatamente como o #4840 já
    // garante pra byCategory.
    rows.push("2026-08-09,Edição x,Seção,Título x,https://x0.com/y,x0.com,10,5,5,50.00,Mercado,XX");

    const csv = rows.join("\n");
    const parsed = parseCtrFromCsv(csv, today)!;
    assert.ok(parsed);

    const totalClicks = [...parsed.byOrigin.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...parsed.byOrigin.values()].reduce((s, a) => s + a.opens, 0);
    const globalRate = totalClicks / totalOpens;

    const int_ = parsed.byOrigin.get("INT")!;
    const xx = parsed.byOrigin.get("XX")!;
    assert.ok(int_);
    assert.ok(xx);

    const shrunkInt = shrinkCtr(int_.clicks, int_.opens, globalRate);
    const shrunkXx = shrinkCtr(xx.clicks, xx.opens, globalRate);

    const bandInt = classifyCtrBand(shrunkInt, globalRate);
    const bandXx = classifyCtrBand(shrunkXx, globalRate);

    assert.equal(
      bandInt,
      "acima",
      `INT (n alto, CTR real acima da média) deveria ser 'acima', obtido ${bandInt}`,
    );
    assert.equal(
      bandXx,
      "sem_sinal",
      `XX (n baixo, CTR bruto dramático) deveria colapsar pra 'sem_sinal', obtido ${bandXx}`,
    );

    // O n continua publicado mesmo pra origem "sem sinal" — transparência
    // não removida pelo encolhimento (mesmo invariante do #4840).
    assert.equal(xx.count, 1);
    assert.ok(xx.opens > 0);

    // A ordenação por CTR ENCOLHIDO usada em "Engajamento por origem" não
    // deve colocar a origem de n baixo (CTR bruto ~27%) acima da origem de
    // n alto (CTR real 3%) — o CTR bruto sozinho inverteria essa ordem.
    assert.ok(
      shrunkInt.rate > shrunkXx.rate,
      `CTR encolhido de INT (${shrunkInt.rate}) deveria superar XX (${shrunkXx.rate}) — CTR bruto invertia essa ordem`,
    );
  });

  it("n alto em ambas origens (BR vs INT): encolhimento quase não altera a taxa observada", () => {
    const rows: string[] = [CTR_HEADER];
    rows.push("2026-08-10,Edição,Seção,Título BR,https://b1.com/x,b1.com,50000,1000,1000,2.00,Mercado,BR");
    rows.push("2026-08-10,Edição,Seção,Título INT,https://i1.com/x,i1.com,50000,900,900,1.80,Mercado,INT");

    const csv = rows.join("\n");
    const parsed = parseCtrFromCsv(csv, today)!;
    assert.ok(parsed);

    const totalClicks = [...parsed.byOrigin.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...parsed.byOrigin.values()].reduce((s, a) => s + a.opens, 0);
    const globalRate = totalClicks / totalOpens;

    const br = parsed.byOrigin.get("BR")!;
    const raw = br.clicks / br.opens;
    const shrunk = shrinkCtr(br.clicks, br.opens, globalRate);

    assert.ok(
      Math.abs(shrunk.rate - raw) < 0.001,
      `com n alto (50k aberturas), esperado shrunk.rate (${shrunk.rate}) perto da taxa bruta (${raw})`,
    );
  });
});
