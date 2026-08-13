import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  brtDayLabel,
  buildWaveProposal,
  computeFirstSendDeficit,
  computeNextWaveNumber,
  detectCohortInversion,
  groupKeyFromCampaignName,
  measureNonOpenerExposure,
  measureNovosFreshness,
  mergeCampaignSources,
  MV_BACKLOG_NO_COHORT_LABEL,
  planMvOnDemand,
  proposeVolumes,
  recommendAbcAction,
  renderWaveProposal,
  scheduledAtForDate,
  sliceCohortComposition,
  summarizeAvailableFirstSendByCohort,
  summarizeCycleSends,
  summarizeMvBacklog,
  waveDateFragment,
  waveKey,
  MV_COST_PER_EMAIL_USD,
  MV_ONDEMAND_APPROVAL_MARGIN,
  NOVOS_FRESHNESS_WARNING_HOURS,
  NOVOS_FRESHNESS_BLOCKER_HOURS,
  type WaveProposalInput,
} from "../scripts/lib/clarice-wave-plan.ts";
import {
  buildGroupCells,
  buildSingleWave,
  cellManifestFileName,
  manifestOf,
  resolveCellStrategy,
  unknownFlags,
} from "../scripts/lib/clarice-group-cells.ts";
import { resolveListName } from "../scripts/clarice-import-waves.ts";
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
    // `new Date("2026-02-31")` vira 03/03 sem erro. Corrigir depois exige
    // cancelar/recriar a campanha via API/painel (#4935, não é gratuito) —
    // um off-by-one aqui só apareceria pós-disparo.
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

  it("#5140: omitir hourUtc preserva 09:00 UTC — o default é o comportamento histórico", () => {
    // Trava o default explicitamente: a parametrização do #5140 não pode ter
    // mudado nada pra quem não passa hora. Todo call site de produção hoje
    // passa por este ramo.
    assert.equal(scheduledAtForDate("2026-08-12"), scheduledAtForDate("2026-08-12", 9));
  });

  it("#5140: hourUtc explícito monta o ISO na hora pedida (13 UTC = 10:00 BRT)", () => {
    assert.equal(scheduledAtForDate("2026-08-12", 13), "2026-08-12T13:00:00.000Z");
    assert.equal(scheduledAtForDate("2026-08-12", 0), "2026-08-12T00:00:00.000Z");
    assert.equal(scheduledAtForDate("2026-08-12", 23), "2026-08-12T23:00:00.000Z");
  });

  it("#5140: hora fora de 0–23 ou fracionária lança — vira scheduledAt de campanha real", () => {
    // Mesmo racional do round-trip de data acima: o valor vai pra Brevo, e
    // um ISO malformado só aparece depois do --create.
    assert.throws(() => scheduledAtForDate("2026-08-12", 24), /hora UTC inválida/);
    assert.throws(() => scheduledAtForDate("2026-08-12", -1), /hora UTC inválida/);
    assert.throws(() => scheduledAtForDate("2026-08-12", 9.5), /hora UTC inválida/);
    assert.throws(() => scheduledAtForDate("2026-08-12", Number.NaN), /hora UTC inválida/);
  });

  it("#5140: a validação de data continua valendo com hora customizada", () => {
    // O guard novo entra ANTES do round-trip; garantir que não curto-circuita
    // a checagem de calendário que já existia.
    assert.throws(() => scheduledAtForDate("2026-02-31", 13), /inexistente no calendário/);
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

describe("waveDateFragment (#5064 — extraído de waveKey pro guard de onda em draft)", () => {
  it("mesmo fragmento que waveKey embute na chave, pra qualquer N/célula", () => {
    assert.equal(waveDateFragment("2026-08-06"), "qui06");
    assert.equal(waveDateFragment("2026-08-01"), "sab01");
    assert.equal(waveKey(6, "2026-08-06"), `d6-${waveDateFragment("2026-08-06")}`);
    assert.equal(waveKey(1, "2026-08-01", "A"), `d1-${waveDateFragment("2026-08-01")}-A`);
  });

  it("rejeita data inválida (mesmo guard de scheduledAtForDate)", () => {
    assert.throws(() => waveDateFragment("2026-02-31"), /inexistente no calendário/);
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

describe("mergeCampaignSources (#5064)", () => {
  it("funde sent/queued com draft, preservando ordem (sent/queued primeiro)", () => {
    const sentOrQueued = [campaign({ id: 1, status: "sent" }), campaign({ id: 2, status: "queued" })];
    const draft = [campaign({ id: 3, status: "draft" })];
    const merged = mergeCampaignSources(sentOrQueued, draft);
    assert.deepEqual(merged.map((c) => c.id), [1, 2, 3]);
  });

  it("dedup defensivo por id — nunca conta a mesma campanha duas vezes", () => {
    const sentOrQueued = [campaign({ id: 1, status: "sent" })];
    const draft = [campaign({ id: 1, status: "draft" })]; // mesmo id, não deveria acontecer de verdade
    const merged = mergeCampaignSources(sentOrQueued, draft);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, "sent", "a 1ª ocorrência (sent/queued) vence");
  });

  it("arrays vazios => vazio", () => {
    assert.deepEqual(mergeCampaignSources([], []), []);
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
    const a = buildGroupCells(rows, 6, "2026-08-06");
    assert.deepEqual(manifestOf(a).map((m) => m.count), [4, 3, 3]);
    assert.equal(a.cells.flatMap((c) => c.rows).length, 10);
  });

  it("nenhum contato aparece em duas células", () => {
    const { cells } = buildGroupCells(rows, 6, "2026-08-06");
    const all = cells.flatMap((c) => c.rows).map((r) => r.email);
    assert.equal(new Set(all).size, all.length);
  });

  it("as chaves são GERADAS e o groupKey é o do dia (o --group do import)", () => {
    const a = buildGroupCells(rows, 6, "2026-08-06");
    assert.equal(a.groupKey, "d6-qui06");
    assert.deepEqual(manifestOf(a).map((m) => m.key), ["d6-qui06-A", "d6-qui06-B", "d6-qui06-C"]);
    const groupKey = a.groupKey;
    assert.equal(cellManifestFileName(groupKey), "d6-qui06-manifest.json");
  });

  it("PARIDADE ponta a ponta: chave gerada → nome de lista → parser do painel", () => {
    // Este é o teste que faltava pra "o nome da lista nunca é digitado" ser
    // verdade: antes, o manifest de 3 entradas era escrito à mão (era esse o
    // "digitado à mão" da #4449, que sobreviveu ao #4471).
    for (const entry of manifestOf(buildGroupCells(rows, 6, "2026-08-06"))) {
      const listName = groupCellListNameFor("2607-08", entry.key);
      const parsed = parseAbcAudienceCampaign(`Clarice 2608 grupo:${entry.key}`, listName);
      assert.ok(parsed, `não parseou: ${listName}`);
      assert.equal(parsed.cycle, "2607-08");
      assert.equal(parsed.cell, entry.key.slice(-1));
    }
  });

  it("buildSingleWave: assunto travado → 1 lista com a chave do dia", () => {
    // Sem isto, o caminho `travar` com vários dias sairia com a chave
    // `ramp-warm` do build-segment: 3 campanhas com o MESMO nome
    // (`grupo:ramp-warm`) colidindo entre si, e `computeNextWaveNumber`
    // travado (porque `ramp-warm` não casa `d{N}-`).
    const a = buildSingleWave(rows, 6, "2026-08-06");
    const manifest = manifestOf(a);
    assert.equal(a.groupKey, "d6-qui06");
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].key, "d6-qui06");
    assert.equal(manifest[0].count, 10);
    assert.equal(a.cells[0].rows.length, 10);
    // A chave gerada avança a numeração, ao contrário de 'ramp-warm':
    assert.equal(computeNextWaveNumber([{ key: manifest[0].key }]), 7);
  });

  it("buildSingleWave: lista vazia não estoura", () => {
    const a = buildSingleWave([], 6, "2026-08-06");
    assert.equal(manifestOf(a)[0].count, 0);
    assert.deepEqual(a.cells[0].rows, []);
  });

  it("REGRESSÃO: buildSingleWave COPIA as linhas, não aliasa o array do chamador", () => {
    // `buildGroupCells` devolve arrays novos (de `stratify`). Aliasar aqui
    // deixaria os dois construtores com contratos diferentes — o tipo de
    // assimetria que produz "funcionou no teste, corrompeu na 3ª invocação".
    const src = [{ email: "a@x.com" }, { email: "b@x.com" }];
    const a = buildSingleWave(src, 6, "2026-08-06");
    src.push({ email: "c@x.com" });
    assert.equal(a.cells[0].rows.length, 2);
  });

  it("chave de onda única NÃO colide com as chaves de célula do mesmo dia", () => {
    const single = manifestOf(buildSingleWave(rows, 6, "2026-08-06")).map((m) => m.key);
    const abc = manifestOf(buildGroupCells(rows, 6, "2026-08-06")).map((m) => m.key);
    assert.equal(new Set([...single, ...abc]).size, single.length + abc.length);
  });

  it("resolveCellStrategy: --no-cells escolhe onda única; ausência escolhe A/B/C", () => {
    // Única lógica com consequência de produção no CLI (1 ou 3 listas na
    // Brevo pra um envio real) e antes sem teste nenhum.
    assert.deepEqual(resolveCellStrategy(["--cycle", "2607-08", "--no-cells"]), { kind: "single" });
    assert.deepEqual(resolveCellStrategy(["--cycle", "2607-08"]), { kind: "cells" });
    assert.deepEqual(resolveCellStrategy(["--no-cells", "--dry-run"]), { kind: "single" });
  });

  it("#5140: --hour-cells escolhe teste de horário, ordenado e sem repetição", () => {
    assert.deepEqual(resolveCellStrategy(["--hour-cells", "6,10"]), { kind: "hours", hoursBrt: [6, 10] });
    assert.deepEqual(resolveCellStrategy(["--hour-cells=10,6"]), { kind: "hours", hoursBrt: [6, 10] });
    assert.deepEqual(resolveCellStrategy(["--hour-cells", "10,6,10"]), { kind: "hours", hoursBrt: [6, 10] });
  });

  it("#5140: --no-cells + --hour-cells ABORTA em vez de eleger um vencedor silencioso", () => {
    // As duas flags exprimem intenções incompatíveis. Adivinhar qual vale
    // reintroduziria a classe do #4660: fragmentar (ou não) a audiência de um
    // envio real sem nada no log distinguindo isso do caminho pedido.
    assert.throws(
      () => resolveCellStrategy(["--no-cells", "--hour-cells", "6,10"]),
      /mutuamente exclusivos/,
    );
  });

  it("#5140: --hour-cells inválido lança — o valor vira scheduledAt de campanha real", () => {
    assert.throws(() => resolveCellStrategy(["--hour-cells", "6"]), />= 2 horas distintas/);
    assert.throws(() => resolveCellStrategy(["--hour-cells", "6,25"]), /hora BRT inválida/);
    assert.throws(() => resolveCellStrategy(["--hour-cells", "6,abc"]), /hora BRT inválida/);
    assert.throws(() => resolveCellStrategy(["--hour-cells", "6,10.5"]), /hora BRT inválida/);
  });

  it("REGRESSÃO: typo em --no-cells é REJEITADO, nunca cai em 3 células calado", () => {
    // `hasFlag` faz match exato: `--nocells` devolvia false e o script gerava
    // A/B/C em silêncio — com assunto travado, 3 listas pro mesmo assunto.
    assert.deepEqual(unknownFlags(["--no-cells"]), []);
    assert.deepEqual(unknownFlags(["--nocells"]), ["--nocells"]);
    assert.deepEqual(unknownFlags(["--no-cell"]), ["--no-cell"]);
    // Flag COM valor não é confundida com flag booleana desconhecida:
    assert.deepEqual(unknownFlags(["--cycle", "2607-08", "--dry-run"]), []);
  });

  it("REGRESSÃO: o nome da lista da onda de dia embute o CICLO, não o label", () => {
    // `listNameFor` embute só `label`, e `summarizeCycleSends` atribui ciclo
    // por `listName.includes(cycle)` — a atribuição dependia de o operador
    // lembrar de digitar o ciclo no `--label`, sem nada forçando (#4660).
    const entry = manifestOf(buildSingleWave(rows, 6, "2026-08-06"))[0];
    const name = resolveListName(
      { key: entry.key, file: entry.file, desc: entry.desc },
      "Agosto/2026", // label SEM o ciclo — o caso que quebrava
      "2607-08",
      "d6-qui06",
    );
    assert.ok(name.includes("2607-08"), `nome sem ciclo: ${name}`);
    // E continua atribuível pelo mesmo predicado que summarizeCycleSends usa:
    assert.ok(name.includes("d6-qui06"));
  });

  it("grupo nomeado sem formato de dia mantém o naming de sempre (sem blast radius)", () => {
    const name = resolveListName(
      { key: "ramp-warm", file: "ramp-warm.csv", desc: "Ramp warm (1º envio seguro)" },
      "Jun/2026",
      "2607-08",
      "ramp-warm",
    );
    assert.match(name, /^Clarice Jun\/2026 ramp-warm — /);
  });

  it("lista vazia não estoura — 3 células vazias", () => {
    assert.deepEqual(manifestOf(buildGroupCells([], 6, "2026-08-06")).map((m) => m.count), [0, 0, 0]);
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

  // -------------------------------------------------------------------------
  // #5055 — o teste encerrado NÃO REABRE por recálculo, e não congela o volume
  // -------------------------------------------------------------------------

  it('#5055: encerrado + tabela que sozinha diria "continuar" (p ≥ 0,05) → travar mesmo assim', () => {
    // Este é o coração da #5055. Sem o estado durável, a onda de 12/08/2026
    // saiu com 3 assuntos porque o recálculo devolveu `continuar` (p 0,2715)
    // DEPOIS de o editor já ter encerrado o teste. Se alguém remover o ramo
    // do `lockedSubject`, este teste quebra.
    const naoSignificativa = table({ significantClick: false, pValue: 0.2715, leaderClickRate: "A" });
    assert.equal(recommendAbcAction(naoSignificativa).action, "continuar", "pré-condição: sem trava, reabriria");

    const r = recommendAbcAction(naoSignificativa, { lockedSubject: "Assunto travado" });
    assert.equal(r.action, "travar");
    assert.equal(r.winner, null, "encerramento editorial não inventa vencedora estatística");
    assert.match(r.rationale, /Assunto travado/);
  });

  it("#5055: encerrado + poder baixo → SEM ressalva, pra que o passo de volume não seja zerado", () => {
    // `clarice-envio-run.ts` zera o passo adaptativo quando `caveats` não é
    // vazio. Com o teste encerrado não existe teste pra ter poder nenhum, então
    // a ressalva de poder baixo (#4559) não pode sobreviver — era ela que
    // fechava o laço "base pequena → poder baixo → passo zerado → base nunca
    // cresce". Uma `minDetectableLiftRelative` altíssima aqui é justamente o
    // caso que geraria a ressalva se o teste estivesse aberto.
    const poderBaixo = table({ minDetectableLiftRelative: 0.9, attributionUnknown: true, suspectedDriftDays: ["2026-08-04"] });
    assert.ok(recommendAbcAction(poderBaixo).caveats.length > 0, "pré-condição: aberto, esta tabela gera ressalvas");

    const r = recommendAbcAction(poderBaixo, { lockedSubject: "Assunto travado" });
    assert.equal(r.action, "travar");
    assert.deepEqual(r.caveats, [], "teste encerrado não tem ressalva de poder — nada zera o passo");
    assert.equal(r.metric, "nenhuma", "nenhuma métrica sustenta a decisão: ela é editorial, não estatística");
  });

  it("#5055: assunto travado vazio/nulo não trava — cai no cálculo normal", () => {
    // Espelha a invariante do lado do estado (`encerrado` sem subject é
    // inválido): mesmo que um caller passe string vazia, o comportamento é o
    // pré-#5055, nunca "travar num assunto vazio".
    for (const vazio of [null, undefined, ""]) {
      const r = recommendAbcAction(table({ significantClick: false, pValue: 0.5 }), { lockedSubject: vazio });
      assert.equal(r.action, "continuar", `lockedSubject=${JSON.stringify(vazio)} não pode travar`);
    }
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
      { cohort: "leads-2023h2", count: 2, mostRecentCreated: null },
      { cohort: "leads-2022h1", count: 1, mostRecentCreated: null },
    ]);
    assert.equal(b.estimatedCostUsd, 3 * MV_COST_PER_EMAIL_USD);
  });

  it("cohort ausente cai num rótulo explícito, nunca em undefined", () => {
    const b = summarizeMvBacklog([{ cohort: null, mv_bucket: null, ineligible_reason: "mv_unverified" }]);
    assert.equal(b.byCohort[0].cohort, "(sem cohort)");
  });

  it("#5179: mostRecentCreated é o `created` mais recente do cohort, ISO — null quando ausente/inválido", () => {
    const b = summarizeMvBacklog([
      { cohort: "ex-assinantes", mv_bucket: null, ineligible_reason: "mv_unverified", created: "2022-01-01T00:00:00.000Z" },
      { cohort: "ex-assinantes", mv_bucket: null, ineligible_reason: "mv_unverified", created: "2025-06-15T00:00:00.000Z" },
      { cohort: "ex-assinantes", mv_bucket: null, ineligible_reason: "mv_unverified", created: "não é data" },
      { cohort: "leads-2026-06", mv_bucket: null, ineligible_reason: "mv_unverified" },
    ]);
    const exAssinantes = b.byCohort.find((e) => e.cohort === "ex-assinantes");
    assert.equal(exAssinantes?.mostRecentCreated, "2025-06-15T00:00:00.000Z");
    const leads = b.byCohort.find((e) => e.cohort === "leads-2026-06");
    assert.equal(leads?.mostRecentCreated, null);
  });
});

// ---------------------------------------------------------------------------
// Verificação MV sob demanda (#4659)
// ---------------------------------------------------------------------------

describe("computeFirstSendDeficit (#4659)", () => {
  it("fila cobre o volume → déficit zero", () => {
    assert.equal(computeFirstSendDeficit(5000, 1000), 0);
    assert.equal(computeFirstSendDeficit(1000, 1000), 0);
  });

  it("fila menor que o volume → déficit é a diferença exata", () => {
    assert.equal(computeFirstSendDeficit(300, 1000), 700);
  });

  it("nunca negativo mesmo com fila zero/negativa (defesa)", () => {
    assert.equal(computeFirstSendDeficit(0, 1000), 1000);
  });
});

describe("planMvOnDemand (#4659)", () => {
  const backlog = (byCohort: Array<{ cohort: string; count: number }>) => ({
    total: byCohort.reduce((s, e) => s + e.count, 0),
    byCohort,
    estimatedCostUsd: byCohort.reduce((s, e) => s + e.count, 0) * MV_COST_PER_EMAIL_USD,
  });

  it("déficit zero → plano vazio, backlog nem é olhado", () => {
    const p = planMvOnDemand(backlog([{ cohort: "leads-2026-06", count: 1000 }]), 0);
    assert.deepEqual(p.byCohort, []);
    assert.equal(p.targetVerifyCount, 0);
    assert.equal(p.backlogInsufficient, false);
  });

  it("aplica a margem de aprovação (déficit ÷ 0,90) — nunca verifica só o déficit exato", () => {
    const p = planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 5000 }]), 900);
    // 900 / 0.9 = 1000 exato — mas o arredondamento pra cima (Math.ceil)
    // importa em casos que não fecham redondo, testado abaixo.
    assert.equal(p.targetVerifyCount, 1000);
    assert.equal(p.byCohort[0].count, 1000);
  });

  it("arredonda o alvo pra CIMA (nunca deixa a onda curta por truncar)", () => {
    const p = planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 5000 }]), 100);
    // 100 / 0.9 = 111.11... → 112
    assert.equal(p.targetVerifyCount, 112);
  });

  it("REGRESSÃO #4542: aloca na ordem de cohortSendRank (morno→frio), NUNCA por volume", () => {
    // leads-caudao tem MUITO mais volume, mas ex-assinantes é mais morno —
    // summarizeMvBacklog ordenaria caudao primeiro (maior count); o plano
    // sob demanda tem que inverter isso pra ordem de prioridade de envio.
    const p = planMvOnDemand(
      backlog([
        { cohort: "leads-caudao", count: 50_000 },
        { cohort: "ex-assinantes", count: 200 },
        { cohort: "leads-2026-06", count: 500 },
      ]),
      600, // alvo = 600/0.9 = 667
    );
    assert.deepEqual(
      p.byCohort.map((a) => a.cohort),
      ["ex-assinantes", "leads-2026-06"],
    );
    assert.equal(p.byCohort[0].count, 200); // esgota ex-assinantes primeiro
    assert.equal(p.byCohort[1].count, 467); // resto (667-200) do próximo cohort mais morno
    assert.equal(p.totalPlanned, 667);
    assert.equal(p.backlogInsufficient, false);
  });

  it("#5179: com mostRecentCreated informado, a alocação segue recência REAL — pode inverter a ordem de cohortSendRank pra ex-assinantes", () => {
    const p = planMvOnDemand(
      {
        total: 700,
        byCohort: [
          { cohort: "leads-2026-06", count: 500, mostRecentCreated: "2026-06-01T00:00:00.000Z" },
          { cohort: "ex-assinantes", count: 200, mostRecentCreated: "2026-08-10T00:00:00.000Z" }, // cadastro MAIS recente que o lead, apesar do rank estrutural "quente" do lead
        ],
        estimatedCostUsd: 700 * MV_COST_PER_EMAIL_USD,
      },
      600, // alvo = 600/0.9 = 667
    );
    assert.deepEqual(
      p.byCohort.map((a) => a.cohort),
      ["ex-assinantes", "leads-2026-06"],
      "ex-assinantes com created mais recente vem primeiro, mesmo cohortSendRank favorecendo o lead",
    );
  });

  it("backlog insuficiente pra cobrir o alvo → totalPlanned < targetVerifyCount, sinalizado", () => {
    const p = planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 50 }]), 1000);
    assert.equal(p.totalPlanned, 50);
    assert.ok(p.totalPlanned < p.targetVerifyCount);
    assert.equal(p.backlogInsufficient, true);
  });

  it("guard explícito da issue: NUNCA aloca assinantes-ativos, mesmo se aparecer no backlog", () => {
    // Defesa em profundidade — summarizeMvBacklog não deveria produzir esta
    // entrada na prática (classifyEligibility nunca marca esse cohort como
    // mv_unverified), mas o filtro aqui não pode depender disso pra ser
    // verdade.
    const p = planMvOnDemand(
      backlog([
        { cohort: "assinantes-ativos", count: 9999 },
        { cohort: "ex-assinantes", count: 100 },
      ]),
      50,
    );
    assert.deepEqual(
      p.byCohort.map((a) => a.cohort),
      ["ex-assinantes"],
    );
  });

  it("REGRESSÃO (achado do self-review): '(sem cohort)' é EXCLUÍDA do plano, nunca alocada", () => {
    // '(sem cohort)' é só o rótulo de EXIBIÇÃO que summarizeMvBacklog usa pra
    // `cohort IS NULL` — não é um valor real da coluna. Se entrasse no plano,
    // `clarice-mv-ondemand.ts` faria `WHERE cohort = '(sem cohort)'` na hora
    // de executar, que nunca bate uma linha real (`cohort IS NULL`) — a
    // alocação gastaria "espaço" do alvo de verificação sem cobrir déficit
    // nenhum, silenciosamente.
    const p = planMvOnDemand(
      backlog([
        { cohort: MV_BACKLOG_NO_COHORT_LABEL, count: 500 },
        { cohort: "ex-assinantes", count: 100 },
      ]),
      150, // alvo = ceil(150/0.9) = 167 — sem a exclusão, sobraria pra '(sem cohort)'
    );
    assert.deepEqual(
      p.byCohort.map((a) => a.cohort),
      ["ex-assinantes"],
      "'(sem cohort)' nunca deveria aparecer numa alocação executável",
    );
    // Consequência esperada: com só 100 disponíveis em ex-assinantes contra
    // um alvo de 167, o backlog fica insuficiente — mesmo havendo 500
    // contatos "disponíveis" sob o rótulo não-executável.
    assert.equal(p.totalPlanned, 100);
    assert.equal(p.backlogInsufficient, true);
  });

  it("cohort DESCONHECIDO mas com slug real (não o sentinel) ainda cai no FIM da fila via cohortSendRank", () => {
    // Distinto do caso acima: um slug real que `cohortSendRank` não reconhece
    // (RANK_UNKNOWN) continua ALOCÁVEL — só vai pro fim da prioridade, nunca
    // é excluído por construção. Só o sentinel de exibição '(sem cohort)' é
    // filtrado (ele não é um valor real de cohort, esses são).
    const p = planMvOnDemand(
      backlog([
        { cohort: "algum-slug-nao-mapeado", count: 500 },
        { cohort: "ex-assinantes", count: 100 },
      ]),
      150,
    );
    assert.deepEqual(
      p.byCohort.map((a) => a.cohort),
      ["ex-assinantes", "algum-slug-nao-mapeado"],
    );
  });

  it("estimatedCostUsd reflete só o TOTAL PLANEJADO, não o alvo", () => {
    const p = planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 30 }]), 1000);
    assert.equal(p.totalPlanned, 30);
    assert.equal(p.estimatedCostUsd, 30 * MV_COST_PER_EMAIL_USD);
  });

  it("rejeita approvalMargin fora de (0, 1]", () => {
    assert.throws(() => planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 10 }]), 5, 0), /approvalMargin inválido/);
    assert.throws(() => planMvOnDemand(backlog([{ cohort: "ex-assinantes", count: 10 }]), 5, 1.1), /approvalMargin inválido/);
  });

  it("MV_ONDEMAND_APPROVAL_MARGIN é 0,90 (documentado, #4659)", () => {
    assert.equal(MV_ONDEMAND_APPROVAL_MARGIN, 0.9);
  });
});

// ---------------------------------------------------------------------------
// Composição por safra e inversão de safra (#4787)
// ---------------------------------------------------------------------------

function mvBacklogFixture(byCohort: Array<{ cohort: string; count: number }>) {
  return {
    total: byCohort.reduce((s, e) => s + e.count, 0),
    byCohort,
    estimatedCostUsd: byCohort.reduce((s, e) => s + e.count, 0) * MV_COST_PER_EMAIL_USD,
  };
}

describe("summarizeAvailableFirstSendByCohort (#4787)", () => {
  it("agrupa por cohort e ordena morno→frio (cohortSendRank) — null (sem cohort) por último, sem created em nenhuma linha", () => {
    const rows = [
      { cohort: "leads-2022h1" },
      { cohort: "leads-2024h2" },
      { cohort: "leads-2024h2" },
      { cohort: null },
      { cohort: "ex-assinantes" },
    ];
    assert.deepEqual(summarizeAvailableFirstSendByCohort(rows), [
      { cohort: "ex-assinantes", count: 1, mostRecentCreated: null },
      { cohort: "leads-2024h2", count: 2, mostRecentCreated: null },
      { cohort: "leads-2022h1", count: 1, mostRecentCreated: null },
      { cohort: null, count: 1, mostRecentCreated: null },
    ]);
  });

  it("lista vazia devolve array vazio", () => {
    assert.deepEqual(summarizeAvailableFirstSendByCohort([]), []);
  });

  it("#5179: ex-assinantes com created MAIS RECENTE que o lead mais quente passa à FRENTE dele — cohortSendRank sozinho erraria isso", () => {
    const rows = [
      { cohort: "leads-2026-06", created: "2026-06-01T00:00:00.000Z" }, // lead recém-nascido, rank quente
      { cohort: "ex-assinantes", created: "2026-08-10T00:00:00.000Z" }, // ex-assinante recém-cadastrado, rank estrutural "morno" mas created MAIS recente
    ];
    const out = summarizeAvailableFirstSendByCohort(rows);
    assert.deepEqual(
      out.map((e) => e.cohort),
      ["ex-assinantes", "leads-2026-06"],
    );
  });

  it("#5179: ex-assinantes SEM created confiável degrada pro cohortSendRank de sempre (fallback, comportamento pré-fix preservado)", () => {
    const rows = [{ cohort: "leads-2026-06" }, { cohort: "ex-assinantes" }];
    const out = summarizeAvailableFirstSendByCohort(rows);
    assert.deepEqual(
      out.map((e) => e.cohort),
      ["ex-assinantes", "leads-2026-06"],
    );
  });
});

describe("sliceCohortComposition (#4787)", () => {
  const available = [
    { cohort: "ex-assinantes", count: 100 },
    { cohort: "leads-2024h2", count: 50 },
    { cohort: "leads-2022h1", count: 200 },
  ];

  it("corta no meio de um cohort quando o total pedido cai lá", () => {
    assert.deepEqual(sliceCohortComposition(available, 120), [
      { cohort: "ex-assinantes", count: 100 },
      { cohort: "leads-2024h2", count: 20 },
    ]);
  });

  it("total 0 ou negativo devolve vazio, nunca lê a fila", () => {
    assert.deepEqual(sliceCohortComposition(available, 0), []);
    assert.deepEqual(sliceCohortComposition(available, -5), []);
  });

  it("total maior que a fila inteira devolve tudo, sem estourar", () => {
    assert.deepEqual(sliceCohortComposition(available, 10_000), available);
  });
});

describe("detectCohortInversion (#4787)", () => {
  it("sem consumo (onda vazia) → null", () => {
    assert.equal(detectCohortInversion([], mvBacklogFixture([{ cohort: "leads-2024h2", count: 100 }])), null);
  });

  it("consumo já é da safra mais nova disponível — backlog bloqueado é MAIS FRIO → null (não é inversão)", () => {
    const consumed = [{ cohort: "leads-2024h2", count: 500 }];
    // leads-2022h1 é mais FRIO que leads-2024h2 (rank maior) — não vira candidato.
    const inversion = detectCohortInversion(consumed, mvBacklogFixture([{ cohort: "leads-2022h1", count: 1000 }]));
    assert.equal(inversion, null);
  });

  it("REGRESSÃO (caso real #4787, onda 09/08 do ciclo 2607-08): safra fria consumida com safra mais nova bloqueada no MV → inversão", () => {
    // Reproduz a sequência real da issue: d9/d10 consumem 2024h2, d10/d11
    // pulam DIRETO pra 2022h1/2021h2 — passando por cima de 2024h1/2023h2/2023h1
    // (226.558 contatos), que nunca passaram pelo MillionVerifier.
    const consumed = [
      { cohort: "leads-2024h2", count: 4_465 },
      { cohort: "leads-2022h1", count: 6_237 },
      { cohort: "leads-2021h2", count: 5_689 },
    ];
    const backlog = mvBacklogFixture([
      { cohort: "leads-2024h1", count: 78_181 },
      { cohort: "leads-2023h2", count: 81_287 },
      { cohort: "leads-2023h1", count: 67_090 },
    ]);
    const inversion = detectCohortInversion(consumed, backlog);
    assert.ok(inversion, "deveria detectar a inversão");
    // leads-2024h1 é o mais NOVO (menor rank) entre os 3 cohorts bloqueados.
    assert.equal(inversion!.blockedCohort, "leads-2024h1");
    assert.equal(inversion!.coldestConsumedCohort, "leads-2021h2");
    // Cauda substituível = tudo consumido mais FRIO que leads-2024h1: 2022h1 + 2021h2
    // (2024h2 é mais QUENTE que 2024h1 — não entra na cauda).
    assert.equal(inversion!.coldTailCount, 6_237 + 5_689);
  });

  it("cohort MV-isento (assinantes-ativos) nunca conta como 'bloqueado', mesmo se aparecer no backlog", () => {
    const consumed = [{ cohort: "leads-2022h1", count: 100 }];
    const inversion = detectCohortInversion(consumed, mvBacklogFixture([{ cohort: "assinantes-ativos", count: 9999 }]));
    assert.equal(inversion, null);
  });

  it("rótulo de exibição '(sem cohort)' nunca conta como 'bloqueado' — não é um cohort executável", () => {
    const consumed = [{ cohort: "leads-2022h1", count: 100 }];
    const inversion = detectCohortInversion(
      consumed,
      mvBacklogFixture([{ cohort: MV_BACKLOG_NO_COHORT_LABEL, count: 9999 }]),
    );
    assert.equal(inversion, null);
  });

  it("REGRESSÃO (#4792 fleet review): cohort:null em `consumed` nunca vira 'coldest' por ruído de dado", () => {
    // Sem o guard, `cohortSendRank(null)` (RANK_UNKNOWN, o rank mais FRIO
    // possível) faria a linha `cohort: null` virar trivialmente "coldest",
    // inflando `coldTailCount` e disparando inversão só por causa de um
    // contato sem cohort identificável -- não por inversão real de safra.
    const consumed = [
      { cohort: "leads-2024h2", count: 500 },
      { cohort: null, count: 50 },
    ];
    // leads-2022h1 é mais FRIO que leads-2024h2 (o único cohort identificado
    // em `consumed`) -- não deveria virar candidato bloqueado.
    const inversion = detectCohortInversion(consumed, mvBacklogFixture([{ cohort: "leads-2022h1", count: 1000 }]));
    assert.equal(inversion, null);
  });

  it("REGRESSÃO (#4792): cohort:null é ignorado, mas inversão real ainda dispara e coldTailCount exclui a linha null", () => {
    const consumed = [
      { cohort: "leads-2024h2", count: 4_465 },
      { cohort: "leads-2022h1", count: 6_237 },
      { cohort: null, count: 999 }, // nunca deveria entrar em coldTailCount
    ];
    const inversion = detectCohortInversion(consumed, mvBacklogFixture([{ cohort: "leads-2024h1", count: 78_181 }]));
    assert.ok(inversion, "deveria detectar a inversão pelo cohort identificado (leads-2022h1)");
    assert.equal(inversion!.blockedCohort, "leads-2024h1");
    assert.equal(inversion!.coldestConsumedCohort, "leads-2022h1");
    assert.equal(inversion!.coldTailCount, 6_237, "a linha cohort:null nunca entra na cauda fria contável");
  });

  it("`consumed` só com cohort:null → null (nada identificável pra avaliar)", () => {
    const inversion = detectCohortInversion(
      [{ cohort: null, count: 100 }],
      mvBacklogFixture([{ cohort: "leads-2024h1", count: 1000 }]),
    );
    assert.equal(inversion, null);
  });
});

describe("buildWaveProposal — mvOnDemandPlan embutido (#4659)", () => {
  it("sem déficit (fila cobre o volume) → mvOnDemandPlan vazio", () => {
    const p = buildWaveProposal(proposalInput({ availableFirstSend: 50_000 }));
    assert.deepEqual(p.mvOnDemandPlan.byCohort, []);
    assert.equal(p.mvOnDemandPlan.deficit, 0);
  });

  it("com déficit e backlog disponível → plano não-vazio, e o BLOQUEIO cita o recorte", () => {
    const p = buildWaveProposal(
      proposalInput({
        availableFirstSend: 300,
        mvBacklog: {
          total: 5000,
          byCohort: [{ cohort: "ex-assinantes", count: 5000 }],
          estimatedCostUsd: 5000 * MV_COST_PER_EMAIL_USD,
        },
      }),
    );
    // déficit = 1000 - 300 = 700; alvo = ceil(700/0.9) = 778
    assert.equal(p.mvOnDemandPlan.deficit, 700);
    assert.equal(p.mvOnDemandPlan.targetVerifyCount, 778);
    assert.deepEqual(p.mvOnDemandPlan.byCohort, [{ cohort: "ex-assinantes", count: 778 }]);
    assert.match(p.blockers.join(" "), /Verificação MV sob demanda cobriria/);
    assert.match(p.blockers.join(" "), /778 contato/);
  });

  it("com déficit mas SEM candidato no backlog (default mvBacklog.byCohort vazio) → bloqueio explica a ausência de alavanca", () => {
    const p = buildWaveProposal(proposalInput({ availableFirstSend: 100 }));
    assert.deepEqual(p.mvOnDemandPlan.byCohort, []);
    assert.match(p.blockers.join(" "), /não tem candidato pra cobrir o déficit/);
  });

  it("REGRESSÃO (achado do self-review): backlog INSUFICIENTE nunca diz 'cobriria' — o texto declara quanto falta", () => {
    // Sem este cuidado, o bloqueio dizia "cobriria: 778 contato(s)" mesmo
    // quando só 50 dos 778 alvo estavam de fato disponíveis — uma alegação
    // de cobertura total que era falsa.
    const p = buildWaveProposal(
      proposalInput({
        availableFirstSend: 300,
        mvBacklog: {
          total: 50,
          byCohort: [{ cohort: "ex-assinantes", count: 50 }],
          estimatedCostUsd: 50 * MV_COST_PER_EMAIL_USD,
        },
      }),
    );
    assert.equal(p.mvOnDemandPlan.backlogInsufficient, true);
    assert.equal(p.mvOnDemandPlan.totalPlanned, 50);
    const text = p.blockers.join(" ");
    assert.doesNotMatch(text, /Verificação MV sob demanda cobriria/, "nunca afirmar cobertura total quando é parcial");
    assert.match(text, /NÃO cobre inteiramente/);
    assert.match(text, /50 de 778 contato/);
  });
});

describe("buildWaveProposal — inversão de safra (#4787)", () => {
  it("SEM déficit de fila (fila cobre o volume) mas COM inversão de safra → mvOnDemandPlan dispara mesmo assim", () => {
    const p = buildWaveProposal(
      proposalInput({
        availableFirstSend: 2000, // 2000 >= volumes.total (1000) — sem déficit
        availableFirstSendByCohort: [{ cohort: "leads-2022h1", count: 2000 }], // única safra disponível, fria
        mvBacklog: mvBacklogFixture([{ cohort: "leads-2024h1", count: 5000 }]), // mais nova, bloqueada
      }),
    );
    assert.ok(p.cohortInversion, "deveria detectar a inversão");
    assert.equal(p.cohortInversion!.blockedCohort, "leads-2024h1");
    assert.equal(p.cohortInversion!.coldTailCount, 1000); // 100% do consumo é da safra fria
    assert.ok(p.mvOnDemandPlan.byCohort.length > 0, "mvOnDemandPlan deveria disparar mesmo sem déficit de fila");
    assert.equal(p.mvOnDemandPlan.byCohort[0].cohort, "leads-2024h1");
    assert.match(p.warnings.join(" "), /Inversão de safra/);
    assert.match(p.warnings.join(" "), /#4787/);
    // Não é bloqueio — a fila cobre o volume pedido, só a ORDEM está errada.
    assert.equal(p.blockers.length, 0);
  });

  it("sem inversão (fila já consome a safra mais nova disponível) → cohortInversion null, plano não dispara por isso", () => {
    const p = buildWaveProposal(
      proposalInput({
        availableFirstSend: 2000,
        availableFirstSendByCohort: [{ cohort: "leads-2024h2", count: 2000 }],
        // leads-2022h1 é mais FRIO que o que já está sendo consumido — não é inversão.
        mvBacklog: mvBacklogFixture([{ cohort: "leads-2022h1", count: 5000 }]),
      }),
    );
    assert.equal(p.cohortInversion, null);
    assert.deepEqual(p.mvOnDemandPlan.byCohort, []);
    assert.doesNotMatch(p.warnings.join(" "), /Inversão de safra/);
  });

  it("déficit E inversão ao mesmo tempo → o alvo do plano é o MAIOR dos dois, nunca sub-cobre nenhum", () => {
    const p = buildWaveProposal(
      proposalInput({
        volumes: { ...proposalInput().volumes, perDay: [10_000], total: 10_000 },
        availableFirstSend: 3_000, // déficit = 10_000 - 3_000 = 7_000 → alvo ceil(7000/0.9) = 7778
        availableFirstSendByCohort: [{ cohort: "leads-2022h1", count: 3_000 }],
        mvBacklog: mvBacklogFixture([{ cohort: "leads-2024h1", count: 50_000 }]),
      }),
    );
    // coldTailCount (3.000, tudo consumido é frio) é MENOR que o déficit — o
    // déficit domina o alvo, mas a inversão continua sinalizada.
    assert.equal(p.mvOnDemandPlan.targetVerifyCount, 7778);
    assert.ok(p.cohortInversion);
    assert.equal(p.cohortInversion!.coldTailCount, 3_000);
  });

  it("availableFirstSendByCohort vazio (caller não populou) → sem composição, sem inversão — nunca estoura", () => {
    const p = buildWaveProposal(proposalInput());
    assert.deepEqual(p.consumedByCohort, []);
    assert.equal(p.cohortInversion, null);
  });
});

describe("renderWaveProposal — seção MV sob demanda (#4659)", () => {
  it("aparece só quando o plano tem alocação, com o comando pronto pra rodar", () => {
    const withPlan = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          availableFirstSend: 300,
          mvBacklog: {
            total: 5000,
            byCohort: [{ cohort: "ex-assinantes", count: 5000 }],
            estimatedCostUsd: 5000 * MV_COST_PER_EMAIL_USD,
          },
        }),
      ),
    );
    assert.match(withPlan, /Verificação MV sob demanda \(#4659\)/);
    assert.match(withPlan, /Ex-assinantes.*778 contato/);
    assert.match(withPlan, /clarice-mv-ondemand\.ts --cycle 2607-08 --dates 2026-08-06/);
    assert.match(withPlan, /clarice-build-db\.ts/);
  });

  it("some da tela quando não há déficit (plano vazio)", () => {
    const noPlan = renderWaveProposal(buildWaveProposal(proposalInput({ availableFirstSend: 50_000 })));
    assert.doesNotMatch(noPlan, /Verificação MV sob demanda/);
  });
});

describe("renderWaveProposal — composição por safra (#4787)", () => {
  it("mostra uma linha por cohort consumido, na ordem morno→frio", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          availableFirstSend: 2000,
          availableFirstSendByCohort: [
            { cohort: "leads-2024h2", count: 400 },
            { cohort: "leads-2022h1", count: 1600 },
          ],
        }),
      ),
    );
    assert.match(out, /Composição da fila consumida, por safra \(#4787\)/);
    // volumes.total (default) = 1000: consome os 400 inteiros de 2024h2 +
    // 600 (PARCIAL) de 2022h1 — o corte no meio do 2º cohort é visível.
    assert.match(out, /2024-H2\s+400 contato/);
    assert.match(out, /2022-H1\s+600 contato/);
  });

  it("sem dado de composição → nota explícita, nunca tabela vazia silenciosa", () => {
    const out = renderWaveProposal(buildWaveProposal(proposalInput()));
    assert.match(out, /sem dado de composição/);
  });

  it("inversão de safra aparece nos avisos, e a seção MV sob demanda dispara mesmo sem déficit", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          availableFirstSend: 2000,
          availableFirstSendByCohort: [{ cohort: "leads-2022h1", count: 2000 }],
          mvBacklog: mvBacklogFixture([{ cohort: "leads-2024h1", count: 5000 }]),
        }),
      ),
    );
    assert.match(out, /Inversão de safra/);
    assert.match(out, /Verificação MV sob demanda \(#4659\)/);
  });

  it("REGRESSÃO (achado do self-review): 'Motivo' NUNCA rotula inversão pura como 'déficit de fila' — a fila cobre o volume inteiro aqui", () => {
    // `mvOnDemandPlan.deficit` (o campo bruto) vira o MAIOR entre déficit de
    // fila e cauda de inversão desde #4787 — sem este cuidado, o render dizia
    // literalmente "Déficit 1.000" mesmo quando não havia déficit real
    // nenhum (availableFirstSend 2000 >= volumes.total 1000), afirmando fila
    // curta quando o problema era só a ORDEM da safra.
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          availableFirstSend: 2000, // >= volumes.total (1000) — SEM déficit de fila
          availableFirstSendByCohort: [{ cohort: "leads-2022h1", count: 2000 }],
          mvBacklog: mvBacklogFixture([{ cohort: "leads-2024h1", count: 5000 }]),
        }),
      ),
    );
    assert.match(out, /Motivo: inversão de safra \(fila cobre o volume, sem déficit real\): 1\.000/);
    assert.doesNotMatch(out, /Motivo: déficit de fila/);
  });

  it("déficit de fila puro (sem inversão) → 'Motivo' rotula corretamente como déficit", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          availableFirstSend: 300, // déficit = 1000-300 = 700
          // availableFirstSendByCohort vazio (default) → sem composição/inversão.
          mvBacklog: mvBacklogFixture([{ cohort: "ex-assinantes", count: 5000 }]),
        }),
      ),
    );
    assert.match(out, /Motivo: déficit de fila: 700/);
    assert.doesNotMatch(out, /inversão de safra/);
  });

  it("déficit de fila E inversão ao mesmo tempo → 'Motivo' nomeia os dois, alvo pelo maior", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          volumes: { ...proposalInput().volumes, perDay: [10_000], total: 10_000 },
          availableFirstSend: 3_000, // déficit = 7.000
          availableFirstSendByCohort: [{ cohort: "leads-2022h1", count: 3_000 }],
          mvBacklog: mvBacklogFixture([{ cohort: "leads-2024h1", count: 50_000 }]),
        }),
      ),
    );
    assert.match(out, /Motivo: déficit de fila \(7\.000\) \+ inversão de safra \(3\.000\) — alvo pelo MAIOR dos dois/);
  });
});

describe("measureNonOpenerExposure (#4657 — lacuna do sunset #4430, fechada pelo #5041)", () => {
  const measured = "2026-06-01T00:00:00Z"; // #4688: hasMeasuredOpens exige brevo_modified_at != null

  it("conta elegíveis com N+ envios e zero aberturas", () => {
    const e = measureNonOpenerExposure([
      { send_eligible: 1, sends_count: 3, opens_count: 0, brevo_modified_at: measured },
      { send_eligible: 1, sends_count: 2, opens_count: 0, brevo_modified_at: measured },
      { send_eligible: 1, sends_count: 5, opens_count: 1, brevo_modified_at: measured }, // abriu
      { send_eligible: 1, sends_count: 1, opens_count: 0, brevo_modified_at: measured }, // 1 envio só
      { send_eligible: 0, sends_count: 9, opens_count: 0, brevo_modified_at: measured }, // inelegível
    ]);
    assert.equal(e.count, 2);
    assert.equal(e.minSends, 2);
    assert.equal(e.fraction, 2 / 4);
  });

  it("base elegível vazia não divide por zero", () => {
    const e = measureNonOpenerExposure([{ send_eligible: 0, sends_count: 3, opens_count: 0, brevo_modified_at: measured }]);
    assert.equal(e.count, 0);
    assert.equal(e.fraction, 0);
  });

  it("#4688: contato NUNCA sincronizado pela Brevo (brevo_modified_at null) não conta como não-abridor — opens_count=0 aqui é só o DEFAULT do schema, não uma medição", () => {
    const e = measureNonOpenerExposure([
      { send_eligible: 1, sends_count: 3, opens_count: 0, brevo_modified_at: measured }, // não-abridor confirmado
      { send_eligible: 1, sends_count: 3, opens_count: 0, brevo_modified_at: null }, // nunca sincronizado — NÃO conta
      { send_eligible: 1, sends_count: 3, opens_count: 0 }, // brevo_modified_at ausente — mesmo tratamento
    ]);
    assert.equal(e.count, 1, "só o contato com brevo_modified_at != null conta como não-abridor medido");
    assert.equal(e.fraction, 1 / 3);
  });
});

// ---------------------------------------------------------------------------
// Frescor do /diaria-clarice-novos (#4664)
// ---------------------------------------------------------------------------

describe("measureNovosFreshness (#4664)", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");

  it("nunca rodou (lastRunAt ausente) → status 'never-run', ageHours null", () => {
    const f = measureNovosFreshness(null, now);
    assert.equal(f.status, "never-run");
    assert.equal(f.lastRunAt, null);
    assert.equal(f.ageHours, null);
  });

  it("lastRunAt inválido também é tratado como 'never-run', nunca uma idade sem sentido", () => {
    const f = measureNovosFreshness("não é uma data", now);
    assert.equal(f.status, "never-run");
    assert.equal(f.ageHours, null);
  });

  it("dentro do limiar de warning → 'fresh'", () => {
    const f = measureNovosFreshness("2026-08-06T18:00:00.000Z", now); // 6h atrás
    assert.equal(f.status, "fresh");
    assert.equal(f.ageHours, 6);
  });

  it("exatamente no limiar de warning (12h) ainda é 'fresh' — só ULTRAPASSAR vira warning", () => {
    const f = measureNovosFreshness("2026-08-06T12:00:00.000Z", now); // exatos 12h
    assert.equal(f.status, "fresh");
  });

  it("acima de 12h e abaixo de 48h → 'warning'", () => {
    const f = measureNovosFreshness("2026-08-06T06:00:00.000Z", now); // 18h atrás
    assert.equal(f.status, "warning");
    assert.equal(f.ageHours, 18);
  });

  it("REGRESSÃO: onda d6-qui06 (05/08 18:06, montada ~24h depois) cai em 'warning', não 'fresh'", () => {
    // Caso real da issue: novos rodou 04/08 18:06, onda foi montada ~24h
    // depois — o achado mostrou 99,3% leads frios/0% cadastros recentes.
    const f = measureNovosFreshness("2026-08-04T18:06:00.000Z", new Date("2026-08-05T18:00:00.000Z"));
    assert.equal(f.status, "warning");
  });

  it("acima de 48h → 'blocker'", () => {
    const f = measureNovosFreshness("2026-08-04T00:00:00.000Z", now); // 72h atrás
    assert.equal(f.status, "blocker");
    assert.equal(f.ageHours, 72);
  });

  it("exatamente no limiar de blocker (48h) ainda é 'warning' — só ULTRAPASSAR vira blocker", () => {
    const f = measureNovosFreshness("2026-08-05T00:00:00.000Z", now); // exatos 48h
    assert.equal(f.status, "warning");
  });

  it("limiares expostos batem com os valores confirmados pelo editor (260806/07, #4664)", () => {
    assert.equal(NOVOS_FRESHNESS_WARNING_HOURS, 12);
    assert.equal(NOVOS_FRESHNESS_BLOCKER_HOURS, 48);
  });
});

describe("buildWaveProposal — frescor do novos (#4664)", () => {
  it("'never-run' BLOQUEIA", () => {
    const p = buildWaveProposal(
      proposalInput({ novosFreshness: { status: "never-run", lastRunAt: null, ageHours: null } }),
    );
    assert.match(p.blockers.join(" "), /nunca rodou/);
  });

  it("'blocker' (>48h) BLOQUEIA, nomeando a idade", () => {
    const p = buildWaveProposal(
      proposalInput({ novosFreshness: { status: "blocker", lastRunAt: "2026-08-04T00:00:00.000Z", ageHours: 72 } }),
    );
    assert.match(p.blockers.join(" "), /72h/);
    assert.match(p.blockers.join(" "), /#4664/);
  });

  it("'warning' (>12h, <=48h) AVISA, sem bloquear", () => {
    const p = buildWaveProposal(
      proposalInput({ novosFreshness: { status: "warning", lastRunAt: "2026-08-06T06:00:00.000Z", ageHours: 18 } }),
    );
    assert.equal(p.blockers.length, 0);
    assert.match(p.warnings.join(" "), /18h/);
  });

  it("'fresh' não gera blocker nem warning", () => {
    const p = buildWaveProposal(
      proposalInput({ novosFreshness: { status: "fresh", lastRunAt: "2026-08-06T20:00:00.000Z", ageHours: 2 } }),
    );
    assert.equal(p.blockers.length, 0);
    assert.doesNotMatch(p.warnings.join(" "), /clarice-novos/);
  });
});

describe("renderWaveProposal — data do novos SEMPRE visível (#4664)", () => {
  it("mostra a data/hora mesmo dentro do prazo ('fresh')", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({ novosFreshness: { status: "fresh", lastRunAt: "2026-08-06T20:00:00.000Z", ageHours: 2 } }),
      ),
    );
    assert.match(out, /Última execução: 2026-08-06T20:00:00\.000Z/);
    assert.match(out, /2\.0h atrás/);
  });

  it("'never-run' aparece explicitamente na tela, não só como bloqueio genérico", () => {
    const out = renderWaveProposal(
      buildWaveProposal(proposalInput({ novosFreshness: { status: "never-run", lastRunAt: null, ageHours: null } })),
    );
    assert.match(out, /Nunca rodou neste histórico/);
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
    // #4787: vazio por default — testes que exercitam composição/inversão de
    // safra passam o override explicitamente (ver describes dedicados).
    availableFirstSendByCohort: [],
    mvBacklog: { total: 253_730, byCohort: [], estimatedCostUsd: 482 },
    nonOpeners: { count: 0, fraction: 0, minSends: 2 },
    brevoCredits: 148_947,
    staleNote: null,
    startingWaveNumber: 6,
    committedLookupFailed: false,
    novosFreshness: { status: "fresh", lastRunAt: "2026-08-06T08:00:00.000Z", ageHours: 4 },
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

  it("AVISA sobre não-abridores acumulados ainda elegíveis (canário pós-sunset #5041)", () => {
    const p = buildWaveProposal(proposalInput({ nonOpeners: { count: 112_172, fraction: 0.675, minSends: 2 } }));
    assert.match(p.warnings.join(" "), /NUNCA abrir/);
    assert.match(p.warnings.join(" "), /#5041/);
  });

  it("AVISA sobre dado stale do dashboard com a idade real", () => {
    const p = buildWaveProposal(proposalInput({ staleNote: "upstream-error — ~3.2h stale" }));
    assert.match(p.warnings.join(" "), /3\.2h stale/);
  });

  it("AVISA sobre campanha ainda agendada (cancelável+recriável, não gratuito — #4935)", () => {
    const p = buildWaveProposal(
      proposalInput({ state: { ...proposalInput().state, scheduledCount: 3 } }),
    );
    assert.match(p.warnings.join(" "), /cancelar via API\/painel Brevo e recriar/);
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

  it("REGRESSÃO (#4786): pede includeScheduled=1 ao dashboard — sem isso, state.scheduledCount fica sempre 0", () => {
    // `/api/campaigns` só devolve `status=sent` por default (deliberado — ver
    // docstring de buildCampaignsResponse no Worker); sem este parâmetro o
    // planner nunca enxerga a própria onda que acabou de agendar.
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/clarice-plan-wave.ts"), "utf8");
    assert.match(src, /\/api\/campaigns\?limit=\$\{DEFAULT_DASHBOARD_LIMIT\}&includeScheduled=1/);
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

  // #4974: quando o pico por campanha governa `spamSignal.ratePct`,
  // `worstCampaignDaysWithData` leva a cobertura da leitura até esta tela —
  // a mesma superfície onde o editor confirma o agendamento da onda. Sem
  // isso, um pico de 1 dia isolado e um pico sustentado pela janela inteira
  // apareciam idênticos aqui.
  it("pico por campanha governa → mostra a cobertura ao lado do número (#4974)", () => {
    const out = renderWaveProposal(
      buildWaveProposal(
        proposalInput({
          volumes: {
            ...proposalInput().volumes,
            spamSignal: {
              source: "postmaster",
              ratePct: 1.39,
              breach: true,
              worstCampaignFeedbackLoopId: "11130585_107",
              worstCampaignDaysWithData: 1,
            },
          },
        }),
      ),
    );
    assert.match(out, /1\.390%/);
    assert.match(out, /pico de campanha, 1 dia\(s\) com dado/);
  });

  it("média de domínio governa (sem pico por campanha) → não inventa sufixo de cobertura (#4974)", () => {
    const out = renderWaveProposal(buildWaveProposal(proposalInput()));
    assert.doesNotMatch(out, /pico de campanha/);
  });
});
