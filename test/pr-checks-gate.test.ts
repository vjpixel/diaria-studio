/**
 * test/pr-checks-gate.test.ts (#6225)
 *
 * Cobre `scripts/lib/pr-checks-gate.ts` — a lógica pura da condição 1 do
 * gate de merge autônomo. O I/O (`gh pr view`) fica no entrypoint
 * `scripts/check-pr-checks-gate.ts`, testado aqui só via a função pura que
 * ele orquestra (mesmo padrão de `test/trade-off-label-gate.test.ts` pro
 * gate irmão).
 *
 * O caso que mais importa (regressão #6225): um payload malformado —
 * `statusCheckRollup` ausente, não-array, `null`, etc — que representa
 * "o comando/parse falhou" **nunca** pode produzir `verdict: "pass"`. É
 * exatamente esse modo de falha (comando quebrado lido como "0 checks
 * reprovados") que causou o achado original com `gh pr checks --json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePrChecksGate,
  isPrChecksGateGreen,
  keepLatestPerName,
  type PrCheckNode,
} from "../scripts/lib/pr-checks-gate.ts";

function check(name: string, status: string, conclusion: string | null): PrCheckNode {
  return { name, status, conclusion };
}

describe("evaluatePrChecksGate — regressão #6225: erro nunca vira pass", () => {
  it("statusCheckRollup undefined (payload sem o campo) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate(undefined);
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup null => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate(null);
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup não é array (string, JSON parcial/garbled) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate("unknown flag: --json");
    assert.equal(result.verdict, "error");
    assert.equal(isPrChecksGateGreen(result), false);
  });

  it("statusCheckRollup é um objeto (não array) => 'error', nunca 'pass'", () => {
    const result = evaluatePrChecksGate({ bucket: "pass" });
    assert.equal(result.verdict, "error");
  });
});

describe("evaluatePrChecksGate — array vazio é 'pending', não 'pass' por ausência", () => {
  it("nenhum check registrado ainda => 'pending' (não é aprovação por vazio)", () => {
    const result = evaluatePrChecksGate([]);
    assert.equal(result.verdict, "pending");
    assert.equal(isPrChecksGateGreen(result), false);
  });
});

describe("evaluatePrChecksGate — caminho feliz", () => {
  it("todos os checks COMPLETED + SUCCESS => 'pass'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("lint", "COMPLETED", "SUCCESS"),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(isPrChecksGateGreen(result), true);
    assert.deepEqual(result.failingChecks, []);
    assert.deepEqual(result.pendingChecks, []);
  });

  it("mistura de SUCCESS/NEUTRAL/SKIPPED, todos COMPLETED => 'pass'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("codeql", "COMPLETED", "NEUTRAL"),
      check("optional-job", "COMPLETED", "SKIPPED"),
    ]);
    assert.equal(result.verdict, "pass");
  });
});

describe("evaluatePrChecksGate — check em andamento (o guard que a issue pede explicitamente)", () => {
  it("check COMPLETED com conclusion null nunca aparece isolado — mas status != COMPLETED com conclusion null => 'pending', não 'fail'", () => {
    // Check em andamento: status ainda não é COMPLETED, conclusion ainda não existe.
    // Contar isso como 'fail' classificaria "rodando" como reprovado — o bug que a issue pede pra evitar.
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("slow-job", "IN_PROGRESS", null),
    ]);
    assert.equal(result.verdict, "pending");
    assert.deepEqual(result.pendingChecks, ["slow-job"]);
    assert.deepEqual(result.failingChecks, []);
  });

  it("check QUEUED (nem começou) => 'pending'", () => {
    const result = evaluatePrChecksGate([check("ci", "QUEUED", null)]);
    assert.equal(result.verdict, "pending");
  });
});

describe("evaluatePrChecksGate — check completou falhando (o outro guard que a issue pede)", () => {
  it("check COMPLETED com conclusion FAILURE => 'fail', não 'pending'", () => {
    // Contar só status==COMPLETED como sinal de aprovação deixaria passar um check
    // que completou FALHANDO — a issue pede explicitamente pra não deixar isso passar.
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "SUCCESS"),
      check("tests", "COMPLETED", "FAILURE"),
    ]);
    assert.equal(result.verdict, "fail");
    assert.deepEqual(result.failingChecks, ["tests"]);
  });

  it("conclusion CANCELLED/TIMED_OUT/ACTION_REQUIRED/STALE => 'fail'", () => {
    for (const conclusion of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]) {
      const result = evaluatePrChecksGate([check("job", "COMPLETED", conclusion)]);
      assert.equal(result.verdict, "fail", `conclusion ${conclusion} devia reprovar`);
    }
  });

  it("um check falhando entre vários pendentes => 'fail' tem precedência sobre 'pending'", () => {
    const result = evaluatePrChecksGate([
      check("ci", "COMPLETED", "FAILURE"),
      check("slow-job", "IN_PROGRESS", null),
    ]);
    assert.equal(result.verdict, "fail");
    assert.deepEqual(result.failingChecks, ["ci"]);
  });
});

describe("evaluatePrChecksGate — nós malformados dentro do array não quebram nem viram pass silencioso", () => {
  it("elemento null dentro do array => 'error' (payload malformado), nunca crash e nunca pass", () => {
    // Expectativa MUDADA na revisão da rodada overnight 260826, de 'pending'
    // pra 'error'. Os dois são fail-safe (nenhum é `pass`), então a mudança
    // não afrouxa nada — mas 'error' é mais preciso e mais útil: um elemento
    // `null` é payload MALFORMADO, exatamente o que o guard do topo desta
    // mesma função já classifica como 'error'. Tratá-lo como 'pending'
    // deixava o gate travado em pendente para sempre sem dizer por quê, que é
    // o modo de falha silencioso que a #6225 existe pra eliminar.
    const result = evaluatePrChecksGate([check("ci", "COMPLETED", "SUCCESS"), null]);
    assert.equal(result.verdict, "error");
    assert.notEqual(result.verdict, "pass");
  });
});

// Finding do self-review do PR #6231, endereçado na revisão da rodada
// overnight 260826: `statusCheckRollup` é uma union GraphQL
// `CheckRun | StatusContext`, e só o 1º membro tem `status`/`conclusion`.
describe("evaluatePrChecksGate — StatusContext (commit-status legada), o 2º membro da union", () => {
  it("state SUCCESS conta como aprovado", () => {
    const r = evaluatePrChecksGate([{ name: "vercel", state: "SUCCESS" }]);
    assert.equal(r.verdict, "pass");
  });

  it("state FAILURE reprova — nunca passa por não ter `conclusion`", () => {
    const r = evaluatePrChecksGate([{ name: "vercel", state: "FAILURE" }]);
    assert.equal(r.verdict, "fail");
    assert.deepEqual(r.failingChecks, ["vercel"]);
  });

  it("state ERROR reprova (não está em PASSING_STATES nem em PENDING_STATES)", () => {
    assert.equal(evaluatePrChecksGate([{ name: "ci-externo", state: "ERROR" }]).verdict, "fail");
  });

  it("state PENDING/EXPECTED viram pending, não fail", () => {
    assert.equal(evaluatePrChecksGate([{ name: "x", state: "PENDING" }]).verdict, "pending");
    assert.equal(evaluatePrChecksGate([{ name: "x", state: "EXPECTED" }]).verdict, "pending");
  });

  it("CheckRun e StatusContext convivem no mesmo rollup", () => {
    const r = evaluatePrChecksGate([
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "deploy", state: "FAILURE" },
    ]);
    assert.equal(r.verdict, "fail");
    assert.deepEqual(r.failingChecks, ["deploy"]);
  });

  it("shape desconhecido vira ERROR, não pending — pendente-pra-sempre seria silencioso", () => {
    // O ponto do fix: antes, um node sem `status` caía em `pending` e o gate
    // travava para sempre sem dizer por quê. Fail-safe, mas mudo — e mudo é
    // exatamente o modo de falha que a #6225 existe pra eliminar.
    const r = evaluatePrChecksGate([{ name: "coisa-nova" } as never]);
    assert.equal(r.verdict, "error");
    assert.match(r.reason, /shape desconhecido/);
  });

  it("shape desconhecido NUNCA vira pass, mesmo com todos os outros verdes", () => {
    const r = evaluatePrChecksGate([
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "misterio" } as never,
    ]);
    assert.notEqual(r.verdict, "pass");
    assert.equal(r.verdict, "error");
  });
});

// #6239 (rodada overnight 260826) — medido ao vivo: um force-push deixa a run
// antiga no rollup como CANCELLED, ao lado da nova, com o MESMO name.
describe("evaluatePrChecksGate — run supersedida por force-push", () => {
  const supersedido = [
    { name: "knip", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-26T11:49:01Z" },
    { name: "knip", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:35Z" },
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:35Z" },
  ];

  it("CANCELLED antigo não reprova quando existe run mais nova com o mesmo nome", () => {
    // Sem a dedup isto era `fail` — falso-vermelho que travava merge legítimo
    // pra sempre, porque a entrada cancelada nunca sai do rollup.
    assert.equal(evaluatePrChecksGate(supersedido).verdict, "pass");
  });

  it("a run VIGENTE continua mandando: se a mais nova falhou, reprova", () => {
    const novaFalhou = [
      { name: "knip", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
      { name: "knip", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-08-26T11:49:35Z" },
    ];
    const r = evaluatePrChecksGate(novaFalhou);
    assert.equal(r.verdict, "fail");
    assert.deepEqual(r.failingChecks, ["knip"]);
  });

  it("a mais nova ainda rodando => pending, mesmo com a antiga verde", () => {
    const novaRodando = [
      { name: "knip", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
      { name: "knip", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-08-26T11:49:35Z" },
    ];
    assert.equal(evaluatePrChecksGate(novaRodando).verdict, "pending");
  });

  it("CANCELLED SEM run mais nova continua reprovando (cancelamento humano)", () => {
    // A dedup não pode virar 'ignore CANCELLED': sem substituta, um check
    // cancelado é ausência de sinal, e ausência de sinal nunca é aprovação.
    const canceladoSozinho = [{ name: "knip", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-26T11:49:01Z" }];
    assert.equal(evaluatePrChecksGate(canceladoSozinho).verdict, "fail");
  });
});

describe("keepLatestPerName", () => {
  it("sem startedAt em TODAS, não desduplica — mantém o grupo inteiro", () => {
    // Expectativa MUDADA após o review (achado alta/P1). A versão anterior
    // desempatava por posição, o que descarta um check real por palpite.
    const r = keepLatestPerName([
      { name: "x", conclusion: "CANCELLED", status: "COMPLETED" },
      { name: "x", conclusion: "SUCCESS", status: "COMPLETED" },
    ]);
    assert.equal(r.length, 2, "sem timestamp não há como provar quem supersede quem");
  });

  it("node sem name não é desduplicável e passa inteiro", () => {
    const r = keepLatestPerName([{ conclusion: "SUCCESS", status: "COMPLETED" }, { conclusion: "FAILURE", status: "COMPLETED" }]);
    assert.equal(r.length, 2);
  });

  it("nomes distintos não se desduplicam entre si", () => {
    const r = keepLatestPerName([
      { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "b", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    assert.equal(r.length, 2);
  });
});

// Achado do review do PR #6240 (confiança alta, P1) — o caso MISTO, que a 1ª
// versão do fix errava e nenhum teste cobria.
describe("keepLatestPerName — timestamp MISTO nunca produz falso-verde", () => {
  it("FAILURE novo SEM startedAt não é descartado por SUCCESS antigo COM startedAt", () => {
    // Era o bug: `""` (ausente) perdia sempre na comparação de string, então o
    // FAILURE sumia do rollup avaliado e o gate devolvia `pass`.
    const misto = [
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
      { name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const r = evaluatePrChecksGate(misto);
    assert.notEqual(r.verdict, "pass", "check reprovado NUNCA pode sumir da avaliação");
    assert.equal(r.verdict, "fail");
  });

  it("a ordem inversa também reprova (não é sensível a posição)", () => {
    const misto = [
      { name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
    ];
    assert.equal(evaluatePrChecksGate(misto).verdict, "fail");
  });

  it("placeholder 0001-01-01 não conta como timestamp válido", () => {
    // Se contasse, viraria o "mais antigo" de qualquer grupo — uma afirmação
    // que o payload não fez. O GitHub emite esse placeholder em completedAt de
    // run em andamento; assumir que nunca aparece em startedAt seria aposta.
    const r = evaluatePrChecksGate([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
      { name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "0001-01-01T00:00:00Z" },
    ]);
    assert.equal(r.verdict, "fail");
  });

  it("startedAt não-parseável também não desduplica", () => {
    const r = evaluatePrChecksGate([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:01Z" },
      { name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "ontem de manhã" },
    ]);
    assert.equal(r.verdict, "fail");
  });

  it("com timestamp válido nos DOIS, a dedup legítima do force-push segue funcionando", () => {
    const r = evaluatePrChecksGate([
      { name: "ci", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-26T11:49:01Z" },
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:35Z" },
    ]);
    assert.equal(r.verdict, "pass");
  });
});

describe("mensagem de pass não conta entradas supersedidas", () => {
  it("diz quantas são VIGENTES e quantas foram ignoradas", () => {
    // Antes dizia "11 check(s), todos concluídos com sucesso" para um rollup
    // com 5 CANCELLED dentro — veredito certo, frase falsa.
    const r = evaluatePrChecksGate([
      { name: "a", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-26T11:49:01Z" },
      { name: "a", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:35Z" },
      { name: "b", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-26T11:49:35Z" },
    ]);
    assert.equal(r.verdict, "pass");
    assert.match(r.reason, /2 check\(s\) vigente/);
    assert.match(r.reason, /1 entrada\(s\) de run supersedida/);
  });

  it("sem supersedidas, a frase antiga (mais curta) permanece", () => {
    const r = evaluatePrChecksGate([{ name: "a", status: "COMPLETED", conclusion: "SUCCESS" }]);
    assert.equal(r.reason, "1 check(s), todos concluídos com sucesso.");
  });
});
