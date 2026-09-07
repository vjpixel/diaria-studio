/**
 * test/acervo-staleness-7591.test.ts (#7591)
 *
 * Entre 27/08 e 07/09/2026 o acervo público ficou 12 dias parado, e nenhum
 * alarme disparou. O `Diaria-Edicao-Diaria-Staleness-Alarm` (#5563) esteve
 * correto e mudo o tempo todo: ele checa se a edição foi PRODUZIDA, e as de
 * setembro existiam em disco. Ninguém comparava produção com publicação.
 *
 * O #7578 fechou a lacuna POR EDIÇÃO (invariante que trava o gate 6). Este
 * alarme fecha a outra metade: **nenhuma edição rodar por dias.**
 *
 * O que estes testes travam:
 *
 * 1. **Dias ÚTEIS, não corridos.** Corridos fariam toda segunda parecer 3 dias
 *    de defasagem, o alarme viraria ruído semanal, e ninguém mais olharia.
 * 2. **"Sem dado" ≠ "defasado".** Falha de rede não pode abrir issue — é o
 *    jeito mais rápido de treinar o editor a ignorar o alarme.
 * 3. **O sinal decisivo é o do LEITOR.** Repo em dia com host velho é o caso
 *    real (o PR de publicação não é mergeado sozinho, #6598), e é justamente o
 *    que uma comparação só local não veria.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACERVO_STALENESS_MAX_BUSINESS_DAYS,
  businessDaysBetween,
  editionIdToDate,
  evaluateAcervoStaleness,
  latestDateInArchiveHtml,
  latestLastmod,
  type AcervoSnapshot,
} from "../scripts/lib/acervo-staleness.ts";

const base: AcervoSnapshot = {
  produzida: "2026-09-04",
  sitemapLocal: "2026-09-04",
  aoVivo: "2026-09-04",
  hoje: "2026-09-07",
};

describe("#7591 — dias úteis, não corridos", () => {
  it("sexta → segunda é 1 dia útil, não 3", () => {
    // 2026-09-04 é sexta; 2026-09-07, segunda. Contar corridos faria toda
    // segunda-feira alarmar.
    assert.equal(businessDaysBetween("2026-09-04", "2026-09-07"), 1);
  });

  it("conta os úteis num intervalo que atravessa dois fins de semana", () => {
    // 27/08 (qui) → 07/09 (seg): o buraco real. 11 dias corridos, 7 úteis —
    // 28, 31, 1, 2, 3, 4 e 7. Os dois fins de semana somem, que é o ponto.
    assert.equal(businessDaysBetween("2026-08-27", "2026-09-07"), 7);
  });

  it("mesma data e data invertida são 0, nunca negativo", () => {
    assert.equal(businessDaysBetween("2026-09-04", "2026-09-04"), 0);
    assert.equal(businessDaysBetween("2026-09-07", "2026-09-04"), 0);
  });

  it("data inválida é 0, não NaN", () => {
    assert.equal(businessDaysBetween("nao-e-data", "2026-09-07"), 0);
  });
});

describe("#7591 — o veredito", () => {
  it("as três fontes concordando é `ok`", () => {
    const r = evaluateAcervoStaleness(base);
    assert.equal(r.verdict, "ok");
    assert.equal(r.diasUteis, 0);
    assert.deepEqual(r.lacunas, []);
  });

  it("defasagem dentro do limiar ainda é `ok` — a diária folga no fim de semana", () => {
    const r = evaluateAcervoStaleness({ ...base, aoVivo: "2026-09-03" });
    assert.equal(r.verdict, "ok");
    assert.equal(r.diasUteis, 1);
  });

  it("REGRESSÃO: o buraco de 12 dias de 27/08 alarma", () => {
    const r = evaluateAcervoStaleness({ ...base, aoVivo: "2026-08-26" });
    assert.equal(r.verdict, "defasado");
    assert.ok((r.diasUteis ?? 0) > ACERVO_STALENESS_MAX_BUSINESS_DAYS);
    assert.match(r.resumo, /2026-08-26/, "o resumo nomeia o que o leitor vê");
    assert.match(r.resumo, /2026-09-04/, "e o que existe");
  });

  it("aponta a publicação quando o REPO está atrás", () => {
    const r = evaluateAcervoStaleness({ ...base, sitemapLocal: "2026-08-26", aoVivo: "2026-08-26" });
    assert.equal(r.verdict, "defasado");
    assert.match(r.resumo, /não foi publicada no repo/);
  });

  it("aponta o DEPLOY quando o repo está em dia e o host não", () => {
    // O caso que uma comparação só local nunca veria: o PR de publicação existe
    // e foi mergeado, mas o worker não foi deployado — ou o inverso, o PR nem
    // foi mergeado (`publish-edition-site-page` abre e nunca mergeia, #6598).
    const r = evaluateAcervoStaleness({ ...base, aoVivo: "2026-08-26" });
    assert.match(r.resumo, /falta deploy/);
  });
});

describe("#7591 — 'sem dado' nunca vira alarme", () => {
  it("host fora do ar é `sem-dado`, não `defasado`", () => {
    const r = evaluateAcervoStaleness({ ...base, aoVivo: null });
    assert.equal(r.verdict, "sem-dado");
    assert.equal(r.diasUteis, null);
    assert.ok(r.lacunas.some((l) => l.includes("arquivo.diar.ia.br")));
  });

  it("sem `data/` usa o sitemap do repo como referência e SEGUE avaliando", () => {
    // `data/` é gitignored: exigir sua presença deixaria o alarme sem rodar em
    // metade dos ambientes. Um alarme que não roda é pior que um parcial.
    const r = evaluateAcervoStaleness({ ...base, produzida: null, aoVivo: "2026-08-26" });
    assert.equal(r.verdict, "defasado");
    assert.ok(r.lacunas.some((l) => l.includes("data/editions")), "mas diz o que não pôde medir");
  });

  it("sem nenhuma referência é `sem-dado` e lista todas as lacunas", () => {
    const r = evaluateAcervoStaleness({ produzida: null, sitemapLocal: null, aoVivo: null, hoje: base.hoje });
    assert.equal(r.verdict, "sem-dado");
    assert.equal(r.lacunas.length, 3);
  });
});

describe("#7591 — leitura das três fontes", () => {
  it("editionIdToDate converte AAMMDD e recusa lixo", () => {
    assert.equal(editionIdToDate("260904"), "2026-09-04");
    assert.equal(editionIdToDate("261299"), null, "dia 99 não é data");
    assert.equal(editionIdToDate("abc"), null);
  });

  it("latestLastmod pega o mais recente, não o último do arquivo", () => {
    const xml = "<url><lastmod>2026-09-04</lastmod></url><url><lastmod>2026-08-26</lastmod></url>";
    assert.equal(latestLastmod(xml), "2026-09-04");
  });

  it("latestLastmod devolve null em sitemap sem lastmod", () => {
    assert.equal(latestLastmod("<urlset><url><loc>x</loc></url></urlset>"), null);
  });

  it("latestDateInArchiveHtml lê a data mais recente do HTML do acervo", () => {
    assert.equal(latestDateInArchiveHtml("<li>2026-08-04</li><li>2026-09-04</li>"), "2026-09-04");
    assert.equal(latestDateInArchiveHtml("<p>sem data</p>"), null);
  });
});
