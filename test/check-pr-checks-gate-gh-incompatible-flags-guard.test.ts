/**
 * test/check-pr-checks-gate-gh-incompatible-flags-guard.test.ts (#8425)
 *
 * Regressão do achado ao vivo da issue: uma sessão peer no `300` ficou
 * travada 5h+ num `until gh pr checks {N} --json bucket --jq '...'; do
 * sleep 30; done` — o `gh` 2.46.0 instalado ali não suporta `--json` em
 * `gh pr checks` (#6225), o comando falha em silêncio, `grep -q true`
 * nunca casa, e o `until` repete PRA SEMPRE, mesmo com a PR já mergeada
 * horas antes.
 *
 * Este teste demonstra a parte NOVA (#8425, vs. #6225/#6937): um `gh` que
 * rejeita a flag/campo `--json` usado por `check-pr-checks-gate.ts` (`gh
 * pr view --json statusCheckRollup,mergeable,commits`) precisa terminar
 * com um veredito DEDICADO (`gh_incompatible_flags`) — nunca cair no
 * `"error"` genérico, cuja via de recuperação (`scripts/lib/wait-
 * pr-checks.sh`, retry até `MAX_ERROR_STREAK`) foi desenhada pra falha
 * TRANSITÓRIA (rate-limit, blip de rede), não pra uma incompatibilidade de
 * versão que falha do mesmo jeito em toda tentativa.
 *
 * Testa `resolveGateResult`, que é PURA (recebe o `spawnSync` já
 * executado) — nunca dispara um `gh` real nem toca rede/CI. O
 * comportamento do LAÇO de espera (`scripts/lib/wait-pr-checks.sh`)
 * abortar na 1ª ocorrência de rc=6, sem retentar, é coberto separadamente
 * em `scripts/lib/wait-pr-checks.test.sh` (bash, não Node — mesmo runner
 * de `scripts/lib/wait-pr-checks.test.sh` original do #6921/#6937).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGateResult, type GhPrViewSpawnOutcome } from "../scripts/check-pr-checks-gate.ts";

function spawnOutcome(partial: Partial<GhPrViewSpawnOutcome>): GhPrViewSpawnOutcome {
  return { error: undefined, status: 0, stdout: "", stderr: "", ...partial };
}

describe("resolveGateResult — regressão #8425: incompatibilidade de flag --json do gh nunca vira loop nem falso-veredito", () => {
  it("stderr com 'unknown flag: --json' (Cobra, gh pr checks em versão antiga) => verdict dedicado, nunca 'error' genérico", () => {
    const result = resolveGateResult(
      spawnOutcome({ status: 1, stdout: "", stderr: "unknown flag: --json\n\nUsage:  gh pr checks [<number> | <url> | <branch>] [flags]\n" }),
    );
    assert.equal(result.verdict, "gh_incompatible_flags");
    assert.match(result.reason, /#8425/);
    assert.match(result.reason, /stderr/);
    assert.deepEqual(result.failingChecks, []);
    assert.deepEqual(result.pendingChecks, []);
  });

  it("stdout/stderr com 'Unknown JSON field' (gh pr view --json com campo não suportado) => também dedicado", () => {
    const result = resolveGateResult(
      spawnOutcome({
        status: 1,
        stdout: "",
        stderr: 'Unknown JSON field: "commits"\nAvailable fields:\n  additions\n  assignees\n',
      }),
    );
    assert.equal(result.verdict, "gh_incompatible_flags");
    assert.match(result.reason, /não.*transitório|NÃO.*transitório/);
  });

  it("assinatura na mensagem de erro do próprio spawnSync (ex: gh reportou via exceção) => também dedicado", () => {
    const result = resolveGateResult(
      spawnOutcome({ error: new Error("unknown flag: --json"), status: null }),
    );
    assert.equal(result.verdict, "gh_incompatible_flags");
    assert.match(result.reason, /mensagem de erro do spawn/);
  });

  it("checagem de incompatibilidade vence mesmo com JSON válido concatenado — nunca tenta parsear no meio do texto de erro", () => {
    const result = resolveGateResult(
      spawnOutcome({
        status: 0,
        stdout: 'unknown flag: --json\n{"statusCheckRollup":[]}',
        stderr: "",
      }),
    );
    assert.equal(result.verdict, "gh_incompatible_flags");
  });

  it("checagem de incompatibilidade de --json roda ANTES da checagem de erro genérico de status != 0", () => {
    // Sem esta ordem, `result.status !== 0` capturaria o caso antes e
    // devolveria `"error"` genérico — que o chamador de espera (#6937)
    // trataria como TRANSITÓRIO e retentaria, exatamente o buraco que
    // esta issue existe pra fechar.
    const result = resolveGateResult(
      spawnOutcome({ status: 1, stdout: "", stderr: "unknown flag: --json" }),
    );
    assert.equal(result.verdict, "gh_incompatible_flags");
    assert.notEqual(result.verdict, "error");
  });

  it("checagem de assinatura do binário claude (#7189) continua vencendo sobre a de --json quando as duas coexistem hipoteticamente", () => {
    // Ordem de checagem documentada em resolveGateResult: binário claude
    // primeiro, --json em seguida. Corrupção de ambiente é uma classe
    // ainda mais básica de "isto não é um veredito real" — nunca deveria
    // ser mascarada por uma 2ª assinatura que aparecesse no mesmo texto.
    const result = resolveGateResult(
      spawnOutcome({
        status: 1,
        stdout: "",
        stderr: "claude native binary not installed\nunknown flag: --json",
      }),
    );
    assert.equal(result.verdict, "claude_binary_error");
  });

  it("payload normal SEM nenhuma assinatura continua caindo no caminho de veredito real (regressão de comportamento pré-#8425)", () => {
    const result = resolveGateResult(
      spawnOutcome({
        status: 0,
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
      }),
    );
    assert.equal(result.verdict, "pass");
  });

  it("erro genérico do gh SEM a assinatura de --json continua 'error' (rc=3), não é promovido a rc=6 por engano", () => {
    const result = resolveGateResult(
      spawnOutcome({ status: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest (repository.pullRequest)" }),
    );
    assert.equal(result.verdict, "error");
  });

  it("regressão rev.2 (self-trap do PR #8427): gh saudável + payload JSON válido cujo commits[].messageBody cita as assinaturas do detector NUNCA vira gh_incompatible_flags", () => {
    // `gh pr view --json statusCheckRollup,mergeable,commits` devolve o
    // corpo de cada commit do PR como DADO dentro de `commits`. Um PR cujo
    // próprio commit body discute (em prosa) as duas regexes que este
    // detector procura — como o PR que introduziu o detector, ou qualquer
    // PR futuro que corrija/discuta o mesmo achado — não pode fazer um
    // `gh` são e um payload válido serem lidos como incompatibilidade de
    // versão. O veredito precisa vir só do `statusCheckRollup` real.
    const payload = JSON.stringify({
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      mergeable: "MERGEABLE",
      commits: [
        {
          committedDate: "2026-09-19T00:00:00Z",
          messageBody:
            'O detector reconhece "unknown flag: --json" e "Unknown JSON field" no stdout/stderr do gh.',
        },
      ],
    });
    const result = resolveGateResult(spawnOutcome({ status: 0, stdout: payload, stderr: "" }));
    assert.equal(result.verdict, "pass");
    assert.notEqual(result.verdict, "gh_incompatible_flags");
  });

  it("regressão rev.2: mesmo payload citando a assinatura do binário claude (#7189) também não é promovido a claude_binary_error quando o gh está saudável", () => {
    const payload = JSON.stringify({
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      mergeable: "MERGEABLE",
      commits: [
        {
          committedDate: "2026-09-19T00:00:00Z",
          messageBody: "fix: detecta a assinatura claude native binary not installed em stdout/stderr",
        },
      ],
    });
    const result = resolveGateResult(spawnOutcome({ status: 0, stdout: payload, stderr: "" }));
    assert.equal(result.verdict, "pass");
    assert.notEqual(result.verdict, "claude_binary_error");
  });
});
