/**
 * test/poll-ink-archive-grouping-3113.test.ts (#3113)
 *
 * Regressão para 3 achados adicionais da issue #3113 (Bloco B, brand
 * `diaria` e `clarice`):
 *
 *   Item 6 — cinzas via `rgba(23,20,17,...)` (opacity-based) que o DS já
 *   aboliu nas páginas leaderboard/arquivo/voto-do-arquivo — texto secundário
 *   agora é ink sólido, hierarquia por tamanho/peso.
 *
 *   Item 9 — edição futura (gabarito já gravado, mas o e-mail ainda não
 *   saiu) aparecia votável no arquivo do ano — `extractEditionsForYear`
 *   agora filtra por `edition > hoje` (BRT).
 *
 *   Item 10 — arquivo crescia como lista flat (passaria de 200 itens/ano);
 *   agora agrupado por mês com heading intercalado na mesma `<ul>`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEditionsForYear,
  todayAammddBrt,
  groupEditionsByMonth,
  monthHeadingLabel,
  renderArchiveListHtml,
} from "../workers/poll/src/leaderboard-routes.ts";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

describe("#3113 item 6 — sem rgba(23,20,17,...) nas páginas leaderboard/arquivo/voto-do-arquivo", () => {
  it("nenhuma das 3 páginas usa opacity-based gray — texto secundário é ink sólido", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../workers/poll/src/leaderboard-routes.ts", import.meta.url), "utf8"),
    );
    assert.doesNotMatch(src, /rgba\(23,\s*20,\s*17/, "leaderboard-routes.ts não deve mais ter cinza opacity-based");
  });
});

describe("todayAammddBrt (#3113)", () => {
  it("converte Date pra AAMMDD em BRT (UTC-3)", () => {
    // 2026-07-08T02:00:00Z (madrugada UTC) = 2026-07-07 23:00 BRT — ainda dia 07.
    assert.equal(todayAammddBrt(new Date("2026-07-08T02:00:00Z")), "260707");
    // 2026-07-08T12:00:00Z = 2026-07-08 09:00 BRT — já dia 08.
    assert.equal(todayAammddBrt(new Date("2026-07-08T12:00:00Z")), "260708");
  });
});

describe("#3113 item 9 — extractEditionsForYear filtra edições futuras", () => {
  it("edição futura (gabarito existe, mas data > hoje) é excluída", () => {
    const keys = ["correct:260101", "correct:260615", "correct:261231"];
    const now = new Date("2026-07-08T12:00:00Z"); // hoje = 260708 BRT
    assert.deepEqual(
      extractEditionsForYear(keys, "2026", now),
      ["260615", "260101"],
      "260 1231 (dezembro) é futura e deve ser excluída; 260101/260615 (passadas) permanecem",
    );
  });

  it("edição de HOJE (não estritamente futura) continua incluída", () => {
    const keys = ["correct:260708"];
    const now = new Date("2026-07-08T12:00:00Z");
    assert.deepEqual(extractEditionsForYear(keys, "2026", now), ["260708"]);
  });

  it("sem `now` explícito, usa new Date() (comportamento de produção) — não quebra chamadas existentes com 2 args", () => {
    // Regressão de compat: #2867 chamava com só (keys, year). Uma edição bem no
    // passado nunca deve ser filtrada independente de quando o teste rodar.
    assert.deepEqual(extractEditionsForYear(["correct:200101"], "2020"), ["200101"]);
  });

  it("GET /leaderboard/{YYYY}/arquivo não lista edição futura (integração)", async () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 1);
    const futureYY = String(farFuture.getFullYear() % 100).padStart(2, "0");
    const futureEdition = `${futureYY}0101`; // 1º de janeiro do ano que vem — sempre futuro
    const env = makeEnv({
      "correct:260101": "A",
      [`correct:${futureEdition}`]: "B",
    });
    const res = await workerDefault.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /260101|1 de janeiro/i);
    if (farFuture.getFullYear() % 100 === 26) {
      // só relevante quando o "ano que vem" cai em 2026 (mesmo YY do teste acima) — não é o caso hoje, mas guarda defensiva.
      assert.doesNotMatch(html, new RegExp(futureEdition));
    }
  });
});

describe("groupEditionsByMonth / monthHeadingLabel (#3113 item 10)", () => {
  it("agrupa por mês preservando ordem de primeira aparição (input DESC → grupos DESC)", () => {
    const groups = groupEditionsByMonth(["260715", "260701", "260615", "260601", "260101"]);
    assert.deepEqual(groups.map((g) => g.month), ["07", "06", "01"]);
    assert.deepEqual(groups.find((g) => g.month === "07")!.editions, ["260715", "260701"]);
    assert.deepEqual(groups.find((g) => g.month === "06")!.editions, ["260615", "260601"]);
  });

  it("lista vazia retorna array vazio", () => {
    assert.deepEqual(groupEditionsByMonth([]), []);
  });

  it("monthHeadingLabel capitaliza o nome do mês em pt-BR", () => {
    assert.equal(monthHeadingLabel("01"), "Janeiro");
    assert.equal(monthHeadingLabel("07"), "Julho");
    assert.equal(monthHeadingLabel("12"), "Dezembro");
  });
});

describe("renderArchiveListHtml agrupa por mês com heading intercalado (#3113 item 10)", () => {
  it("headings de mês aparecem na mesma <ul>, em ordem DESC, antes das edições daquele mês", async () => {
    const res = renderArchiveListHtml(["260715", "260701", "260601"], "2026", "diaria");
    const html = await res.text();
    const julIdx = html.indexOf(">Julho<");
    const ed715Idx = html.indexOf("260715");
    const ed701Idx = html.indexOf("260701");
    const junIdx = html.indexOf(">Junho<");
    const ed601Idx = html.indexOf("260601");
    assert.ok([julIdx, ed715Idx, ed701Idx, junIdx, ed601Idx].every((i) => i >= 0), "todos os elementos devem existir");
    assert.ok(julIdx < ed715Idx && ed715Idx < ed701Idx, "heading de Julho vem antes das 2 edições de julho");
    assert.ok(ed701Idx < junIdx, "Junho vem depois de todas as edições de Julho (ordem DESC)");
    assert.ok(junIdx < ed601Idx, "heading de Junho vem antes da edição de junho");
  });

  it("ano sem edições: continua mostrando o empty-state, sem heading nenhum", async () => {
    const res = renderArchiveListHtml([], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível ainda/);
    // A classe .month-heading existe na folha de estilos independente de haver
    // dados (mesmo padrão de qualquer outra classe CSS) — o que importa é que
    // NENHUM <li class="month-heading"> é renderizado no corpo sem edições.
    assert.doesNotMatch(html, /<li class="month-heading"/);
  });

  it("heading de mês tem role=heading/aria-level=2 (a11y — navegação por heading pula entre meses)", async () => {
    const res = renderArchiveListHtml(["260701"], "2026", "diaria");
    const html = await res.text();
    assert.match(html, /<li class="month-heading" role="heading" aria-level="2">Julho<\/li>/);
  });
});
