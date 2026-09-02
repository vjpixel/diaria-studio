/**
 * test/ads-kill-switch.test.ts (#5239)
 *
 * Lógica pura de `scripts/lib/ads-kill-switch.ts` — o kill switch por
 * custo das campanhas de anúncio. Cobre os guardrails obrigatórios da
 * issue (piso de `n`, janela de assentamento), as duas condições de
 * degradação (self / cross-arm, cada uma independente), o adaptador de
 * linhas de CSV, e o desenho "só pausa, nunca toca API real" do executor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KILL_SWITCH_GUARDRAILS,
  computeSelfBaseline,
  computeCrossArmFloor,
  evaluateArmKillSwitch,
  evaluateKillSwitchRound,
  buildArmCostSamplesFromRows,
  notWiredPauseExecutor,
  recordSkippedPauseEvent,
  recordAttemptedPauseEvent,
  buildKillSwitchAlarmEmail,
  type ArmCostSample,
  type KillSwitchGuardrails,
} from "../scripts/lib/ads-kill-switch.ts";

const D0 = "2026-08-26";
const G: KillSwitchGuardrails = DEFAULT_KILL_SWITCH_GUARDRAILS; // minLeitores=10, minDaysSinceD0=3, ratios=2, minBaselineSamples=2

const BRACOS = ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"] as const;
const [GOOGLE, MICROSOFT, META] = BRACOS;

function sample(braco: string, date: string, leitores: number, custoPorLeitor: number): ArmCostSample {
  return { braco, date, leitores, custoPorLeitor };
}

describe("#5239 — ads-kill-switch: guardrails de entrada (n / janela de assentamento)", () => {
  it("dentro da janela de assentamento (daysSinceD0 < minDaysSinceD0) → nunca avalia, mesmo com dado disparador", () => {
    // D0+1: minDaysSinceD0=3, ainda dentro da janela.
    const history = [sample(GOOGLE, "2026-08-27", 100, 999)];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-08-27", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, false);
    assert.equal(ev.skipReason, "within-settle-window");
    assert.equal(ev.triggered, false);
    assert.deepEqual(ev.reasons, []);
  });

  it("fora da janela de assentamento, mas sem amostra na data → skipReason 'no-sample-for-date', nunca 'ok' silencioso", () => {
    const history: ArmCostSample[] = [];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-08-30", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, false);
    assert.equal(ev.skipReason, "no-sample-for-date");
  });

  it("amostra existe mas leitores < piso (minLeitores=10) → skipReason 'insufficient-n', nunca compara custo", () => {
    const history = [sample(GOOGLE, "2026-08-30", 5, 999)];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-08-30", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, false);
    assert.equal(ev.skipReason, "insufficient-n");
    assert.equal(ev.triggered, false);
  });

  it("leitores EXATAMENTE no piso → passa (piso é '>=', não '>')", () => {
    const history = [sample(GOOGLE, "2026-08-30", G.minLeitores, 5)];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-08-30", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, true);
    assert.equal(ev.skipReason, null);
  });

  it("daysSinceD0 EXATAMENTE no piso de assentamento → passa (piso é '>=', não '>')", () => {
    // D0+3 = 2026-08-29, minDaysSinceD0=3.
    const history = [sample(GOOGLE, "2026-08-29", 20, 5)];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-08-29", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, true);
  });
});

describe("#5239 — ads-kill-switch: self-degradation (contra a própria história)", () => {
  it("sem baseline suficiente (< minBaselineSamples) → self-degradation nunca avalia, mesmo custo alto", () => {
    // Só 1 amostra histórica elegível (minBaselineSamples=2) — sem irmãos elegíveis também, então nada dispara.
    const history = [sample(GOOGLE, "2026-08-29", 20, 5), sample(GOOGLE, "2026-09-01", 20, 999)];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, true);
    assert.equal(ev.triggered, false, "1 única amostra histórica não é baseline suficiente");
  });

  it("custo atual > 2× a mediana da própria história → dispara self-degradation com os números certos", () => {
    const history = [
      sample(GOOGLE, "2026-08-29", 20, 10),
      sample(GOOGLE, "2026-08-30", 20, 12),
      sample(GOOGLE, "2026-09-01", 20, 30), // > 2×11 (mediana de 10,12)
    ];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.triggered, true);
    const reason = ev.reasons.find((r) => r.kind === "self-degradation");
    assert.ok(reason, "deveria conter razão self-degradation");
    assert.equal(reason!.currentCustoPorLeitor, 30);
    assert.equal(reason!.baselineCustoPorLeitor, 11); // mediana(10,12)
    assert.equal(reason!.thresholdRatio, 2);
    assert.ok(reason!.ratio > 2);
  });

  it("custo atual EXATAMENTE 2× a baseline → NÃO dispara (estritamente maior que o limiar, mesma convenção do #3.2 item 3)", () => {
    const history = [
      sample(GOOGLE, "2026-08-29", 20, 10),
      sample(GOOGLE, "2026-08-30", 20, 10),
      sample(GOOGLE, "2026-09-01", 20, 20), // exatamente 2×10
    ];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.reasons.some((r) => r.kind === "self-degradation"), false);
  });

  it("amostras DENTRO da janela de assentamento não entram na baseline (custo inicial ruim não contamina a própria história)", () => {
    // D0 e D0+1 são janela de assentamento (minDaysSinceD0=3) — mesmo com
    // custo baixo ali, não deveriam contar como baseline "normal".
    const history = [
      sample(GOOGLE, D0, 20, 1), // dentro da janela — nunca entra na baseline
      sample(GOOGLE, "2026-08-27", 20, 1), // dentro da janela — nunca entra na baseline
      sample(GOOGLE, "2026-09-01", 20, 999), // avaliado
    ];
    const baseline = computeSelfBaseline(history, GOOGLE, "2026-09-01", D0, G);
    assert.equal(baseline, null, "só 2 amostras na janela de assentamento não deveriam formar baseline");
  });

  it("computeSelfBaseline usa MEDIANA, não média (robusto a outlier)", () => {
    const history = [
      sample(GOOGLE, "2026-08-29", 20, 5),
      sample(GOOGLE, "2026-08-30", 20, 6),
      sample(GOOGLE, "2026-08-31", 20, 1000), // outlier não deveria puxar a mediana
    ];
    const baseline = computeSelfBaseline(history, GOOGLE, "2026-09-01", D0, G);
    assert.equal(baseline, 6);
  });
});

describe("#5239 — ads-kill-switch: cross-arm-degradation (contra os outros braços)", () => {
  it("custo do braço > 2× o MENOR custo entre os irmãos elegíveis na MESMA data → dispara", () => {
    const history = [
      sample(GOOGLE, "2026-09-01", 20, 50), // sob avaliação
      sample(MICROSOFT, "2026-09-01", 20, 20), // menor entre os irmãos
      sample(META, "2026-09-01", 20, 25),
    ];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.triggered, true);
    const reason = ev.reasons.find((r) => r.kind === "cross-arm-degradation");
    assert.ok(reason);
    assert.equal(reason!.baselineCustoPorLeitor, 20, "usa o MENOR custo entre os irmãos, não a média");
  });

  it("irmão sem n suficiente na data → não conta como piso (nunca compara contra um irmão que também não passaria no próprio guardrail)", () => {
    const history = [
      sample(GOOGLE, "2026-09-01", 20, 50),
      sample(MICROSOFT, "2026-09-01", 5, 1), // leitores < minLeitores — desqualificado
      sample(META, "2026-09-01", 20, 30), // único elegível
    ];
    const floor = computeCrossArmFloor(history, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(floor, 30, "deveria ignorar o Microsoft (n insuficiente) e usar só o Meta");
  });

  it("nenhum irmão elegível na data → cross-arm-degradation nunca avalia (null), não é 'ok' por vácuo", () => {
    const history = [sample(GOOGLE, "2026-09-01", 20, 999)];
    const floor = computeCrossArmFloor(history, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(floor, null);
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.reasons.some((r) => r.kind === "cross-arm-degradation"), false);
  });

  it("as duas condições podem disparar JUNTAS (self + cross-arm), sem exclusão mútua", () => {
    const history = [
      sample(GOOGLE, "2026-08-29", 20, 10),
      sample(GOOGLE, "2026-08-30", 20, 10),
      sample(GOOGLE, "2026-09-01", 20, 100), // 10× a própria baseline
      sample(MICROSOFT, "2026-09-01", 20, 20),
      sample(META, "2026-09-01", 20, 25),
    ];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.triggered, true);
    assert.equal(ev.reasons.length, 2);
    assert.deepEqual(
      ev.reasons.map((r) => r.kind).sort(),
      ["cross-arm-degradation", "self-degradation"],
    );
  });

  it("custo dentro do normal em ambas as dimensões → não dispara nada", () => {
    const history = [
      sample(GOOGLE, "2026-08-29", 20, 10),
      sample(GOOGLE, "2026-08-30", 20, 11),
      sample(GOOGLE, "2026-09-01", 20, 12),
      sample(MICROSOFT, "2026-09-01", 20, 11),
      sample(META, "2026-09-01", 20, 13),
    ];
    const ev = evaluateArmKillSwitch(history, GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);
    assert.equal(ev.evaluated, true);
    assert.equal(ev.triggered, false);
    assert.deepEqual(ev.reasons, []);
  });
});

describe("#5239 — ads-kill-switch: evaluateKillSwitchRound (rodada inteira, 3 braços)", () => {
  it("avalia cada braço vendo os OUTROS 2 como irmãos, nunca a si mesmo", () => {
    const history = [
      sample(GOOGLE, "2026-09-01", 20, 50),
      sample(MICROSOFT, "2026-09-01", 20, 20),
      sample(META, "2026-09-01", 20, 20),
    ];
    const evaluations = evaluateKillSwitchRound(history, BRACOS, "2026-09-01", D0, G);
    assert.equal(evaluations.length, 3);
    const googleEval = evaluations.find((e) => e.braco === GOOGLE)!;
    assert.equal(googleEval.triggered, true); // 50 > 2×20
    const microsoftEval = evaluations.find((e) => e.braco === MICROSOFT)!;
    assert.equal(microsoftEval.triggered, false); // 20 vs. menor dos irmãos (Meta=20, Google=50) -> min=20, 20 não é > 2×20
  });
});

describe("#5239 — ads-kill-switch: buildArmCostSamplesFromRows (adaptador de CSV)", () => {
  it("linha com leitoresAcumulado válido (>0) vira amostra, custoPorLeitor derivado corretamente", () => {
    const samples = buildArmCostSamplesFromRows([
      { canal: GOOGLE, data_apuracao: "2026-09-01", gasto_acumulado: 500, leitoresAcumulado: 25 },
    ]);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].leitores, 25);
    assert.equal(samples[0].custoPorLeitor, 20);
  });

  it("leitoresAcumulado ausente (undefined) → linha NUNCA vira amostra (editor ainda não reconciliou)", () => {
    const samples = buildArmCostSamplesFromRows([{ canal: GOOGLE, data_apuracao: "2026-09-01", gasto_acumulado: 500 }]);
    assert.deepEqual(samples, []);
  });

  it("leitoresAcumulado null → linha NUNCA vira amostra", () => {
    const samples = buildArmCostSamplesFromRows([
      { canal: GOOGLE, data_apuracao: "2026-09-01", gasto_acumulado: 500, leitoresAcumulado: null },
    ]);
    assert.deepEqual(samples, []);
  });

  it("leitoresAcumulado === 0 → linha NUNCA vira amostra (custo por leitor seria infinito/indefinido)", () => {
    const samples = buildArmCostSamplesFromRows([
      { canal: GOOGLE, data_apuracao: "2026-09-01", gasto_acumulado: 500, leitoresAcumulado: 0 },
    ]);
    assert.deepEqual(samples, []);
  });
});

describe("#5239 — ads-kill-switch: notWiredPauseExecutor NUNCA toca API real (LIMITE DURO)", () => {
  it("sempre devolve ok:false, com detalhe explicando a ação manual necessária", async () => {
    const ev = evaluateArmKillSwitch(
      [sample(GOOGLE, "2026-09-01", 20, 999)],
      GOOGLE,
      "2026-09-01",
      [MICROSOFT, META],
      D0,
      G,
    );
    const result = await notWiredPauseExecutor(GOOGLE, ev);
    assert.equal(result.ok, false);
    assert.match(result.detail, /ação manual/);
    assert.match(result.detail, /nunca uma chamada automática/);
  });
});

describe("#5239 — ads-kill-switch: PauseEvent — evento registrado, nunca ajuste de lance", () => {
  const ev = evaluateArmKillSwitch([sample(GOOGLE, "2026-09-01", 20, 999)], GOOGLE, "2026-09-01", [MICROSOFT, META], D0, G);

  it("recordSkippedPauseEvent → executionAttempted:false, executionOk:null", () => {
    const event = recordSkippedPauseEvent(ev, "2026-09-01T10:00:00.000Z");
    assert.equal(event.braco, GOOGLE);
    assert.equal(event.date, "2026-09-01");
    assert.equal(event.executionAttempted, false);
    assert.equal(event.executionOk, null);
    assert.equal(event.executionDetail, null);
  });

  it("recordAttemptedPauseEvent → carrega o resultado do executor", () => {
    const event = recordAttemptedPauseEvent(ev, "2026-09-01T10:00:00.000Z", { ok: false, detail: "não wired" });
    assert.equal(event.executionAttempted, true);
    assert.equal(event.executionOk, false);
    assert.equal(event.executionDetail, "não wired");
  });
});

describe("#5239 — ads-kill-switch: buildKillSwitchAlarmEmail", () => {
  it("e-mail cita todos os braços disparados + explicita se a pausa automática está ligada/desligada", () => {
    const evaluations = evaluateKillSwitchRound(
      [
        sample(GOOGLE, "2026-09-01", 20, 50),
        sample(MICROSOFT, "2026-09-01", 20, 20),
        sample(META, "2026-09-01", 20, 20),
      ],
      BRACOS,
      "2026-09-01",
      D0,
      G,
    );
    const offEmail = buildKillSwitchAlarmEmail(evaluations, false);
    assert.match(offEmail.subject, new RegExp(GOOGLE.replace(/[()]/g, "\\$&")));
    assert.match(offEmail.body, /DESLIGADO/);
    assert.match(offEmail.body, /Nenhuma chamada automática/);

    const onEmail = buildKillSwitchAlarmEmail(evaluations, true);
    // Regex com "está " antes de "LIGADO" — "DESLIGADO" também contém a
    // substring "LIGADO" sozinha, então checar só "/LIGADO/" não
    // distinguiria os dois casos (falso-positivo se os textos fossem
    // trocados por engano).
    assert.match(onEmail.body, /está LIGADO/);
    assert.doesNotMatch(onEmail.body, /DESLIGADO/);
  });
});
