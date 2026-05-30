/**
 * test/update-audience-decay.test.ts (#1564)
 *
 * Tests pra mudança que filtra Aprofunde + aplica exponential decay no
 * CTR table antes de exportar pro audience-profile.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAprofundeAnchor,
  decayWeight,
  DECAY_HALF_LIFE_DAYS,
  parseCtrFromCsv,
} from "../scripts/update-audience.ts";

const CTR_HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";

describe("isAprofundeAnchor", () => {
  it("detecta anchor 'Aprofunde' exato", () => {
    assert.equal(isAprofundeAnchor("Aprofunde"), true);
  });

  it("detecta variantes com sufixo (Aprofunde — Treinamento)", () => {
    assert.equal(isAprofundeAnchor("Aprofunde — Treinamento"), true);
    assert.equal(isAprofundeAnchor("Aprofunde — Lançamento"), true);
  });

  it("é case-insensitive", () => {
    assert.equal(isAprofundeAnchor("aprofunde"), true);
    assert.equal(isAprofundeAnchor("APROFUNDE"), true);
  });

  it("ignora whitespace no início", () => {
    assert.equal(isAprofundeAnchor("  Aprofunde"), true);
  });

  it("rejeita títulos comuns que NÃO começam com Aprofunde", () => {
    assert.equal(isAprofundeAnchor("Robinhood permite IA operar ações"), false);
    assert.equal(isAprofundeAnchor("OpenAI lança GPT-7"), false);
    assert.equal(isAprofundeAnchor("Gamma AI"), false);
  });

  it("rejeita strings que CONTÊM 'aprofunde' mas não começam (defensive)", () => {
    // Edge case improvável, mas regex \b garante boundary no início
    assert.equal(isAprofundeAnchor("Vamos aprofunde no tema"), false);
  });

  it("rejeita anchor vazio ou undefined-like", () => {
    assert.equal(isAprofundeAnchor(""), false);
    assert.equal(isAprofundeAnchor("   "), false);
  });
});

describe("decayWeight", () => {
  const today = new Date("2026-05-28");

  it("retorna 1.0 pra row de hoje (days=0)", () => {
    const w = decayWeight("2026-05-28", today);
    assert.ok(Math.abs(w - 1.0) < 0.001, `expected ~1.0, got ${w}`);
  });

  it("retorna ~0.368 (1/e) pra row de 90 dias atrás (time constant)", () => {
    // DECAY_HALF_LIFE_DAYS na verdade é o time constant da exp decay:
    // exp(-90/90) = 1/e ≈ 0.368. Half-life real é ~62 dias (90 × ln(2)).
    const w = decayWeight("2026-02-27", today); // 90 days ago
    assert.ok(Math.abs(w - 0.368) < 0.01, `expected ~0.368, got ${w}`);
  });

  it("retorna ~0.135 (1/e²) pra row de 180 dias atrás", () => {
    const w = decayWeight("2025-11-29", today); // 180 days ago
    assert.ok(Math.abs(w - 0.135) < 0.01, `expected ~0.135, got ${w}`);
  });

  it("half-life real é ~62 dias (90 × ln(2))", () => {
    const halfLifeDays = Math.round(DECAY_HALF_LIFE_DAYS * Math.log(2));
    const ms = halfLifeDays * 86400000;
    const past = new Date(today.getTime() - ms);
    const w = decayWeight(past.toISOString().slice(0, 10), today);
    assert.ok(Math.abs(w - 0.5) < 0.02, `expected ~0.5 at ~62d, got ${w}`);
  });

  it("rows muito antigas ficam quase zero (peso negligenciável)", () => {
    const w = decayWeight("2024-01-01", today); // ~870 days ago
    assert.ok(w < 0.001, `expected very small, got ${w}`);
  });

  it("nunca retorna negativo (defensive)", () => {
    assert.ok(decayWeight("2026-05-28", today) > 0);
    assert.ok(decayWeight("2020-01-01", today) > 0);
  });

  it("retorna 1.0 (fallback) pra data inválida", () => {
    assert.equal(decayWeight("not-a-date", today), 1);
    assert.equal(decayWeight("", today), 1);
  });

  it("rows do futuro têm peso 1.0 (clamped — não amplifica)", () => {
    const w = decayWeight("2026-12-31", today); // future
    // days < 0 → Math.max(0, days) = 0 → weight = exp(0) = 1
    assert.ok(Math.abs(w - 1.0) < 0.001, `future date should clamp to 1.0, got ${w}`);
  });

  it("DECAY_HALF_LIFE_DAYS é 90 (sweet spot validado)", () => {
    assert.equal(DECAY_HALF_LIFE_DAYS, 90);
  });
});

describe("decayWeight monotonicidade", () => {
  it("rows mais antigas têm peso menor que rows mais recentes", () => {
    const today = new Date("2026-05-28");
    const w_today = decayWeight("2026-05-28", today);
    const w_30d = decayWeight("2026-04-28", today);
    const w_90d = decayWeight("2026-02-27", today);
    const w_180d = decayWeight("2025-11-29", today);
    assert.ok(w_today > w_30d, "today > 30 dias atrás");
    assert.ok(w_30d > w_90d, "30d > 90d");
    assert.ok(w_90d > w_180d, "90d > 180d");
  });
});

// Regressão #1567 audit (finding A): o anchor era lido em parts[3] de um
// split(",") ingênuo. Vírgulas em post_title/section_title deslocavam o índice,
// então rows Aprofunde com vírgula no título VAZAVAM o filtro #1564 e
// reinflavam o CTR das categorias no profile do scorer (35 de 255 no CSV real).
// parseCtrFromCsv agora usa papaparse e lê rec.anchor por nome.
describe("parseCtrFromCsv — Aprofunde filter robusto a vírgulas (regressão #1567 finding A)", () => {
  const today = new Date("2026-05-21");

  it("filtra row Aprofunde mesmo com vírgulas em post_title/section_title", () => {
    const csv = [
      CTR_HEADER,
      // anchor REAL = Aprofunde, mas split(",")[3] daria " com vírgula" (fragmento do título)
      '2026-05-20,"Título, com vírgula","Seção, também",Aprofunde,https://a.com/x,a.com,100,5,5,5.00,Estratégia,BR',
      // row normal (regime título), sem vírgulas
      "2026-05-20,Limpo,Seção,GPT-5 chega,https://b.com/y,b.com,100,3,3,3.00,Lançamento,INT",
      // row NÃO-Aprofunde COM vírgulas no título — prova que os campos finais (categoria/origem/domínio/números) são lidos certo
      '2026-05-21,"Outro, título, com, vírgulas",Seção,Saiba mais,https://c.com/z,c.com,200,8,8,4.00,Pesquisa,BR',
    ].join("\n");

    const r = parseCtrFromCsv(csv, today)!;

    // O fix: a row Aprofunde (com vírgula no título) É detectada e excluída
    assert.equal(r.filteredAprofunde, 1);
    assert.equal(r.byCategory.has("Estratégia"), false); // a categoria da row Aprofunde NÃO vaza
    assert.equal(r.totalLinks, 2); // 3 rows - 1 Aprofunde

    // As rows legítimas (incl. uma com vírgulas no título) são agregadas corretamente
    assert.equal(r.byCategory.get("Lançamento")?.count, 1);
    assert.equal(r.byCategory.get("Pesquisa")?.count, 1);

    // Campos lidos por nome continuam corretos numa row com vírgulas no título:
    // a row Pesquisa (data == today → decay weight 1) deve ter opens=200, clicks=8
    const pesquisa = r.byCategory.get("Pesquisa")!;
    assert.equal(pesquisa.opens, 200);
    assert.equal(pesquisa.clicks, 8);
    assert.equal(r.byDomain.get("c.com")?.count, 1); // domínio lido certo apesar das vírgulas

    // origin: a única BR remanescente é a row Pesquisa (a BR Aprofunde foi filtrada)
    assert.equal(r.byOrigin.get("BR")?.count, 1);
    assert.equal(r.byOrigin.get("INT")?.count, 1);
  });

  it("conta múltiplas rows Aprofunde e devolve null pra CSV só com header", () => {
    const csv = [
      CTR_HEADER,
      '2026-05-20,"A, B",Sec,Aprofunde,https://a.com,a.com,100,2,2,2.00,Mercado,BR',
      "2026-05-20,Limpo,Sec,aprofunde — extra,https://b.com,b.com,100,1,1,1.00,Mercado,INT",
      "2026-05-20,Limpo,Sec,Título normal,https://d.com,d.com,100,4,4,4.00,Tendência,INT",
    ].join("\n");
    const r = parseCtrFromCsv(csv, today)!;
    assert.equal(r.filteredAprofunde, 2);
    assert.equal(r.totalLinks, 1);

    assert.equal(parseCtrFromCsv(CTR_HEADER, today), null); // só header → sem dados
  });
});
