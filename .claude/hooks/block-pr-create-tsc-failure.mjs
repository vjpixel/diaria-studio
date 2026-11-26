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
// `DIARIA_ALLOW_PR_WITH_TSC_ERRORS=1` pula o guard — registrado em
// `data/run-log.jsonl` (`tsc_pr_guard_bypassed`) toda vez que usado, nunca
// sem rastro. Duas formas valem (#13539): no ambiente da sessão (o processo
// do hook herda) OU como atribuição na frente do próprio comando
// (`DIARIA_ALLOW_PR_WITH_TSC_ERRORS=1 gh pr create ...`). A 2ª forma, a que a
// mensagem de recusa ensina, nunca chega ao `process.env` do hook (o hook
// roda no processo do harness, antes do shell do Bash), por isso é lida no
// TEXTO do comando — só como atribuição de ambiente que precede o `gh pr
// create`, nunca dentro de aspas (`--body "..."`) nem de corpo de heredoc.
//
// Antes do #13539 o prefixo nem era reconhecido como `gh pr create`
// (`isGhPrCreateCommand` só aceita o comando no início do segmento), então
// `QUALQUER_VAR=x gh pr create` saía do hook sem typecheck e sem log — o
// escape hatch "funcionava" em silêncio, e qualquer atribuição o imitava.
//
// Nunca lança / nunca sai com código não-zero fora do processo do hook em
// si — só emite `permissionDecision: "deny"` quando há um motivo real de
// bloquear.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isGhPrCreateCommand,
  resolveRepoRootCandidates,
  resolveGitRoot,
} from "./block-pr-create-pii-runtime-artifacts.mjs";
import { stripHeredocSpans } from "./block-handwritten-pr-checks-loop.mjs";
import { isForeignRepoGhCommand as defaultIsForeignRepoGhCommand } from "./lib/gh-target-repo.mjs";
import { stripQuotedSpans } from "./lib/shell-quote-strip.mjs";
import { isStudioCheckout as defaultIsStudioCheckout, studioLogRoot } from "./lib/studio-checkout.mjs";

/** Var de ambiente do escape hatch — nome único pra não colidir com nenhum
 * outro guard/flag do repo. */
export const TSC_PR_GUARD_BYPASS_ENV = "DIARIA_ALLOW_PR_WITH_TSC_ERRORS";

// Início de segmento de comando (mesmos separadores de `isGhPrCreateCommand`)
// e uma sequência de atribuições de ambiente `NOME=valor ` (#13539).
const SEGMENT_START = String.raw`(?:^|&&|;|\|\||\||\n)\s*`;
const ENV_ASSIGNMENTS = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const ENV_PREFIXED_PR_CREATE_RE = new RegExp(
  `${SEGMENT_START}(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)+gh\\s+pr\\s+create\\b`,
);
const BYPASS_ASSIGNMENT_RE = new RegExp(
  `${SEGMENT_START}${ENV_ASSIGNMENTS}${TSC_PR_GUARD_BYPASS_ENV}=1\\s+${ENV_ASSIGNMENTS}gh\\s+pr\\s+create\\b`,
);

/** Texto do comando que o shell de fato executa: sem corpo de heredoc, sem
 * conteúdo entre aspas (texto citado nunca é comando nem atribuição), com
 * `\x` neutralizado (`x\;y` é um `;` literal, não separador) e sem
 * comentário de shell (`# ...` até o fim da linha, quando o `#` abre palavra). */
export function liveCommandText(command) {
  return stripQuotedSpans(stripHeredocSpans(command))
    .replace(/\\[\s\S]/g, "__")
    .replace(/(^|[ \t])#[^\n]*/gm, "$1");
}

/**
 * `true` quando o comando roda `gh pr create` precedido de atribuição(ões) de
 * ambiente (`FOO=bar gh pr create`). `isGhPrCreateCommand` (compartilhado com
 * os outros guards de `gh pr create`) não reconhece essa forma (#13539).
 */
export function isEnvPrefixedGhPrCreate(command) {
  if (typeof command !== "string") return false;
  return ENV_PREFIXED_PR_CREATE_RE.test(liveCommandText(command));
}

/** O guard de typecheck se aplica a este comando? */
export function isTscGuardedPrCreate(command) {
  return isGhPrCreateCommand(command) || isEnvPrefixedGhPrCreate(command);
}

/**
 * `true` quando `DIARIA_ALLOW_PR_WITH_TSC_ERRORS=1` aparece como atribuição de
 * ambiente na frente do `gh pr create` (também depois de outras atribuições
 * ou de `&&`/`;`). Ocorrência dentro de aspas ou de corpo de heredoc não conta
 * (#13539). Com mais de um `gh pr create` no mesmo comando, o prefixo em
 * qualquer um deles pula o guard do comando inteiro (o hook decide por comando).
 */
export function commandHasBypassAssignment(command) {
  if (typeof command !== "string") return false;
  return BYPASS_ASSIGNMENT_RE.test(liveCommandText(command));
}

/**
 * De onde veio o pedido de bypass: `"env"` (ambiente do processo do hook),
 * `"inline"` (atribuição no comando) ou `null` (nenhum).
 */
export function bypassSource(command, env = process.env) {
  if (env?.[TSC_PR_GUARD_BYPASS_ENV] === "1") return "env";
  if (commandHasBypassAssignment(command)) return "inline";
  return null;
}

/**
 * Aplica o escape hatch: se pedido, registra `tsc_pr_guard_bypassed` e devolve
 * `true` (o hook sai sem typecheck). `logFn` injetável pros testes.
 */
export function applyTscGuardBypass(command, { env = process.env, logRoot, logFn = logTscGuardEvent } = {}) {
  const source = bypassSource(command, env);
  if (source === null) return false;
  logFn(
    "tsc_pr_guard_bypassed",
    { source, command: typeof command === "string" ? command.slice(0, 500) : null },
    { repoRoot: logRoot },
  );
  return true;
}

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

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Primeiro filtro do hook: só Bash com `gh pr create` guardado pelo
 * typecheck. Exportado para o despachante único (#14045), que só spawna este
 * hook quando ele se aplica; `handlePayload` usa a mesma função, então o
 * filtro dos dois é um só.
 */
export function appliesTo(payload) {
  if (payload?.tool_name && payload.tool_name !== "Bash") return false;
  return isTscGuardedPrCreate(payload?.tool_input?.command);
}

/**
 * Corpo do hook (#13539): decide sobre um payload PreToolUse e devolve o
 * objeto de saída (deny) ou `undefined` (segue o fluxo normal de permissão).
 * Tudo que toca processo, disco ou git é injetável em `deps`, pra que o teste
 * exercite o fluxo real sem spawn nem escrita no `data/run-log.jsonl`. Os
 * nomes locais `isForeignRepoGhCommand`/`isStudioCheckout` são os que os
 * guards de texto de #10618/#12951 procuram neste arquivo.
 */
export function handlePayload(payload, deps = {}) {
  const {
    env = process.env,
    hookDir,
    resolveRepoRoot = (p, dir, cmd) => resolveGitRoot(resolveRepoRootCandidates(p?.cwd, dir, cmd)),
    isForeignRepo: isForeignRepoGhCommand = defaultIsForeignRepoGhCommand,
    isStudio: isStudioCheckout = defaultIsStudioCheckout,
    resolveLogRoot = studioLogRoot,
    checkTscAvailableFn = checkTscAvailable,
    runTypecheckFn = runTypecheck,
    logFn = logTscGuardEvent,
  } = deps;

  if (!appliesTo(payload)) return;
  const command = payload?.tool_input?.command;

  const cwd = resolveRepoRoot(payload, hookDir, command);
  if (cwd === null) return; // fail-open: nenhum candidato é repo git
  // #10618: PR de OUTRO repo (ex: vjpixel/diaria-design, `-R` ou cwd num
  // checkout dele) — esta é uma regra do diaria-studio, não se aplica lá.
  // Repo indeterminado segue aplicando a regra (comportamento anterior).
  if (isForeignRepoGhCommand(command, cwd)) return;
  // #12951: log sempre no `data/` do studio, nunca no cwd do comando.
  const logRoot = resolveLogRoot(hookDir);
  // #12951: checkout de outro repo com `origin` indeterminado.
  if (isStudioCheckout(cwd, hookDir, { command }) === false) {
    logFn("tsc_pr_guard_skipped_foreign_checkout", { cwd }, { repoRoot: logRoot });
    return;
  }

  if (applyTscGuardBypass(command, { env, logRoot, logFn })) return;

  if (!checkTscAvailableFn(cwd)) return denyOutput(buildTscUnavailableDenyMessage(cwd));

  const result = runTypecheckFn(cwd);

  if (result.infra) {
    logFn("tsc_pr_guard_infra_error", { output: result.output?.slice?.(0, 500) ?? null }, { repoRoot: logRoot });
    return; // fail-open: tsc não rodou por motivo de ambiente, não bloqueia
  }

  if (!result.ok) {
    logFn(
      "tsc_pr_guard_blocked",
      { command: typeof command === "string" ? command.slice(0, 500) : null },
      { repoRoot: logRoot },
    );
    return denyOutput(buildTscDenyMessage(result.output));
  }
  // ok: true — typecheck limpo, sem output, cai no fluxo normal de permissão.
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-pr-create-tsc-failure.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  // #9197: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const output = handlePayload(JSON.parse(data || "{}"), {
        hookDir: dirname(fileURLToPath(import.meta.url)),
      });
      if (output) process.stdout.write(JSON.stringify(output));
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr create`
      // legítimo.
    }
  });
}
