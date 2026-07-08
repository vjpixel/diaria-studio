/**
 * test/poll-archive-future-edition-month-grouping-3113.test.ts (#3113)
 *
 * Regressão para 2 achados do arquivo retroativo do leaderboard "É IA?":
 *
 *   Item 9 — `extractEditionsForYear` não filtrava por data: uma edição com
 *   gabarito já definido (`correct:{edition}`) mas cuja data ainda não
 *   chegou aparecia como votável no arquivo do brand `diaria` antes do
 *   e-mail sair. Fix: exclui edições com AAMMDD > hoje (BRT).
 *
 *   Item 10 — `renderArchiveListHtml` renderizava uma lista `<ul>` flat sem
 *   agrupamento — cresce sem limite (>200 itens/ano). Fix: `groupEditionsByMonth`
 *   agrupa as edições (já ordenadas DESC) por mês, com heading `.month-heading`
 *   por grupo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEditionsForYear,
  groupEditionsByMonth,
  renderArchiveListHtml,
} from "../workers/poll/src/leaderboard-routes.ts";

describe("extractEditionsForYear — filtra edições futuras (#3113 item 9)", () => {
  it("exclui edição com data > hoje (BRT), mesmo com gabarito definido", () => {
    // "agora" fixado em 15 de junho de 2026 — 260620 é uma semana no futuro.
    const now = new Date("2026-06-15T12:00:00Z");
    const editions = extractEditionsForYear(
      ["correct:260610", "correct:260620", "correct:260601"],
      "2026",
      now,
    );
    assert.deepEqual(editions, ["260610", "260601"], "260620 (futuro) deve ser excluída");
  });

  it("inclui a edição de HOJE (data == hoje não é 'futuro')", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const editions = extractEditionsForYear(["correct:260615"], "2026", now);
    assert.deepEqual(editions, ["260615"]);
  });

  it("sem `now` explícito, usa a data real (comportamento de produção) — smoke test", () => {
    // Edição bem no futuro (ano 2099) nunca deve aparecer com o relógio real.
    const editions = extractEditionsForYear(["correct:991231"], "2099");
    assert.deepEqual(editions, []);
  });

  it("considera o offset BRT (UTC-3) na fronteira da meia-noite", () => {
    // 2026-06-16T02:00:00Z == 2026-06-15T23:00:00 BRT (ainda dia 15 em BRT).
    const now = new Date("2026-06-16T02:00:00Z");
    const editions = extractEditionsForYear(["correct:260615", "correct:260616"], "2026", now);
    assert.deepEqual(editions, ["260615"], "260616 ainda não chegou em BRT nesse instante");
  });
});

describe("groupEditionsByMonth (#3113 item 10)", () => {
  it("agrupa edições consecutivas do mesmo mês num único grupo", () => {
    const groups = groupEditionsByMonth(["260620", "260615", "260601"]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].monthLabel, "Junho");
    assert.deepEqual(groups[0].editions, ["260620", "260615", "260601"]);
  });

  it("cria um grupo por mês, preservando a ordem DESC de entrada", () => {
    const groups = groupEditionsByMonth(["260715", "260701", "260620", "260601"]);
    assert.deepEqual(
      groups.map((g) => g.monthLabel),
      ["Julho", "Junho"],
    );
    assert.deepEqual(groups[0].editions, ["260715", "260701"]);
    assert.deepEqual(groups[1].editions, ["260620", "260601"]);
  });

  it("lista vazia → nenhum grupo", () => {
    assert.deepEqual(groupEditionsByMonth([]), []);
  });

  it("nome do mês capitalizado (Janeiro, não janeiro)", () => {
    const groups = groupEditionsByMonth(["260105"]);
    assert.equal(groups[0].monthLabel, "Janeiro");
  });
});

describe("renderArchiveListHtml — agrupamento por mês no HTML (#3113 item 10)", () => {
  it("renderiza um heading .month-heading por mês, cada um com seu próprio <ul>", async () => {
    const res = renderArchiveListHtml(["260715", "260701", "260620"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /<h2 class="month-heading">Julho<\/h2>\s*<ul>/);
    assert.match(html, /<h2 class="month-heading">Junho<\/h2>\s*<ul>/);
    // Ordem: heading de Julho antes do de Junho (mais recente primeiro).
    assert.ok(html.indexOf(">Julho<") < html.indexOf(">Junho<"));
    // Cada edição aparece dentro do seu próprio grupo (não uma lista flat única).
    const julyIdx = html.indexOf(">Julho<");
    const juneIdx = html.indexOf(">Junho<");
    const ed715Idx = html.indexOf("260715");
    const ed620Idx = html.indexOf("260620");
    assert.ok(julyIdx < ed715Idx && ed715Idx < juneIdx, "260715 deve estar no grupo de Julho");
    assert.ok(juneIdx < ed620Idx, "260620 deve estar no grupo de Junho");
  });

  it("lista vazia → mensagem de fallback, sem heading de mês", async () => {
    const res = renderArchiveListHtml([], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível ainda\./);
    // Checa só o BODY (a regra CSS .month-heading segue declarada no <style>
    // de qualquer forma — o que importa é não haver o elemento no corpo).
    const body = html.slice(html.indexOf("<body>"));
    assert.doesNotMatch(body, /<h2 class="month-heading">/);
  });
});
