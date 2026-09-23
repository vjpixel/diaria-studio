// PreToolUse hook — recusa `gh pr create` quando o snapshot de
// `test/orchestrator-prompt.test.ts` (#634) está desatualizado na branch
// atual (#8732).
//
// Incidente de origem: em 22/09/2026 duas PRs seguidas (#8723, #8703)
// editaram `.claude/agents/orchestrator-stage-*.md` sem rodar
// `NODE_TEST_SNAPSHOTS=1 npm test` antes do push, chegando ao CI vermelhas
// pelo mesmo motivo — o teste "snapshot hash — detecta mudanças
// não-intencionais" só avisa DEPOIS que o CI já rodou, e a mensagem de erro
// (por mais clara que seja) só ajuda quem já está olhando o log de CI. Mesmo
// padrão dos outros guards deste diretório: uma instrução em prosa/mensagem
// de teste é probabilística, rodar o teste de verdade ANTES do `gh pr
// create` é determinístico e barato (~poucos ms, é só hash + comparação).
//
// Mecanismo: intercepta `gh pr create` (mesmo ponto de extensão de
// `pr-create-review.mjs`/`block-pr-create-tsc-failure.mjs`), roda só o
// teste do snapshot (`--test-name-pattern "snapshot.hash"`) no repo/worktree
// de onde o comando está saindo, e nega a criação da PR se ele falhar —
// reusando o teste real (não reimplementando o hash aqui) pra nunca divergir
// da lógica que o CI de fato roda.
//
// Contrato de fail-direction, mesmo padrão de block-pr-create-tsc-failure.mjs:
//   - repo git não resolvido → fail-OPEN (nada pra checar).
//   - `tsx`/teste não resolvível ou não termina (spawn falhou, timeout) →
//     fail-OPEN, mas logado — indisponibilidade de ambiente não é sinal de
//     snapshot desatualizado.
//   - teste rodou e passou → fail-OPEN (snapshot em dia).
//   - teste rodou e falhou → fail-CLOSED (o caso central desta issue).
//
// Escape hatch (mesmo espírito do #8482 — "deve ser explícito e logado,
// nunca silencioso"): `DIARIA_ALLOW_PR_WITH_STALE_ORCHESTRATOR_SNAPSHOT=1`
// na frente do comando pula o guard — registrado em `data/run-log.jsonl`
// toda vez que usado.
//
// Nunca lança / nunca sai com código não-zero fora do processo do hook em
// si — só emite `permissionDecision: "deny"` quando há um motivo real de
// bloquear.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isGhPrCreateCommand,
  resolveRepoRootCandidates,
  resolveGitRoot,
} from "./block-pr-create-pii-runtime-artifacts.mjs";

/** Var de ambiente do escape hatch — nome único pra não colidir com nenhum
 * outro guard/flag do repo. */
export const SNAPSHOT_PR_GUARD_BYPASS_ENV = "DIARIA_ALLOW_PR_WITH_STALE_ORCHESTRATOR_SNAPSHOT";

/**
 * Roda só o teste do snapshot do orchestrator (`orchestrator-prompt.test.ts`,
 * filtro `--test-name-pattern "snapshot.hash"`) em `cwd` via `spawnFn`
 * injetável (produção: `spawnSync`; teste: fake sem processo real).
 *
 * Devolve `{ infra, ok, output }` — mesmo shape/contrato de `runTypecheck`
 * em `block-pr-create-tsc-failure.mjs`:
 *   - `infra: true` quando o PRÓPRIO teste não rodou (spawn falhou, timeout,
 *     sinal, `tsx` não resolvível) — indisponibilidade de ambiente, nunca
 *     tratado como "snapshot desatualizado".
 *   - `infra: false, ok: true` — snapshot em dia (exit 0).
 *   - `infra: false, ok: false` — snapshot desatualizado; `output` carrega o
 *     stdout+stderr combinado do teste (inclui a mensagem "Orchestrator
 *     content changed" com os 2 hashes e o comando de correção).
 */
export function runOrchestratorSnapshotCheck(cwd, spawnFn = spawnSync) {
  const result = spawnFn(
    "npx",
    // "snapshot.hash" (não "snapshot hash"): --test-name-pattern compila pra
    // RegExp, e `.` casa o espaço — evita passar um argumento com espaço sob
    // spawnSync com shell:true, que NÃO escapa/aspa args automaticamente
    // (Node emite DEP0190 exatamente por isso). Um argumento com espaço vira
    // 2 tokens de shell separados ("snapshot" + "hash" solto), e "hash"
    // solto é lido por `node --test` como outro glob de arquivo — reproduzido
    // ao vivo: a chamada varre 6 testes em 3 suites (inclui #3947/#3953, que
    // só têm "snapshot" no nome) em vez do 1 teste pretendido. Achado do
    // review da própria PR que introduziu este hook (#8732).
    ["tsx", "--test", "--test-name-pattern", "snapshot.hash", "test/orchestrator-prompt.test.ts"],
    {
      cwd,
      encoding: "utf8",
      // Teste único, hash + comparação — folga generosa sobre o ~300ms
      // medido localmente (o custo real é o boot do tsx, não o teste).
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      // shell:true — mesma razão de block-pr-create-tsc-failure.mjs: `npx`
      // é wrapper .cmd no Windows, spawnSync sem shell não resolve (#6777).
      shell: true,
      windowsHide: true,
    },
  );
  if (!result || result.error) {
    return { infra: true, ok: false, output: String(result?.error?.message ?? result?.error ?? "spawn falhou") };
  }
  if (result.status === null) {
    return { infra: true, ok: false, output: "teste do snapshot não terminou (timeout ou sinal) — tratado como infra, não bloqueia a PR" };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { infra: false, ok: result.status === 0, output };
}

/** Trunca a saída do teste pra não inflar a mensagem de recusa indefinidamente
 * — mesma preocupação de `truncateTscOutput` em block-pr-create-tsc-failure.mjs. */
export function truncateSnapshotOutput(output, maxChars = 2000) {
  if (typeof output !== "string") return "";
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n… (+${output.length - maxChars} chars, truncado)`;
}

/** Monta a mensagem de recusa quando o snapshot está desatualizado. */
export function buildSnapshotDenyMessage(output) {
  return [
    "gh pr create bloqueado pelo guard mecânico de snapshot do orchestrator (#8732): test/orchestrator-prompt.test.ts (#634) detectou mudança não-refletida no snapshot.",
    "",
    truncateSnapshotOutput(output),
    "",
    "Se a mudança é intencional, atualize o snapshot e commite antes de reabrir `gh pr create`:",
    "  NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts",
    `Escape hatch (só pra falso positivo comprovado do guard, nunca pra contornar mudança real não revisada): ${SNAPSHOT_PR_GUARD_BYPASS_ENV}=1 gh pr create ... — fica registrado em data/run-log.jsonl (orchestrator_snapshot_pr_guard_bypassed), nunca silencioso.`,
  ].join("\n");
}

/**
 * Loga um evento do guard em `data/run-log.jsonl` — mesmo formato/arquivo de
 * `logTscGuardEvent` em `block-pr-create-tsc-failure.mjs`. Fail-soft: uma
 * falha ao logar nunca pode propagar nem bloquear o hook.
 */
export function logSnapshotGuardEvent(message, details, { repoRoot, appendFn = appendFileSync, mkdirFn = mkdirSync } = {}) {
  try {
    if (typeof repoRoot !== "string" || repoRoot === "") return;
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: null,
      agent: "pr-create-orchestrator-snapshot-guard",
      level: "info",
      message,
      details,
    };
    const logPath = join(repoRoot, "data", "run-log.jsonl");
    mkdirFn(dirname(logPath), { recursive: true });
    appendFn(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Swallow everything — mesmo contrato do resto deste diretório.
  }
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por
// test/block-pr-create-orchestrator-snapshot-stale.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!isGhPrCreateCommand(command)) return;

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const cwd = resolveGitRoot(resolveRepoRootCandidates(payload.cwd, hookDir, command));
      if (cwd === null) return; // fail-open: nenhum candidato é repo git

      if (process.env[SNAPSHOT_PR_GUARD_BYPASS_ENV] === "1") {
        logSnapshotGuardEvent(
          "orchestrator_snapshot_pr_guard_bypassed",
          { command: typeof command === "string" ? command.slice(0, 500) : null },
          { repoRoot: cwd },
        );
        return;
      }

      const result = runOrchestratorSnapshotCheck(cwd);

      if (result.infra) {
        logSnapshotGuardEvent("orchestrator_snapshot_pr_guard_infra_error", { output: result.output?.slice?.(0, 500) ?? null }, { repoRoot: cwd });
        return; // fail-open: teste não rodou por motivo de ambiente, não bloqueia
      }

      if (!result.ok) {
        logSnapshotGuardEvent(
          "orchestrator_snapshot_pr_guard_blocked",
          { command: typeof command === "string" ? command.slice(0, 500) : null },
          { repoRoot: cwd },
        );
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildSnapshotDenyMessage(result.output),
            },
          }),
        );
      }
      // ok: true — snapshot em dia, sem output, cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr create`
      // legítimo.
    }
  });
}
