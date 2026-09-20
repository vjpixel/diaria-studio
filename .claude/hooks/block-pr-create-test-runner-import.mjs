// PreToolUse hook — recusa `gh pr create` quando algum `test/**/*.test.ts`
// da branch importa um runner de teste proibido (vitest/jest/mocha/ava) ou
// usa `describe()`/`it()` sem importar de `node:test` (#8526).
//
// Incidente de origem: PR #8510 (`fix(#8507)`) abriu com 4 checks vermelhos
// (`test`, `knip`, `Typecheck ratchet` ×3) por uma causa única —
// `test/8507-alarm-dedup.test.ts` importava `describe`/`it`/`expect` de
// `vitest` e usava `require()`/`__dirname` num arquivo TS ESM. O guard que
// existe pra exatamente isso — `test/test-runner-import-guard.test.ts`
// (#7807) — pegou corretamente, mas só DEPOIS de `gh pr create`: a suíte
// inteira (~6min) já tinha rodado, a PR já ocupava fila e disparava review
// automatizado, e o diagnóstico ainda exigia abrir o log da CI pra descobrir
// que a causa dos 4 vermelhos era 1 linha de `import`. Esta é a 4ª
// ocorrência do mesmo erro (as 3 anteriores: #7660, PR #7783/#7746, PR
// #7771/#7765) e a 1ª depois do guard existir — o guard nomeou a falha, mas
// não evitou nenhum dos custos que a própria issue #7807 listava como
// justificativa.
//
// Mecanismo: mesmo ponto de extensão de `block-pr-create-tsc-failure.mjs`
// (#8482) — intercepta `gh pr create`, roda a checagem ESTÁTICA (sem
// executar teste nenhum) de `scripts/lib/test-runner-import-guard.ts` contra
// `test/**/*.test.ts` no repo/worktree de onde o comando está saindo, e nega
// a criação da PR se achar violação.
//
// `test/test-runner-import-guard.test.ts` continua existindo como rede de
// CI (#7807, comportamento inalterado) — este hook é a camada rápida, não a
// substituta (#8526, critério de aceite: "o teste em test/ continua
// existindo como rede de CI").
//
// Reusa a resolução de repo-root de `block-pr-create-pii-runtime-artifacts.mjs`
// (`resolveRepoRootCandidates`/`resolveGitRoot`), mesmo padrão de
// `block-pr-create-tsc-failure.mjs`.
//
// Contrato de fail-direction:
//   - repo git não resolvido → fail-OPEN (nada pra checar).
//   - `test/` ausente do repo/worktree (nunca deveria acontecer, mas
//     `readdirSync` lançando não pode travar `gh pr create` legítimo) →
//     fail-OPEN (sem log dedicado — cenário sem sinal de erro real, ao
//     contrário do `tsc` ausente do guard de typecheck).
//   - checagem rodou e achou violação → fail-CLOSED, mensagem nomeando
//     arquivo(s) + correção — mesmo texto do guard de CI (#7807).
//   - checagem rodou limpa → segue o fluxo normal de permissão.
//
// Nunca lança / nunca sai com código não-zero fora do processo do hook em
// si — só emite `permissionDecision: "deny"` quando há um motivo real de
// bloquear.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isGhPrCreateCommand,
  resolveRepoRootCandidates,
  resolveGitRoot,
} from "./block-pr-create-pii-runtime-artifacts.mjs";

/**
 * Roda a checagem estática contra `{repoRoot}/test`. Devolve `null` quando
 * `test/` não existe (fail-open — nada pra checar) ou o resultado de
 * `checkTestRunnerImports`.
 */
export async function runTestRunnerImportCheck(repoRoot, importGuardModule) {
  const testDir = join(repoRoot, "test");
  if (!existsSync(testDir)) return null;
  const { checkTestRunnerImports } =
    importGuardModule ??
    // pathToFileURL (não uma string de path crua): um path absoluto do
    // Windows ("C:\...") não é resolvido pelo loader ESM sem virar
    // file:// primeiro — mesma armadilha que `dirname(fileURLToPath(...))`
    // evita do lado da leitura, aqui do lado da escrita do specifier.
    (await import(
      `${pathToFileURL(join(repoRoot, "scripts", "lib", "test-runner-import-guard.ts")).href}?t=${Date.now()}`
    ));
  return checkTestRunnerImports(testDir, repoRoot);
}

/** Monta a mensagem de recusa a partir do resultado de `checkTestRunnerImports`. */
export function buildTestRunnerImportDenyMessage(result) {
  const linhas = [
    "gh pr create bloqueado pelo guard mecânico de runner de teste (#8526): " +
      "test/**/*.test.ts precisa usar node:test, o único runner deste repo.",
    "",
  ];
  if (result.runnerProibido.length > 0) {
    linhas.push(
      `arquivo(s) importando runner proibido: ${result.runnerProibido.join(", ")} — ` +
        "este repo roda node:test (ver scripts/run-tests.ts). Troque por " +
        'import { describe, it } from "node:test" + import assert from "node:assert/strict".',
    );
  }
  if (result.importAusenteNodeTest.length > 0) {
    linhas.push(
      `arquivo(s) usando describe()/it() sem importar de node:test: ${result.importAusenteNodeTest.join(", ")} — ` +
        'adicione import { describe, it } from "node:test".',
    );
  }
  linhas.push("", "Corrija o(s) import(s) acima e rode `npx tsx --test <arquivo>` antes de reabrir `gh pr create`.");
  return linhas.join("\n");
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por
// test/block-pr-create-test-runner-import.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", async () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!isGhPrCreateCommand(command)) return;

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const cwd = resolveGitRoot(resolveRepoRootCandidates(payload.cwd, hookDir, command));
      if (cwd === null) return; // fail-open: nenhum candidato é repo git

      const result = await runTestRunnerImportCheck(cwd);
      if (result === null) return; // fail-open: test/ não existe

      if (result.runnerProibido.length > 0 || result.importAusenteNodeTest.length > 0) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildTestRunnerImportDenyMessage(result),
            },
          }),
        );
      }
      // sem violação: sem output, cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr create`
      // legítimo.
    }
  });
}
