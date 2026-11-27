// PreToolUse hook — recusa `gh pr create` com `docs/editorial-invariants.md`
// do commit defasado ou sem `removal-declaration:` no corpo de uma PR acima do
// limiar de adições (#14216).
//
// Origem: a medição da #14120 achou 5 ciclos de `dev-fixer` causados por essas
// duas falhas. As regras já estavam escritas (itens 13 e 29 de
// `context/overnight-dispatch-rules.md`) e foram ignoradas: prosa no prompt é
// probabilística, o CI só reprova depois do push. Este guard confere as duas
// antes de a PR existir, no checkout de onde o comando sai.
//
// Mecanismo: lê o corpo do comando sem rodar nada (`--body`/`-b` literal ou
// `"$(cat <<'X' ... X)"`, `--body-file`/`-F` com arquivo, `--body-file -` com
// heredoc) e o entrega por stdin a `scripts/check-pr-create-preflight.ts`, que
// compara o documento do HEAD com o registry, mede o diff contra o merge-base
// com `origin/{--base do comando, ou master}` (como o gate do CI, #9403) e
// decide (`scripts/lib/pr-create-preflight.ts`). O CLI roda com o `node` do
// próprio hook e o `tsx` do `node_modules` do checkout: sem shell, sem `npx`
// (nada baixado da rede, e o teto mata o processo certo).
//
// Direção de falha:
//   - nega só o que o CI reprovaria: documento do commit divergente, ausente
//     ou regenerado sem commit; corpo LIDO sem `removal-declaration:` com mais
//     de 500 adições;
//   - corpo que só existe ao rodar (variável, substituição de comando que não é
//     `cat` de heredoc com delimitador entre aspas, crase, `--fill`), diff não
//     medido, registry sujo ou que não carrega, `--head` de outra branch:
//     aviso no `systemMessage`, nunca recusa. A leitura do `$` é conservadora:
//     na dúvida, "não determinável" (aviso), nunca texto inventado;
//   - checkout sem o script (branch antiga, outro repo): silencioso, nada a
//     conferir;
//   - preflight que não rodou (sem `tsx` no checkout, spawn que falha ou passa
//     do teto, saída fora do formato): deixa passar, com `systemMessage`
//     dizendo que NÃO rodou e o log em `data/run-log.jsonl` (`level: warn`).
//
// Escape hatch, explícito e logado (`level: warn`):
// `DIARIA_ALLOW_PR_WITHOUT_PREFLIGHT=1` no ambiente da sessão ou como
// atribuição na frente do `gh pr create`.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cdTargetFromCommand, resolveRepoRootCandidates, resolveGitRoot } from "./block-pr-create-pii-runtime-artifacts.mjs";
import { isTscGuardedPrCreate, liveCommandText } from "./block-pr-create-tsc-failure.mjs";
import { isForeignRepoGhCommand as defaultIsForeignRepoGhCommand } from "./lib/gh-target-repo.mjs";
import { isStudioCheckout as defaultIsStudioCheckout, studioLogRoot } from "./lib/studio-checkout.mjs";
import { resolveCommandWords, tokenizeShell } from "../../scripts/lib/protected-path-bash-write.mjs";

export const PREFLIGHT_PR_GUARD_BYPASS_ENV = "DIARIA_ALLOW_PR_WITHOUT_PREFLIGHT";
export const PREFLIGHT_SCRIPT = "scripts/check-pr-create-preflight.ts";
/** Loader do tsx dentro do checkout (o `"."` do `exports` do pacote). */
export const TSX_LOADER = "node_modules/tsx/dist/loader.mjs";

const BYPASS_ASSIGNMENT_RE = new RegExp(
  String.raw`(?:^|&&|;|\|\||\||\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*${PREFLIGHT_PR_GUARD_BYPASS_ENV}=1\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*gh\s+pr\s+create\b`,
);

/** De onde veio o pedido de bypass (`"env"`, `"command"`) ou `null`. */
export function bypassSource(command, env = process.env) {
  if (env?.[PREFLIGHT_PR_GUARD_BYPASS_ENV] === "1") return "env";
  if (typeof command === "string" && BYPASS_ASSIGNMENT_RE.test(liveCommandText(command))) return "command";
  return null;
}

// ---------------------------------------------------------------------------
// Leitura crua do comando (com as aspas), só para o `gh pr create`.
// ---------------------------------------------------------------------------

const HEREDOC_OP_RE = /^<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/;

/** Índice logo depois do corpo do heredoc que começa na linha seguinte a `from` (`n` se não fechar). */
function skipHeredocBody(src, from, delim, strip) {
  let nl = src.indexOf("\n", from);
  if (nl < 0) return src.length;
  let pos = nl + 1;
  while (pos <= src.length) {
    const end = src.indexOf("\n", pos);
    const line = src.slice(pos, end < 0 ? src.length : end);
    if ((strip ? line.replace(/^\t+/, "") : line) === delim) return end < 0 ? src.length : end;
    if (end < 0) return src.length;
    pos = end + 1;
  }
  return src.length;
}

/** Fim (exclusivo) da substituição `$(` aberta em `open` (índice do `(`), com aspas e heredoc dentro. */
function scanParen(src, open) {
  let depth = 1;
  let j = open + 1;
  const pending = [];
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") j += 2;
    else if (c === "'") {
      const k = src.indexOf("'", j + 1);
      j = k < 0 ? src.length : k + 1;
    } else if (c === '"') j = scanDouble(src, j);
    else if (c === "<" && src[j + 1] === "<") {
      const m = HEREDOC_OP_RE.exec(src.slice(j));
      if (m) {
        pending.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        j += m[0].length;
      } else j += 2;
    } else if (c === "\n" && pending.length) {
      let k = j;
      while (pending.length) {
        const h = pending.shift();
        k = skipHeredocBody(src, k, h.delim, h.strip);
      }
      j = k;
    } else if (c === "(") {
      depth++;
      j++;
    } else if (c === ")") {
      depth--;
      j++;
      if (depth === 0) return j;
    } else j++;
  }
  return src.length;
}

/** Fim (exclusivo) da string entre aspas duplas aberta em `i`. */
function scanDouble(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") j += 2;
    else if (c === '"') return j + 1;
    else if (c === "$" && src[j + 1] === "(") j = scanParen(src, j + 1);
    else if (c === "`") {
      const k = src.indexOf("`", j + 1);
      j = k < 0 ? src.length : k + 1;
    } else j++;
  }
  return src.length;
}

/**
 * Palavras CRUAS (aspas e substituições preservadas) de cada comando simples
 * de `src`, separados por `;`, `&`, `|` ou quebra de linha fora de aspas.
 * Corpo de heredoc é pulado (não vira comando).
 */
export function rawCommandWords(src) {
  const cmds = [];
  if (typeof src !== "string") return cmds;
  let words = [];
  let cur = null;
  const pending = [];
  const add = (s) => (cur = (cur ?? "") + s);
  const flush = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endCmd = () => {
    flush();
    if (words.length) cmds.push(words);
    words = [];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const k = src.indexOf("'", i + 1);
      const end = k < 0 ? src.length : k + 1;
      add(src.slice(i, end));
      i = end;
    } else if (c === '"') {
      const end = scanDouble(src, i);
      add(src.slice(i, end));
      i = end;
    } else if (c === "\\") {
      add(src.slice(i, i + 2));
      i += 2;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = scanParen(src, i + 1);
      add(src.slice(i, end));
      i = end;
    } else if (c === "`") {
      const k = src.indexOf("`", i + 1);
      const end = k < 0 ? src.length : k + 1;
      add(src.slice(i, end));
      i = end;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      flush();
      const m = HEREDOC_OP_RE.exec(src.slice(i));
      if (m) {
        pending.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        i += m[0].length;
      } else i += 2;
    } else if (c === "\n") {
      endCmd();
      let k = i;
      while (pending.length) {
        const h = pending.shift();
        k = skipHeredocBody(src, k, h.delim, h.strip);
      }
      i = k + 1;
    } else if (c === ";" || c === "&" || c === "|") {
      endCmd();
      i++;
    } else if (c === " " || c === "\t") {
      flush();
      i++;
    } else {
      add(c);
      i++;
    }
  }
  endCmd();
  return cmds;
}

/** `$` que o bash expande: seguido de nome, `{`, `(`, dígito ou parâmetro especial. */
const EXPANDING_DOLLAR_RE = /^\$[A-Za-z_{(0-9@*#?$!-]/;

/** `"$(cat <<'X' ... X)"` com o delimitador entre aspas: o corpo é literal. */
const CAT_QUOTED_HEREDOC_RE = /^"\$\(\s*cat\s+<<(-?)\s*(['"])([^'"\n]+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*\n?\s*\)"$/;

/**
 * Valor de uma palavra crua do shell, sem rodar nada: `{ text }` quando ele é
 * fixo, `{ dynamic: true }` quando depende de expansão (variável, substituição
 * de comando, crase). Aspas simples são literais (`'custa R$ 4.000'`); `$`
 * sem nome depois também. A única substituição aceita como fixa é `cat` de
 * heredoc com delimitador entre aspas, o formato padrão de `--body`.
 */
export function rawWordValue(raw) {
  if (typeof raw !== "string") return { dynamic: true };
  const hd = CAT_QUOTED_HEREDOC_RE.exec(raw);
  if (hd) return { text: hd[1] === "-" ? hd[4].replace(/^\t+/gm, "") : hd[4] };
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      const k = raw.indexOf("'", i + 1);
      if (k < 0) return { dynamic: true };
      out += raw.slice(i + 1, k);
      i = k + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === "\\" && '"\\$`\n'.includes(raw[j + 1] ?? "")) {
          out += raw[j + 1];
          j += 2;
          continue;
        }
        if (raw[j] === "`" || (raw[j] === "$" && EXPANDING_DOLLAR_RE.test(raw.slice(j)))) return { dynamic: true };
        out += raw[j];
        j++;
      }
      if (j >= raw.length) return { dynamic: true };
      i = j + 1;
    } else if (c === "\\") {
      out += raw[i + 1] ?? "";
      i += 2;
    } else if (c === "`" || (c === "$" && EXPANDING_DOLLAR_RE.test(raw.slice(i)))) {
      return { dynamic: true };
    } else {
      out += c;
      i++;
    }
  }
  return { text: out };
}

/** Flags do `gh pr create` que levam valor (o valor nunca é lido como flag). */
const PR_CREATE_VALUE_FLAGS = new Set([
  "--title", "-t", "--head", "-H", "--base", "-B", "--label", "-l", "--assignee", "-a",
  "--reviewer", "-r", "--milestone", "-m", "--project", "-p", "--template", "-T", "--repo", "-R", "--recover",
]);
const GH_GLOBAL_VALUE_FLAGS = new Set(["-R", "--repo"]);
const STDIN_FILES = new Set(["-", "/dev/stdin", "/dev/fd/0"]);
const FILL_FLAGS = new Set(["--fill", "--fill-first", "--fill-verbose", "-f"]);

/** Corpo do heredoc entregue ao `gh pr create` (tokenizer do guard #12009), ou `null`. */
function prCreateStdin(command) {
  for (const cmd of tokenizeShell(command)) {
    const w = resolveCommandWords(cmd.words);
    let i = 0;
    if (w[i] !== "gh" && !/[\\/]gh(?:\.exe)?$/.test(w[i] ?? "")) continue;
    i++;
    while (i < w.length && w[i].startsWith("-")) i += GH_GLOBAL_VALUE_FLAGS.has(w[i]) ? 2 : 1;
    if (w[i] === "pr" && w[i + 1] === "create") return cmd.stdin.length ? cmd.stdin.join("\n") : null;
  }
  return null;
}

/**
 * Corpo, base e head do `gh pr create` do comando, sem rodar nada.
 * `kind`: `"text"` (`body`), `"file"` (`path`, relativo ao diretório do
 * comando) ou `"unknown"` (`reason`). `base`/`head`: o valor literal das
 * flags, quando houver.
 */
export function extractPrCreateBody(command) {
  if (typeof command !== "string") return { kind: "unknown", reason: "comando ilegível" };
  for (const raw of rawCommandWords(command)) {
    const words = raw.map((r) => ({ raw: r, value: rawWordValue(r) }));
    const text = (k) => words[k]?.value.text;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].raw)) i++;
    const head = text(i);
    if (head !== "gh" && !/[\\/]gh(?:\.exe)?$/.test(head ?? "")) continue;
    i++;
    while (i < words.length && (text(i) ?? "").startsWith("-")) i += GH_GLOBAL_VALUE_FLAGS.has(text(i)) ? 2 : 1;
    if (text(i) !== "pr" || text(i + 1) !== "create") continue;
    const out = { kind: "unknown", reason: "gh pr create sem --body nem --body-file" };
    let base = null;
    let headRef = null;
    let found = null;
    for (let k = i + 2; k < words.length; k++) {
      const name = text(k);
      if (name === undefined) continue;
      if (name === "--") break;
      const eq = name.indexOf("=");
      const flag = name.startsWith("--") && eq > 0 ? name.slice(0, eq) : name;
      const inlineRaw = flag !== name ? words[k].raw.slice(words[k].raw.indexOf("=") + 1) : null;
      const valueAt = () => (inlineRaw !== null ? { raw: inlineRaw, value: rawWordValue(inlineRaw) } : words[++k]);
      if (flag === "--body" || flag === "-b" || (/^-b./.test(name) && !name.startsWith("--"))) {
        const v = flag === "--body" || name === "-b" ? valueAt() : { value: rawWordValue(words[k].raw.slice(words[k].raw[2] === "=" ? 3 : 2)) };
        if (!v) found ??= { kind: "unknown", reason: "--body sem valor" };
        else if (v.value.dynamic) found ??= { kind: "unknown", reason: "--body montado por expansão de shell" };
        else found ??= { kind: "text", body: v.value.text };
      } else if (flag === "--body-file" || flag === "-F" || (/^-F./.test(name) && !name.startsWith("--"))) {
        const v = flag === "--body-file" || name === "-F" ? valueAt() : { value: rawWordValue(words[k].raw.slice(words[k].raw[2] === "=" ? 3 : 2)) };
        if (!v) found ??= { kind: "unknown", reason: "--body-file sem valor" };
        else if (v.value.dynamic) found ??= { kind: "unknown", reason: "--body-file com expansão de shell" };
        else if (STDIN_FILES.has(v.value.text)) {
          const stdin = prCreateStdin(command);
          found ??= stdin !== null ? { kind: "text", body: stdin } : { kind: "unknown", reason: "--body-file - sem heredoc legível" };
        } else if (v.value.text === "") found ??= { kind: "unknown", reason: "--body-file sem valor" };
        else found ??= { kind: "file", path: v.value.text };
      } else if (FILL_FLAGS.has(flag)) {
        found ??= { kind: "unknown", reason: `${flag}: o gh monta o corpo dos commits` };
      } else if (PR_CREATE_VALUE_FLAGS.has(flag)) {
        const v = valueAt();
        if (flag === "--base" || flag === "-B") base = v?.value.text ?? null;
        if (flag === "--head" || flag === "-H") headRef = v?.value.text ?? "(dinâmico)";
      }
    }
    return { ...(found ?? out), base, head: headRef };
  }
  return { kind: "unknown", reason: "gh pr create não encontrado no comando", base: null, head: null };
}

/** Lê o corpo (`text` volta igual; `file` é lido relativo a `dir`, o diretório do comando). */
export function resolveBody(extracted, dir, readFile = (p) => readFileSync(p, "utf8")) {
  if (extracted.kind === "text") return { body: extracted.body, reason: null };
  if (extracted.kind === "file") {
    const path = isAbsolute(extracted.path) ? extracted.path : resolvePath(dir, extracted.path);
    try {
      return { body: readFile(path), reason: null };
    } catch (e) {
      return { body: null, reason: `--body-file ${extracted.path} ilegível: ${e?.message ?? e}` };
    }
  }
  return { body: null, reason: extracted.reason };
}

/** Diretório onde o `gh pr create` roda: o alvo do `cd` do comando, senão o `cwd` do payload. */
export function commandDir(command, payloadCwd, fallback) {
  return cdTargetFromCommand(command, payloadCwd) ?? (typeof payloadCwd === "string" && payloadCwd !== "" ? payloadCwd : fallback);
}

const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Roda o CLI no checkout `cwd` com o `node` atual e o `tsx` do checkout, sem
 * shell. Resultado: `{ infra: true, missing?, output }` ou
 * `{ infra: false, code, result }`.
 */
export function runPreflight(cwd, { body, bodyReason, base = null, warnOnly = null }, spawnFn = spawnSync, exists = existsSync) {
  if (!exists(join(cwd, PREFLIGHT_SCRIPT))) return { infra: true, missing: true, output: `${PREFLIGHT_SCRIPT} ausente neste checkout` };
  const loader = join(cwd, TSX_LOADER);
  if (!exists(loader)) return { infra: true, output: `${TSX_LOADER} ausente neste checkout (rode npm ci no worktree)` };
  const args = ["--import", pathToFileURL(loader).href, PREFLIGHT_SCRIPT, "--base", base && SAFE_REF_RE.test(base) ? `origin/${base}` : "origin/master"];
  if (body !== null) args.push("--body-stdin");
  if (warnOnly) args.push("--warn-only", warnOnly);
  const r = spawnFn(process.execPath, args, {
    cwd,
    input: body ?? "",
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: bodyReason ? { ...process.env, DIARIA_PREFLIGHT_BODY_UNKNOWN: bodyReason } : process.env,
  });
  if (!r || r.error) return { infra: true, output: String(r?.error?.message ?? "spawn falhou") };
  if (r.status === null) return { infra: true, output: "preflight não terminou (timeout ou sinal)" };
  if (r.status !== 0 && r.status !== 1) return { infra: true, output: `exit ${r.status}: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(0, 1000)}` };
  const lines = String(r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1] ?? "";
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

/** Mensagem de quando o preflight não rodou: nunca silêncio. */
export function buildInfraMessage(output) {
  return (
    `Preflight da PR (#14216) NÃO rodou: ${String(output ?? "motivo desconhecido").slice(0, 300)}; ` +
    "confira à mão npx tsx scripts/list-invariants.ts --check docs/editorial-invariants.md e a linha removal-declaration: (PR acima de 500 adições)."
  );
}

/** Evento em `data/run-log.jsonl`; fail-soft. */
export function logPreflightEvent(message, details, { repoRoot, level = "info", appendFn = appendFileSync, mkdirFn = mkdirSync } = {}) {
  try {
    if (typeof repoRoot !== "string" || repoRoot === "") return;
    const event = { timestamp: new Date().toISOString(), edition: null, stage: null, agent: "pr-create-preflight-guard", level, message, details };
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

const warnOutput = (text) => ({ systemMessage: text, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

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
    logFn("pr_create_preflight_bypassed", { source, command: String(command).slice(0, 500) }, { repoRoot: logRoot, level: "warn" });
    return;
  }

  const extracted = extractPrCreateBody(command);
  const { body, reason } = resolveBody(extracted, commandDir(command, payload?.cwd, cwd), readFile);
  const warnOnly = extracted.head ? `--head ${extracted.head}: o guard confere o checkout atual, não a branch da PR` : null;
  const run = runPreflightFn(cwd, { body, bodyReason: reason, base: extracted.base ?? null, warnOnly });
  if (run.infra) {
    // Checkout sem o script (branch antiga, outro repo): nada a conferir.
    if (run.missing) return;
    logFn("pr_create_preflight_infra_error", { output: String(run.output ?? "").slice(0, 500) }, { repoRoot: logRoot, level: "warn" });
    return warnOutput(buildInfraMessage(run.output));
  }
  const { deny, warn } = run.result;
  if (deny.length) {
    logFn("pr_create_preflight_blocked", { deny }, { repoRoot: logRoot });
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: buildDenyMessage(deny) },
    };
  }
  if (warn.length) return warnOutput(`Preflight da PR (#14216), aviso:\n${warn.join("\n")}`);
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
    } catch (e) {
      // Deixa a PR passar, mas nunca em silêncio.
      process.stderr.write(`block-pr-create-preflight (#14216): ${e?.stack ?? e}\n`);
      process.stdout.write(JSON.stringify(warnOutput(buildInfraMessage(`o hook falhou (${e?.message ?? e})`))));
    }
  });
}
