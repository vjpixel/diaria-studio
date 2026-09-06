/**
 * test/ads-daily-digest.test.ts (#7487)
 *
 * Lógica pura de `scripts/lib/ads-daily-digest.ts` — delta diário por
 * canal, gasto acumulado do teste 2608, leitores por canal, e o e-mail
 * SEMPRE enviado (inclusive "sem gasto no período").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeChannelDeltas,
  hasSpendInPeriod,
  sumTeste2608Spend,
  summarizeTeste2608,
  totalSpendByKnownChannel,
  computeReadersByChannel,
  buildAdsDailyDigestEmail,
  toHistoryRows,
  type ChannelDeltaRow,
} from "../scripts/lib/ads-daily-digest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function spendRow(overrides: Partial<SpendRow> = {}): SpendRow {
  return { canal: "Google Ads", mes: "2026-09", moeda: "BRL", valor: 100, fonte: "teste", ...overrides };
}

describe("#7487 — computeChannelDeltas", () => {
  it("sem histórico anterior (1ª checagem) → deltaDia null, totalAnterior null", () => {
    const rows = [spendRow({ valor: 250.5 })];
    const deltas = computeChannelDeltas(rows, []);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].deltaDia, null);
    assert.equal(deltas[0].totalAnterior, null);
    assert.equal(deltas[0].totalAtual, 250.5);
  });

  it("com histórico do mesmo canal+mes → delta é a diferença", () => {
    const rows = [spendRow({ valor: 300 })];
    const previous = toHistoryRows([spendRow({ valor: 250 })]);
    const deltas = computeChannelDeltas(rows, previous);
    assert.equal(deltas[0].deltaDia, 50);
    assert.equal(deltas[0].totalAnterior, 250);
  });

  it("mês mudou desde a última checagem → tratado como 1ª checagem do novo mês (sem baseline)", () => {
    const rows = [spendRow({ mes: "2026-10", valor: 40 })];
    const previous = toHistoryRows([spendRow({ mes: "2026-09", valor: 300 })]);
    const deltas = computeChannelDeltas(rows, previous);
    assert.equal(deltas[0].deltaDia, null);
  });

  it("canal presente no histórico mas ausente hoje → não aparece no resultado (nunca 'delta negativo por remoção')", () => {
    const rows: SpendRow[] = [];
    const previous = toHistoryRows([spendRow({ valor: 100 })]);
    const deltas = computeChannelDeltas(rows, previous);
    assert.deepEqual(deltas, []);
  });

  it("arredonda pra 2 casas decimais (evita erro de ponto flutuante tipo 0.1+0.2)", () => {
    const rows = [spendRow({ valor: 0.3 })];
    const previous = toHistoryRows([spendRow({ valor: 0.1 })]);
    const deltas = computeChannelDeltas(rows, previous);
    assert.equal(deltas[0].deltaDia, 0.2);
  });

  it("#7531 — canal+mes com 2 subcanais (PMax/Search) não colide: cada um tem seu próprio delta e sobrevive no histórico", () => {
    const rows = [
      spendRow({ subcanal: "PMax", valor: 718.39 }),
      spendRow({ subcanal: "Search", valor: 239.62 }),
    ];
    const previous = toHistoryRows([
      spendRow({ subcanal: "PMax", valor: 700 }),
      spendRow({ subcanal: "Search", valor: 230 }),
    ]);

    const deltas = computeChannelDeltas(rows, previous);
    assert.equal(deltas.length, 2);

    const pmax = deltas.find((d) => d.subcanal === "PMax")!;
    const search = deltas.find((d) => d.subcanal === "Search")!;
    assert.equal(pmax.totalAtual, 718.39);
    assert.equal(pmax.totalAnterior, 700);
    assert.equal(pmax.deltaDia, 18.39);
    assert.equal(search.totalAtual, 239.62);
    assert.equal(search.totalAnterior, 230);
    assert.equal(search.deltaDia, 9.62);

    // Round-trip pro histórico preserva as 2 linhas distintas (não colapsa
    // na mesma chave canal+mes) — regressão do bug original da #7531.
    const historyRows = toHistoryRows(rows);
    assert.equal(historyRows.length, 2);
    assert.deepEqual(
      historyRows.map((r) => r.subcanal).sort(),
      ["PMax", "Search"],
    );
  });
});

describe("#7487 — hasSpendInPeriod", () => {
  it("todos os deltas <= 0 → false (sem gasto no período)", () => {
    const deltas: ChannelDeltaRow[] = [
      { canal: "Google Ads", mes: "2026-09", moeda: "BRL", totalAtual: 100, totalAnterior: 100, deltaDia: 0 },
    ];
    assert.equal(hasSpendInPeriod(deltas), false);
  });

  it("pelo menos um delta > 0 → true", () => {
    const deltas: ChannelDeltaRow[] = [
      { canal: "Google Ads", mes: "2026-09", moeda: "BRL", totalAtual: 150, totalAnterior: 100, deltaDia: 50 },
    ];
    assert.equal(hasSpendInPeriod(deltas), true);
  });

  it("1ª checagem (deltaDia null) com totalAtual > 0 → true (nunca reporta 'sem gasto' sem baseline)", () => {
    const deltas: ChannelDeltaRow[] = [
      { canal: "Google Ads", mes: "2026-09", moeda: "BRL", totalAtual: 50, totalAnterior: null, deltaDia: null },
    ];
    assert.equal(hasSpendInPeriod(deltas), true);
  });

  it("1ª checagem com totalAtual 0 → false", () => {
    const deltas: ChannelDeltaRow[] = [
      { canal: "LinkedIn", mes: "2026-09", moeda: "BRL", totalAtual: 0, totalAnterior: null, deltaDia: null },
    ];
    assert.equal(hasSpendInPeriod(deltas), false);
  });

  it("lista vazia → false", () => {
    assert.equal(hasSpendInPeriod([]), false);
  });
});

describe("#7487 — sumTeste2608Spend / summarizeTeste2608", () => {
  const bracos = ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"] as const;

  it("soma só as linhas cujo canal está nos braços do teste, ignorando outros canais", () => {
    const rows: SpendRow[] = [
      spendRow({ canal: "Google Ads (teste 2608)", mes: "2026-08", valor: 100 }),
      spendRow({ canal: "Google Ads (teste 2608)", mes: "2026-09", valor: 50 }),
      spendRow({ canal: "Microsoft Ads (teste 2608)", mes: "2026-08", valor: 30 }),
      spendRow({ canal: "Google Ads", mes: "2026-08", valor: 999 }), // fora do teste
    ];
    assert.equal(sumTeste2608Spend(rows, bracos), 180);
  });

  it("run-state ausente → summarizeTeste2608 devolve null (nunca uma seção vazia)", () => {
    assert.equal(summarizeTeste2608([], null, "2026-09-06"), null);
  });

  it("hoje dentro de d0..fim_janela → emAndamento true", () => {
    const runState = { d0: "2026-08-26", fim_janela: "2026-09-09", bracos };
    const summary = summarizeTeste2608(
      [spendRow({ canal: "Google Ads (teste 2608)", valor: 100 })],
      runState,
      "2026-09-01",
    );
    assert.equal(summary?.emAndamento, true);
    assert.equal(summary?.totalAcumulado, 100);
  });

  it("hoje depois de fim_janela → emAndamento false (encerrado, ainda reportável mas sinalizado)", () => {
    const runState = { d0: "2026-08-26", fim_janela: "2026-09-09", bracos };
    const summary = summarizeTeste2608([], runState, "2026-09-10");
    assert.equal(summary?.emAndamento, false);
  });

  it("hoje antes de d0 → emAndamento false (ainda não acendeu)", () => {
    const runState = { d0: "2026-08-26", fim_janela: "2026-09-09", bracos };
    const summary = summarizeTeste2608([], runState, "2026-08-25");
    assert.equal(summary?.emAndamento, false);
  });
});

describe("#7487 — totalSpendByKnownChannel / computeReadersByChannel", () => {
  it("soma gasto acumulado por canal reconhecido, ignorando canal desconhecido de CHANNEL_GROUP_KEYS", () => {
    const rows: SpendRow[] = [
      spendRow({ canal: "Google Ads", mes: "2026-08", valor: 100 }),
      spendRow({ canal: "Google Ads", mes: "2026-09", valor: 50 }),
      spendRow({ canal: "Canal Totalmente Inventado", mes: "2026-09", valor: 999 }),
    ];
    const totals = totalSpendByKnownChannel(rows);
    assert.equal(totals.get("Google Ads"), 150);
    assert.equal(totals.has("Canal Totalmente Inventado"), false);
  });

  it("subs null (sem snapshot) → computeReadersByChannel devolve null, nunca lista vazia", () => {
    const totals = new Map([["Google Ads", 100]]);
    assert.equal(computeReadersByChannel(null, totals), null);
  });

  it("com subs, canal sem leitor-v1 nenhum → custoPorLeitor null (nunca Infinity/NaN)", () => {
    const subs: BeehiivBackupSubscriber[] = [
      {
        email: "a@example.com",
        status: "active",
        created: 0,
        utm_source: "totalmente-desconhecido",
        utm_medium: "",
        utm_campaign: "",
        referring_site: "",
        stats: { total_received: 1, total_unique_clicked: 0 },
      },
    ];
    const totals = new Map([["Google Ads", 100]]);
    const readers = computeReadersByChannel(subs, totals);
    assert.equal(readers?.[0].canal, "Google Ads");
    assert.equal(readers?.[0].leitores, 0);
    assert.equal(readers?.[0].custoPorLeitor, null);
  });

  it("canal sem gasto nenhum não aparece no resultado", () => {
    const readers = computeReadersByChannel([], new Map());
    assert.deepEqual(readers, []);
  });
});

describe("#7487 — buildAdsDailyDigestEmail", () => {
  it("sem canais em spend.csv → mensagem explícita de SEM GASTO (nunca omite o e-mail)", () => {
    const { subject, body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: null,
      readers: null,
      readersSnapshotDate: null,
    });
    assert.match(subject, /2026-09-05/);
    assert.match(body, /SEM GASTO/);
  });

  it("todos os deltas zero/negativos → mensagem explícita de SEM GASTO, mas lista os totais acumulados", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [{ canal: "Google Ads", mes: "2026-09", moeda: "BRL", totalAtual: 500, totalAnterior: 500, deltaDia: 0 }],
      teste2608: null,
      readers: null,
      readersSnapshotDate: null,
    });
    assert.match(body, /SEM GASTO/);
    assert.match(body, /Google Ads \(2026-09\): BRL 500\.00/);
  });

  it("com gasto real → mostra o incremento por canal, nunca a string SEM GASTO", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [{ canal: "Google Ads", mes: "2026-09", moeda: "BRL", totalAtual: 550, totalAnterior: 500, deltaDia: 50 }],
      teste2608: null,
      readers: null,
      readersSnapshotDate: null,
    });
    assert.doesNotMatch(body, /SEM GASTO/);
    assert.match(body, /\+BRL 50\.00/);
  });

  it("teste 2608 em andamento → seção aparece com total acumulado e braços", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: { emAndamento: true, totalAcumulado: 1234.56, bracos: ["Google Ads (teste 2608)"] },
      readers: null,
      readersSnapshotDate: null,
    });
    assert.match(body, /Teste 2608 \(em andamento\)/);
    assert.match(body, /R\$ 1234\.56/);
  });

  it("teste 2608 encerrado (emAndamento false) → seção NÃO aparece", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: { emAndamento: false, totalAcumulado: 1234.56, bracos: ["Google Ads (teste 2608)"] },
      readers: null,
      readersSnapshotDate: null,
    });
    assert.doesNotMatch(body, /Teste 2608/);
  });

  it("readers null → indica explicitamente indisponibilidade de snapshot", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: null,
      readers: null,
      readersSnapshotDate: null,
    });
    assert.match(body, /indisponível \(sem snapshot Beehiiv local ainda\)/);
  });

  it("readers presentes → mostra leitores e custo por leitor por canal", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: null,
      readers: [{ canal: "Google Ads", leitores: 4, custoPorLeitor: 25 }],
      readersSnapshotDate: "2026-09-01",
    });
    assert.match(body, /snapshot 2026-09-01/);
    assert.match(body, /Google Ads: 4 leitor\(es\) — custo por leitor: R\$ 25\.00\/leitor/);
  });

  it("canal com 0 leitores → custo por leitor N/A, nunca Infinity/NaN no corpo", () => {
    const { body } = buildAdsDailyDigestEmail({
      periodDate: "2026-09-05",
      deltas: [],
      teste2608: null,
      readers: [{ canal: "Google Ads", leitores: 0, custoPorLeitor: null }],
      readersSnapshotDate: "2026-09-01",
    });
    assert.match(body, /N\/A \(ainda sem leitor\)/);
    assert.doesNotMatch(body, /Infinity|NaN/);
  });
});
