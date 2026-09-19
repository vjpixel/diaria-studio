// PreToolUse hook — recusa `gh pr create` quando `npx tsc --noEmit` falha na
// branch atual (#8482).
//
// Incidente de origem: em 19/09/2026 duas PRs abertas pelo `continuo`
// (#8478, #8456) chegaram ao CI com erro de typecheck (`TS2304: Cannot find
// name`) — ambas por usar uma variável fora do escopo onde foi declarada. A
// regra que deveria ter pego isso já existe, mas só como prosa num prompt de
// dispatch (`context/overnight-dispatch-rules.md` item 4, "testes locais =
// npx tsc --noEmit antes de abrir a PR"): nas duas rodadas ela simplesmente
// não foi executada. Esse é o mesmo padrão que motivou os outros guards
// mecânicos deste diretório — uma instrução em prompt é probabilística, um
// `tsc --noEmit` é determinístico e barato (~20s medidos localmente).
//
// Mecanismo: intercepta `gh pr create` (mesmo ponto de extensão de
// `pr-create-review.mjs`/`block-pr-create-pii-runtime-artifacts.mjs`), roda
// `npx tsc --noEmit` (tsconfig raiz — `scripts/**`, o mesmo que `npm run
// typecheck`/CI) no repo/worktree de onde o comando está saindo, e nega a
// criação da PR se o typecheck falhar, imprimindo os erros do `tsc`.
//
// Reusa a resolução de repo-root de `block-pr-create-pii-runtime-artifacts.mjs`
// (`resolveRepoRootCandidates`/`resolveGitRoot`) em vez de duplicá-la — mesmo
// requisito ali (#7241): num worktree, o comando roda de onde o `cd` inline
// ou o `cwd` do payload apontam, nunca do path fixo do hook.
//
// Contrato de fail-direction, deliberadamente ASSIMÉTRICO por tipo de falha:
//   - repo git não resolvido (nenhum candidato é um repo) → fail-OPEN (nada
//     pra checar; mesmo comportamento dos outros guards deste diretório).
//   - `tsc` não resolvível no ambiente (worktree sem bootstrap, `npm ci`
//     nunca rodou, e NENHUM node_modules ancestral tem `typescript`) →
//     fail-CLOSED com mensagem explícita, NUNCA um erro críptico de `tsc`
//     ausente (pedido explícito da issue #8482 — "cuidado com worktree sem
//     node_modules").
//   - `tsc` genuinamente não executou (spawn falhou, binário ausente) →
//     fail-OPEN (infra, não é sinal de erro de tipo real) — mas logado, nunca
//     silencioso.
//   - `tsc --noEmit` executou e devolveu erro de tipo → fail-CLOSED (o caso
//     central da issue).
//
// Escape hatch (#8482 "deve ser explícito e logado, nunca silencioso"):
// `DIARIA_ALLOW_PR_WITH_TSC_ERRORS=1` na frente do comando pula o guard —
// registrado em `data/run-log.jsonl` (`tsc_pr_guard_bypassed`) toda vez que
// usado, nunca sem rastro.
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
export const TSC_PR_GUARD_BYPASS_ENV = "DIARIA_ALLOW_PR_WITH_TSC_ERRORS";

/**
 * `true` se `tsc` é resolvível a partir de `cwd` sem precisar instalar nada
 * (`npx --no-install tsc --version`).
 *
 * **Por que NÃO checar `existsSync(cwd/node_modules)` (achado ao vivo ao
 * testar este próprio guard):** um worktree em
 * `.claude/worktrees/{tag}/` não tem `node_modules/` PRÓPRIO até `npm ci`
 * rodar (regra 3 de `context/overnight-dispatch-rules.md`) — mas a
 * resolução de módulo do Node (e por tabela do `npx`) sobe o diretório até
 * achar um `node_modules` ancestral, e o worktree fica ANINHADO dentro do
 * checkout principal. `npx tsc --noEmit` já funciona nesse caso via o
 * `node_modules` do checkout principal, mesmo sem bootstrap local — uma
 * checagem de path só em `cwd` teria produzido um falso positivo (deny)
 * exatamente no cenário legítimo mais comum. `--no-install` é o jeito
 * correto de perguntar "roda sem tocar rede/instalar nada?", que é a
 * pergunta real por trás do pedido da issue.
 */
export function checkTscAvailable(cwd, spawnFn = spawnSync) {
  const result = spawnFn("npx", ["--no-install", "tsc", "--version"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    shell: true,
    windowsHide: true,
  });
  if (!result || result.error) return false;
  return result.status === 0;
}

/**
 * Roda `npx tsc --noEmit` (tsconfig raiz — `scripts/**`, o mesmo que `npm
 * run typecheck` e o job `test` do CI) em `cwd` via `spawnFn` injetável
 * (produção: `spawnSync`; teste: fake sem processo real).
 *
 * Devolve `{ infra, ok, output }`:
 *   - `infra: true` quando o PRÓPRIO `tsc` não rodou (spawn falhou, timeout,
 *     sinal) — não é sinal de erro de tipo, é indisponibilidade de ambiente;
 *     `ok` some junto (sempre `false`, mas o chamador deve olhar `infra`
 *     primeiro e nunca tratar isso como "typecheck falhou").
 *   - `infra: false, ok: true` — typecheck limpo (exit 0).
 *   - `infra: false, ok: false` — typecheck rodou e encontrou erro(s); `output`
 *     carrega o stdout+stderr combinado do `tsc`.
 */
export function runTypecheck(cwd, spawnFn = spawnSync) {
  const result = spawnFn("npx", ["tsc", "--noEmit"], {
    cwd,
    encoding: "utf8",
    // 60s: ~20s medidos localmente + margem. Deliberadamente MENOR que o
    // timeout do hook em .claude/settings.json (90s) — se este spawnSync
    // não estourasse antes, o harness mataria o processo do hook primeiro
    // (sem nosso log de infra, sem a distinção infra/erro-de-tipo).
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    // shell:true — mesma razão de runTscTest em scripts/typecheck-ratchet.ts:
    // `npx` é um wrapper .cmd no Windows, spawnSync sem shell não resolve
    // (#6777). Sem input de usuário nos args (literais), sem risco de
    // injeção.
    shell: true,
    windowsHide: true,
  });
  if (!result || result.error) {
    return { infra: true, ok: false, output: String(result?.error?.message ?? result?.error ?? "spawn falhou") };
  }
  if (result.status === null) {
    return { infra: true, ok: false, output: "npx tsc --noEmit não terminou (timeout ou sinal) — tratado como infra, não bloqueia a PR" };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { infra: false, ok: result.status === 0, output };
}

/** Trunca a saída do `tsc` pra não inflar a mensagem de recusa indefinidamente
 * — mesma preocupação de tamanho de `logSuppressedReviewInstruction` em
 * `pr-create-review.mjs`, aplicada aqui à mensagem de deny em vez do log. */
export function truncateTscOutput(output, maxChars = 4000) {
  if (typeof output !== "string") return "";
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n… (+${output.length - maxChars} chars, truncado)`;
}

/** Monta a mensagem de recusa quando `tsc --noEmit` falhou. */
export function buildTscDenyMessage(output) {
  return [
    "gh pr create bloqueado pelo guard mecânico de typecheck (#8482): `npx tsc --noEmit` falhou nesta branch.",
    "",
    truncateTscOutput(output),
    "",
    "Corrija o(s) erro(s) de tipo acima e rode `npx tsc --noEmit` de novo antes de reabrir `gh pr create`.",
    `Escape hatch (só pra falso positivo comprovado do guard, nunca pra contornar erro real): ${TSC_PR_GUARD_BYPASS_ENV}=1 gh pr create ... — fica registrado em data/run-log.jsonl (tsc_pr_guard_bypassed), nunca silencioso.`,
  ].join("\n");
}

/** Monta a mensagem de recusa quando `tsc` não é resolvível a partir do
 * worktree (nenhum `node_modules` local nem ancestral com `typescript`) —
 * pedido explícito da issue #8482, nunca deixar isso virar um erro críptico
 * de `tsc`/`npx` ausente. */
export function buildTscUnavailableDenyMessage(cwd) {
  return [
    `gh pr create bloqueado: não foi possível resolver \`tsc\` a partir de "${cwd}" — o guard mecânico de typecheck (#8482) precisa dele pra rodar \`npx tsc --noEmit\`.`,
    "Rode `npm ci` neste worktree (context/overnight-dispatch-rules.md item 3) e tente de novo.",
  ].join("\n");
}

/**
 * Loga um evento do guard em `data/run-log.jsonl` (mesmo formato/arquivo de
 * `logEffortDecision`/`logSuppressedReviewInstruction` em
 * `pr-create-review.mjs`). Fail-soft: uma falha ao logar nunca pode
 * propagar nem bloquear o hook.
 */
export function logTscGuardEvent(message, details, { repoRoot, appendFn = appendFileSync, mkdirFn = mkdirSync } = {}) {
  try {
    if (typeof repoRoot !== "string" || repoRoot === "") return;
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: null,
      agent: "pr-create-tsc-guard",
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
// entrypoint (nunca ao ser importado por test/block-pr-create-tsc-failure.test.ts).
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

      if (process.env[TSC_PR_GUARD_BYPASS_ENV] === "1") {
        logTscGuardEvent(
          "tsc_pr_guard_bypassed",
          { command: typeof command === "string" ? command.slice(0, 500) : null },
          { repoRoot: cwd },
        );
        return;
      }

      if (!checkTscAvailable(cwd)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildTscUnavailableDenyMessage(cwd),
            },
          }),
        );
        return;
      }

      const result = runTypecheck(cwd);

      if (result.infra) {
        logTscGuardEvent("tsc_pr_guard_infra_error", { output: result.output?.slice?.(0, 500) ?? null }, { repoRoot: cwd });
        return; // fail-open: tsc não rodou por motivo de ambiente, não bloqueia
      }

      if (!result.ok) {
        logTscGuardEvent(
          "tsc_pr_guard_blocked",
          { command: typeof command === "string" ? command.slice(0, 500) : null },
          { repoRoot: cwd },
        );
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildTscDenyMessage(result.output),
            },
          }),
        );
      }
      // ok: true — typecheck limpo, sem output, cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr create`
      // legítimo.
    }
  });
}
