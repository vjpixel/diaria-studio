/**
 * test/acquisition-health.test.ts (#5249)
 *
 * Cobertura da lógica pura do alarme de saúde de aquisição:
 * `computeChannelStats` (agrupamento + métricas por canal) e
 * `detectAcquisitionHealthFindings` (os 3 sinais + os guardrails de
 * desenho da issue #5249 — amostra insuficiente, coorte recém-criada, base
 * do mesmo período, 1ª execução nunca alarma canal desconhecido).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeChannelStats,
  detectAcquisitionHealthFindings,
  computeFindingsFingerprint,
  buildNextKnownChannels,
  buildAcquisitionHealthEmail,
  snapshotDateToEpochSeconds,
  median,
  emptyAcquisitionHealthState,
  DEFAULT_ACQUISITION_HEALTH_THRESHOLDS,
  type AcquisitionHealthState,
  type ChannelStats,
} from "../scripts/lib/acquisition-health.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "x@example.com",
    status: "active",
    created: 1_700_000_000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 30, total_unique_clicked: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// median / snapshotDateToEpochSeconds — helpers puros
// ---------------------------------------------------------------------------

describe("median", () => {
  it("ímpar: retorna o valor do meio", () => {
    assert.equal(median([3, 1, 2]), 2);
  });
  it("par: média dos dois centrais", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it("vazio: null", () => {
    assert.equal(median([]), null);
  });
});

describe("snapshotDateToEpochSeconds", () => {
  it("converte AAAA-MM-DD pro epoch UTC do início do dia", () => {
    assert.equal(snapshotDateToEpochSeconds("2026-08-14"), Date.UTC(2026, 7, 14) / 1000);
  });
  it("lança em formato inválido", () => {
    assert.throws(() => snapshotDateToEpochSeconds("14/08/2026"));
  });
});

// ---------------------------------------------------------------------------
// computeChannelStats
// ---------------------------------------------------------------------------

describe("computeChannelStats", () => {
  it("agrupa por utm_source, com fallback pra referring_site (mesma convenção de cohort-engagement.ts)", () => {
    const subs = [
      sub({ email: "a@x.com", utm_source: "google-ads" }),
      sub({ email: "b@x.com", utm_source: "", referring_site: "reddit.com" }),
      sub({ email: "c@x.com", utm_source: "", referring_site: "" }),
    ];
    const stats = computeChannelStats(subs, null, null);
    const channels = stats.map((s) => s.channel).sort();
    assert.deepEqual(channels, ["__none__", "google-ads", "reddit.com"]);
  });

  it("sobrevivência = ativos/cadastros; amostraNova quando cadastros < cohortMinSize", () => {
    const subs = [
      sub({ email: "a@x.com", status: "active", utm_source: "canal-a" }),
      sub({ email: "b@x.com", status: "inactive", utm_source: "canal-a" }),
    ];
    const [stat] = computeChannelStats(subs, null, null);
    assert.equal(stat.cadastros, 2);
    assert.equal(stat.ativos, 1);
    assert.equal(stat.sobrevivenciaPct, 50);
    assert.equal(stat.amostraNova, true); // 2 < cohortMinSize default (20)
  });

  it("CTR agregado usa cliques únicos ÷ recebidas — NUNCA click_rate (mesma armadilha do leitor.ts)", () => {
    const subs = [
      sub({
        email: "a@x.com",
        utm_source: "canal-b",
        stats: { total_received: 100, total_unique_clicked: 10, click_rate: 999 as unknown as number },
      }),
      sub({ email: "b@x.com", utm_source: "canal-b", stats: { total_received: 100, total_unique_clicked: 0 } }),
    ];
    const [stat] = computeChannelStats(subs, null, null);
    // Σclicked=10, Σreceived=200 → 5%, nunca o click_rate=999 inflado
    assert.equal(stat.ctrAgregadoPct, 5);
  });

  it("amostraVazia quando nenhum ativo atinge ctrReceivedMin; amostraPequena quando 0<n<ctrSampleMin", () => {
    const subsVazio = [sub({ email: "a@x.com", utm_source: "canal-c", stats: { total_received: 1, total_unique_clicked: 0 } })];
    const [vazio] = computeChannelStats(subsVazio, null, null);
    assert.equal(vazio.amostraVazia, true);
    assert.equal(vazio.ctrAgregadoPct, null);

    const subsPequena = [sub({ email: "a@x.com", utm_source: "canal-d", stats: { total_received: 30, total_unique_clicked: 1 } })];
    const [pequena] = computeChannelStats(subsPequena, null, null);
    assert.equal(pequena.amostraPequena, true); // 1 < ctrSampleMin (5)
    assert.equal(pequena.amostraVazia, false);
  });

  it("novosNaJanela conta só created dentro de (since, until]; sem janela informada fica 0", () => {
    const since = snapshotDateToEpochSeconds("2026-08-01");
    const until = snapshotDateToEpochSeconds("2026-08-08");
    const subs = [
      sub({ email: "a@x.com", utm_source: "canal-e", created: since }), // fora (exclusivo)
      sub({ email: "b@x.com", utm_source: "canal-e", created: since + 1 }), // dentro
      sub({ email: "c@x.com", utm_source: "canal-e", created: until }), // dentro (inclusivo)
      sub({ email: "d@x.com", utm_source: "canal-e", created: until + 1 }), // fora
    ];
    const [withWindow] = computeChannelStats(subs, since, until);
    assert.equal(withWindow.novosNaJanela, 2);

    const [withoutWindow] = computeChannelStats(subs, null, null);
    assert.equal(withoutWindow.novosNaJanela, 0);
  });

  it("ordena por cadastros decrescente", () => {
    const subs = [
      sub({ email: "a@x.com", utm_source: "pequeno" }),
      sub({ email: "b@x.com", utm_source: "grande" }),
      sub({ email: "c@x.com", utm_source: "grande" }),
    ];
    const stats = computeChannelStats(subs, null, null);
    assert.equal(stats[0].channel, "grande");
  });
});

// ---------------------------------------------------------------------------
// detectAcquisitionHealthFindings — os 3 sinais + guardrails
// ---------------------------------------------------------------------------

function bigChannelStats(overrides: Partial<ChannelStats> = {}): ChannelStats {
  return {
    channel: "canal-x",
    cadastros: 100,
    ativos: 80,
    sobrevivenciaPct: 80,
    amostraConsiderada: 50,
    amostraNova: false,
    amostraPequena: false,
    amostraVazia: false,
    ctrAgregadoPct: 5,
    novosNaJanela: 10,
    ...overrides,
  };
}

describe("detectAcquisitionHealthFindings — sinal 1 (sobrevivência)", () => {
  it("alarma sobrevivencia_baixa quando abaixo do piso, mesmo sem semana anterior", () => {
    const current = [bigChannelStats({ sobrevivenciaPct: 10 })]; // < 30 (default floor)
    const { findings } = detectAcquisitionHealthFindings(current, null, emptyAcquisitionHealthState());
    assert.ok(findings.some((f) => f.type === "sobrevivencia_baixa" && f.channel === "canal-x"));
  });

  it("alarma sobrevivencia_queda quando cai >= survivalDropPtsAlarm vs a semana anterior, mesmo acima do piso", () => {
    const current = [bigChannelStats({ sobrevivenciaPct: 60 })]; // acima do piso 30
    const previous = [bigChannelStats({ sobrevivenciaPct: 75 })]; // queda de 15pp >= 10
    const { findings } = detectAcquisitionHealthFindings(current, previous, emptyAcquisitionHealthState());
    assert.ok(findings.some((f) => f.type === "sobrevivencia_queda"));
  });

  it("NÃO alarma sobrevivência quando queda é pequena e acima do piso", () => {
    const current = [bigChannelStats({ sobrevivenciaPct: 78 })];
    const previous = [bigChannelStats({ sobrevivenciaPct: 80 })]; // queda de 2pp, abaixo do limiar
    const { findings } = detectAcquisitionHealthFindings(current, previous, emptyAcquisitionHealthState());
    assert.ok(!findings.some((f) => f.type.startsWith("sobrevivencia")));
  });

  it("guard 2 — coorte recém-criada (amostraNova) nunca gera sobrevivencia_baixa/queda", () => {
    const current = [bigChannelStats({ sobrevivenciaPct: 5, amostraNova: true, cadastros: 3 })];
    const previous = [bigChannelStats({ sobrevivenciaPct: 90, amostraNova: true, cadastros: 3 })];
    const { findings } = detectAcquisitionHealthFindings(current, previous, emptyAcquisitionHealthState());
    assert.ok(!findings.some((f) => f.type.startsWith("sobrevivencia")));
  });
});

describe("detectAcquisitionHealthFindings — sinal 2 (CTR abaixo da base)", () => {
  it("base é a MEDIANA dos canais elegíveis na MESMA rodada — nunca um número fixo (guard 3)", () => {
    const current = [
      bigChannelStats({ channel: "alto", ctrAgregadoPct: 10 }),
      bigChannelStats({ channel: "medio", ctrAgregadoPct: 5 }),
      bigChannelStats({ channel: "baixo", ctrAgregadoPct: 1 }),
    ];
    // base = mediana(10,5,1) = 5 → "baixo" (1) fica abaixo, "alto"/"medio" não
    const state: AcquisitionHealthState = {
      ...emptyAcquisitionHealthState(),
      lastCheckedSnapshotDate: "2026-08-07",
      ctrBelowBaseStreak: { baixo: 1 }, // já 1 semana abaixo — esta some a 2ª
    };
    const { findings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(current, null, state);
    assert.ok(findings.some((f) => f.type === "ctr_abaixo_base" && f.channel === "baixo"));
    assert.ok(!findings.some((f) => f.type === "ctr_abaixo_base" && (f.channel === "alto" || f.channel === "medio")));
    assert.equal(nextCtrBelowBaseStreak["baixo"], 2);
  });

  it("1 semana abaixo da base NÃO alarma ainda (precisa de ctrWeeksBelowBase seguidas)", () => {
    const current = [
      bigChannelStats({ channel: "alto", ctrAgregadoPct: 10 }),
      bigChannelStats({ channel: "baixo", ctrAgregadoPct: 1 }),
    ];
    const state: AcquisitionHealthState = { ...emptyAcquisitionHealthState(), lastCheckedSnapshotDate: "2026-08-07" };
    const { findings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(current, null, state);
    assert.ok(!findings.some((f) => f.type === "ctr_abaixo_base"));
    assert.equal(nextCtrBelowBaseStreak["baixo"], 1);
  });

  it("streak zera quando o canal volta pra cima da base", () => {
    const current = [
      bigChannelStats({ channel: "alto", ctrAgregadoPct: 10 }),
      bigChannelStats({ channel: "baixo", ctrAgregadoPct: 2 }),
      bigChannelStats({ channel: "recuperado", ctrAgregadoPct: 9 }), // mediana(10,2,9)=9 → 9 NÃO é < 9
    ];
    const state: AcquisitionHealthState = {
      ...emptyAcquisitionHealthState(),
      lastCheckedSnapshotDate: "2026-08-07",
      ctrBelowBaseStreak: { recuperado: 1 },
    };
    const { nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(current, null, state);
    assert.equal(nextCtrBelowBaseStreak["recuperado"], undefined);
  });

  it("guard 1 — amostra insuficiente (amostraPequena/amostraVazia/amostraNova) nunca entra no pool de base nem é avaliada, e zera o streak", () => {
    const current = [
      bigChannelStats({ channel: "pequena", ctrAgregadoPct: 1, amostraPequena: true }),
      bigChannelStats({ channel: "vazia", ctrAgregadoPct: null, amostraVazia: true }),
      bigChannelStats({ channel: "nova", ctrAgregadoPct: 1, amostraNova: true, cadastros: 3 }),
    ];
    const state: AcquisitionHealthState = {
      ...emptyAcquisitionHealthState(),
      lastCheckedSnapshotDate: "2026-08-07",
      ctrBelowBaseStreak: { pequena: 5, vazia: 5, nova: 5 }, // streak antigo alto — precisa zerar
    };
    const { findings, nextCtrBelowBaseStreak } = detectAcquisitionHealthFindings(current, null, state);
    assert.ok(!findings.some((f) => f.type === "ctr_abaixo_base"));
    assert.equal(nextCtrBelowBaseStreak["pequena"], undefined);
    assert.equal(nextCtrBelowBaseStreak["vazia"], undefined);
    assert.equal(nextCtrBelowBaseStreak["nova"], undefined);
  });
});

describe("detectAcquisitionHealthFindings — sinal 3a (canal_parou)", () => {
  it("alarma quando a semana anterior tinha novosNaJanela>0 e a atual zera", () => {
    const current = [bigChannelStats({ novosNaJanela: 0 })];
    const previous = [bigChannelStats({ novosNaJanela: 12 })];
    const { findings } = detectAcquisitionHealthFindings(current, previous, emptyAcquisitionHealthState());
    assert.ok(findings.some((f) => f.type === "canal_parou"));
  });

  it("sem 3ª data disponível (previous.novosNaJanela sempre 0 por falta de janela) nunca alarma canal_parou", () => {
    const current = [bigChannelStats({ novosNaJanela: 0 })];
    const previous = [bigChannelStats({ novosNaJanela: 0 })]; // janela desligada no caller
    const { findings } = detectAcquisitionHealthFindings(current, previous, emptyAcquisitionHealthState());
    assert.ok(!findings.some((f) => f.type === "canal_parou"));
  });
});

describe("detectAcquisitionHealthFindings — sinal 3b (canal_desconhecido)", () => {
  it("1ª execução (lastCheckedSnapshotDate null) NUNCA alarma canal_desconhecido — só estabelece baseline", () => {
    const current = [bigChannelStats({ channel: "google-ads" }), bigChannelStats({ channel: "sparkloop" })];
    const { findings } = detectAcquisitionHealthFindings(current, null, emptyAcquisitionHealthState());
    assert.ok(!findings.some((f) => f.type === "canal_desconhecido"));
  });

  it("canal ausente de knownChannels alarma canal_desconhecido a partir da 2ª execução", () => {
    const current = [bigChannelStats({ channel: "google-ads" }), bigChannelStats({ channel: "sparkloop" })];
    const state: AcquisitionHealthState = {
      ...emptyAcquisitionHealthState(),
      knownChannels: ["google-ads"],
      lastCheckedSnapshotDate: "2026-08-07",
    };
    const { findings } = detectAcquisitionHealthFindings(current, null, state);
    assert.ok(findings.some((f) => f.type === "canal_desconhecido" && f.channel === "sparkloop"));
    assert.ok(!findings.some((f) => f.type === "canal_desconhecido" && f.channel === "google-ads"));
  });

  it("canal_desconhecido NUNCA é suprimido por amostraNova/amostraPequena/amostraVazia — a novidade É o sinal", () => {
    const current = [bigChannelStats({ channel: "novo-canal", amostraNova: true, cadastros: 2 })];
    const state: AcquisitionHealthState = {
      ...emptyAcquisitionHealthState(),
      knownChannels: ["outro"],
      lastCheckedSnapshotDate: "2026-08-07",
    };
    const { findings } = detectAcquisitionHealthFindings(current, null, state);
    assert.ok(findings.some((f) => f.type === "canal_desconhecido" && f.channel === "novo-canal"));
  });
});

// ---------------------------------------------------------------------------
// computeFindingsFingerprint / buildNextKnownChannels / buildAcquisitionHealthEmail
// ---------------------------------------------------------------------------

describe("computeFindingsFingerprint", () => {
  it("estável independente de ordem, e ignora o campo detail (só type+channel)", () => {
    const a = [
      { type: "canal_parou" as const, channel: "x", detail: "detalhe A" },
      { type: "ctr_abaixo_base" as const, channel: "y", detail: "detalhe qualquer" },
    ];
    const b = [
      { type: "ctr_abaixo_base" as const, channel: "y", detail: "detalhe DIFERENTE" },
      { type: "canal_parou" as const, channel: "x", detail: "outro detalhe" },
    ];
    assert.equal(computeFindingsFingerprint(a), computeFindingsFingerprint(b));
  });

  it("achados diferentes → fingerprints diferentes", () => {
    const a = [{ type: "canal_parou" as const, channel: "x", detail: "" }];
    const b = [{ type: "canal_parou" as const, channel: "z", detail: "" }];
    assert.notEqual(computeFindingsFingerprint(a), computeFindingsFingerprint(b));
  });
});

describe("buildNextKnownChannels", () => {
  it("une knownChannels anteriores com os canais da rodada atual, sem duplicata, ordenado", () => {
    const state: AcquisitionHealthState = { ...emptyAcquisitionHealthState(), knownChannels: ["b", "a"] };
    const current = [bigChannelStats({ channel: "c" }), bigChannelStats({ channel: "a" })];
    assert.deepEqual(buildNextKnownChannels(state, current), ["a", "b", "c"]);
  });
});

describe("buildAcquisitionHealthEmail", () => {
  it("subject inclui a contagem de achados e a data do snapshot; body lista cada achado", () => {
    const findings = [
      { type: "canal_desconhecido" as const, channel: "sparkloop", detail: "canal nunca visto." },
      { type: "sobrevivencia_baixa" as const, channel: "google-ads", detail: "sobrevivência 10%." },
    ];
    const { subject, body } = buildAcquisitionHealthEmail(findings, "2026-08-16");
    assert.match(subject, /2 achado/);
    assert.match(subject, /2026-08-16/);
    assert.match(body, /sparkloop/);
    assert.match(body, /google-ads/);
  });
});

describe("DEFAULT_ACQUISITION_HEALTH_THRESHOLDS", () => {
  it("valores documentados (regressão de config silenciosa)", () => {
    assert.deepEqual(DEFAULT_ACQUISITION_HEALTH_THRESHOLDS, {
      cohortMinSize: 20,
      survivalFloorPct: 30,
      survivalDropPtsAlarm: 10,
      ctrReceivedMin: 20,
      ctrSampleMin: 5,
      ctrWeeksBelowBase: 2,
    });
  });
});
