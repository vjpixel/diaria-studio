/**
 * test/clarice-envio-policy.test.ts (#4705)
 *
 * Motor de decisão do envio diário automatizado da Clarice News. O teste
 * central deste arquivo é o de REGRESSÃO DA CATRACA (primeiro `describe`
 * abaixo): abertura baixíssima com risco de ISP saudável tem que resultar em
 * `ok` + passo POSITIVO. Foi o oposto disso — abertura ~1% caindo no vermelho
 * do semáforo e cortando 30% todo dia — que produziu a sequência 10.014 → 322
 * → 1.053 → 817 e-mails/dia.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEND_WINDOWS,
  RED_RISK_THRESHOLDS,
  RISK_METRIC_KEYS,
  INDETERMINATE_SPAM_UTIL,
  HOLD_UTIL,
  STOP_UTIL,
  FIXED_DAILY_STEP,
  OPEN_TREND_MIN_DAYS,
  riskUtilization,
  decideBrake,
  adaptiveStep,
  proposeNextVolume,
  shouldSunsetNonOpener,
  openRateTrend,
  brtDayKey,
  groupByBrtDay,
  selectLastSendDays,
  selectWithinDays,
  type RiskMetrics,
  type SpamSignalLike,
} from "../scripts/lib/clarice-envio-policy.ts";

import { DEFAULT_HEALTH_THRESHOLDS } from "../workers/brevo-dashboard/src/thresholds.ts";
import { groupByBrtDay as workerGroupByBrtDay } from "../workers/brevo-dashboard/src/weekly-plan.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Risco de ISP saudável: nenhuma métrica passa de ~17% do seu limiar. */
const HEALTHY: RiskMetrics = {
  hardBounceRatePct: 0.2, // 10% de 2%
  bounceRatePct: 0.5, // 10% de 5%
  unsubRatePct: 0.1, // 3,3% de 3%
  sent: 10_000,
  delivered: 9_800,
};

const SPAM_OK: SpamSignalLike = { source: "postmaster", ratePct: 0.05 }; // 16,7% de 0,3%
const SPAM_INDETERMINATE: SpamSignalLike = { source: "indeterminate", ratePct: null };

function risk(over: Partial<RiskMetrics>): RiskMetrics {
  return { ...HEALTHY, ...over };
}

// ---------------------------------------------------------------------------
// REGRESSÃO CENTRAL — a catraca não pode voltar (#4705)
// ---------------------------------------------------------------------------

describe("#4705 — regressão da catraca: abertura NUNCA freia volume", () => {
  it("abertura de 1% com risco de ISP saudável => freio 'ok' e passo POSITIVO", () => {
    // A base de 1º envio é ~96% fria e abre ~1%. No motor ANTIGO
    // (decideSemaphore/computeWeekPlan do worker) isto era 🔴 automático
    // (openRate < 15%) e cortava 30% do volume TODO DIA — a catraca que zerou
    // o envio (10.014 → 322 → 1.053 → 817). Aqui a abertura de 1% aparece
    // explicitamente como TENDÊNCIA e mesmo assim não toca no freio nem no passo.
    const trend = openRateTrend([
      { dayKey: "2026-08-05", delivered: 2_000, uniqueViews: 20 }, // 1,0%
      { dayKey: "2026-08-06", delivered: 2_000, uniqueViews: 22 }, // 1,1%
      { dayKey: "2026-08-07", delivered: 2_000, uniqueViews: 19 },
      { dayKey: "2026-08-08", delivered: 2_000, uniqueViews: 21 },
    ]);
    assert.ok(trend.current < 2, "cenário: abertura ~1%, base fria");

    const brake = decideBrake(HEALTHY, SPAM_OK);
    assert.equal(brake.level, "ok", "abertura de 1% não pode produzir hold/stop");

    const step = adaptiveStep();
    assert.equal(step, FIXED_DAILY_STEP, `passo é sempre fixo desde #6888, veio ${step}`);

    // E o volume proposto CRESCE — nunca corta.
    const next = proposeNextVolume({
      baseVolume: 10_014,
      step,
      brake: brake.level,
      queueAvailable: 500_000,
      creditAvailable: null,
    });
    assert.ok(next.volume > 10_014, `volume deveria crescer, veio ${next.volume}`);
  });

  it("nem sequer é possível passar abertura pro freio: o tipo dos limiares não tem o campo", () => {
    // Guard estrutural (não comportamental): reintroduzir a catraca exigiria
    // mudar RiskMetrics E RiskThresholdsPct de propósito, não um `if` distraído.
    assert.deepEqual(Object.keys(RED_RISK_THRESHOLDS).sort(), [
      "bounce",
      "hardBounce",
      "spam",
      "unsub",
    ]);
    assert.ok(!("openRate" in RED_RISK_THRESHOLDS));
    assert.deepEqual([...RISK_METRIC_KEYS], ["hardBounce", "bounce", "unsub", "spam"]);
  });

  it("queda de abertura de 20% pra 4% NÃO muda freio nem passo", () => {
    const trend = openRateTrend([
      { dayKey: "2026-06-01", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-06-02", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-07-30", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-07-31", delivered: 1_000, uniqueViews: 40 },
    ]);
    assert.equal(trend.verdict, "queda");
    // Mesmíssimas entradas de risco => mesmíssima decisão. A tendência é
    // relatório; não existe caminho de código dela pro freio.
    assert.equal(decideBrake(HEALTHY, SPAM_OK).level, "ok");
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("#6888: sem NENHUM envio na janela, decideBrake.level é 'ok' (freio removido, #6793) E adaptiveStep cresce 10% mesmo assim (guard sufficientData→0 REMOVIDO por pedido explícito do editor, #6888)", () => {
    // Histórico (Finding 1, silent-failure-hunter, até #6793 — decideBrake; até
    // #6888 — adaptiveStep): sent=0 zera as 3 métricas de e-mail (nada pra
    // dividir), e a leitura original era "crescer sobre isso é crescer sem
    // UMA evidência real de saúde". #6793 já tinha removido essa proteção do
    // FREIO; #6888 (01/09/2026) remove a mesma proteção do PASSO, por pedido
    // EXPLÍCITO do editor — registrado na issue como escolha consciente, não
    // como detalhe de implementação (ver `FIXED_DAILY_STEP` no módulo).
    const noSends: RiskMetrics = { hardBounceRatePct: 0, bounceRatePct: 0, unsubRatePct: 0, sent: 0, delivered: 0 };
    const brake = decideBrake(noSends, SPAM_OK);
    assert.equal(brake.level, "ok", "#6793: decideBrake nunca mais produz hold/stop, nem sobre dado ausente");
    assert.equal(
      adaptiveStep(),
      FIXED_DAILY_STEP,
      "#6888: adaptiveStep cresce 10% mesmo sem NENHUM envio na janela — decisão explícita do editor, era 0 até 01/09/2026",
    );
    assert.ok(
      brake.reasons.some((r) => r.includes("sem NENHUM envio na janela")),
      "a razão principal continua nomeando a falta de envio, mesmo sem mais pausar/frear por causa dela",
    );
  });

  it("#6793: spam REAL e ruim não para mais a onda (freio removido) — mas reasons ainda nomeia o breach real", () => {
    const noSends: RiskMetrics = { hardBounceRatePct: 0, bounceRatePct: 0, unsubRatePct: 0, sent: 0, delivered: 0 };
    const badSpam: SpamSignalLike = { source: "postmaster", ratePct: 0.5 }; // acima do limiar de 0,3%
    const brake = decideBrake(noSends, badSpam);
    assert.equal(brake.level, "ok", "#6793: era 'stop' até 01/09/2026 — freio removido, spam ruim não zera mais o volume sozinho");
    assert.ok(brake.reasons.some((r) => r.includes("spam (Postmaster)")), "o breach real continua visível no relatório, só não age mais");
  });
});

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------

describe("SEND_WINDOWS", () => {
  it("freio 3 dias de envio, acelerador 30d, tendência 60d", () => {
    assert.deepEqual({ ...SEND_WINDOWS }, { brakeSendDays: 3, accelDays: 30, trendDays: 60 });
  });
});

// ---------------------------------------------------------------------------
// riskUtilization
// ---------------------------------------------------------------------------

describe("riskUtilization", () => {
  it("cada métrica é valor ÷ limiar vermelho", () => {
    const u = riskUtilization(
      { hardBounceRatePct: 1, bounceRatePct: 2.5, unsubRatePct: 1.5, sent: 1_000, delivered: 990 },
      { source: "postmaster", ratePct: 0.15 },
    );
    assert.equal(u.byMetric.hardBounce, 0.5); // 1 / 2
    assert.equal(u.byMetric.bounce, 0.5); // 2,5 / 5
    assert.equal(u.byMetric.unsub, 0.5); // 1,5 / 3
    assert.equal(u.byMetric.spam, 0.5); // 0,15 / 0,3
    assert.equal(u.maxUtil, 0.5);
    assert.equal(u.worst, "hardBounce", "empate desempata pela ordem de RISK_METRIC_KEYS");
    assert.deepEqual(u.noDataMetrics, []);
  });

  it("worst é a métrica de maior utilização", () => {
    const u = riskUtilization(risk({ unsubRatePct: 2.7 }), SPAM_OK);
    assert.equal(u.worst, "unsub");
    assert.ok(Math.abs(u.maxUtil - 0.9) < 1e-9);
  });

  it("spam indeterminate => utilização fixa 0,7 (nunca acelera, nunca para)", () => {
    const u = riskUtilization(HEALTHY, SPAM_INDETERMINATE);
    assert.equal(u.byMetric.spam, INDETERMINATE_SPAM_UTIL);
    assert.equal(INDETERMINATE_SPAM_UTIL, HOLD_UTIL);
    assert.ok(INDETERMINATE_SPAM_UTIL < STOP_UTIL);
    assert.equal(u.worst, "spam");
    // indeterminado NÃO é "sem dado": tem tratamento próprio e sinaliza hold.
    assert.deepEqual(u.noDataMetrics, []);
  });

  it("source 'postmaster' com ratePct null (estado que a união discriminada não representa mais, mas o runtime ainda defende) cai no mesmo tratamento de indeterminado", () => {
    // `SpamSignalLike` virou união discriminada no review da PR — este shape
    // não compila mais como literal válido (é exatamente o estado impossível
    // que a união elimina). O cast força o cenário mesmo assim: a defesa em
    // profundidade dentro de `riskUtilization` (comentário "ratePct===null
    // tratado como indeterminado") continua no código por precaução — este
    // teste garante que ela não apodrece silenciosamente se alguém a remover
    // achando "o tipo já impede isso".
    const illegal = { source: "postmaster", ratePct: null } as unknown as SpamSignalLike;
    const u = riskUtilization(HEALTHY, illegal);
    assert.equal(u.byMetric.spam, INDETERMINATE_SPAM_UTIL);
  });

  it("denominador ZERO em todas as métricas: util 0, reportado, nunca NaN", () => {
    const u = riskUtilization(
      { hardBounceRatePct: 0, bounceRatePct: 0, unsubRatePct: 0, sent: 0, delivered: 0 },
      SPAM_OK,
    );
    for (const k of ["hardBounce", "bounce", "unsub"]) {
      assert.equal(u.byMetric[k], 0, `${k} deveria ser 0`);
      assert.ok(Number.isFinite(u.byMetric[k]), `${k} não pode ser NaN/Infinity`);
    }
    assert.deepEqual(u.noDataMetrics, ["hardBounce", "bounce", "unsub"]);
    assert.ok(Number.isFinite(u.maxUtil));
    // O relatório precisa dizer que é ausência de dado, não saúde confirmada.
    const brake = decideBrake(
      { hardBounceRatePct: 0, bounceRatePct: 0, unsubRatePct: 0, sent: 0, delivered: 0 },
      SPAM_OK,
    );
    assert.ok(brake.reasons.some((r) => r.includes("sem dado na janela")));
  });

  it("#6888: denominador zero + spam sem leitura => level 'ok' (era hold, #6793); adaptiveStep cresce 10% mesmo assim (era 0 até 01/09/2026, #6888)", () => {
    const b = decideBrake(
      { hardBounceRatePct: 0, bounceRatePct: 0, unsubRatePct: 0, sent: 0, delivered: 0 },
      SPAM_INDETERMINATE,
    );
    assert.equal(b.level, "ok");
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("valor não-finito nunca vaza pra comparação (NaN >= 1 seria um 'ok' fabricado)", () => {
    const u = riskUtilization(risk({ hardBounceRatePct: Number.NaN }), SPAM_OK);
    assert.equal(u.byMetric.hardBounce, 0);
    assert.ok(u.noDataMetrics.includes("hardBounce"));
    assert.ok(Number.isFinite(u.maxUtil));
  });

  it("Finding 4 (silent-failure-hunter): valor NEGATIVO é sem-dado, não '-2,5× o limiar'", () => {
    const u = riskUtilization(risk({ hardBounceRatePct: -5 }), SPAM_OK);
    assert.equal(u.byMetric.hardBounce, 0, "negativo nunca vira utilização negativa");
    assert.ok(u.noDataMetrics.includes("hardBounce"), "negativo precisa aparecer como sem-dado, não como saudável");
  });

  it("sufficientData reflete `hasSent` — false só quando sent<=0/não-finito", () => {
    assert.equal(riskUtilization(HEALTHY, SPAM_OK).sufficientData, true);
    assert.equal(riskUtilization(risk({ sent: 0 }), SPAM_OK).sufficientData, false);
    assert.equal(riskUtilization(risk({ sent: -1 }), SPAM_OK).sufficientData, false);
    assert.equal(riskUtilization(risk({ sent: Number.NaN }), SPAM_OK).sufficientData, false);
  });
});

// ---------------------------------------------------------------------------
// decideBrake
// ---------------------------------------------------------------------------

describe("decideBrake — freio removido (#6793 Faixa B, item 2, 01/09/2026) — level sempre 'ok', reasons continuam nomeando o risco real", () => {
  it("#6793: hard bounce 2,0% (100% do limiar) => level 'ok' (era stop até 01/09/2026), maxUtil e reasons continuam corretos", () => {
    const b = decideBrake(risk({ hardBounceRatePct: 2 }), SPAM_OK);
    assert.equal(b.level, "ok");
    assert.equal(b.maxUtil, 1);
    assert.ok(b.reasons.some((r) => r.includes("hard bounce") && r.includes("2,00%")));
  });

  it("#6793/#6888: hard bounce 1,4% (70% do limiar, zona de atenção) => level 'ok' (era hold até 01/09/2026); adaptiveStep cresce 10% mesmo em zona de atenção (era 0 até 01/09/2026, #6888)", () => {
    const b = decideBrake(risk({ hardBounceRatePct: 1.4 }), SPAM_OK);
    assert.equal(b.level, "ok");
    assert.ok(Math.abs(b.maxUtil - 0.7) < 1e-9);
    assert.equal(
      adaptiveStep(),
      FIXED_DAILY_STEP,
      "#6888: passo fixo cresce mesmo em zona de atenção (maxUtil>=HOLD_UTIL) — decisão explícita do editor",
    );
  });

  it("hard bounce 0,5% => ok com passo fixo de 10%", () => {
    const m = risk({ hardBounceRatePct: 0.5 });
    assert.equal(decideBrake(m, SPAM_OK).level, "ok");
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("#6793: bounce total 5% => level 'ok' (era stop); 4,9% também 'ok' (já era antes)", () => {
    assert.equal(decideBrake(risk({ bounceRatePct: 5 }), SPAM_OK).level, "ok");
    assert.equal(decideBrake(risk({ bounceRatePct: 4.9 }), SPAM_OK).level, "ok");
  });

  it("#6793: unsub 3% => level 'ok' (era stop até 01/09/2026), reason continua nomeando o descadastro", () => {
    const b = decideBrake(risk({ unsubRatePct: 3 }), SPAM_OK);
    assert.equal(b.level, "ok");
    assert.ok(b.reasons.some((r) => r.includes("descadastro")));
  });

  it("#6793: spam do Postmaster 0,3% => level 'ok' (era stop até 01/09/2026), reason continua nomeando o spam", () => {
    const b = decideBrake(HEALTHY, { source: "postmaster", ratePct: 0.3 });
    assert.equal(b.level, "ok");
    assert.ok(b.reasons.some((r) => r.includes("spam (Postmaster)")));
  });

  it("#6793/#6888: spam indeterminate => level 'ok' (era hold); adaptiveStep cresce 10% mesmo assim (era 0 até 01/09/2026, #6888)", () => {
    const b = decideBrake(HEALTHY, SPAM_INDETERMINATE);
    assert.equal(b.level, "ok");
    assert.equal(
      adaptiveStep(),
      FIXED_DAILY_STEP,
      "#6888: passo fixo, spam sem leitura não zera mais",
    );
    assert.ok(b.reasons.some((r) => r.includes("sem leitura confiável")));
  });

  it("reasons sempre em pt-BR e não-vazio, inclusive no caminho feliz", () => {
    const b = decideBrake(HEALTHY, SPAM_OK);
    assert.equal(b.level, "ok");
    assert.ok(b.reasons.length >= 1);
    assert.ok(b.reasons[0].includes("dentro dos limiares"));
  });

  it("#6793: NENHUMA combinação de métricas produz stop/hold — level sempre 'ok'", () => {
    // 3 métricas ótimas + 1 estourada — antes 'a pior métrica manda' (stop);
    // agora level é sempre 'ok', mas a pior métrica AINDA manda no relatório
    // (reasons/flagged continuam ordenados pela pior utilização).
    const b = decideBrake(risk({ unsubRatePct: 3.6 }), SPAM_OK);
    assert.equal(b.level, "ok");
    assert.ok(b.reasons.some((r) => r.includes("descadastro")), "a pior métrica ainda aparece no relatório");
  });

  it("Finding 2 (silent-failure-hunter): valor NaN/Infinity nunca vaza pro texto de 'reasons' — nunca 'NaN%'", () => {
    // worst resolve pra uma métrica corrompida (NaN) enquanto as outras 3
    // ficam em 0 (spam limpo, sem nenhuma flagged >= HOLD_UTIL) — o caminho
    // que monta o texto do 'caso feliz' (reasons.length === 0 antes de
    // entrar no if) é o que tinha o vazamento.
    const b = decideBrake(risk({ hardBounceRatePct: Number.NaN, bounceRatePct: 0, unsubRatePct: 0 }), {
      source: "postmaster",
      ratePct: 0,
    });
    for (const r of b.reasons) {
      assert.ok(!/nan/i.test(r), `reason vazou valor não-finito: "${r}"`);
      assert.ok(!/infinity/i.test(r), `reason vazou valor não-finito: "${r}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// adaptiveStep — passo FIXO desde #6888 (01/09/2026)
// ---------------------------------------------------------------------------

describe("adaptiveStep — passo fixo de 10%/dia, incondicional (#6888, 01/09/2026)", () => {
  // Teste de regressão INVERTIDO (critério de fechamento da issue #6888): até
  // 01/09/2026 este describe se chamava "adaptiveStep — escalada pela folga,
  // teto +25%/dia" e afirmava "passo é 0 em risco alto, escala pela folga em
  // risco baixo, teto 25%/dia" (MAX_DAILY_STEP). Por pedido EXPLÍCITO do
  // editor o passo deixou de depender de risco — as asserções abaixo afirmam
  // o OPOSTO do que afirmavam antes. O teste antigo não foi apagado: foi
  // invertido, citando esta issue, como o critério de fechamento pede.
  //
  // #6958 (achado 9 do review, type-design-analyzer): `adaptiveStep` perdeu
  // os parâmetros `accelRisk`/`spam`/`t` — eram ignorados desde #6888, e o
  // único call site (`clarice-envio-risk.ts`) não precisava deles pra nada.
  // Os testes "estado 1-4" abaixo, que antes variavam risco/spam pra provar
  // que o resultado não mudava, viraram a MESMA chamada `adaptiveStep()`
  // repetida — mantidos como regressão nomeada (documentam qual estado
  // histórico cada um cobria antes do #6888), mas sem mais poder EXPRESSAR
  // "input variado, output igual": essa garantia agora é ESTRUTURAL (a
  // função não tem entrada pra variar), não mais testável por asserção. O
  // teste "incondicional" que fechava esse describe testando NaN/negativo/
  // extremo foi removido por não ser mais expressável — a garantia que ele
  // checava é a mesma que a assinatura `(): number` agora impõe em tempo de
  // compilação.

  it("estado 1 — risco zero, dados suficientes => 10% (antes: 0,25 = teto/MAX_DAILY_STEP)", () => {
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("estado 2 — risco na metade da folga (hardBounce 0,5% => util 0,25) => 10% (antes: ~0,1607)", () => {
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("estado 3 — maxUtil >= 0,7 (zona de atenção) => 10% (antes: 0 — congelava)", () => {
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("estado 4 — sufficientData: false (sem NENHUM envio na janela de 30 dias) => 10% (antes: 0 — nunca escalava sobre dado ausente)", () => {
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
  });

  it("FIXED_DAILY_STEP é a única fonte do passo — sem argumentos, `adaptiveStep()` não tem como variar (#6958)", () => {
    assert.equal(adaptiveStep(), FIXED_DAILY_STEP);
    assert.equal(adaptiveStep.length, 0, "assinatura sem parâmetros — TypeScript garante isto em compile-time");
  });
});

// ---------------------------------------------------------------------------
// proposeNextVolume
// ---------------------------------------------------------------------------

describe("proposeNextVolume", () => {
  const BIG_QUEUE = 1_000_000;

  it("cappedBy 'step' — caminho normal, escala sobre o último dia enviado", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.1607,
      brake: "ok",
      queueAvailable: BIG_QUEUE,
      creditAvailable: null,
    });
    assert.equal(r.volume, 1_161); // round(1000 × 1,1607)
    assert.equal(r.cappedBy, "step");
    assert.ok(r.note.includes("1161"));
  });

  it("cappedBy 'stop' — freio stop zera", () => {
    // cappedBy tem um valor DEDICADO pra stop (não colapsado em "brake" — ver
    // NextVolumeDecision, achado do type-design-analyzer): um consumidor que
    // persista só este objeto ainda sabe se foi stop ou hold sem parsear `note`.
    const r = proposeNextVolume({
      baseVolume: 10_000,
      step: 0.25,
      brake: "stop",
      queueAvailable: BIG_QUEUE,
      creditAvailable: null,
    });
    assert.equal(r.volume, 0);
    assert.equal(r.cappedBy, "stop");
    assert.ok(r.note.includes("cancelar"));
  });

  it("cappedBy 'hold' — freio hold repete a base SEM escalar (e sem cortar)", () => {
    const r = proposeNextVolume({
      baseVolume: 10_000,
      step: 0.25,
      brake: "hold",
      queueAvailable: BIG_QUEUE,
      creditAvailable: null,
    });
    assert.equal(r.volume, 10_000, "hold mantém — a poda de 30% do motor antigo não existe mais");
    assert.equal(r.cappedBy, "hold");
  });

  it("cappedBy 'queue' — fila menor que o proposto", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: 900,
      creditAvailable: null,
    });
    assert.equal(r.volume, 900);
    assert.equal(r.cappedBy, "queue");
    assert.ok(r.note.includes("fila"));
  });

  it("cappedBy 'credit' — crédito Brevo menor que o proposto (e menor que a fila)", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: BIG_QUEUE,
      creditAvailable: 500,
    });
    assert.equal(r.volume, 500);
    assert.equal(r.cappedBy, "credit");
    assert.ok(r.note.includes("crédito"));
  });

  it("crédito null = não consultado, não limita", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: BIG_QUEUE,
      creditAvailable: null,
    });
    assert.equal(r.volume, 1_250);
    assert.equal(r.cappedBy, "step");
    assert.ok(r.note.includes("não consultado"));
  });

  it("crédito 0 zera (0 é limite real, não 'não consultado')", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: BIG_QUEUE,
      creditAvailable: 0,
    });
    assert.equal(r.volume, 0);
    assert.equal(r.cappedBy, "credit");
  });

  it("baseVolume 0 ou negativo => 0 com nota, nunca NaN", () => {
    for (const baseVolume of [0, -50, Number.NaN]) {
      const r = proposeNextVolume({
        baseVolume,
        step: 0.25,
        brake: "ok",
        queueAvailable: BIG_QUEUE,
        creditAvailable: null,
      });
      assert.equal(r.volume, 0, `baseVolume ${baseVolume}`);
      assert.equal(r.cappedBy, null);
      assert.ok(Number.isFinite(r.volume));
      assert.ok(r.note.includes("Sem volume-base"));
    }
  });

  it("fila negativa/não-finita é fail-closed (0), nunca vira volume fantasma", () => {
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.1,
      brake: "ok",
      queueAvailable: Number.NaN,
      creditAvailable: null,
    });
    assert.equal(r.volume, 0);
    assert.equal(r.cappedBy, "queue");
  });

  it("SEM teto absoluto de volume — 100k de base escala normalmente", () => {
    // Decisão do editor (#4705): o que limita é fila, crédito e freio. Um teto
    // fixo seria a mesma catraca com outra roupa.
    const r = proposeNextVolume({
      baseVolume: 100_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: 5_000_000,
      creditAvailable: 5_000_000,
    });
    assert.equal(r.volume, 125_000);
    assert.equal(r.cappedBy, "step");
  });

  it("Finding 5 (pr-test-analyzer): fila E crédito cortam JUNTOS — crédito manda por último, mas a nota registra os dois cortes", () => {
    // Antes deste teste, fila e crédito só eram testados isoladamente (um
    // sempre com o outro em "não limita"). Aqui os DOIS são mais restritivos
    // que o proposto: base 1000 × 1,25 = 1250 -> fila corta pra 900 -> crédito
    // corta de novo pra 500. cappedBy é o ÚLTIMO corte a agir (documentado no
    // tipo); a nota precisa mencionar os dois, não só o vencedor.
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "ok",
      queueAvailable: 900,
      creditAvailable: 500,
    });
    assert.equal(r.volume, 500);
    assert.equal(r.cappedBy, "credit");
    assert.ok(r.note.includes("fila"), "nota precisa registrar que a fila TAMBÉM cortou");
    assert.ok(r.note.includes("crédito"), "nota precisa registrar o corte final do crédito");
  });

  it("hold combinado com fila mais apertada que a base — cappedBy vira 'queue', não fica preso em 'hold'", () => {
    // Achado do type-design-analyzer: o caminho hold cai nos MESMOS ifs de
    // fila/crédito abaixo — uma fila mais apertada que a base PRECISA
    // sobrescrever cappedBy, senão o consumidor acha que agendou a base
    // inteira quando na real a fila não comportava.
    const r = proposeNextVolume({
      baseVolume: 1_000,
      step: 0.25,
      brake: "hold",
      queueAvailable: 300,
      creditAvailable: null,
    });
    assert.equal(r.volume, 300);
    assert.equal(r.cappedBy, "queue");
  });
});

// ---------------------------------------------------------------------------
// Sunset
// ---------------------------------------------------------------------------

describe("shouldSunsetNonOpener (#4430)", () => {
  it("2 envios e 0 aberturas => sunset", () => {
    assert.equal(shouldSunsetNonOpener({ sendsCount: 2, opensCount: 0 }), true);
  });

  it("2 envios e 1 abertura => fica", () => {
    assert.equal(shouldSunsetNonOpener({ sendsCount: 2, opensCount: 1 }), false);
  });

  it("1 envio e 0 aberturas => fica (ainda não teve 2 chances)", () => {
    assert.equal(shouldSunsetNonOpener({ sendsCount: 1, opensCount: 0 }), false);
  });

  it("0 envios => fica", () => {
    assert.equal(shouldSunsetNonOpener({ sendsCount: 0, opensCount: 0 }), false);
  });

  it("muitos envios e nenhuma abertura => sunset", () => {
    assert.equal(shouldSunsetNonOpener({ sendsCount: 17, opensCount: 0 }), true);
  });

  it("Finding 3 (silent-failure-hunter): opensCount corrompido (NaN) NUNCA decide sunset — sunset é permanente, dado ruim tem que ficar seguro", () => {
    // Versão anterior tratava opensCount=NaN como 0 (mesmo default de
    // sendsCount), o que combinado com sendsCount>=2 produzia sunset=true —
    // "não sei quantas aberturas teve" virando "confirmado que nunca abriu".
    // Sunset corta de vez (#4430); o único lado seguro pra dado corrompido é
    // NUNCA cortar, nos dois campos.
    assert.equal(shouldSunsetNonOpener({ sendsCount: 5, opensCount: Number.NaN }), false);
    assert.equal(shouldSunsetNonOpener({ sendsCount: Number.NaN, opensCount: 5 }), false);
    assert.equal(shouldSunsetNonOpener({ sendsCount: Number.NaN, opensCount: Number.NaN }), false);
  });
});

// ---------------------------------------------------------------------------
// Tendência de abertura (informativa)
// ---------------------------------------------------------------------------

describe("openRateTrend — só relatório", () => {
  it("20% => 4% é 'queda'", () => {
    const t = openRateTrend([
      { dayKey: "2026-06-01", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-06-02", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-07-30", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-07-31", delivered: 1_000, uniqueViews: 40 },
    ]);
    assert.equal(t.previous, 20);
    assert.equal(t.current, 4);
    assert.equal(t.deltaPp, -16);
    assert.equal(t.verdict, "queda");
    assert.equal(t.sampleDays, 4);
  });

  it("estabilidade em 1% => 'estavel' (base fria não é 'queda')", () => {
    const t = openRateTrend([
      { dayKey: "2026-08-01", delivered: 2_000, uniqueViews: 20 },
      { dayKey: "2026-08-02", delivered: 2_000, uniqueViews: 21 },
      { dayKey: "2026-08-03", delivered: 2_000, uniqueViews: 19 },
      { dayKey: "2026-08-04", delivered: 2_000, uniqueViews: 20 },
    ]);
    assert.equal(t.verdict, "estavel");
    assert.ok(Math.abs(t.deltaPp) < 1);
  });

  it("4% => 20% é 'alta'", () => {
    const t = openRateTrend([
      { dayKey: "2026-06-01", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-06-02", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-07-30", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-07-31", delivered: 1_000, uniqueViews: 200 },
    ]);
    assert.equal(t.verdict, "alta");
    assert.equal(t.deltaPp, 16);
  });

  it("amostra insuficiente nunca afirma queda/alta", () => {
    const t = openRateTrend([
      { dayKey: "2026-08-01", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-08-02", delivered: 1_000, uniqueViews: 10 },
      { dayKey: "2026-08-03", delivered: 1_000, uniqueViews: 10 },
    ]);
    assert.equal(t.sampleDays, 3);
    assert.ok(t.sampleDays < OPEN_TREND_MIN_DAYS);
    assert.equal(t.verdict, "estavel");
    assert.equal(t.deltaPp, 0);
    assert.equal(t.previous, t.current);
  });

  it("array vazio não divide por zero", () => {
    const t = openRateTrend([]);
    assert.deepEqual(t, { current: 0, previous: 0, deltaPp: 0, verdict: "estavel", sampleDays: 0 });
  });

  it("dias sem delivered são descartados (não contam como amostra)", () => {
    const t = openRateTrend([
      { dayKey: "2026-08-01", delivered: 0, uniqueViews: 0 },
      { dayKey: "2026-08-02", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-08-03", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-08-04", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-08-05", delivered: 1_000, uniqueViews: 40 },
    ]);
    assert.equal(t.sampleDays, 4);
    assert.equal(t.verdict, "queda");
  });

  it("com nº ímpar de dias, o do MEIO é descartado (nunca contado 2×)", () => {
    const t = openRateTrend([
      { dayKey: "2026-08-01", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-08-02", delivered: 1_000, uniqueViews: 200 },
      { dayKey: "2026-08-03", delivered: 1_000, uniqueViews: 999 }, // meio, ignorado
      { dayKey: "2026-08-04", delivered: 1_000, uniqueViews: 40 },
      { dayKey: "2026-08-05", delivered: 1_000, uniqueViews: 40 },
    ]);
    assert.equal(t.previous, 20);
    assert.equal(t.current, 4);
    assert.equal(t.sampleDays, 5);
  });

  it("ponderado por delivered (dia grande pesa mais que dia pequeno)", () => {
    const t = openRateTrend([
      { dayKey: "2026-08-01", delivered: 100, uniqueViews: 50 }, // 50%
      { dayKey: "2026-08-02", delivered: 9_900, uniqueViews: 99 }, // 1%
      { dayKey: "2026-08-03", delivered: 5_000, uniqueViews: 50 },
      { dayKey: "2026-08-04", delivered: 5_000, uniqueViews: 50 },
    ]);
    // Metade antiga: (50+99)/10.000 = 1,49% — não os ~25,5% de uma média de médias.
    assert.ok(Math.abs(t.previous - 1.49) < 1e-9);
    assert.equal(t.current, 1);
    assert.equal(t.verdict, "estavel");
  });
});

// ---------------------------------------------------------------------------
// Seleção de janela
// ---------------------------------------------------------------------------

describe("selectLastSendDays / selectWithinDays", () => {
  // 10/08 com teste A/B/C (3 campanhas, 1 dia); depois 09, 08 e 07/08.
  const CAMPAIGNS = [
    { name: "d1-A", sentDate: "2026-08-10T09:00:00.000Z" },
    { name: "d1-B", sentDate: "2026-08-10T09:05:00.000Z" },
    { name: "d1-C", sentDate: "2026-08-10T09:10:00.000Z" },
    { name: "d2", sentDate: "2026-08-09T09:00:00.000Z" },
    { name: "d3", sentDate: "2026-08-08T09:00:00.000Z" },
    { name: "d4", sentDate: "2026-08-07T09:00:00.000Z" },
    { name: "futura", sentDate: "2026-08-12T09:00:00.000Z" },
    { name: "sem-data", sentDate: null },
  ];
  const NOW = new Date("2026-08-11T20:00:00.000Z");

  it("um dia de teste A/B/C conta como 1 DIA, não como 3 campanhas", () => {
    const sel = selectLastSendDays(CAMPAIGNS, NOW, { days: 3 });
    const names = sel.map((c) => c.name).sort();
    assert.deepEqual(names, ["d1-A", "d1-B", "d1-C", "d2", "d3"]);
    // 3 dias de envio = 10, 09 e 08 — o 07 fica fora.
    assert.equal(groupByBrtDay(sel).size, 3);
  });

  it("envio no FUTURO e sem data ficam fora (agendada não dilui a janela do freio)", () => {
    const sel = selectLastSendDays(CAMPAIGNS, NOW, { days: 30 });
    assert.ok(!sel.some((c) => c.name === "futura"));
    assert.ok(!sel.some((c) => c.name === "sem-data"));
    assert.equal(sel.length, 6);
  });

  it("days inválido devolve vazio (nunca a janela inteira por acidente)", () => {
    assert.deepEqual(selectLastSendDays(CAMPAIGNS, NOW, { days: 0 }), []);
    assert.deepEqual(selectLastSendDays(CAMPAIGNS, NOW, { days: -3 }), []);
    assert.deepEqual(selectLastSendDays(CAMPAIGNS, NOW, { days: 1.5 }), []);
  });

  it("selectWithinDays usa dias CORRIDOS (janela rolante)", () => {
    const old = [
      { name: "dentro", sentDate: "2026-07-13T09:00:00.000Z" },
      { name: "fora", sentDate: "2026-07-12T19:00:00.000Z" }, // > 30×24h antes de NOW
    ];
    const sel = selectWithinDays(old, NOW, { days: 30 });
    assert.deepEqual(sel.map((c) => c.name), ["dentro"]);
  });

  it("selectWithinDays byCalendarDay usa fronteira de dia BRT", () => {
    const sel = selectWithinDays(CAMPAIGNS, NOW, { days: 3, byCalendarDay: true });
    // hoje BRT = 11/08 => janela 09, 10, 11.
    assert.deepEqual(sel.map((c) => c.name).sort(), ["d1-A", "d1-B", "d1-C", "d2"]);
  });

  it("acelerador (30d) e tendência (60d) enxergam janelas diferentes", () => {
    const hist = [
      { name: "recente", sentDate: "2026-08-01T09:00:00.000Z" },
      { name: "antiga", sentDate: "2026-06-25T09:00:00.000Z" },
    ];
    assert.deepEqual(
      selectWithinDays(hist, NOW, { days: SEND_WINDOWS.accelDays }).map((c) => c.name),
      ["recente"],
    );
    assert.deepEqual(
      selectWithinDays(hist, NOW, { days: SEND_WINDOWS.trendDays }).map((c) => c.name),
      ["recente", "antiga"],
    );
  });
});

describe("brtDayKey — paridade com o agrupamento do worker", () => {
  it("mesmo dia-calendário BRT que groupByBrtDay de weekly-plan.ts", () => {
    // Inclui o caso que separa BRT de UTC: 02:00Z é 23:00 BRT do dia ANTERIOR.
    const fixtures = [
      { sentDate: "2026-08-10T02:00:00.000Z" }, // BRT 09/08
      { sentDate: "2026-08-10T09:00:00.000Z" }, // BRT 10/08
      { sentDate: "2026-08-10T23:59:00.000Z" }, // BRT 10/08
      { sentDate: "2026-08-11T02:59:00.000Z" }, // BRT 10/08
      { sentDate: null },
      { sentDate: "lixo" },
    ];
    const mine = groupByBrtDay(fixtures);
    const theirs = workerGroupByBrtDay(fixtures as never);
    assert.deepEqual([...mine.keys()].sort(), [...theirs.keys()].sort());
    for (const [day, list] of mine) {
      assert.equal(list.length, theirs.get(day)?.length, `dia ${day}`);
    }
    assert.equal(brtDayKey("2026-08-10T02:00:00.000Z"), "2026-08-09");
    assert.equal(brtDayKey(null), null);
    assert.equal(brtDayKey("lixo"), null);
  });
});

// ---------------------------------------------------------------------------
// Paridade de limiares — fonte única (#3078)
// ---------------------------------------------------------------------------

describe("paridade com workers/brevo-dashboard/src/thresholds.ts", () => {
  it("RED_RISK_THRESHOLDS é derivado (não redigitado) das faixas vermelhas do doc", () => {
    assert.equal(RED_RISK_THRESHOLDS.hardBounce, DEFAULT_HEALTH_THRESHOLDS.hardBounceRate.yellow);
    assert.equal(RED_RISK_THRESHOLDS.bounce, DEFAULT_HEALTH_THRESHOLDS.bounceRate.yellow);
    assert.equal(RED_RISK_THRESHOLDS.unsub, DEFAULT_HEALTH_THRESHOLDS.unsubRate.yellow);
    assert.equal(RED_RISK_THRESHOLDS.spam, DEFAULT_HEALTH_THRESHOLDS.spamRate.yellow);
  });

  it("valores CONGELADOS — mudar thresholds.ts quebra aqui, nunca em silêncio", () => {
    // Decisão do editor no #4705: os limiares de risco de ISP ficam como estão
    // hoje. Este teste é o alarme: se alguém mexer nos números do dashboard, o
    // motor de envio muda junto — e isso tem que ser uma decisão consciente,
    // não um efeito colateral.
    assert.deepEqual(RED_RISK_THRESHOLDS, {
      hardBounce: 2,
      bounce: 5,
      unsub: 3,
      spam: 0.3,
    });
  });

  it("o arquivo-fonte declara exatamente esses números (guard contra reshuffle)", () => {
    const src = readFileSync(
      resolve(ROOT, "workers", "brevo-dashboard", "src", "thresholds.ts"),
      "utf8",
    );
    const yellowOf = (metric: string): number | null => {
      const m = new RegExp(`${metric}:\\s*\\{[^}]*yellow:\\s*([0-9.]+)`).exec(src);
      return m ? Number(m[1]) : null;
    };
    assert.equal(yellowOf("hardBounceRate"), 2);
    assert.equal(yellowOf("bounceRate"), 5);
    assert.equal(yellowOf("unsubRate"), 3);
    assert.equal(yellowOf("spamRate"), 0.3);
    // Abertura continua existindo no dashboard (o semáforo da Rampa segue
    // usando) — só não governa mais o envio automático diário.
    assert.equal(yellowOf("openRate"), 15);
  });
});
