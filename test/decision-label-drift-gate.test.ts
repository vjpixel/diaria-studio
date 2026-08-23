/**
 * decision-label-drift-gate.test.ts (#5955)
 *
 * Trava a orquestração do gate — escopo, corte por track, decisão de buscar
 * comentários. Extraída pra `lib/` a pedido do review da PR #5958: até então
 * essa lógica vivia no `main()` do script e nada em CI a cobria, sendo a
 * parte do diff mais propensa a regredir em silêncio (decisão errada aqui não
 * falha, só deixa de reportar).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGateEvaluations,
  planTextsFor,
  type GatePlanIssue,
  type GateOpenIssue,
} from "../scripts/lib/decision-label-drift-gate.ts";

const AGORA = new Date("2026-08-23T12:00:00Z");
const aberta = (number: number, labels: string[], body?: string): GateOpenIssue => ({
  number,
  labels,
  body,
});

describe("planTextsFor", () => {
  it("junta motivo e scope_note, ignorando vazios e whitespace", () => {
    assert.deepEqual(planTextsFor({ number: 1, motivo: "m", scope_note: "s" }), ["m", "s"]);
    assert.deepEqual(planTextsFor({ number: 1, motivo: "m" }), ["m"]);
    assert.deepEqual(planTextsFor({ number: 1, motivo: "   ", scope_note: "" }), []);
    assert.deepEqual(planTextsFor({ number: 1 }), []);
  });
});

describe("buildGateEvaluations — escopo", () => {
  it("ignora issue aberta que não está no plano da rodada", () => {
    const evals = buildGateEvaluations(
      [{ number: 1, motivo: "m" }],
      [aberta(1, ["P2"]), aberta(2, ["P2"])],
      AGORA,
    );
    assert.deepEqual(evals.map((e) => e.issueNumber), [1]);
  });

  it("ignora issue do plano que não está aberta (fechada entre o plano e o gate)", () => {
    const evals = buildGateEvaluations(
      [{ number: 1, motivo: "m" }, { number: 99, motivo: "m" }],
      [aberta(1, ["P2"])],
      AGORA,
    );
    assert.deepEqual(evals.map((e) => e.issueNumber), [1]);
  });
});

describe("buildGateEvaluations — corte por track (#5955)", () => {
  it("mantém issue que ainda classifica overnight", () => {
    const evals = buildGateEvaluations([{ number: 1, motivo: "m" }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals.length, 1);
    assert.equal(evals[0].currentTrack, "overnight");
  });

  for (const [nome, labels, body] of [
    ["on-hold → fora-de-rodada", ["on-hold"], undefined],
    ["external-blocker → bloqueada", ["external-blocker"], undefined],
    ["develop-track → develop", ["develop-track"], undefined],
    ["windows → develop", ["windows"], undefined],
    ["aguardando-ate futuro → agendada", ["P2"], "<!-- aguardando-ate: 2099-01-01 -->"],
  ] as Array<[string, string[], string | undefined]>) {
    it(`descarta issue já roteada: ${nome}`, () => {
      const evals = buildGateEvaluations(
        [{ number: 1, motivo: "bloqueio-externo: aguardando terceiro" }],
        [aberta(1, labels, body)],
        AGORA,
      );
      assert.equal(evals.length, 0);
    });
  }

  it("marcador de data JÁ VENCIDO volta a ser avaliado", () => {
    // É exatamente a transição que despejou a #5140 de volta em `overnight`.
    const evals = buildGateEvaluations(
      [{ number: 5140, motivo: "m" }],
      [aberta(5140, ["P2"], "<!-- aguardando-ate: 2026-08-23 -->")],
      new Date("2026-08-23T12:00:00Z"),
    );
    assert.equal(evals.length, 1);
  });
});

describe("buildGateEvaluations — comentários e in_round", () => {
  it("in_round true busca comentários", () => {
    const evals = buildGateEvaluations([{ number: 1, in_round: true, motivo: "m" }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals[0].needsComments, true);
  });

  it("in_round false NÃO busca comentários, mas ainda avalia a prosa do plano", () => {
    // O ponto central da correção: `in_round: false` é a issue excluída antes
    // do despacho — a mais propensa a carregar veredito que nunca virou label.
    const evals = buildGateEvaluations([{ number: 1, in_round: false, motivo: "m" }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals.length, 1);
    assert.equal(evals[0].needsComments, false);
    assert.deepEqual(evals[0].planTexts, ["m"]);
  });

  it("in_round AUSENTE conta como true — fail-open do plan.json legado", () => {
    // A comparação estrita `=== true` divergia da convenção documentada na
    // SKILL ("Ausente em plan.json legado → true").
    const evals = buildGateEvaluations([{ number: 1, motivo: "m" }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals[0].needsComments, true);
  });

  it("in_round false sem prosa de plano é descartada — não há o que varrer", () => {
    const evals = buildGateEvaluations([{ number: 1, in_round: false }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals.length, 0);
  });

  it("in_round ausente sem prosa de plano ainda entra, pelos comentários", () => {
    const evals = buildGateEvaluations([{ number: 1 }], [aberta(1, ["P2"])], AGORA);
    assert.equal(evals.length, 1);
    assert.deepEqual(evals[0].planTexts, []);
  });
});

describe("buildGateEvaluations — plano real da rodada 260823", () => {
  it("a #5140 como estava de manhã entra; os 2 falsos positivos medidos não", () => {
    const plano: GatePlanIssue[] = [
      {
        number: 5140,
        in_round: true,
        motivo: "ja-implementada: Parte 2 já estava mergeada (PR #5142); Parte 1 segue bloqueada (execução ao vivo)",
        scope_note: "Parte 1 permanece bloqueada — exige rodar envio Clarice ao vivo, vedado pelo guard de publicação.",
      },
      { number: 4549, in_round: false, motivo: "bloqueio-externo: aguardando amostras físicas (terceiro)" },
      { number: 5917, in_round: false, motivo: "bloqueio-externo: aguardando reunião com Nexo Jornal" },
    ];
    const abertas: GateOpenIssue[] = [
      aberta(5140, ["enhancement", "P2"]),
      aberta(4549, ["enhancement", "P3", "external-blocker", "on-hold", "growth"]),
      aberta(5917, ["enhancement", "P2", "growth"], "<!-- aguardando-ate: 2099-01-01 -->"),
    ];
    const evals = buildGateEvaluations(plano, abertas, AGORA);
    assert.deepEqual(evals.map((e) => e.issueNumber), [5140]);
  });
});
