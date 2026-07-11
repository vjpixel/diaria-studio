/**
 * test/poll-editions-legacy-cycle-3350.test.ts (#3350)
 *
 * BUG: `handleEditions` (workers/poll/src/vote.ts, #3257) enumera ciclos via
 * scan bruto das chaves KV `stats:` e devolve o sufixo literal armazenado —
 * nunca normaliza uma chave legada AAMMDD (marcador de ciclo mensal
 * pré-#2115, ver #3261) de volta pro slug de ciclo `YYMM-MM`.
 * `fetchClariceEditions` (workers/brevo-dashboard/src/eia-refresh.ts) filtra
 * essa lista só pro formato de ciclo, descartando silenciosamente qualquer
 * entrada em formato legado.
 *
 * Cenário real (issue): `GET /editions?brand=clarice` retornava
 * `["2606-07","260531"]` — depois do filtro cycle-only do eia-refresh.ts,
 * sobrava só `["2606-07"]`. O ciclo `2605-06` (32 votos reais sob a chave
 * legada `260531`, ver #3261) desaparecia. O botão "Atualizar votos"
 * (#3257) faz um `.put()` de SOBRESCRITA COMPLETA no KV `eia:engagement` —
 * não é merge — então rodar o refresh regredia dado que estava correto
 * (populado via `scripts/build-poll-eia-data.ts --push`, que descobre
 * ciclos por diretórios locais já em formato de ciclo).
 *
 * FIX: `cycleForLegacyMonthlyEdition` (lib.ts) reconstrói o slug de ciclo a
 * partir do AAMMDD legado (direção inversa de `legacyMonthlyEditionForCycle`,
 * #3261). `handleEditions` aplica essa normalização SÓ para brands com
 * leaderboard anual (`BRAND_INFO[brand].leaderboardPeriod === "year"` — hoje
 * só `clarice`, que não tem conceito de edição diária) — dedup via Set pra
 * não listar o mesmo ciclo 2x quando ambas as chaves (legada + nova)
 * existem.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cycleForLegacyMonthlyEdition,
  legacyMonthlyEditionForCycle,
} from "../workers/poll/src/lib.ts";
import { handleEditions } from "../workers/poll/src/vote.ts";
import { brandedNamespace, type Env } from "../workers/poll/src/index.ts";
import worker from "../workers/poll/src/index.ts";

// ── Mock KV backed por Map (mesmo padrão de poll-editions-endpoint-3257.test.ts) ──
function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: makeMapKV() as unknown as Env["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ...overrides,
  };
}

// ── 1. cycleForLegacyMonthlyEdition — pure ──────────────────────────────────

describe("cycleForLegacyMonthlyEdition (#3350)", () => {
  it("260531 (último dia de maio, legado) → 2605-06 (digest de maio, enviado em junho)", () => {
    assert.equal(cycleForLegacyMonthlyEdition("260531"), "2605-06");
  });

  it("260430 (abril tem 30 dias) → 2604-05", () => {
    assert.equal(cycleForLegacyMonthlyEdition("260430"), "2604-05");
  });

  it("260331 (março tem 31 dias) → 2603-04", () => {
    assert.equal(cycleForLegacyMonthlyEdition("260331"), "2603-04");
  });

  it("261231 (dezembro, virada de ano) → 2612-01", () => {
    assert.equal(cycleForLegacyMonthlyEdition("261231"), "2612-01");
  });

  it("260228 (fevereiro não-bissexto 2026, 28 dias) → 2602-03", () => {
    assert.equal(cycleForLegacyMonthlyEdition("260228"), "2602-03");
  });

  it("dia NÃO é o último do mês → null (não é marcador legado reconstruível)", () => {
    // 260615 não é o último dia de junho (30) — edição diária real, não ciclo.
    assert.equal(cycleForLegacyMonthlyEdition("260615"), null);
  });

  it("já em formato de ciclo (YYMM-MM) → null (não é AAMMDD)", () => {
    assert.equal(cycleForLegacyMonthlyEdition("2605-06"), null);
  });

  it("mês inválido (00 ou >12) → null", () => {
    assert.equal(cycleForLegacyMonthlyEdition("260031"), null);
    assert.equal(cycleForLegacyMonthlyEdition("261331"), null);
  });

  it("formato lixo → null", () => {
    assert.equal(cycleForLegacyMonthlyEdition(""), null);
    assert.equal(cycleForLegacyMonthlyEdition("abc"), null);
    assert.equal(cycleForLegacyMonthlyEdition("2606"), null);
  });

  it("round-trip com legacyMonthlyEditionForCycle: cycle → legado → cycle", () => {
    for (const cycle of ["2603-04", "2604-05", "2605-06", "2606-07", "2612-01"]) {
      const legacy = legacyMonthlyEditionForCycle(cycle);
      assert.ok(legacy, `${cycle} deve ter um legado`);
      assert.equal(
        cycleForLegacyMonthlyEdition(legacy!),
        cycle,
        `round-trip ${cycle} → ${legacy} → ${cycle} deve preservar o ciclo original`,
      );
    }
  });
});

// ── 2. handleEditions — normaliza legado só pra brand=clarice ──────────────

describe("handleEditions: normaliza chave AAMMDD legada pro slug de ciclo (#3350)", () => {
  it("REGRESSÃO EXATA: ciclo com votos só sob chave legada AAMMDD aparece como ciclo, não como AAMMDD cru", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:2606-07": "{}", // ciclo corrente, já no formato novo
        "stats:260531": "{}", // 2605-06 — votos só sob a chave legada (cenário real #3261)
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "clarice");
    const body = (await res.json()) as { brand: string; editions: string[] };
    assert.deepEqual(
      body.editions,
      ["2606-07", "2605-06"],
      "ANTES do fix isso retornava ['2606-07', '260531'] — o AAMMDD cru sobrevivia sem normalizar," +
        " e fetchClariceEditions descartava '260531' por não bater /^\\d{4}-\\d{2}$/",
    );
  });

  it("ambas as chaves (legada + nova) do MESMO ciclo → dedup, aparece só 1x", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:260531": "{}", // legado
        "stats:2605-06": "{}", // novo — mesmo ciclo lógico
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "clarice");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["2605-06"], "não deve listar o mesmo ciclo 2x");
  });

  it("brand=diaria NÃO normaliza — AAMMDD é edição diária real, mesmo caindo no último dia do mês", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:260531": "{}", // edição diária publicada em 31/mai — NÃO é marcador de ciclo
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "diaria");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["260531"], "diária mantém o AAMMDD cru — não tem conceito de ciclo mensal");
  });

  it("chave legada que NÃO reconstrói (dia não é o último do mês) mantém o AAMMDD cru como fallback", async () => {
    const env = makeEnv({
      POLL: makeMapKV({
        "stats:260615": "{}", // não é último dia de junho — cycleForLegacyMonthlyEdition retorna null
      }) as unknown as Env["POLL"],
    });
    const res = await handleEditions(env, "clarice");
    const body = (await res.json()) as { editions: string[] };
    assert.deepEqual(body.editions, ["260615"], "sem reconstrução possível, fallback pra edition original");
  });

  it("isolamento por brand preservado — normalização não vaza chave diaria pra clarice nem vice-versa", async () => {
    const rawKv = makeMapKV({
      "clarice:stats:260531": "{}", // clarice legado
      "stats:260615": "{}", // diaria, edição diária real
    });
    const clariceKv = brandedNamespace(rawKv as unknown as Env["POLL"], "clarice:");
    const resClarice = await handleEditions(makeEnv({ POLL: clariceKv }), "clarice");
    const bodyClarice = (await resClarice.json()) as { editions: string[] };
    assert.deepEqual(bodyClarice.editions, ["2605-06"]);

    const resDiaria = await handleEditions(makeEnv({ POLL: rawKv as unknown as Env["POLL"] }), "diaria");
    const bodyDiaria = (await resDiaria.json()) as { editions: string[] };
    assert.deepEqual(bodyDiaria.editions, ["260615"], "não deve ver a chave clarice: nem normalizá-la");
  });

  it("integração via router: GET /editions?brand=clarice devolve o ciclo normalizado, sobrevive ao formato de saída consumido por fetchClariceEditions", async () => {
    const env: Env = {
      POLL: makeMapKV({
        "clarice:stats:260531": "{}",
        "clarice:stats:2606-07": "{}",
      }) as unknown as Env["POLL"],
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const res = await worker.fetch(new Request("https://poll.test/editions?brand=clarice"), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { editions: string[] };
    // Mesmo filtro que fetchClariceEditions aplica (/^\d{4}-\d{2}$/) — com o
    // fix, TODAS as entries já vêm em formato de ciclo, então nada é descartado.
    const survivesEiaRefreshFilter = body.editions.filter((e) => /^\d{4}-\d{2}$/.test(e));
    assert.deepEqual(body.editions, ["2606-07", "2605-06"]);
    assert.deepEqual(survivesEiaRefreshFilter, body.editions, "nenhuma entry é descartada pelo filtro cycle-only");
  });
});
