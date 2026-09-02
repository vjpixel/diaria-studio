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
  it("sem startedAt em TODAS, não desduplica por CHRONOLOGIA — mantém o grupo inteiro quando nenhuma é CANCELLED", () => {
    // Expectativa MUDADA após o review (achado alta/P1). A versão anterior
    // desempatava por posição, o que descarta um check real por palpite.
    // (FAILURE vs SUCCESS: nenhuma das duas é categoricamente descartável —
    // precisa de timestamp pra provar quem supersede quem, e não há.)
    const r = keepLatestPerName([
      { name: "x", conclusion: "FAILURE", status: "COMPLETED" },
      { name: "x", conclusion: "SUCCESS", status: "COMPLETED" },
    ]);
    assert.equal(r.length, 2, "sem timestamp não há como provar quem supersede quem");
  });

  it("CANCELLED vs SUCCESS sem startedAt em nenhuma: desduplica MESMO ASSIM (#6766) — não é uma decisão cronológica", () => {
    // Diferente do caso acima: quando uma das entradas é CANCELLED e a outra
    // não, não precisa de timestamp pra saber qual descartar — é uma regra
    // categórica (`dropSupersededCancelled`, roda ANTES da comparação por
    // horário), não uma disputa de "qual é mais nova". Ver #6766: o próprio
    // bug original mostrou que comparar por `startedAt` entre um CANCELLED e
    // uma run genuína é enganoso mesmo QUANDO o timestamp existe — então não
    // ter timestamp nenhum não é motivo pra manter o CANCELLED.
    const r = keepLatestPerName([
      { name: "x", conclusion: "CANCELLED", status: "COMPLETED" },
      { name: "x", conclusion: "SUCCESS", status: "COMPLETED" },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].conclusion, "SUCCESS");
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

// #6766 (rodada overnight 260829b) — payload real medido no PR #6764: um
// evento `labeled` pós-`gh run rerun` disparou um 2º run separado, cancelado
// pelo `concurrency`, cujas entradas têm `startedAt` MAIS TARDE que as do run
// que de fato passou — `keepLatestPerName` por timestamp escolhia a
// `CANCELLED` errada e o gate reportava `fail` com CI genuinamente verde.
describe("evaluatePrChecksGate — #6766: CANCELLED de run superseded não reprova quando startedAt engana", () => {
  it("CANCELLED com startedAt MAIS TARDE que o SUCCESS ainda assim não reprova (payload real do PR #6764)", () => {
    // "Unused code check" no PR #6764: o run cancelado (evento `labeled`)
    // começou às 00:54:58 — depois do job do run que passou, que começou às
    // 00:52:17 e concluiu SUCCESS às 00:52:43. Timestamp puro escolheria o
    // CANCELLED (mais recente por startedAt) — o bug exato da issue.
    const r = evaluatePrChecksGate([
      {
        name: "Unused code check",
        status: "COMPLETED",
        conclusion: "CANCELLED",
        startedAt: "2026-08-30T00:54:58Z",
      },
      {
        name: "Unused code check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-30T00:52:17Z",
      },
    ]);
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.failingChecks, []);
  });

  it("mesmo cenário mas a substituta é FAILURE (não SUCCESS) — CANCELLED ainda é descartado, mas o gate reprova pela FAILURE real", () => {
    const r = evaluatePrChecksGate([
      { name: "tests", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-30T00:54:58Z" },
      { name: "tests", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-08-30T00:52:17Z" },
    ]);
    assert.equal(r.verdict, "fail");
    assert.deepEqual(r.failingChecks, ["tests"]);
  });

  it("CANCELLED com substituta ainda EM ANDAMENTO (sem conclusion) vira pending, não fail", () => {
    const r = evaluatePrChecksGate([
      { name: "slow-job", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-30T00:54:58Z" },
      { name: "slow-job", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-08-30T00:55:10Z" },
    ]);
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.pendingChecks, ["slow-job"]);
  });

  it("CANCELLED sozinho (sem substituta) continua reprovando — regra pré-existente preservada", () => {
    const r = evaluatePrChecksGate([
      { name: "knip", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-30T00:54:58Z" },
    ]);
    assert.equal(r.verdict, "fail");
  });

  it("múltiplos checks do payload real do PR #6764 — todos passam mesmo com CANCELLED intercalado", () => {
    const rollupReal = [
      { name: "Unused code check", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-30T00:54:58Z" },
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-30T00:52:16Z" },
      { name: "Unused code check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-30T00:52:17Z" },
      { name: "Static invariants check", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-08-30T00:54:58Z" },
      { name: "Static invariants check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-08-30T00:52:17Z" },
      {
        name: "Regression test gate",
        status: "COMPLETED",
        conclusion: "CANCELLED",
        startedAt: "2026-08-30T00:54:57Z",
      },
      {
        name: "Regression test gate",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-30T00:55:10Z",
      },
    ];
    const r = evaluatePrChecksGate(rollupReal);
    assert.equal(r.verdict, "pass", r.reason);
  });
});

// #6768 (rodada overnight 260829b) — PR #6765: branch virou CONFLICTING
// depois do merge de outros PRs da mesma onda; o GitHub nunca disparou
// `pull_request` pra esse SHA (não computa merge ref com conflito), então o
// check-suite ficou `queued` pra sempre sem nunca virar `workflow_run`.
describe("evaluatePrChecksGate — #6768: CONFLICTING sem check nenhum vira blocked_by_conflict, não pending genérico", () => {
  it("statusCheckRollup vazio + mergeable CONFLICTING => 'blocked_by_conflict'", () => {
    const r = evaluatePrChecksGate([], { mergeable: "CONFLICTING" });
    assert.equal(r.verdict, "blocked_by_conflict");
    assert.match(r.reason, /CONFLICTING/);
  });

  it("todos os checks QUEUED (sem startedAt) + mergeable CONFLICTING => 'blocked_by_conflict'", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "QUEUED", conclusion: null }], {
      mergeable: "CONFLICTING",
    });
    assert.equal(r.verdict, "blocked_by_conflict");
  });

  it("statusCheckRollup vazio SEM mergeable informado continua 'pending' (comportamento pré-#6768 preservado)", () => {
    const r = evaluatePrChecksGate([]);
    assert.equal(r.verdict, "pending");
  });

  it("statusCheckRollup vazio + mergeable MERGEABLE continua 'pending', nunca blocked_by_conflict", () => {
    const r = evaluatePrChecksGate([], { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
  });

  it("statusCheckRollup vazio + mergeable UNKNOWN continua 'pending' — só CONFLICTING dispara o veredito novo", () => {
    const r = evaluatePrChecksGate([], { mergeable: "UNKNOWN" });
    assert.equal(r.verdict, "pending");
  });

  it("checks JÁ começaram (têm startedAt) + mergeable CONFLICTING não dispara blocked_by_conflict — CI já está rodando de verdade", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-08-30T00:00:00Z" }], {
      mergeable: "CONFLICTING",
    });
    assert.equal(r.verdict, "pending");
    assert.notEqual(r.verdict, "blocked_by_conflict");
  });

  it("isPrChecksGateGreen(blocked_by_conflict) é sempre false", () => {
    const r = evaluatePrChecksGate([], { mergeable: "CONFLICTING" });
    assert.equal(isPrChecksGateGreen(r), false);
  });

  // Achados P1 do self-review do PR #6770: `nenhumComecou` calculado só por
  // `startedAt` ausente confundia "não começou" com "já resolveu, mas o
  // shape/payload não carrega startedAt". Nenhum destes pode virar
  // `blocked_by_conflict` — todos já têm sinal real de CI.
  it("StatusContext já FAILURE + mergeable CONFLICTING => 'fail', nunca 'blocked_by_conflict' (StatusContext nunca tem startedAt)", () => {
    const r = evaluatePrChecksGate([{ name: "vercel", state: "FAILURE" }], { mergeable: "CONFLICTING" });
    assert.equal(r.verdict, "fail");
    assert.notEqual(r.verdict, "blocked_by_conflict");
  });

  it("StatusContext já SUCCESS + mergeable CONFLICTING => 'pass', nunca 'blocked_by_conflict'", () => {
    const r = evaluatePrChecksGate([{ name: "vercel", state: "SUCCESS" }], { mergeable: "CONFLICTING" });
    assert.equal(r.verdict, "pass");
  });

  it("CheckRun COMPLETED sem `startedAt` no payload (parcial) + mergeable CONFLICTING => decide pelo conclusion, nunca 'blocked_by_conflict'", () => {
    const semStartedAt = { name: "ci", status: "COMPLETED", conclusion: "FAILURE" } as PrCheckNode;
    const r = evaluatePrChecksGate([semStartedAt], { mergeable: "CONFLICTING" });
    assert.equal(r.verdict, "fail");
    assert.notEqual(r.verdict, "blocked_by_conflict");
  });

  it("CANCELLED + SUCCESS sobrevivente, NENHUM com startedAt, + mergeable CONFLICTING => resolve pelo sobrevivente ('pass'), não 'blocked_by_conflict' (interação #6766×#6768)", () => {
    // O sobrevivente pós-dedup é COMPLETED/SUCCESS — já é sinal de que o
    // pull_request rodou, então blocked_by_conflict nunca devia disparar
    // aqui, mesmo que nenhuma entrada carregue startedAt.
    const r = evaluatePrChecksGate(
      [
        { name: "x", status: "COMPLETED", conclusion: "CANCELLED" },
        { name: "x", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      { mergeable: "CONFLICTING" },
    );
    assert.equal(r.verdict, "pass");
  });

  it("1 check pendente sem sinal nenhum + 1 check já COMPLETED (não empurrado a nenhum array) + CONFLICTING => 'pending', não 'blocked_by_conflict' (qualquer sinal real desarma o veredito)", () => {
    const r = evaluatePrChecksGate(
      [
        { name: "ci-a", status: "QUEUED", conclusion: null },
        { name: "ci-b", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      { mergeable: "CONFLICTING" },
    );
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.pendingChecks, ["ci-a"]);
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

describe("evaluatePrChecksGate — regressão #7060: janela de corrida (merge ref ainda não recalculado)", () => {
  const HEAD_PUSHED_AT = "2026-09-02T02:13:53Z";
  // Mesmo gap medido ao vivo na issue: 7s entre o push e o run.
  const RUN_STARTED_RACE = "2026-09-02T02:14:00Z";
  // Bem fora da janela default (20s) — 5min depois do push, caso normal.
  const RUN_STARTED_SAFE = "2026-09-02T02:18:53Z";

  it("check FAILURE que começou 7s após o push do HEAD => 'pending', nunca 'fail' (o caso medido ao vivo)", () => {
    const r = evaluatePrChecksGate(
      [{ name: "workers-observability-guard", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_RACE }],
      { headCommittedAt: HEAD_PUSHED_AT },
    );
    assert.equal(r.verdict, "pending");
    assert.match(r.reason, /corrida/);
    assert.deepEqual(r.pendingChecks, ["workers-observability-guard"]);
    assert.deepEqual(r.failingChecks, [], "dentro da janela, nunca reporta como falha — nem em failingChecks");
  });

  it("check SUCCESS que começou 7s após o push do HEAD => 'pending', nunca 'pass' (falso-verde é o outro lado do mesmo defeito)", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED_RACE }], {
      headCommittedAt: HEAD_PUSHED_AT,
    });
    assert.equal(r.verdict, "pending");
    assert.match(r.reason, /corrida/);
  });

  it("check FAILURE que começou 5min após o push do HEAD => 'fail' normalmente (fora da janela, comportamento pré-#7060)", () => {
    const r = evaluatePrChecksGate(
      [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_SAFE }],
      { headCommittedAt: HEAD_PUSHED_AT },
    );
    assert.equal(r.verdict, "fail");
  });

  it("check SUCCESS que começou 5min após o push do HEAD => 'pass' normalmente (fora da janela)", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED_SAFE }], {
      headCommittedAt: HEAD_PUSHED_AT,
    });
    assert.equal(r.verdict, "pass");
  });

  it("sem headCommittedAt (chamador antigo — merge-train-live.ts, testes existentes): nenhuma mudança, mesmo dentro do que seria a janela", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_RACE }]);
    assert.equal(r.verdict, "fail", "sem headCommittedAt a heurística nunca ativa — comportamento idêntico ao pré-#7060");
  });

  it("headCommittedAt presente mas nenhum check tem startedAt utilizável => sem dado pra julgar, comportamento normal preservado", () => {
    const semStartedAt = { name: "ci", status: "COMPLETED", conclusion: "FAILURE" };
    const r = evaluatePrChecksGate([semStartedAt], { headCommittedAt: HEAD_PUSHED_AT });
    assert.equal(r.verdict, "fail", "sem startedAt em NENHUM check, nunca há como comparar — nunca fica mais rígido que antes");
  });

  it("headCommittedAt inválido (string não-parseável) => heurística não ativa, nunca lança", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_RACE }], {
      headCommittedAt: "não é uma data",
    });
    assert.equal(r.verdict, "fail");
  });

  it("raceWindowMs customizado sobrescreve o default — janela maior pega um gap que o default deixaria passar", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_SAFE }], {
      headCommittedAt: HEAD_PUSHED_AT,
      raceWindowMs: 10 * 60 * 1000, // 10min — cobre o gap de 5min do fixture "SAFE"
    });
    assert.equal(r.verdict, "pending");
  });

  it("lote com 1 check dentro da janela e 1 fora => ainda conservador (usa o MAIS ANTIGO startedAt do grupo)", () => {
    const r = evaluatePrChecksGate(
      [
        { name: "rapido-suspeito", status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED_RACE },
        { name: "lento-normal", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED_SAFE },
      ],
      { headCommittedAt: HEAD_PUSHED_AT },
    );
    // O check que já reprovou (lento-normal) está fora da janela — mas o
    // mais antigo do grupo (rapido-suspeito) está dentro, então o veredito
    // inteiro (que já seria "fail" por causa de lento-normal) vira pending.
    assert.equal(r.verdict, "pending");
  });

  it("isPrChecksGateGreen nunca é true dentro da janela de corrida", () => {
    const r = evaluatePrChecksGate([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED_RACE }], {
      headCommittedAt: HEAD_PUSHED_AT,
    });
    assert.equal(isPrChecksGateGreen(r), false);
  });
});
