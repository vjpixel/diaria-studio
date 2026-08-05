import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  brtDayLabel,
  buildWaveProposal,
  computeNextWaveNumber,
  groupKeyFromCampaignName,
  measureNonOpenerExposure,
  proposeVolumes,
  recommendAbcAction,
  renderWaveProposal,
  scheduledAtForDate,
  summarizeCycleSends,
  summarizeMvBacklog,
  waveKey,
  MV_COST_PER_EMAIL_USD,
  type WaveProposalInput,
} from "../scripts/lib/clarice-wave-plan.ts";
import { buildGroupCells, cellManifestFileName } from "../scripts/lib/clarice-group-cells.ts";
import { parseDatesArg } from "../scripts/clarice-plan-wave.ts";
import { groupCellListNameFor } from "../scripts/clarice-import-waves.ts";
import { parseAbcAudienceCampaign } from "../workers/brevo-dashboard/src/index.ts";
import type { AbcAudienceTable } from "../workers/brevo-dashboard/src/sections-core.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ---------------------------------------------------------------------------
// Datas — "data é sempre explícita", nunca inferida nem "corrigida"
// ---------------------------------------------------------------------------

describe("scheduledAtForDate (#4657)", () => {
  it("converte YYYY-MM-DD pro horário canônico 06:00 BRT = 09:00 UTC", () => {
    assert.equal(scheduledAtForDate("2026-08-06"), "2026-08-06T09:00:00.000Z");
  });

  it("rejeita formato fora de YYYY-MM-DD", () => {
    assert.throws(() => scheduledAtForDate("06/08/2026"), /esperado YYYY-MM-DD/);
    assert.throws(() => scheduledAtForDate("2026-8-6"), /esperado YYYY-MM-DD/);
  });

  it("REGRESSÃO: data inexistente no calendário lança, nunca é 'corrigida' em silêncio", () => {
    // `new Date("2026-02-31")` vira 03/03 sem erro. Uma campanha Brevo
    // agendada é imutável — um off-by-one aqui só apareceria pós-disparo.
    assert.throws(() => scheduledAtForDate("2026-02-31"), /inexistente no calendário/);
    // Mês 14 nem chega no round-trip — `Date.parse` já devolve NaN e o guard
    // anterior pega. Rejeição por qualquer um dos dois caminhos serve; o que
    // não pode é passar.
    assert.throws(() => scheduledAtForDate("2026-14-01"), /data inválida|inexistente/);
  });

  it("REGRESSÃO: 29/02 é aceito em ano bissexto e rejeitado fora dele", () => {
    // O caso "parece plausível, está errado" — o que o Date do JS mais
    // gosta de 'consertar' em silêncio. 2028 é bissexto, 2026 não.
    assert.equal(scheduledAtForDate("2028-02-29"), "2028-02-29T09:00:00.000Z");
    assert.throws(() => scheduledAtForDate("2026-02-29"), /inexistente no calendário/);
  });

  it("o offset é FIXO o ano todo — Brasil não tem horário de verão desde 2019", () => {
    // Trava a premissa contra alguém 'consertar' isto pra conversão via ICU
    // no futuro: janeiro e julho têm que dar o mesmo horário UTC.
    assert.ok(scheduledAtForDate("2026-01-15").endsWith("T09:00:00.000Z"));
    assert.ok(scheduledAtForDate("2026-07-15").endsWith("T09:00:00.000Z"));
  });

  it("brtDayLabel dá o dia da semana em BRT", () => {
    assert.equal(brtDayLabel("2026-08-06"), "qui");
    assert.equal(brtDayLabel("2026-08-01"), "sab");
    assert.equal(brtDayLabel("2026-08-02"), "dom");
  });
});

describe("waveKey (#4657 — fecha o item 3 da #4449)", () => {
  it("gera a chave no mesmo formato que o ciclo 2607-08 usou à mão", () => {
    assert.equal(waveKey(6, "2026-08-06"), "d6-qui06");
    assert.equal(waveKey(1, "2026-08-01"), "d1-sab01");
  });

  it("sufixa a célula quando há teste A/B/C", () => {
    assert.equal(waveKey(6, "2026-08-06", "A"), "d6-qui06-A");
  });

  it("rejeita número de onda inválido", () => {
    assert.throws(() => waveKey(0, "2026-08-06"), /inteiro > 0/);
    assert.throws(() => waveKey(-1, "2026-08-06"), /inteiro > 0/);
  });

  it("PARIDADE gerador↔parser: a chave gerada sobrevive ao round-trip do painel", () => {
    // Esta é a regressão que a #4449 item 3 pedia: o formato de nome de lista
    // era digitado à mão, e uma variação de digitação quebrava o parser em
    // silêncio — 3 incidentes (#3081 → #3128 → #4447). Gerar a chave aqui e
    // parsear com o MESMO parser do painel trava os dois lados juntos.
    for (const cell of ["A", "B", "C"] as const) {
      const key = waveKey(6, "2026-08-06", cell);
      const listName = groupCellListNameFor("2607-08", key);
      const parsed = parseAbcAudienceCampaign(`Clarice 2608 grupo:${key}`, listName);
      assert.ok(parsed, `não parseou: ${listName}`);
      assert.equal(parsed.cycle, "2607-08");
      assert.equal(parsed.cell, cell);
    }
  });
});

describe("parseDatesArg", () => {
  it("aceita lista válida em ordem crescente", () => {
    assert.deepEqual(parseDatesArg("2026-08-06,2026-08-07"), ["2026-08-06", "2026-08-07"]);
  });

  it("rejeita ausência, repetição e desordem", () => {
    assert.throws(() => parseDatesArg(undefined), /obrigatório/);
    assert.throws(() => parseDatesArg("2026-08-06,2026-08-06"), /repetida/);
    assert.throws(() => parseDatesArg("2026-08-07,2026-08-06"), /ordem crescente/);
    assert.throws(() => parseDatesArg("ontem"), /data inválida/);
  });
});

// ---------------------------------------------------------------------------
// Estado do ciclo
// ---------------------------------------------------------------------------

function campaign(over: Partial<BrevoCampaign> & { listName?: string; listSize?: number } = {}) {
  return {
    id: 1,
    name: "Clarice 2608 grupo:d1-sab01-A",
    subject: "Assunto",
    status: "sent",
    sentDate: "2026-08-01T09:00:00.000Z",
    scheduledAt: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    recipients: { lists: [88] },
    ...over,
  } as BrevoCampaign & { listName?: string; listSize?: number };
}

describe("groupKeyFromCampaignName", () => {
  it("extrai a chave do naming do fluxo --group", () => {
    assert.equal(groupKeyFromCampaignName("Clarice 2608 grupo:d1-sab01-A"), "d1-sab01-A");
    assert.equal(groupKeyFromCampaignName("Clarice 2608 grupo:novos"), "novos");
  });

  it("devolve null pra campanha fora desse fluxo", () => {
    assert.equal(groupKeyFromCampaignName("cold 2607-08 — A"), null);
    assert.equal(groupKeyFromCampaignName(""), null);
  });
});

describe("summarizeCycleSends (#4657)", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("agrupa as ondas do ciclo e separa disparado de agendado", () => {
    const state = summarizeCycleSends(
      [
        campaign({ listName: "Clarice 2607-08 d1-sab01-A — célula A", listSize: 2666 }),
        campaign({
          name: "Clarice 2608 grupo:d9-dom09-A",
          status: "queued",
          sentDate: null,
          scheduledAt: "2026-08-09T09:00:00.000Z",
          listName: "Clarice 2607-08 d9-dom09-A — célula A",
          listSize: 500,
        }),
      ],
      "2607-08",
      now,
    );
    assert.equal(state.waves.length, 2);
    assert.equal(state.sentCount, 1);
    assert.equal(state.scheduledCount, 1);
    assert.equal(state.volumeSum, 3166);
    assert.equal(state.volumeComplete, true);
  });

  it("exclui campanha de OUTRO ciclo (a lista carrega o ciclo, o nome não)", () => {
    const state = summarizeCycleSends(
      [campaign({ listName: "Clarice 2606-07 d1-sab01-A — célula A", listSize: 10 })],
      "2607-08",
      now,
    );
    assert.equal(state.waves.length, 0);
  });

  it("REGRESSÃO: campanha SEM listName é EXCLUÍDA e contada, nunca mantida 'na dúvida'", () => {
    // O guard original era `if (c.listName && !c.listName.includes(cycle))`
    // — pula-se-presente. Sem listName (falha da chamada por lista, ou API
    // key ausente), uma campanha de OUTRO ciclo entrava no resumo e inflava
    // volumeSum/sentCount e o maxWaveN que decide a próxima chave.
    const state = summarizeCycleSends(
      [
        campaign({ listName: "Clarice 2607-08 d1-sab01-A — célula A", listSize: 100 }),
        campaign({ name: "Clarice 2608 grupo:d9-dom09-A", listSize: 9999 }), // sem listName
      ],
      "2607-08",
      now,
    );
    assert.equal(state.waves.length, 1);
    assert.equal(state.unscopedCount, 1);
    assert.equal(state.volumeSum, 100);
    // E não contamina a numeração da próxima onda:
    assert.equal(computeNextWaveNumber(state.waves), 2);
  });

  it("volume desconhecido faz o total virar PISO, não total exato", () => {
    const state = summarizeCycleSends(
      [
        campaign({ listName: "Clarice 2607-08 d1-sab01-A — célula A", listSize: 100 }),
        campaign({ name: "Clarice 2608 grupo:d2-dom02-A", listName: "Clarice 2607-08 d2-dom02-A — célula A" }),
      ],
      "2607-08",
      now,
    );
    assert.equal(state.volumeComplete, false);
    assert.equal(state.volumeSum, 100);
  });
});

describe("computeNextWaveNumber (#4657)", () => {
  it("continua a numeração, nunca reinicia", () => {
    assert.equal(computeNextWaveNumber([{ key: "d5-qua05-A" }, { key: "d1-sab01-A" }]), 6);
  });

  it("ciclo vazio começa em 1", () => {
    assert.equal(computeNextWaveNumber([]), 1);
  });

  it("REGRESSÃO: número de 2 dígitos não perde pra 1 dígito (ordenação numérica, não lexical)", () => {
    // "d9" > "d10" lexicalmente — se comparasse string, a próxima onda
    // reusaria d10 e produziria chave/lista duplicada (classe do #3682).
    assert.equal(computeNextWaveNumber([{ key: "d9-dom09" }, { key: "d10-seg10" }]), 11);
  });

  it("chave sem numeração é ignorada (grupos legítimos como 'novos')", () => {
    assert.equal(computeNextWaveNumber([{ key: "novos" }, { key: "d3-seg03-A" }]), 4);
  });

  it("sufixo -interno do fluxo real casa pelo prefixo e conta", () => {
    assert.equal(computeNextWaveNumber([{ key: "d1-sab01-interno" }]), 2);
  });
});

// ---------------------------------------------------------------------------
// Divisão em células — o naming determinístico ponta a ponta
// ---------------------------------------------------------------------------

describe("buildGroupCells (#4657 — fecha o item 3 da #4449)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ email: `p${i}@x.com` }));

  it("divide em 3 células com tamanhos o mais iguais possível", () => {
    const { cells, manifest } = buildGroupCells(rows, 6, "2026-08-06");
    assert.deepEqual(manifest.map((m) => m.count), [4, 3, 3]);
    assert.equal(cells.flat().length, 10);
  });

  it("nenhum contato aparece em duas células", () => {
    const { cells } = buildGroupCells(rows, 6, "2026-08-06");
    const all = cells.flat().map((r) => r.email);
    assert.equal(new Set(all).size, all.length);
  });

  it("as chaves são GERADAS e o groupKey é o do dia (o --group do import)", () => {
    const { groupKey, manifest } = buildGroupCells(rows, 6, "2026-08-06");
    assert.equal(groupKey, "d6-qui06");
    assert.deepEqual(manifest.map((m) => m.key), ["d6-qui06-A", "d6-qui06-B", "d6-qui06-C"]);
    assert.equal(cellManifestFileName(groupKey), "d6-qui06-manifest.json");
  });

  it("PARIDADE ponta a ponta: chave gerada → nome de lista → parser do painel", () => {
    // Este é o teste que faltava pra "o nome da lista nunca é digitado" ser
    // verdade: antes, o manifest de 3 entradas era escrito à mão (era esse o
    // "digitado à mão" da #4449, que sobreviveu ao #4471).
    const { manifest } = buildGroupCells(rows, 6, "2026-08-06");
    for (const entry of manifest) {
      const listName = groupCellListNameFor("2607-08", entry.key);
      const parsed = parseAbcAudienceCampaign(`Clarice 2608 grupo:${entry.key}`, listName);
      assert.ok(parsed, `não parseou: ${listName}`);
      assert.equal(parsed.cycle, "2607-08");
      assert.equal(parsed.cell, entry.key.slice(-1));
    }
  });

  it("lista vazia não estoura — 3 células vazias", () => {
    const { manifest } = buildGroupCells([], 6, "2026-08-06");
    assert.deepEqual(manifest.map((m) => m.count), [0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Recomendação A/B/C — conservadora por design
// ---------------------------------------------------------------------------

function cell(over: Record<string, unknown> = {}) {
  return {
    cell: "A" as const,
    campaignCount: 1,
    sent: 1000,
    delivered: 1000,
    opens: 200,
    clicksAttributed: 50,
    clicksTotal: 50,
    unattributedCampaignCount: 0,
    unsubscriptions: 5,
    openRate: 20,
    ctor: 25,
    clickRate: 5,
    unsubRate: 0.5,
    bounceRate: 1,
    spamRate: 0.05,
    ...over,
  };
}

function table(over: Partial<AbcAudienceTable> = {}): AbcAudienceTable {
  return {
    cells: [cell(), cell({ cell: "B" }), cell({ cell: "C" })],
    leaderOpenRate: "A",
    leaderClickRate: "A",
    significantClick: true,
    pValue: 0.001,
    minDetectableLiftRelative: 0.10,
    suspectedDriftDays: [],
    attributionUnknown: false,
    ...over,
  } as AbcAudienceTable;
}

describe("recommendAbcAction (#4657)", () => {
  it("sem célula amostrada → iniciar", () => {
    const r = recommendAbcAction(table({ cells: [] }));
    assert.equal(r.action, "iniciar");
    assert.equal(r.metric, "nenhuma");
  });

  it("tabela nula → iniciar (não estoura)", () => {
    assert.equal(recommendAbcAction(null).action, "iniciar");
  });

  it("assunto já travado → travar, sem recalcular nada", () => {
    const r = recommendAbcAction(table(), { lockedSubject: "Vencedor" });
    assert.equal(r.action, "travar");
    assert.match(r.rationale, /assunto único/);
  });

  it("significativo e SEM ressalva → travar, declarando a métrica", () => {
    const r = recommendAbcAction(table());
    assert.equal(r.action, "travar");
    assert.equal(r.metric, "clique");
    assert.equal(r.winner, "A");
    assert.deepEqual(r.caveats, []);
  });

  it("#4559: significativo COM atribuição desconhecida → travar, mas com a ressalva explícita", () => {
    // Decisão do editor (05/08): a skill dá a leitura e o editor pesa a
    // ressalva no gate. Rebaixar pra "continuar" sempre que houvesse
    // ressalva fazia o teste nunca terminar — no 2607-08, concluir por
    // clique exigiria ~217k envios contra uma fila de ~26k.
    const r = recommendAbcAction(table({ attributionUnknown: true }));
    assert.equal(r.action, "travar");
    assert.equal(r.winner, "A");
    assert.equal(r.caveats.length, 1);
    assert.match(r.caveats[0], /NÃO-VERIFICADA/);
    // A ressalva NUNCA some — some do veredito, não do gate.
    assert.match(r.rationale, /ressalva/);
  });

  it("#4559: significativo com PODER BAIXO → travar, ressalva nos avisos", () => {
    const r = recommendAbcAction(table({ minDetectableLiftRelative: 0.9 }));
    assert.equal(r.action, "travar");
    assert.match(r.caveats.join(" "), /Poder baixo/);
  });

  it("REGRESSÃO #4449: dia com drift de naming continua virando ressalva visível", () => {
    const r = recommendAbcAction(table({ suspectedDriftDays: ["2026-08-04"] }));
    assert.equal(r.action, "travar");
    assert.match(r.caveats.join(" "), /DRIFT DE NAMING/);
  });

  it("não significativo → continuar e acumular amostra", () => {
    const r = recommendAbcAction(table({ significantClick: false, pValue: 0.4 }));
    assert.equal(r.action, "continuar");
    assert.equal(r.winner, null);
    assert.match(r.rationale, /NÃO é significativa/);
  });

  it("abertura DISCORDANDO do clique é reportada, nunca promovida a critério", () => {
    const r = recommendAbcAction(
      table({ significantClick: false, pValue: 0.4, leaderOpenRate: "B", leaderClickRate: "A" }),
    );
    assert.match(r.rationale, /líder por ABERTURA é a B/);
    assert.equal(r.metric, "clique");
  });
});

// ---------------------------------------------------------------------------
// Backlog MV e não-abridores
// ---------------------------------------------------------------------------

describe("summarizeMvBacklog (#4657)", () => {
  it("conta só quem nunca passou pelo MV, por cohort, ordenado por volume", () => {
    const b = summarizeMvBacklog([
      { cohort: "leads-2023h2", mv_bucket: null, ineligible_reason: "mv_unverified" },
      { cohort: "leads-2023h2", mv_bucket: null, ineligible_reason: "mv_unverified" },
      { cohort: "leads-2022h1", mv_bucket: null, ineligible_reason: "mv_unverified" },
      { cohort: "leads-2024h2", mv_bucket: "verified", ineligible_reason: null },
      { cohort: "leads-2024h2", mv_bucket: null, ineligible_reason: "mv_rejected" },
    ]);
    assert.equal(b.total, 3);
    assert.deepEqual(b.byCohort, [
      { cohort: "leads-2023h2", count: 2 },
      { cohort: "leads-2022h1", count: 1 },
    ]);
    assert.equal(b.estimatedCostUsd, 3 * MV_COST_PER_EMAIL_USD);
  });

  it("cohort ausente cai num rótulo explícito, nunca em undefined", () => {
    const b = summarizeMvBacklog([{ cohort: null, mv_bucket: null, ineligible_reason: "mv_unverified" }]);
    assert.equal(b.byCohort[0].cohort, "(sem cohort)");
  });
});

describe("measureNonOpenerExposure (#4657 — lacuna do sunset #4430)", () => {
  it("conta elegíveis com N+ envios e zero aberturas", () => {
    const e = measureNonOpenerExposure([
      { send_eligible: 1, sends_count: 3, opens_count: 0 },
      { send_eligible: 1, sends_count: 2, opens_count: 0 },
      { send_eligible: 1, sends_count: 5, opens_count: 1 }, // abriu
      { send_eligible: 1, sends_count: 1, opens_count: 0 }, // 1 envio só
      { send_eligible: 0, sends_count: 9, opens_count: 0 }, // inelegível
    ]);
    assert.equal(e.count, 2);
    assert.equal(e.minSends, 2);
    assert.equal(e.fraction, 2 / 4);
  });

  it("base elegível vazia não divide por zero", () => {
    const e = measureNonOpenerExposure([{ send_eligible: 0, sends_count: 3, opens_count: 0 }]);
    assert.equal(e.count, 0);
    assert.equal(e.fraction, 0);
  });
});

// ---------------------------------------------------------------------------
// Volume — delega ao semáforo, sem lógica própria
// ---------------------------------------------------------------------------

function sentCampaign(day: string, sent: number): BrevoCampaign {
  return {
    id: 1,
    name: "c",
    subject: "s",
    status: "sent",
    sentDate: `${day}T09:00:00.000Z`,
    scheduledAt: null,
    createdAt: day,
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent,
        delivered: sent,
        hardBounces: 0,
        softBounces: 0,
        uniqueViews: Math.round(sent * 0.25),
        viewed: Math.round(sent * 0.25),
        trackableViews: sent,
        uniqueClicks: Math.round(sent * 0.05),
        clickers: Math.round(sent * 0.05),
        unsubscriptions: 0,
        complaints: 0,
        appleMppOpens: 0,
      },
    },
  } as BrevoCampaign;
}

describe("proposeVolumes (#4657)", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");

  it("rejeita horizonte inválido", () => {
    const r = proposeVolumes([], 0, now, null);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /inteiro > 0/);
  });

  it("sem envio registrado → erro explícito, nunca chuta volume", () => {
    const r = proposeVolumes([], 3, now, null);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Nenhum envio registrado/);
  });

  it("sem envio maduro (>48h) → pede pra aguardar as métricas", () => {
    const r = proposeVolumes([sentCampaign("2026-08-10", 1000)], 3, now, null);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /maduro/);
  });

  it("propõe um volume por dia do horizonte pedido", () => {
    const r = proposeVolumes([sentCampaign("2026-08-01", 1000)], 3, now, null);
    assert.equal(r.ok, true);
    const p = (r as { proposal: { perDay: number[]; total: number } }).proposal;
    assert.equal(p.perDay.length, 3);
    assert.equal(p.total, p.perDay.reduce((a, b) => a + b, 0));
  });

  it("horizonte > 3 repete o 3º volume em vez de extrapolar a escalada", () => {
    // Escalar composto sem métrica nova entre um dia e outro inventaria
    // confiança que o dado não sustenta — os dias 4+ ainda não maturaram.
    const r = proposeVolumes([sentCampaign("2026-08-01", 1000)], 5, now, null);
    assert.equal(r.ok, true);
    const { perDay } = (r as { proposal: { perDay: number[] } }).proposal;
    assert.equal(perDay.length, 5);
    assert.equal(perDay[3], perDay[2]);
    assert.equal(perDay[4], perDay[2]);
  });

  it("leitura de spam ausente nunca deixa o semáforo verde às cegas", () => {
    const r = proposeVolumes([sentCampaign("2026-08-01", 1000)], 3, now, null);
    assert.equal(r.ok, true);
    const p = (r as { proposal: { semaphore: string } }).proposal;
    assert.notEqual(p.semaphore, "green");
  });
});

// ---------------------------------------------------------------------------
// Proposta consolidada — bloqueio ≠ aviso
// ---------------------------------------------------------------------------

function proposalInput(over: Partial<WaveProposalInput> = {}): WaveProposalInput {
  return {
    cycle: "2607-08",
    dates: ["2026-08-06"],
    volumes: {
      perDay: [1000],
      total: 1000,
      semaphore: "yellow",
      flagged: false,
      baseVolume: 1000,
      health: { openRate: 20, hardBounceRate: 0.2, bounceRate: 1.5, spamRate: 0, unsubRate: 0.9, delivered: 1000, sent: 1000 },
      spamSignal: { source: "postmaster", ratePct: 0.1, breach: false },
    },
    abc: { action: "continuar", metric: "clique", winner: "A", caveats: [], rationale: "…" },
    state: { cycle: "2607-08", waves: [], volumeSum: 0, volumeComplete: false, sentCount: 0, scheduledCount: 0, unscopedCount: 0 },
    availableFirstSend: 50_000,
    mvBacklog: { total: 253_730, byCohort: [], estimatedCostUsd: 482 },
    nonOpeners: { count: 0, fraction: 0, minSends: 2 },
    brevoCredits: 148_947,
    staleNote: null,
    startingWaveNumber: 6,
    committedLookupFailed: false,
    ...over,
  };
}

describe("buildWaveProposal (#4657)", () => {
  it("gera 3 listas por dia quando o teste continua, 1 quando trava", () => {
    const withTest = buildWaveProposal(proposalInput());
    assert.deepEqual(withTest.waves[0].keys, ["d6-qui06-A", "d6-qui06-B", "d6-qui06-C"]);

    const locked = buildWaveProposal(
      proposalInput({ abc: { action: "travar", metric: "clique", winner: "A", caveats: [], rationale: "…" } }),
    );
    assert.deepEqual(locked.waves[0].keys, ["d6-qui06"]);
  });

  it("numera as ondas continuando o ciclo, nunca reiniciando", () => {
    const p = buildWaveProposal(
      proposalInput({
        dates: ["2026-08-06", "2026-08-07"],
        volumes: { ...proposalInput().volumes, perDay: [1000, 1100], total: 2100 },
        startingWaveNumber: 6,
      }),
    );
    assert.deepEqual(p.waves.map((w) => w.n), [6, 7]);
    assert.equal(p.waves[1].scheduledAt, "2026-08-07T09:00:00.000Z");
  });

  it("BLOQUEIA no semáforo vermelho", () => {
    const p = buildWaveProposal(
      proposalInput({ volumes: { ...proposalInput().volumes, semaphore: "red", flagged: true } }),
    );
    assert.match(p.blockers.join(" "), /VERMELHO/);
  });

  it("BLOQUEIA quando o crédito Brevo não cobre a onda", () => {
    const p = buildWaveProposal(proposalInput({ brevoCredits: 500 }));
    assert.match(p.blockers.join(" "), /Crédito Brevo insuficiente/);
  });

  it("BLOQUEIA quando o crédito nem foi consultado — nunca agenda às cegas", () => {
    const p = buildWaveProposal(proposalInput({ brevoCredits: null }));
    assert.match(p.blockers.join(" "), /não consultado/);
  });

  it("BLOQUEIA quando a fila é menor que o volume proposto", () => {
    const p = buildWaveProposal(proposalInput({ availableFirstSend: 100 }));
    assert.match(p.blockers.join(" "), /Fila de 1º envio/);
  });

  it("REGRESSÃO #3682: falha na consulta de comprometidos BLOQUEIA, não avisa", () => {
    // `fetchCommittedCampaignListIds` é documentada pra falhar alto: sem ela
    // o set de exclusão fica vazio e a fila é superestimada — quem já está
    // agendado recebe de novo. Antes isso era só um console.error, que nem
    // entra no --json que a skill lê.
    const p = buildWaveProposal(proposalInput({ committedLookupFailed: true }));
    assert.match(p.blockers.join(" "), /campanhas comprometidas/);
    assert.match(p.blockers.join(" "), /#3682/);
  });

  it("REGRESSÃO: perDay que não cobre dates LANÇA, nunca preenche com 0", () => {
    // Antes caía num `?? 0` silencioso — uma onda de volume ZERO renderizada
    // como se fosse plano legítimo.
    assert.throws(
      () =>
        buildWaveProposal(
          proposalInput({
            dates: ["2026-08-06", "2026-08-07"],
            volumes: { ...proposalInput().volumes, perDay: [1000] },
          }),
        ),
      /não cobre dates/,
    );
  });

  it("AVISA quando campanhas ficaram sem escopo de ciclo", () => {
    const p = buildWaveProposal(
      proposalInput({ state: { ...proposalInput().state, unscopedCount: 2 } }),
    );
    assert.match(p.warnings.join(" "), /EXCLUÍDAS do resumo/);
  });

  it("AVISA (sem bloquear) quando a fila acaba logo, apontando o MV como alavanca", () => {
    const p = buildWaveProposal(proposalInput({ availableFirstSend: 1500 }));
    assert.equal(p.blockers.length, 0);
    assert.match(p.warnings.join(" "), /MillionVerifier/);
    // Decisão do editor: sinalizar o MV como alavanca e dizer explicitamente
    // que a saída NÃO é trocar o público pra reenvio (mudança de natureza da
    // onda — aquisição → retenção — disfarçada de continuidade).
    assert.match(p.warnings.join(" "), /não trocar o público pra reenvio/);
  });

  it("AVISA sobre não-abridores acumulados (sunset #4430 nunca implementado)", () => {
    const p = buildWaveProposal(proposalInput({ nonOpeners: { count: 112_172, fraction: 0.675, minSends: 2 } }));
    assert.match(p.warnings.join(" "), /NUNCA abrir/);
    assert.match(p.warnings.join(" "), /#4430/);
  });

  it("AVISA sobre dado stale do dashboard com a idade real", () => {
    const p = buildWaveProposal(proposalInput({ staleNote: "upstream-error — ~3.2h stale" }));
    assert.match(p.warnings.join(" "), /3\.2h stale/);
  });

  it("AVISA sobre campanha ainda agendada (imutável na Brevo)", () => {
    const p = buildWaveProposal(
      proposalInput({ state: { ...proposalInput().state, scheduledCount: 3 } }),
    );
    assert.match(p.warnings.join(" "), /imutáveis/);
  });

  it("propaga as ressalvas do A/B/C pros avisos", () => {
    const p = buildWaveProposal(
      proposalInput({
        abc: { action: "continuar", metric: "clique", winner: "A", caveats: ["ressalva X"], rationale: "…" },
      }),
    );
    assert.match(p.warnings.join(" "), /Teste A\/B\/C: ressalva X/);
  });
});

describe("clarice-plan-wave.ts é READ-ONLY (#4657)", () => {
  it("não importa nenhum helper de ESCRITA da Brevo", () => {
    // A PR afirma "read-only por construção". Sem este teste a afirmação
    // vive só num comentário, e uma edição futura que adicione um POST
    // passaria despercebida — num script cujo output autoriza envio pra
    // dezenas de milhares de contatos.
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/clarice-plan-wave.ts"), "utf8");
    for (const forbidden of ["brevoPost", "brevoPut", "brevoDelete", "brevoSendNow", "writeFileSync", "writeFileAtomic"]) {
      assert.doesNotMatch(src, new RegExp(`\\b${forbidden}\\b`), `${forbidden} não pode aparecer neste script`);
    }
  });

  it("só usa SELECT no store — nenhum INSERT/UPDATE/DELETE", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/clarice-plan-wave.ts"), "utf8");
    for (const forbidden of ["INSERT", "UPDATE ", "DELETE", "DROP", "recomputeDerived"]) {
      assert.doesNotMatch(src, new RegExp(forbidden), `${forbidden} não pode aparecer neste script`);
    }
  });
});

describe("renderWaveProposal (#4657)", () => {
  it("mostra TODO valor que vira escrita na Brevo, e oferece 'sim' só sem bloqueio", () => {
    const out = renderWaveProposal(buildWaveProposal(proposalInput()));
    assert.match(out, /2026-08-06 06:00 BRT/);
    assert.match(out, /Clarice 2607-08 d6-qui06-A — célula A/);
    assert.match(out, /Crédito Brevo/);
    assert.match(out, /Confirmar e agendar\? sim \/ ajustar \/ abortar/);
  });

  it("com bloqueio, NÃO oferece 'sim'", () => {
    const out = renderWaveProposal(buildWaveProposal(proposalInput({ brevoCredits: 10 })));
    assert.doesNotMatch(out, /Confirmar e agendar\?/);
    assert.match(out, /Não é possível agendar com bloqueio/);
  });

  it("spam indeterminado é dito explicitamente, nunca omitido", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          volumes: {
            ...proposalInput().volumes,
            spamSignal: { source: "indeterminate", ratePct: null, breach: false },
          },
        }),
      ),
    );
    assert.match(out, /indeterminado/);
  });
});
