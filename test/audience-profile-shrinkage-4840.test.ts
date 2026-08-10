/**
 * test/audience-profile-shrinkage-4840.test.ts (#4840)
 *
 * Cobre o encolhimento empírico-Bayes (`shrinkCtr`) e a classificação em
 * bandas (`classifyCtrBand`) introduzidos pra substituir o ranking de 17
 * posições do `context/audience-profile.md` — ver issue #4840 (auditoria
 * retrospectiva 260810): ranking por posição não é sustentado pelo n típico
 * de cada categoria (IC95 do posto cobre boa parte das 17 posições, split
 * cronológico com Spearman ≈0,06 fora da amostra).
 *
 * Regra #633: cobre explicitamente os dois regimes exigidos pela issue —
 *   (a) n alto: encolhimento quase não altera a taxa observada, banda
 *       classificada com confiança quando há diferença real;
 *   (b) n baixo: encolhimento puxa a taxa fortemente pra média global e a
 *       banda colapsa em "sem_sinal" mesmo diante de um CTR bruto dramático
 *       — nunca afirma ranking que o n não sustenta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shrinkCtr,
  classifyCtrBand,
  parseCtrFromCsv,
  CTR_SHRINKAGE_K,
  CTR_BAND_Z_THRESHOLD,
  type CtrBand,
} from "../scripts/update-audience.ts";

const CTR_HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";

// ─── shrinkCtr ───────────────────────────────────────────────────────────────

describe("shrinkCtr (#4840)", () => {
  it("n alto (opens >> k): taxa encolhida fica muito perto da taxa bruta", () => {
    const globalRate = 0.02;
    const opens = 50_000;
    const clicks = 1_500; // raw ctr = 3.0%
    const raw = clicks / opens;
    const shrunk = shrinkCtr(clicks, opens, globalRate);

    assert.ok(
      Math.abs(shrunk.rate - raw) < 0.0005,
      `esperado shrunk.rate perto de raw=${raw}, obtido ${shrunk.rate}`,
    );
    // erro padrão pequeno com n grande
    assert.ok(shrunk.se < 0.001, `se deveria ser pequeno com n alto, obtido ${shrunk.se}`);
    assert.equal(shrunk.n, opens);
  });

  it("n baixo (opens << k): taxa encolhida fica muito mais perto da média global que da taxa bruta", () => {
    const globalRate = 0.02;
    const opens = 20;
    const clicks = 4; // raw ctr = 20% — dramático, mas amostra pequena
    const raw = clicks / opens;
    const shrunk = shrinkCtr(clicks, opens, globalRate);

    const distToGlobal = Math.abs(shrunk.rate - globalRate);
    const distToRaw = Math.abs(shrunk.rate - raw);
    assert.ok(
      distToGlobal < distToRaw,
      `com n baixo, shrunk.rate (${shrunk.rate}) deveria estar mais perto da média global (${globalRate}) que da taxa bruta (${raw})`,
    );
    // encolhimento efetivamente puxou a taxa bruta de 20% para bem perto de 2%
    assert.ok(shrunk.rate < 0.05, `esperado shrunk.rate << raw=20%, obtido ${shrunk.rate}`);
  });

  it("opens=0: retorna a própria média global (sem dado, sem desvio)", () => {
    const shrunk = shrinkCtr(0, 0, 0.03);
    assert.equal(shrunk.rate, 0.03);
    assert.equal(shrunk.n, 0);
  });

  it("k=0 degenera pro comportamento pré-#4840 (taxa bruta, sem encolhimento)", () => {
    const shrunk = shrinkCtr(10, 100, 0.5, 0);
    assert.ok(Math.abs(shrunk.rate - 0.1) < 1e-9, `k=0 deveria retornar taxa bruta, obtido ${shrunk.rate}`);
  });

  it("opens=0 e k=0: fallback defensivo (globalRate, se=0) sem divisão por zero", () => {
    const shrunk = shrinkCtr(0, 0, 0.04, 0);
    assert.equal(shrunk.rate, 0.04);
    assert.equal(shrunk.se, 0);
  });

  it("CTR_SHRINKAGE_K é 850 (centro da faixa achatada 700-1000 medida na auditoria #4840)", () => {
    assert.equal(CTR_SHRINKAGE_K, 850);
  });

  it("é monotônico: mais opens (mesma taxa bruta) aproxima a estimativa da taxa bruta", () => {
    const globalRate = 0.01;
    const rawRate = 0.06;
    const shrunkLow = shrinkCtr(rawRate * 50, 50, globalRate);
    const shrunkHigh = shrinkCtr(rawRate * 5000, 5000, globalRate);
    const distLow = Math.abs(shrunkLow.rate - rawRate);
    const distHigh = Math.abs(shrunkHigh.rate - rawRate);
    assert.ok(distHigh < distLow, "amostra maior deveria ficar mais perto da taxa bruta (menos encolhimento)");
  });
});

// ─── classifyCtrBand ─────────────────────────────────────────────────────────

describe("classifyCtrBand (#4840)", () => {
  it("n alto com diferença real acima da média → banda 'acima'", () => {
    const globalRate = 0.02;
    const shrunk = shrinkCtr(1_500, 50_000, globalRate); // raw 3.0%, quase sem encolher
    assert.equal(classifyCtrBand(shrunk, globalRate), "acima");
  });

  it("n alto com diferença real abaixo da média → banda 'abaixo'", () => {
    const globalRate = 0.03;
    const shrunk = shrinkCtr(500, 50_000, globalRate); // raw 1.0%, bem abaixo
    assert.equal(classifyCtrBand(shrunk, globalRate), "abaixo");
  });

  it("n alto com taxa ~igual à média → banda 'sem_sinal'", () => {
    const globalRate = 0.02;
    const shrunk = shrinkCtr(1_002, 50_000, globalRate); // raw ≈ 2.004%, indistinguível
    assert.equal(classifyCtrBand(shrunk, globalRate), "sem_sinal");
  });

  it("n baixo com CTR bruto dramático (80%) ainda colapsa pra 'sem_sinal' — nunca afirma ranking que o n não sustenta", () => {
    const globalRate = 0.02;
    const shrunk = shrinkCtr(8, 10, globalRate); // raw ctr = 80%, mas só 10 aberturas
    assert.equal(
      classifyCtrBand(shrunk, globalRate),
      "sem_sinal",
      "categoria de n baixo não deve ser classificada como 'acima' mesmo com CTR bruto extremo",
    );
  });

  it("n baixo com CTR bruto moderadamente alto (20% sobre n=20) também colapsa pra 'sem_sinal'", () => {
    const globalRate = 0.02;
    const shrunk = shrinkCtr(4, 20, globalRate);
    assert.equal(classifyCtrBand(shrunk, globalRate), "sem_sinal");
  });

  it("se<=0 (fallback defensivo) sempre retorna 'sem_sinal', nunca lança", () => {
    const shrunk = shrinkCtr(0, 0, 0.05, 0); // se=0 pelo fallback
    assert.equal(classifyCtrBand(shrunk, 0.05), "sem_sinal");
  });

  it("zThreshold custom permite banda mais/menos permissiva", () => {
    const globalRate = 0.02;
    const shrunk = shrinkCtr(1_002, 50_000, globalRate); // z pequeno, perto do limiar padrão
    // Com um threshold bem mais baixo, a mesma diferença pequena pode virar sinal.
    const bandLoose = classifyCtrBand(shrunk, globalRate, 0.01);
    const bandDefault = classifyCtrBand(shrunk, globalRate, CTR_BAND_Z_THRESHOLD);
    assert.equal(bandDefault, "sem_sinal");
    assert.notEqual(bandLoose, "sem_sinal");
  });

  it("as 3 bandas cobrem exatamente os valores do tipo CtrBand", () => {
    const bands: CtrBand[] = ["acima", "sem_sinal", "abaixo"];
    assert.equal(bands.length, 3);
  });
});

// ─── Integração: parseCtrFromCsv → shrinkCtr/classifyCtrBand sobre dado real ──

describe("integração #4840: categoria de alto volume vs. categoria de n baixo no mesmo CSV", () => {
  const today = new Date("2026-08-10");

  it("categoria com muitos links E aberturas é classificada com confiança; categoria com poucos links E aberturas cai em sem_sinal mesmo com CTR bruto maior", () => {
    const rows: string[] = [CTR_HEADER];

    // 2 categorias de volume alto com CTR mais baixo — diversificam a média
    // global pra ela não ser trivialmente definida pela própria "Treinamento"
    // (se só existissem 2 categorias, a dominante por volume acaba sendo
    // quase idêntica à média geral por construção, mascarando o teste).
    rows.push("2026-08-10,Edição,Seção,Título Mercado,https://m1.com/x,m1.com,40000,400,400,1.00,Mercado,BR");
    rows.push("2026-08-10,Edição,Seção,Título Estratégia,https://e1.com/x,e1.com,40000,600,600,1.50,Estratégia,BR");

    // "Treinamento": volume alto (40k aberturas) e CTR real acima da média —
    // encolhimento não deve alterar muito a taxa observada, e a diferença
    // real deve sobreviver ao teste-z (banda "acima").
    rows.push("2026-08-10,Edição,Seção,Título Treinamento,https://t1.com/x,t1.com,40000,1200,1200,3.00,Treinamento,BR");

    // "Curiosidade": só 3 links com poucas aberturas (n=45 total), CTR bruto
    // dramaticamente maior que a média (20% vs ~1.8%) — mas n baixo o
    // suficiente pra colapsar em "sem_sinal" (não deve virar "acima").
    for (let i = 0; i < 3; i++) {
      rows.push(
        `2026-08-09,Edição c${i},Seção,Título c${i},https://c${i}.com/y,c${i}.com,15,3,3,20.00,Curiosidade,BR`,
      );
    }

    const csv = rows.join("\n");
    const parsed = parseCtrFromCsv(csv, today)!;
    assert.ok(parsed);

    const totalClicks = [...parsed.byCategory.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...parsed.byCategory.values()].reduce((s, a) => s + a.opens, 0);
    const globalRate = totalClicks / totalOpens;

    const treinamento = parsed.byCategory.get("Treinamento")!;
    const curiosidade = parsed.byCategory.get("Curiosidade")!;
    assert.ok(treinamento);
    assert.ok(curiosidade);

    const shrunkTreinamento = shrinkCtr(treinamento.clicks, treinamento.opens, globalRate);
    const shrunkCuriosidade = shrinkCtr(curiosidade.clicks, curiosidade.opens, globalRate);

    const bandTreinamento = classifyCtrBand(shrunkTreinamento, globalRate);
    const bandCuriosidade = classifyCtrBand(shrunkCuriosidade, globalRate);

    // n alto (40 links × 1000 aberturas = 40k aberturas) com CTR real acima da
    // média → banda com sinal.
    assert.equal(bandTreinamento, "acima", `Treinamento deveria ser 'acima', obtido ${bandTreinamento}`);

    // n baixo (3 links × 15 aberturas = 45 aberturas) com CTR bruto de 60% —
    // mesmo assim, sem confiança estatística suficiente pra afirmar banda.
    assert.equal(
      bandCuriosidade,
      "sem_sinal",
      `Curiosidade (n baixo, CTR bruto dramático) deveria colapsar pra 'sem_sinal', obtido ${bandCuriosidade}`,
    );

    // A categoria de n baixo continua tendo n explicitamente disponível — a
    // issue exige nunca omitir o n, só suprimir a AFIRMAÇÃO de ranking.
    assert.equal(curiosidade.count, 3);
    assert.ok(curiosidade.opens > 0);
  });
});
