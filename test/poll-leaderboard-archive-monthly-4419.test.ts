/**
 * test/poll-leaderboard-archive-monthly-4419.test.ts (#4419)
 *
 * BUG: `/leaderboard/{ano}/arquivo` da marca `clarice` (a única que expõe o
 * link publicamente, #3615) listava TODAS as edições DIÁRIAS do ano — não as
 * mensais do "É IA?" da Clarice.
 *
 * Causa: `handleLeaderboardArchive` (leaderboard-routes.ts) enumerava as
 * chaves `correct:{yy}*` — gabarito é FATO COMPARTILHADO entre marcas, sem
 * prefixo (#3600/#4038/#4117) — via `extractEditionsForYear`, que mantém só
 * o formato AAMMDD e IGNORA de propósito qualquer chave em formato de ciclo
 * mensal Clarice (`YYMM-MM`). Resultado: o que sobrava era a lista de
 * edições da DIÁRIA.
 *
 * FIX: pra brand com `leaderboardPeriod === "year"` (só `clarice` hoje),
 * `handleLeaderboardArchive` passa a enumerar via o namespace BRANDED da
 * marca (`stats:{edition}`, mesmo padrão de `handleEditions`/#3350) — só ali
 * dá pra saber com certeza que a edição pertence à clarice — e intersecta
 * com `correct:` fechado (aceitando tanto o marcador legado AAMMDD quanto o
 * formato novo de ciclo) via a nova função pura `extractMonthlyEditionsForYear`.
 * A rota de voto individual (`handleArchiveVotePage`) e `formatEditionDateForBrand`/
 * `groupEditionsByMonth` (já cycle-aware desde #3464) passam a aceitar o
 * formato de ciclo, não só AAMMDD.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMonthlyEditionsForYear,
  handleLeaderboardArchive,
  handleArchiveVotePage,
} from "../workers/poll/src/leaderboard-routes.ts";
import { brandedNamespace, type Env } from "../workers/poll/src/index.ts";
import { brandKvPrefix } from "../workers/poll/src/lib.ts";
import worker from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

function makeEnv(kv: ReturnType<typeof makeTrackedKv>, overrides: Partial<Env> = {}): Env {
  return {
    POLL: kv as unknown as Env["POLL"],
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

// ── 1. extractMonthlyEditionsForYear — pure ────────────────────────────────

describe("extractMonthlyEditionsForYear (#4419)", () => {
  it("candidato em formato de ciclo, gabarito fechado sob a MESMA chave → incluído", () => {
    const editions = extractMonthlyEditionsForYear(
      ["2605-06"],
      ["correct:2605-06"],
      "2026",
    );
    assert.deepEqual(editions, ["2605-06"]);
  });

  it("candidato legado AAMMDD normaliza pro ciclo; gabarito fechado sob a chave LEGADA → incluído", () => {
    const editions = extractMonthlyEditionsForYear(
      ["260531"], // marcador legado do ciclo 2605-06
      ["correct:260531"],
      "2026",
    );
    assert.deepEqual(editions, ["2605-06"]);
  });

  it("candidato legado AAMMDD normaliza pro ciclo; gabarito fechado sob a chave NOVA → incluído (checagem cruzada)", () => {
    const editions = extractMonthlyEditionsForYear(
      ["260531"],
      ["correct:2605-06"], // gabarito gravado já no formato novo pro mesmo ciclo
      "2026",
    );
    assert.deepEqual(editions, ["2605-06"]);
  });

  it("stats: traz AMBAS as formas (legada + nova) do mesmo ciclo → dedup, aparece 1x", () => {
    const editions = extractMonthlyEditionsForYear(
      ["260531", "2605-06"],
      ["correct:260531", "correct:2605-06"],
      "2026",
    );
    assert.deepEqual(editions, ["2605-06"]);
  });

  it("edição DIÁRIA nunca aparece nem por acidente — nunca é um candidato válido de stats: da clarice", () => {
    // 260731 (31/jul) por acaso TAMBÉM bate o guard de "último dia do mês" de
    // cycleForLegacyMonthlyEdition (jul tem 31 dias) — mas isso só importa se
    // ALGUÉM alimentar esta função com "260731" como candidato de stats: (o
    // que só aconteceria se essa chave existisse sob o namespace BRANDED da
    // clarice, o que nunca ocorre pra uma edição genuinamente diária).
    const editions = extractMonthlyEditionsForYear(
      [], // nenhum candidato de stats: da clarice — 260731 não é um deles
      ["correct:260731", "correct:2605-06"],
      "2026",
    );
    assert.deepEqual(editions, [], "sem candidato de stats:, correct:260731 sozinho não produz nenhuma edição");
  });

  it("gabarito ainda não fechado (sem correct: em nenhuma forma) → excluído", () => {
    const editions = extractMonthlyEditionsForYear(["2607-08"], [], "2026");
    assert.deepEqual(editions, []);
  });

  it("filtra pelo ano de CONTEÚDO pedido", () => {
    const editions = extractMonthlyEditionsForYear(
      ["2605-06", "2512-01"], // conteúdo maio/2026 vs conteúdo dezembro/2025
      ["correct:2605-06", "correct:2512-01"],
      "2026",
    );
    assert.deepEqual(editions, ["2605-06"]);
  });

  it("ordena DESC (ciclo mais recente primeiro)", () => {
    const editions = extractMonthlyEditionsForYear(
      ["2603-04", "2607-08", "2605-06"],
      ["correct:2603-04", "correct:2607-08", "correct:2605-06"],
      "2026",
    );
    assert.deepEqual(editions, ["2607-08", "2605-06", "2603-04"]);
  });

  it("candidato malformado (lixo) é ignorado sem lançar", () => {
    const editions = extractMonthlyEditionsForYear(["lixo", "", "26010"], ["correct:2605-06"], "2026");
    assert.deepEqual(editions, []);
  });
});

// ── 2. GET /leaderboard/{YYYY}/arquivo?brand=clarice — integração ─────────

describe("GET /leaderboard/{YYYY}/arquivo?brand=clarice lista só ciclos mensais (#4419)", () => {
  it("REGRESSÃO EXATA da issue: correct:260731 (diária) + correct:260531 (legado) + correct:2605-06 (novo) → só o ciclo 2605-06, 1x, nenhuma edição diária", async () => {
    const kv = makeTrackedKv({
      "correct:260731": "A", // edição DIÁRIA — não deve aparecer no arquivo da clarice
      "correct:260531": "B", // marcador legado do ciclo 2605-06
      "correct:2605-06": "B", // MESMO ciclo, já no formato novo (fixture adversarial da issue)
      "stats:260731": JSON.stringify({ total: 10, correct: 5 }), // stats da DIÁRIA (namespace cru — sem prefixo de brand)
      "clarice:stats:260531": JSON.stringify({ total: 20, correct: 12 }), // stats da clarice, forma legada
      "clarice:stats:2605-06": JSON.stringify({ total: 20, correct: 12 }), // stats da clarice, forma nova
    });
    const env = makeEnv(kv);

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.doesNotMatch(html, /260731/, "edição diária NUNCA deve aparecer no arquivo da clarice");
    assert.doesNotMatch(html, /260531/, "chave legada crua nunca deve vazar pro HTML — só o ciclo normalizado");

    const hrefMatches = [...html.matchAll(/\/leaderboard\/2026\/arquivo\/2605-06\?brand=clarice/g)];
    assert.equal(hrefMatches.length, 1, "o ciclo 2605-06 deve aparecer exatamente 1 vez (dedup legado+novo)");
  });

  it("ano sem nenhum ciclo fechado da clarice → lista vazia, ainda 200 (não quebra pra 'sem votos ainda')", async () => {
    const kv = makeTrackedKv({
      "correct:260731": "A", // diária existe, mas irrelevante pro arquivo da clarice
    });
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível/i);
  });

  it("brand=diaria (default) continua listando edições DIÁRIAS normalmente — regressão do comportamento pré-#4419", async () => {
    const kv = makeTrackedKv({
      "correct:260615": "A",
      "stats:260615": JSON.stringify({ total: 3, correct: 1 }),
    });
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /260615|15 de junho/i, "brand diaria segue listando via correct: cru — comportamento inalterado");
  });

  it("chamada direta de handleLeaderboardArchive com bEnv explícito (brand=diaria não lê stats: nesse ramo)", async () => {
    const kv = makeTrackedKv({
      "correct:260615": "A",
    });
    const env = makeEnv(kv);
    // #4435 (achado type-design-analyzer): `bEnv` deixou de ter default
    // (`= env`) — era um fail-open perigoso, ver rationale no header de
    // `handleLeaderboardArchive` em leaderboard-routes.ts. Passa `env`
    // explicitamente como bEnv; pra brand=diaria (leaderboardPeriod "month")
    // o branch nunca lê bEnv mesmo, então este teste reproduz o MESMO
    // cenário de antes sem depender de um default.
    const res = await handleLeaderboardArchive("2026", env, "diaria", env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /260615/);
  });
});

// ── 3. GET /leaderboard/{YYYY}/arquivo/{ciclo} — página de voto individual ─

describe("GET /leaderboard/{YYYY}/arquivo/{YYMM-MM}?brand=clarice — formato de ciclo (#4419)", () => {
  it("gabarito sob a chave NOVA (correct:{ciclo}) → 200, imagens referenciam a key de ciclo", async () => {
    const kv = makeTrackedKv({ "correct:2605-06": "A" });
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/2605-06?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /img-2605-06-01-eia-A\.jpg/);
    assert.match(html, /img-2605-06-01-eia-B\.jpg/);
  });

  it("gabarito só sob a chave LEGADA (correct:260531) → 200 (checagem cruzada legado↔novo)", async () => {
    const kv = makeTrackedKv({ "correct:260531": "B" }); // só a forma legada existe
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/2605-06?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(
      res.status,
      200,
      "a página de voto do ciclo novo deve achar o gabarito mesmo gravado só sob o marcador legado",
    );
  });

  it("edição de outro ano de CONTEÚDO que não o da URL → 404", async () => {
    const kv = makeTrackedKv({ "correct:2505-06": "A" }); // conteúdo 2025
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/2505-06?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404);
  });

  it("sem gabarito fechado em nenhuma forma → 404", async () => {
    const env = makeEnv(makeTrackedKv());
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/2605-06?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404);
  });

  it("edição AAMMDD diária continua funcionando na rota de arquivo (regressão de formato)", async () => {
    const kv = makeTrackedKv({ "correct:260101": "A" });
    const env = makeEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/leaderboard/2026/arquivo/260101"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /img-260101-01-eia-A\.jpg/);
  });
});

// ── 4. handleArchiveVotePage direto — dual-key lookup + edition futura só p/ AAMMDD ─

describe("handleArchiveVotePage: dual-key + 'futuro' só se aplica a AAMMDD (#4419)", () => {
  it("edition ciclo sem qualquer correct: → 404 mesmo não sendo 'futuro' (ciclo não tem noção de dia)", async () => {
    const env = makeEnv(makeTrackedKv());
    const res = await handleArchiveVotePage("2026", "2605-06", env, "clarice");
    assert.equal(res.status, 404);
  });

  it("edition AAMMDD futura, MESMO com gabarito já gravado → 404 preservado (#3113 item 9, sem regressão)", async () => {
    const futureYear = new Date().getFullYear() + 1;
    const futureAammdd = `${String(futureYear).slice(2)}1231`;
    // Gabarito PRESENTE (diferente do teste acima, que não tinha nenhum) —
    // isola especificamente o ramo "edição futura" do guard, não o ramo
    // "sem correct: nenhum".
    const env = makeEnv(makeTrackedKv({ [`correct:${futureAammdd}`]: "A" }));
    const res = await handleArchiveVotePage(String(futureYear), futureAammdd, env, "diaria");
    assert.equal(res.status, 404, "AAMMDD futuro continua bloqueado mesmo com gabarito já definido");
  });
});

// ── 5. Isolamento por brand preservado ─────────────────────────────────────

describe("Isolamento por brand: stats: de outra marca nunca vaza pro arquivo da clarice (#4419)", () => {
  it("stats: sem prefixo (diaria) não é lido como se fosse da clarice", async () => {
    const rawKv = makeTrackedKv({
      "correct:260731": "A",
      "stats:260731": JSON.stringify({ total: 5, correct: 2 }), // diaria, sem prefixo
    });
    const env = makeEnv(rawKv);
    const bEnv: Env = { ...env, POLL: brandedNamespace(env.POLL, brandKvPrefix("clarice")) };
    const res = await handleLeaderboardArchive("2026", env, "clarice", bEnv);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Nenhuma edição disponível/i, "sem stats: BRANDED da clarice, o arquivo fica vazio — não herda a edição diária");
  });
});
