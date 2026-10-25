/**
 * #11065: Humanizador + Clarice nos resumos da retro semanal — rastro
 * (summary_raw → summary_humanized → summary), revalidação do texto FINAL e
 * falha da Clarice sem halt. A Clarice nunca é chamada ao vivo (fetch mockado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  snapshotRaw,
  markHumanized,
  applyClarice,
  markClariceFailed,
  runClariceRest,
  revalidate,
} from "../scripts/weekly-summaries-passes.ts";
import { weeklySummaryPassWarnings, type WeeklySummariesFile } from "../scripts/lib/weekly-summaries.ts";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";

function fixture(): WeeklySummariesFile {
  return {
    carouselKey: "261024-clicked",
    items: [
      {
        url: URL_A,
        title: "Mistral desafia ElevenLabs com voz mais barata",
        summary: "O Voxtral 3 monta atendentes que falam portugues e fazem ligações por US$ 0,04 o minuto.",
      },
      {
        url: URL_B,
        title: "CFM dá ao médico a palavra final sobre a máquina",
        summary: "Dois em cada três médicos já usam IA no consultório, e hospitais passam a responder pela auditoria desses sistemas.",
      },
    ],
  };
}

describe("weekly-summaries-passes (#11065)", () => {
  it("snapshot guarda a versão do agente e é idempotente", () => {
    const d = fixture();
    assert.equal(snapshotRaw(d).snapshotted, 2);
    d.items[0].summary = "editado pelo humanizador";
    assert.equal(snapshotRaw(d).snapshotted, 0);
    assert.equal(d.items[0].summary_raw, fixture().items[0].summary);
  });

  it("humanized exige snapshot antes", () => {
    assert.throws(() => markHumanized(fixture()), /summary_raw/);
  });

  it("Clarice exige Humanizador antes (ordem da diária)", () => {
    const d = fixture();
    snapshotRaw(d);
    assert.throws(() => applyClarice(d, {}, "mcp"), /Humanizador/);
  });

  it("rastro completo: agente → humanizador → Clarice", () => {
    const d = fixture();
    snapshotRaw(d);
    d.items[1].summary = "Dois de cada três médicos já usam IA no consultório, e hospitais respondem pela auditoria desses sistemas.";
    markHumanized(d);
    const r = applyClarice(d, { [URL_A]: [{ from: "portugues", to: "português" }], [URL_B]: [] }, "mcp");
    assert.equal(r.applied, 1);
    assert.equal(d.items[0].summary_raw, fixture().items[0].summary);
    assert.match(d.items[0].summary, /português/);
    assert.equal(d.items[1].summary_humanized, d.items[1].summary);
    assert.notEqual(d.items[1].summary_raw, d.items[1].summary);
    assert.deepEqual(d.passes, { humanizador: "ok", clarice: "ok", clarice_via: "mcp", clarice_skipped: 0 });
    assert.deepEqual(weeklySummaryPassWarnings(d.passes ?? null), []);
    assert.deepEqual(revalidate(d), []);
  });

  it("texto pós-Humanizador que estoura o limite é barrado na revalidação", () => {
    const d = fixture();
    snapshotRaw(d);
    assert.deepEqual(revalidate(d), [], "a versão do agente passava");
    d.items[0].summary =
      "O Voxtral 3, novo modelo de voz da empresa francesa, monta atendentes automáticos que falam português com sotaque natural, " +
      "fazem e recebem ligações telefônicas e cobram apenas US$ 0,04 por minuto de conversa gravada.";
    markHumanized(d);
    const bad = revalidate(d);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].url, URL_A);
    assert.match(bad[0].problems.join(";"), /200 caracteres/);
  });

  it("Clarice que vira 3 frases também é barrada (vale sobre o texto final)", () => {
    const d = fixture();
    snapshotRaw(d);
    markHumanized(d);
    applyClarice(d, { [URL_A]: [{ from: "atendentes que", to: "atendentes. Eles" }, { from: "ligações por", to: "ligações. Custa" }], [URL_B]: [] }, "mcp");
    assert.match(revalidate(d)[0].problems.join(";"), /3 frases/);
  });

  it("Clarice fora: segue o texto humanizado e o preview avisa", () => {
    const d = fixture();
    snapshotRaw(d);
    markHumanized(d);
    markClariceFailed(d, "MCP e REST fora");
    assert.equal(d.items[0].summary, d.items[0].summary_humanized);
    const w = weeklySummaryPassWarnings(d.passes ?? null);
    assert.equal(w.length, 1);
    assert.match(w[0], /Clarice falhou \(MCP e REST fora\)/);
  });

  it("arquivo sem passes avisa Humanizador e Clarice ausentes", () => {
    assert.equal(weeklySummaryPassWarnings({}).length, 2);
    assert.deepEqual(weeklySummaryPassWarnings(null), []);
  });

  it("REST mockado: aplica sugestões, 1 chamada por resumo", async () => {
    const d = fixture();
    snapshotRaw(d);
    markHumanized(d);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const body = calls === 1 ? [{ from: "portugues", to: "português" }] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await runClariceRest(d, { apiKey: "test", fetchImpl, policy: { maxAttempts: 1, timeoutMs: 1000, baseBackoffMs: 0 } });
    assert.equal(calls, 2);
    assert.ok(r.ok);
    assert.match(d.items[0].summary, /português/);
    assert.equal(d.passes?.clarice_via, "rest");
  });

  it("REST mockado falhando: registra falha sem lançar", async () => {
    const d = fixture();
    snapshotRaw(d);
    markHumanized(d);
    const fetchImpl = (async () => new Response("boom", { status: 401 })) as unknown as typeof fetch;
    const r = await runClariceRest(d, { apiKey: "test", fetchImpl, policy: { maxAttempts: 1, timeoutMs: 1000, baseBackoffMs: 0 } });
    assert.equal(r.ok, false);
    assert.equal(d.passes?.clarice, "falhou");
    assert.equal(d.items[0].summary, d.items[0].summary_humanized);
  });
});
