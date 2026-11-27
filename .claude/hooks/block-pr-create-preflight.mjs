// PreToolUse hook — recusa `gh pr create` com `docs/editorial-invariants.md`
// defasado ou sem `removal-declaration:` no corpo de uma PR acima do limiar
// de adições (#14216).
//
// Origem: a medição da #14120 achou 5 ciclos de `dev-fixer` causados por essas
// duas falhas. As regras já estavam escritas (itens 13 e 29 de
// `context/overnight-dispatch-rules.md`) e foram ignoradas: prosa no prompt é
// probabilística, o CI só reprova depois do push. Este guard confere as duas
// antes de a PR existir, no checkout de onde o comando sai.
//
// Mecanismo: lê o corpo do comando (`--body`/`-b`, `--body-file`/`-F` com
// arquivo, ou `--body-file -` com heredoc) e o entrega por stdin a
// `scripts/check-pr-create-preflight.ts`, que gera o markdown das invariantes,
// mede o diff contra o merge-base com `origin/master` (como o gate do CI,
// #9403) e decide (`scripts/lib/pr-create-preflight.ts`).
//
// Direção de falha:
//   - nega só o que o CI reprovaria: documento divergente, ou corpo LIDO sem
//     `removal-declaration:` com mais de 500 adições;
//   - corpo que só existe ao rodar (`--body "$(cat ...)"`, `--fill`, nome com
//     `$`), diff não medido ou registry que não carrega: aviso no
//     `systemMessage`, nunca recusa;
//   - script ausente (checkout sem ele), spawn que falha ou passa do teto:
//     fail-open, logado em `data/run-log.jsonl`.
//
// Escape hatch, explícito e logado: `DIARIA_ALLOW_PR_WITHOUT_PREFLIGHT=1` no
// ambiente da sessão ou como atribuição na frente do `gh pr create`.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRepoRootCandidates, resolveGitRoot } from "./block-pr-create-pii-runtime-artifacts.mjs";
import { isTscGuardedPrCreate, liveCommandText } from "./block-pr-create-tsc-failure.mjs";
import { isForeignRepoGhCommand as defaultIsForeignRepoGhCommand } from "./lib/gh-target-repo.mjs";
import { isStudioCheckout as defaultIsStudioCheckout, studioLogRoot } from "./lib/studio-checkout.mjs";
import { resolveCommandWords, tokenizeShell } from "../../scripts/lib/protected-path-bash-write.mjs";

export const PREFLIGHT_PR_GUARD_BYPASS_ENV = "DIARIA_ALLOW_PR_WITHOUT_PREFLIGHT";
export const PREFLIGHT_SCRIPT = "scripts/check-pr-create-preflight.ts";

const BYPASS_ASSIGNMENT_RE = new RegExp(
  String.raw`(?:^|&&|;|\|\||\||\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*gh\s+pr\s+create\b`,
);

/** De onde veio o pedido de bypass (`"env"`, `"command"`) ou `null`. */
export function bypassSource(command, env = process.env) {
  if (env?.[PREFLIGHT_PR_GUARD_BYPASS_ENV] === "1") return "env";
  if (typeof command === "string" && BYPASS_ASSIGNMENT_RE.test(liveCommandText(command))) return "command";
  return null;
}

const GH_VALUE_FLAGS = new Set(["-R", "--repo"]);
const STDIN_FILES = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

/**
 * Corpo do `gh pr create` do comando, sem rodar nada:
 * `{ kind: "text", body }`, `{ kind: "file", path }` (relativo ao `cwd` do
 * comando) ou `{ kind: "unknown", reason }`. Texto entre aspas e corpo de
 * heredoc não viram comando (tokenizer do guard #12009). Valor com `$` só se
 * resolve ao rodar: `unknown`.
 */
export function extractPrCreateBody(command) {
  if (typeof command !== "string") return { kind: "unknown", reason: "comando ilegível" };
  for (const cmd of tokenizeShell(command)) {
    const w = resolveCommandWords(cmd.words);
    let i = 0;
    if (w[i] !== "gh" && !/[\\/]gh(?:\.exe)?$/.test(w[i] ?? "")) continue;
    i++;
    while (i < w.length && w[i].startsWith("-")) i += GH_VALUE_FLAGS.has(w[i]) ? 2 : 1;
    if (w[i] !== "pr" || w[i + 1] !== "create") continue;
    const args = w.slice(i + 2);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "--") break;
      let text;
      let file;
      if (a === "--body" || a === "-b") text = args[++k];
      else if (a.startsWith("--body=")) text = a.slice("--body=".length);
      // `-bTEXTO` e `-b=TEXTO` (o pflag do gh aceita os dois; `-B` é a base, outra flag)
      else if (a.startsWith("-b") && a.length > 2) text = a.slice(a[2] === "=" ? 3 : 2);
      else if (a === "--body-file" || a === "-F") file = args[++k];
      else if (a.startsWith("--body-file=")) file = a.slice("--body-file=".length);
      else if (a.startsWith("-F") && a.length > 2) file = a.slice(a[2] === "=" ? 3 : 2);
      else if (a === "--fill" || a === "--fill-first" || a === "--fill-verbose" || a === "-f") {
        return { kind: "unknown", reason: `${a}: o gh monta o corpo dos commits` };
      } else continue;
      if (text !== undefined) {
        // `--body "$(cat <<'EOF' ...)"`: o tokenizer não deixa `$` cru na palavra, mas o texto original tem.
        if (text.includes("$") || command.includes(`"$(`)) return { kind: "unknown", reason: "--body montado por expansão de shell" };
        return { kind: "text", body: text };
      }
      if (file === undefined || file === "") return { kind: "unknown", reason: "--body-file sem valor" };
      if (STDIN_FILES.has(file)) {
        if (cmd.stdin.length) return { kind: "text", body: cmd.stdin.join("\n") };
        return { kind: "unknown", reason: "--body-file - sem heredoc legível" };
      }
      if (file.includes("$")) return { kind: "unknown", reason: "--body-file com expansão de shell" };
      return { kind: "file", path: file };
    }
    return { kind: "unknown", reason: "gh pr create sem --body nem --body-file" };
  }
  return { kind: "unknown", reason: "gh pr create não encontrado no comando" };
}

/** Lê o corpo (`text` volta igual; `file` é lido relativo a `cwd`). */
export function resolveBody(extracted, cwd, readFile = (p) => readFileSync(p, "utf8")) {
  if (extracted.kind === "text") return { body: extracted.body, reason: null };
  if (extracted.kind === "file") {
    const path = isAbsolute(extracted.path) ? extracted.path : resolvePath(cwd, extracted.path);
    try {
      return { body: readFile(path), reason: null };
    } catch (e) {
      return { body: null, reason: `--body-file ${extracted.path} ilegível: ${e?.message ?? e}` };
    }
  }
  return { body: null, reason: extracted.reason };
}

/**
 * Roda o CLI no checkout `cwd`. `{ infra, code, result, output }`: `infra`
 * quando o script não existe, o spawn falhou, passou do teto ou a saída não é
 * o JSON esperado.
 */
export function runPreflight(cwd, { body, bodyReason }, spawnFn = spawnSync, exists = existsSync) {
  if (!exists(join(cwd, PREFLIGHT_SCRIPT))) return { infra: true, missing: true, output: `${PREFLIGHT_SCRIPT} ausente neste checkout` };
  const args = ["tsx", PREFLIGHT_SCRIPT, "--base", "origin/master"];
  if (body !== null) args.push("--body-stdin");
  const r = spawnFn("npx", args, {
    cwd,
    input: body ?? "",
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
    // `npx` é .cmd no Windows (#6777); os argumentos não têm espaço nem aspas.
    shell: true,
    windowsHide: true,
    env: bodyReason ? { ...process.env, DIARIA_PREFLIGHT_BODY_UNKNOWN: bodyReason } : process.env,
  });
  if (!r || r.error) return { infra: true, output: String(r?.error?.message ?? "spawn falhou") };
  if (r.status === null) return { infra: true, output: "preflight não terminou (timeout ou sinal)" };
  if (r.status !== 0 && r.status !== 1) return { infra: true, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(0, 1000) };
  const line = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    const result = JSON.parse(line);
    if (!Array.isArray(result?.deny) || !Array.isArray(result?.warn)) throw new Error("formato");
    return { infra: false, code: r.status, result };
  } catch {
    return { infra: true, output: `saída inesperada: ${line.slice(0, 500)}` };
  }
}

export function buildDenyMessage(deny) {
  return [
    "gh pr create bloqueado pelo preflight da PR (#14216): o CI reprovaria esta PR.",
    "",
    ...deny,
    "",
    `Escape hatch (só para falso positivo comprovado): ${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1 gh pr create ... — fica registrado em data/run-log.jsonl (pr_create_preflight_bypassed).`,
  ].join("\n");
}

/** Evento em `data/run-log.jsonl`; fail-soft. */
export function logPreflightEvent(message, details, { repoRoot, appendFn = appendFileSync, mkdirFn = mkdirSync } = {}) {
  try {
    if (typeof repoRoot !== "string" || repoRoot === "") return;
    const event = { timestamp: new Date().toISOString(), edition: null, stage: null, agent: "pr-create-preflight-guard", level: "info", message, details };
    const logPath = join(repoRoot, "data", "run-log.jsonl");
    mkdirFn(dirname(logPath), { recursive: true });
    appendFn(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // nunca propaga
  }
}

/** Primeiro filtro (puro, sem disco), exportado para o despachante (#14045). */
export function appliesTo(payload) {
  if (payload?.tool_name && payload.tool_name !== "Bash") return false;
  return isTscGuardedPrCreate(payload?.tool_input?.command);
}

/**
 * Decide sobre um payload PreToolUse: objeto de saída (deny ou aviso) ou
 * `undefined`. I/O injetável em `deps`.
 */
export function handlePayload(payload, deps = {}) {
  const {
    env = process.env,
    hookDir,
    resolveRepoRoot = (p, dir, cmd) => resolveGitRoot(resolveRepoRootCandidates(p?.cwd, dir, cmd)),
    isForeignRepo: isForeignRepoGhCommand = defaultIsForeignRepoGhCommand,
    isStudio: isStudioCheckout = defaultIsStudioCheckout,
    resolveLogRoot = studioLogRoot,
    readFile,
    runPreflightFn = runPreflight,
    logFn = logPreflightEvent,
  } = deps;

  if (!appliesTo(payload)) return;
  const command = payload?.tool_input?.command;
  const cwd = resolveRepoRoot(payload, hookDir, command);
  if (cwd === null) return;
  // #10618: PR de outro repo (diaria-design) — regra do studio não se aplica.
  if (isForeignRepoGhCommand(command, cwd)) return;
  const logRoot = resolveLogRoot(hookDir);
  if (isStudioCheckout(cwd, hookDir, { command }) === false) return;

  const source = bypassSource(command, env);
  if (source) {
    logFn("pr_create_preflight_bypassed", { source, command: String(command).slice(0, 500) }, { repoRoot: logRoot });
    return;
  }

  const { body, reason } = resolveBody(extractPrCreateBody(command), payload?.cwd ?? cwd, readFile);
  const run = runPreflightFn(cwd, { body, bodyReason: reason });
  if (run.infra) {
    // Checkout sem o script (branch antiga, outro repo): nada a conferir, sem ruído no run-log.
    if (run.missing) return;
    logFn("pr_create_preflight_infra_error", { output: String(run.output ?? "").slice(0, 500) }, { repoRoot: logRoot });
    return;
  }
  const { deny, warn } = run.result;
  if (deny.length) {
    logFn("pr_create_preflight_blocked", { deny }, { repoRoot: logRoot });
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: buildDenyMessage(deny) },
    };
  }
  if (warn.length) {
    const text = `Preflight da PR (#14216), aviso:\n${warn.join("\n")}`;
    return { systemMessage: text, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const output = handlePayload(JSON.parse(data || "{}"), { hookDir: dirname(fileURLToPath(import.meta.url)) });
      if (output) process.stdout.write(JSON.stringify(output));
    } catch {
      // Fail-open: um hook quebrado não trava `gh pr create` legítimo.
    }
  });
}
