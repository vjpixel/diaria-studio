/**
 * cohort-retention.test.ts (#4556)
 *
 * Cobre o particionamento em três baldes, as métricas por balde e o bloco de
 * ressalvas de `scripts/cohort-retention.ts`. Tudo puro — nenhum teste toca a
 * API Beehiiv nem lê snapshot de disco.
 *
 * O caso mais importante aqui é o de `coorte_imatura` ("marcador lido do
 * pré-corte"): o marcador nasceu lendo `mediana_recebidas`, que é `>=` piso
 * por construção depois do corte, então nunca disparava. A primeira leitura
 * ao vivo (17/08/2026) expôs o buraco — pré-corte 18, pós-corte 20, piso 20,
 * marcador `false`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  type CohortWindow,
} from "../scripts/cohort-engagement.ts";
import {
  AMOSTRA_PEQUENA_THRESHOLD,
  BUCKET_ORDER,
  EXPOSICAO_DESIGUAL_RATIO,
  LAUNCH_COHORT_SINCE,
  LAUNCH_COHORT_UNTIL,
  bucketOf,
  buildComparabilityNotes,
  computeRetention,
  computeRetentionGroup,
  formatRetentionReport,
  isExposicaoDesigual,
  partitionByCohort,
  type BucketLabel,
  type RetentionGroup,
  type RetentionSubscriber,
} from "../scripts/cohort-retention.ts";

const WINDOW: CohortWindow = {
  since: parseSinceToEpochSeconds(LAUNCH_COHORT_SINCE),
  untilExclusive: parseUntilToEpochSecondsExclusive(LAUNCH_COHORT_UNTIL),
};

const DAY = 86_400;
/** 2026-08-17T00:00:00Z — "agora" fixo, pra que a mediana de exposição não
 *  dependa do relógio de quem roda a suíte. */
const NOW = Date.UTC(2026, 7, 17) / 1000;

function sub(
  created: number | null,
  status: string,
  stats?: { received?: number; opened?: number; clicked?: number } | null,
): RetentionSubscriber {
  return {
    created,
    status,
    stats:
      stats === undefined
        ? undefined
        : stats === null
          ? null
          : {
              total_received: stats.received ?? 0,
              total_unique_opened: stats.opened ?? 0,
              total_unique_clicked: stats.clicked ?? 0,
            },
  };
}

const IN_COHORT = WINDOW.since! + DAY; // 22/07
const BEFORE = WINDOW.since! - 1; // último segundo de 20/07
const AFTER = WINDOW.untilExclusive!; // primeiro segundo de 03/08

// ---------------------------------------------------------------------------
// bucketOf / partitionByCohort
// ---------------------------------------------------------------------------

describe("bucketOf (#4556)", () => {
  it("põe a borda inferior INCLUSIVA dentro da coorte", () => {
    assert.equal(bucketOf(sub(WINDOW.since!, "active"), WINDOW), "coorte");
    assert.equal(bucketOf(sub(WINDOW.since! - 1, "active"), WINDOW), "base_anterior");
  });

  it("inclui o dia de --until inteiro e exclui o primeiro segundo do seguinte", () => {
    assert.equal(bucketOf(sub(WINDOW.untilExclusive! - 1, "active"), WINDOW), "coorte");
    assert.equal(bucketOf(sub(WINDOW.untilExclusive!, "active"), WINDOW), "pos_coorte");
  });

  it("devolve null sem `created` — nunca chuta um balde", () => {
    assert.equal(bucketOf({ status: "active" }, WINDOW), null);
    assert.equal(bucketOf(sub(null, "active"), WINDOW), null);
  });
});

describe("partitionByCohort (#4556)", () => {
  it("particiona sem perder nem duplicar ninguém", () => {
    const subs = [
      sub(BEFORE, "active"),
      sub(IN_COHORT, "active"),
      sub(IN_COHORT, "inactive"),
      sub(AFTER, "pending"),
      sub(null, "active"),
    ];
    const { buckets, semCreated } = partitionByCohort(subs, WINDOW);
    assert.equal(buckets.base_anterior.length, 1);
    assert.equal(buckets.coorte.length, 2);
    assert.equal(buckets.pos_coorte.length, 1);
    assert.equal(semCreated, 1);
    const somados =
      buckets.base_anterior.length +
      buckets.coorte.length +
      buckets.pos_coorte.length +
      semCreated;
    assert.equal(somados, subs.length);
  });

  it("nunca soma pos_coorte ao controle — o ponto metodológico da issue", () => {
    const { buckets } = partitionByCohort([sub(AFTER, "active"), sub(AFTER, "active")], WINDOW);
    assert.equal(buckets.base_anterior.length, 0);
    assert.equal(buckets.pos_coorte.length, 2);
  });

  it("devolve os três baldes mesmo quando vazios", () => {
    const { buckets } = partitionByCohort([], WINDOW);
    for (const label of BUCKET_ORDER) {
      assert.ok(Array.isArray(buckets[label as BucketLabel]));
    }
  });
});

// ---------------------------------------------------------------------------
// computeRetentionGroup
// ---------------------------------------------------------------------------

const OPTS = { minReceived: 0, nowEpochSeconds: NOW };

describe("computeRetentionGroup — retenção (#4556)", () => {
  it("exclui pending e invalid do denominador de retenção", () => {
    const g = computeRetentionGroup(
      [
        sub(IN_COHORT, "active", { received: 10 }),
        sub(IN_COHORT, "active", { received: 10 }),
        sub(IN_COHORT, "active", { received: 10 }),
        sub(IN_COHORT, "inactive", { received: 10 }),
        sub(IN_COHORT, "pending"),
        sub(IN_COHORT, "invalid"),
      ],
      OPTS,
    );
    assert.equal(g.cadastros, 6);
    assert.equal(g.ativos, 3);
    assert.equal(g.inativos, 1);
    assert.equal(g.pending, 1);
    assert.equal(g.invalid, 1);
    assert.equal(g.base_confirmada, 4);
    assert.equal(g.retencao, 0.75);
    assert.equal(g.saidas, 1);
  });

  it("conta status desconhecido em outros_status em vez de descartar", () => {
    const g = computeRetentionGroup([sub(IN_COHORT, "needs_attention")], OPTS);
    assert.equal(g.outros_status, 1);
    assert.equal(g.cadastros, 1);
    assert.equal(g.retencao, null, "ninguém confirmado → retenção indefinida, não 0");
  });

  it("retenção é null (não 0) quando não há confirmados", () => {
    const g = computeRetentionGroup([sub(IN_COHORT, "pending")], OPTS);
    assert.equal(g.base_confirmada, 0);
    assert.equal(g.retencao, null);
  });
});

describe("computeRetentionGroup — engajamento (#4556)", () => {
  it("agrega abertura e CTR sobre a SOMA, não sobre a média das taxas", () => {
    // Um assinante com 100 recebidas/50 abertas e outro com 10/10: a média das
    // taxas daria 75%, a agregada dá 60/110.
    const g = computeRetentionGroup(
      [
        sub(IN_COHORT, "active", { received: 100, opened: 50, clicked: 10 }),
        sub(IN_COHORT, "active", { received: 10, opened: 10, clicked: 1 }),
      ],
      OPTS,
    );
    assert.equal(g.abertura_agregada, 60 / 110);
    assert.equal(g.ctr_agregado, 11 / 110);
  });

  it("ignora não-ativos no denominador de engajamento", () => {
    const g = computeRetentionGroup(
      [
        sub(IN_COHORT, "active", { received: 10, opened: 5, clicked: 1 }),
        sub(IN_COHORT, "inactive", { received: 100, opened: 0, clicked: 0 }),
      ],
      OPTS,
    );
    assert.equal(g.amostra_considerada, 1);
    assert.equal(g.abertura_agregada, 0.5);
  });

  it("ativo sem stats conta em ativos mas fica fora do denominador", () => {
    const g = computeRetentionGroup(
      [sub(IN_COHORT, "active", null), sub(IN_COHORT, "active", { received: 10, opened: 5 })],
      OPTS,
    );
    assert.equal(g.ativos, 2);
    assert.equal(g.pre_corte_considerado, 1);
    assert.equal(g.abertura_agregada, 0.5);
  });

  it("abertura/CTR são null quando ninguém recebeu nada", () => {
    const g = computeRetentionGroup([sub(IN_COHORT, "active", { received: 0 })], OPTS);
    assert.equal(g.abertura_agregada, null);
    assert.equal(g.ctr_agregado, null);
  });

  it("--min-received corta o denominador e preserva o pré-corte", () => {
    const g = computeRetentionGroup(
      [
        sub(IN_COHORT, "active", { received: 30, opened: 15, clicked: 3 }),
        sub(IN_COHORT, "active", { received: 5, opened: 5, clicked: 5 }),
      ],
      { minReceived: 20, nowEpochSeconds: NOW },
    );
    assert.equal(g.amostra_considerada, 1);
    assert.equal(g.pre_corte_considerado, 2);
    assert.equal(g.abertura_agregada, 0.5, "o de 5 recebidas não infla a taxa");
  });
});

describe("computeRetentionGroup — leitores-v1 (#4556)", () => {
  it("usa CTR real (cliques únicos ÷ recebidas), nunca click_rate", () => {
    // click_rate=100 (10 cliques / 10 aberturas) mas CTR real = 10/1000 = 1%,
    // abaixo do piso de 2% do leitor-v1.
    const armadilha: RetentionSubscriber = {
      created: IN_COHORT,
      status: "active",
      stats: { total_received: 1000, total_unique_opened: 10, total_unique_clicked: 10 },
    };
    const g = computeRetentionGroup([armadilha], OPTS);
    assert.equal(g.leitores_v1, 0);
  });

  it("conta quem passa nos dois pisos do leitor-v1", () => {
    const g = computeRetentionGroup(
      [sub(IN_COHORT, "active", { received: 100, opened: 50, clicked: 5 })],
      OPTS,
    );
    assert.equal(g.leitores_v1, 1);
    assert.equal(g.densidade_leitores, 1);
  });

  it("não conta quem não alcançou o piso de 20 recebidas", () => {
    const g = computeRetentionGroup(
      [sub(IN_COHORT, "active", { received: 19, opened: 19, clicked: 19 })],
      OPTS,
    );
    assert.equal(g.leitores_v1, 0);
  });

  it("não conta inativo, por mais que ele clicasse", () => {
    const g = computeRetentionGroup(
      [sub(IN_COHORT, "inactive", { received: 100, opened: 100, clicked: 100 })],
      OPTS,
    );
    assert.equal(g.leitores_v1, 0);
    assert.equal(g.densidade_leitores, null, "sem ativos → densidade indefinida, não 0");
  });

  it("--min-received NÃO altera a contagem de leitores-v1 (definição canônica)", () => {
    const subs = [sub(IN_COHORT, "active", { received: 100, opened: 50, clicked: 5 })];
    const semCorte = computeRetentionGroup(subs, { minReceived: 0, nowEpochSeconds: NOW });
    const comCorte = computeRetentionGroup(subs, { minReceived: 90, nowEpochSeconds: NOW });
    assert.equal(semCorte.leitores_v1, comCorte.leitores_v1);
  });
});

describe("computeRetentionGroup — medianas e marcadores (#4556)", () => {
  it("mediana pré-corte é a de ANTES do piso; a outra é a de depois", () => {
    const g = computeRetentionGroup(
      [
        sub(IN_COHORT, "active", { received: 5 }),
        sub(IN_COHORT, "active", { received: 5 }),
        sub(IN_COHORT, "active", { received: 30 }),
      ],
      { minReceived: 20, nowEpochSeconds: NOW },
    );
    assert.equal(g.mediana_recebidas_pre_corte, 5);
    assert.equal(g.mediana_recebidas, 30);
  });

  it("mede exposição em dias desde `created`", () => {
    const g = computeRetentionGroup([sub(NOW - 25 * DAY, "active", { received: 1 })], OPTS);
    assert.equal(g.mediana_dias_expostos, 25);
  });

  it("amostra_vazia e amostra_pequena são mutuamente exclusivos", () => {
    const vazio = computeRetentionGroup([sub(IN_COHORT, "pending")], OPTS);
    assert.equal(vazio.amostra_vazia, true);
    assert.equal(vazio.amostra_pequena, false);

    const poucos = computeRetentionGroup([sub(IN_COHORT, "active", { received: 50 })], OPTS);
    assert.equal(poucos.amostra_vazia, false);
    assert.equal(poucos.amostra_pequena, true);
  });

  it("amostra_pequena some no limiar", () => {
    const subs = Array.from({ length: AMOSTRA_PEQUENA_THRESHOLD }, () =>
      sub(IN_COHORT, "active", { received: 50 }),
    );
    assert.equal(computeRetentionGroup(subs, OPTS).amostra_pequena, false);
  });

  it("amostra_instavel marca mediana de recebidas abaixo de 10", () => {
    const g = computeRetentionGroup([sub(IN_COHORT, "active", { received: 4 })], OPTS);
    assert.equal(g.amostra_instavel, true);
  });
});

// ---------------------------------------------------------------------------
// buildComparabilityNotes
// ---------------------------------------------------------------------------

function grupos(over: Partial<Record<BucketLabel, RetentionSubscriber[]>>, minReceived = 0) {
  const opts = { minReceived, nowEpochSeconds: NOW };
  return {
    coorte: computeRetentionGroup(over.coorte ?? [], opts),
    base_anterior: computeRetentionGroup(over.base_anterior ?? [], opts),
    pos_coorte: computeRetentionGroup(over.pos_coorte ?? [], opts),
  } as Record<BucketLabel, RetentionGroup>;
}

describe("isExposicaoDesigual (#4556)", () => {
  it("REGRESSÃO: coorte com 0 dias contra base madura é o caso MAIS desigual", () => {
    // A versão inline original exigia `diasCoorte > 0` antes do ratio, na
    // intenção de evitar divisão por zero — que em JS devolve `Infinity`, não
    // lança. O efeito era desligar o aviso exatamente aqui.
    assert.equal(isExposicaoDesigual(0, 233), true);
    assert.equal(isExposicaoDesigual(233, 0), true);
  });

  it("0 vs 0 não é desigual — são iguais", () => {
    assert.equal(isExposicaoDesigual(0, 0), false);
  });

  it("null de qualquer lado não afirma desigualdade", () => {
    assert.equal(isExposicaoDesigual(null, 233), false);
    assert.equal(isExposicaoDesigual(25, null), false);
    assert.equal(isExposicaoDesigual(null, null), false);
  });

  it("compara pelo ratio nos dois sentidos", () => {
    assert.equal(isExposicaoDesigual(25, 233), true);
    assert.equal(isExposicaoDesigual(233, 25), true);
    assert.equal(isExposicaoDesigual(25, 30), false);
  });

  it("o limiar é estrito — exatamente o ratio não marca", () => {
    assert.equal(isExposicaoDesigual(10, 10 * EXPOSICAO_DESIGUAL_RATIO), false);
    assert.equal(isExposicaoDesigual(10, 10 * EXPOSICAO_DESIGUAL_RATIO + 1), true);
  });
});

describe("buildComparabilityNotes (#4556)", () => {
  it("emite as três ressalvas estruturais mesmo sem dado nenhum", () => {
    const notas = buildComparabilityNotes(grupos({}), 0);
    assert.ok(notas.notas.length >= 3, "as ressalvas estruturais nunca são condicionais");
    assert.equal(notas.exposicao_desigual, false);
    assert.equal(notas.coorte_imatura, false);
  });

  it("marca exposição desigual acima do ratio", () => {
    const notas = buildComparabilityNotes(
      grupos({
        coorte: [sub(NOW - 25 * DAY, "active", { received: 18 })],
        base_anterior: [sub(NOW - 233 * DAY, "active", { received: 137 })],
      }),
      0,
    );
    assert.equal(notas.exposicao_desigual, true);
    assert.ok(notas.notas.some((n) => n.includes("25d") && n.includes("233d")));
  });

  it("não marca exposição desigual quando os baldes têm idade parecida", () => {
    const notas = buildComparabilityNotes(
      grupos({
        coorte: [sub(NOW - 25 * DAY, "active", { received: 18 })],
        base_anterior: [sub(NOW - 30 * DAY, "active", { received: 25 })],
      }),
      0,
    );
    assert.equal(notas.exposicao_desigual, false);
    assert.ok(EXPOSICAO_DESIGUAL_RATIO > 1);
  });

  it("REGRESSÃO: coorte_imatura lê a mediana PRÉ-corte, não a pós", () => {
    // Pós-corte a mediana é >= piso por construção; lendo dali o marcador
    // jamais dispararia — foi o que aconteceu na primeira leitura ao vivo
    // (pré-corte 18, pós-corte 20, piso 20, marcador falso).
    const g = grupos(
      {
        coorte: [
          sub(IN_COHORT, "active", { received: 18 }),
          sub(IN_COHORT, "active", { received: 18 }),
          sub(IN_COHORT, "active", { received: 20 }),
        ],
      },
      20,
    );
    assert.equal(g.coorte.mediana_recebidas, 20, "pré-condição: pós-corte alcança o piso");
    assert.equal(g.coorte.mediana_recebidas_pre_corte, 18);
    assert.equal(buildComparabilityNotes(g, 20).coorte_imatura, true);
  });

  it("coorte_imatura fica false quando a coorte amadurece", () => {
    const g = grupos({ coorte: [sub(IN_COHORT, "active", { received: 48 })] }, 20);
    assert.equal(buildComparabilityNotes(g, 20).coorte_imatura, false);
  });

  it("coorte_imatura nunca dispara sem piso (--min-received 0)", () => {
    const g = grupos({ coorte: [sub(IN_COHORT, "active", { received: 1 })] }, 0);
    assert.equal(buildComparabilityNotes(g, 0).coorte_imatura, false);
  });

  it("avisa quando há cadastros pós-coorte fora do controle", () => {
    const notas = buildComparabilityNotes(grupos({ pos_coorte: [sub(AFTER, "active")] }), 0);
    assert.ok(notas.notas.some((n) => n.includes("pos_coorte")));
  });
});

// ---------------------------------------------------------------------------
// computeRetention / formatRetentionReport
// ---------------------------------------------------------------------------

describe("computeRetention (#4556)", () => {
  const result = computeRetention(
    [
      sub(BEFORE, "active", { received: 137, opened: 48, clicked: 7 }),
      sub(BEFORE, "inactive", { received: 137 }),
      sub(IN_COHORT, "active", { received: 18, opened: 8, clicked: 2 }),
      sub(IN_COHORT, "inactive", { received: 18 }),
      sub(AFTER, "active", { received: 4, opened: 2 }),
      sub(null, "active", { received: 1 }),
    ],
    {
      window: WINDOW,
      since: LAUNCH_COHORT_SINCE,
      until: LAUNCH_COHORT_UNTIL,
      minReceived: 0,
      nowEpochSeconds: NOW,
      fonte: "snapshot:2026-08-16",
    },
  );

  it("ecoa os parâmetros aplicados e a fonte", () => {
    assert.equal(result.since, LAUNCH_COHORT_SINCE);
    assert.equal(result.until, LAUNCH_COHORT_UNTIL);
    assert.equal(result.min_received, 0);
    assert.equal(result.fonte, "snapshot:2026-08-16");
    assert.equal(result.fetched_at, new Date(NOW * 1000).toISOString());
  });

  it("conta quem foi descartado por falta de `created`", () => {
    assert.equal(result.excluidos_sem_created, 1);
    assert.equal(result.total_subscribers, 6);
  });

  it("separa os três baldes com as métricas de cada um", () => {
    assert.equal(result.grupos.coorte.cadastros, 2);
    assert.equal(result.grupos.coorte.retencao, 0.5);
    assert.equal(result.grupos.base_anterior.cadastros, 2);
    assert.equal(result.grupos.pos_coorte.cadastros, 1);
  });

  it("carrega o bloco de comparabilidade no resultado", () => {
    assert.ok(result.comparabilidade.notas.length >= 3);
  });
});

describe("computeRetention — o que NÃO pode sair no output (#4556)", () => {
  // O subscriber real (API e snapshot) carrega `email` e `stats.click_rate`
  // em runtime, mesmo que `RetentionSubscriber` não os declare — tipagem
  // estrutural não remove campo. O resultado é montado campo a campo, nunca
  // por spread; este teste trava isso contra um refactor futuro que resolvesse
  // "simplificar" espalhando o objeto bruto. Espelha o teste de não-uso de
  // `click_rate` em `test/leitor.test.ts`.
  const bruto = {
    email: "assinante@exemplo.com.br",
    created: IN_COHORT,
    status: "active",
    stats: {
      total_received: 100,
      total_unique_opened: 50,
      total_unique_clicked: 5,
      click_rate: 999,
    },
  } as unknown as RetentionSubscriber;

  const serializado = JSON.stringify(
    computeRetention([bruto], {
      window: WINDOW,
      since: LAUNCH_COHORT_SINCE,
      until: LAUNCH_COHORT_UNTIL,
      minReceived: 0,
      nowEpochSeconds: NOW,
      fonte: "teste",
    }),
  );

  it("não vaza e-mail de assinante", () => {
    assert.ok(!serializado.includes("assinante@exemplo.com.br"));
    assert.ok(!serializado.includes("email"));
  });

  it("não propaga click_rate — nem o valor, nem o campo", () => {
    assert.ok(!serializado.includes("click_rate"));
    assert.ok(!serializado.includes("999"));
  });

  it("o CTR que sai é o real (5/100), não o click_rate", () => {
    const result = computeRetention([bruto], {
      window: WINDOW,
      since: LAUNCH_COHORT_SINCE,
      until: LAUNCH_COHORT_UNTIL,
      minReceived: 0,
      nowEpochSeconds: NOW,
      fonte: "teste",
    });
    assert.equal(result.grupos.coorte.ctr_agregado, 0.05);
  });
});

describe("formatRetentionReport (#4556)", () => {
  const result = computeRetention([sub(IN_COHORT, "active", { received: 18, opened: 8 })], {
    window: WINDOW,
    since: LAUNCH_COHORT_SINCE,
    until: LAUNCH_COHORT_UNTIL,
    minReceived: 20,
    nowEpochSeconds: NOW,
    fonte: "snapshot:2026-08-16",
  });
  const texto = formatRetentionReport(result);

  it("imprime os três baldes", () => {
    for (const titulo of ["COORTE", "BASE ANTERIOR", "PÓS-COORTE"]) {
      assert.ok(texto.includes(titulo), `faltou ${titulo}`);
    }
  });

  it("imprime as ressalvas no MESMO output do número", () => {
    assert.ok(texto.includes("Ressalvas de comparabilidade"));
    for (const nota of result.comparabilidade.notas) {
      assert.ok(texto.includes(nota), `ressalva ausente do texto: ${nota.slice(0, 40)}…`);
    }
  });

  it("mostra a mediana pré-corte ao lado da pós", () => {
    assert.ok(texto.includes("pré-corte"));
  });
});
