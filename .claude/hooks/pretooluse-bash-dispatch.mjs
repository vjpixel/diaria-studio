// PreToolUse hook (matcher Bash) — despachante único dos 16 guards de Bash
// (#14045).
//
// Antes, `.claude/settings.json` registrava os 16 guards como 16 hooks
// separados: o harness spawnava 16 processos `node` em paralelo a cada Bash.
// Medido em 26/11/2026 no Neo: ~0,3 s por Bash sem carga, mais com outras
// sessões ativas. Este arquivo é o único hook PreToolUse/Bash dos guards:
// roda os 16 em paralelo e devolve UMA saída combinada.
//
// Onde cada guard roda (`mode` em `GUARDS`):
// - `worker`: numa Worker própria (`pretooluse-bash-dispatch-worker.mjs`),
//   fora do event loop daqui. Só guard puro (injeção de `--session-id`, laço
//   de `gh pr checks`, review cru): travado num laço, `terminate()` no teto
//   dele e ele fica sem saída.
// - `spawn-if-applies`: todo guard que toca disco ou git, em processo
//   próprio, só quando o filtro dele (`appliesTo`, exportado pelo hook, puro,
//   sem disco) diz que ele tem o que decidir. Import e filtro também rodam
//   em processo cancelável, dentro do mesmo teto (#14302). Processo travado em disco, git
//   ou rede é morto no teto dele com a árvore de filhos (`killProcessTree`),
//   como o harness fazia. O CLI só é iniciado quando o filtro se aplica.
//
// O que é preservado, guard a guard:
// - Mesma entrada: cada guard recebe o stdin CRU original (no harness os 16
//   rodavam em paralelo e nenhum via o `updatedInput` de outro).
// - Mesma decisão e mensagem: a saída é a que o CLI do guard escreveria (o
//   CLI de cada um chama o mesmo `runHook`).
// - Mesma composição (`combineHookOutputs`): deny > ask > allow; no empate,
//   o primeiro na ordem de `GUARDS` (a ordem antiga do settings.json);
//   `updatedInput` só sem deny; `systemMessage`/`additionalContext` somados.
// - Mesmo teto por guard (`timeoutMs` = o `timeout` antigo), e todos correm
//   em paralelo: o pior caso do grupo é o maior teto, não a soma.
//
// O que mudou de propósito (review da PR #14107):
// - Deny sai NA HORA: assim que um guard nega e nenhum anterior a ele na
//   ordem está pendente, a saída é escrita e o processo sai. Um guard lento
//   ou travado depois dele não atrasa nem apaga o deny.
// - Falha de guard (não carregou, lançou, passou do teto, filtro lançou)
//   aparece no `systemMessage`, além do stderr: nunca é silêncio com exit 0.
// - Filtro que lança: o guard de PII e o de merge rodam mesmo assim
//   (`onFilterError: "run"`, fail-closed); os demais ficam sem decisão,
//   com o aviso.
//
// Por que nenhum guard de disco roda em Worker: uma Worker presa numa chamada
// nativa bloqueante não termina com `terminate()`, e o Node espera a thread
// antes de sair, com qualquer forma de saída que devolva código 0 (ver o
// docblock de `GUARDS`). Teste: `test/pretooluse-bash-dispatch-14045.test.ts`
// trava que os guards de `worker` não importam `node:fs` nem
// `node:child_process`.
//
// Equivalência travada em `test/pretooluse-bash-dispatch-14045.test.ts`.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HOOK_DIR, "pretooluse-bash-dispatch-worker.mjs");

/**
 * Os guards, na ordem do settings.json antes do #14045 (guard novo entra no
 * fim, #14216). `timeoutMs` é o
 * `timeout` que o hook tinha lá. `onFilterError` (só `spawn-if-applies`):
 * `"run"` roda o guard quando o `appliesTo` lança; `"skip"` (padrão) não.
 * `failureAsContext`: a falha do guard vai também no `additionalContext`
 * (o `inject-session-id` que falha deixa o comando sem `--session-id`, e o
 * modelo precisa saber disso para não ler o erro seguinte como outra coisa).
 *
 * Só guard PURO (sem disco, sem git, sem rede) roda em `worker`: travado num
 * laço, `terminate()` o encerra. Uma Worker presa numa chamada nativa não
 * encerraria, e o Node espera a thread antes de sair (medido em 26/11/2026:
 * `process.exit`, `process.reallyExit` e `unref()` esperam; matar o próprio
 * processo sai com código 1, e o harness descarta o JSON de saída com código
 * diferente de 0). Por isso todo guard que toca disco ou git roda em
 * processo próprio.
 */
export const GUARDS = Object.freeze([
  { file: "inject-session-id.mjs", mode: "worker", timeoutMs: 10_000, failureAsContext: true },
  { file: "block-gh-pr-merge-subagent.mjs", mode: "spawn-if-applies", timeoutMs: 10_000, onFilterError: "run" },
  { file: "block-gh-comment-secrets.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-branch-checkout-main.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-pr-create-pii-runtime-artifacts.mjs", mode: "spawn-if-applies", timeoutMs: 30_000, onFilterError: "run" },
  { file: "block-pr-create-tsc-failure.mjs", mode: "spawn-if-applies", timeoutMs: 90_000 },
  { file: "block-pr-create-orchestrator-snapshot-stale.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-pr-create-test-runner-import.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-unsafe-shared-checkout-ops.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-worktree-bare-push.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-npm-install-node-modules-symlink.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-worktree-alien-commit.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-continuo-master-commit.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-handwritten-pr-checks-loop.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-raw-pr-review-comment.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-bash-protected-path-write.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  // Depois do #14045 (fora da lista antiga): preflight de invariantes e removal-declaration (#14216).
  { file: "block-pr-create-preflight.mjs", mode: "spawn-if-applies", timeoutMs: 60_000 },
]);

/** Folga sobre o maior teto: partida do node, das Workers e dos processos. */
export const STARTUP_MARGIN_MS = 15_000;

/**
 * Pior caso do grupo, em ms. Os guards correm todos em paralelo (nenhum
 * espera outro), então a cadeia em série tem um elo só por guard e o pior
 * caso é o maior teto mais a folga de partida.
 */
export function worstCaseMs(guards = GUARDS) {
  return Math.max(0, ...guards.map((g) => g.timeoutMs)) + STARTUP_MARGIN_MS;
}

const DECISION_RANK = { deny: 3, ask: 2, allow: 1 };

/** Lê a saída de um guard como objeto JSON; texto que não é objeto JSON é ignorado (o harness também não tirava decisão dele). */
function parseHookOutput(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Combina as saídas dos guards (texto cru, na ordem de `GUARDS`) numa saída
 * só, com a semântica que o harness aplicava a vários hooks do mesmo evento:
 * - decisão: a mais restritiva (deny > ask > allow); no empate, a primeira,
 *   com o motivo dela;
 * - `updatedInput`: o do primeiro guard que reescreveu o comando, só sem
 *   deny (comando negado não roda, a reescrita não importa);
 * - `systemMessage` e `additionalContext`: todos, um por linha;
 * - outra chave de topo (`continue`, `stopReason`...): a primeira.
 * `notices` (falhas do próprio despachante) entram no fim do `systemMessage`;
 * `contextNotices` (falha de guard cujo silêncio o modelo precisa saber, ex.
 * `--session-id` não injetado) também no fim do `additionalContext`.
 * Uma saída única, sem aviso, volta igual. Nada a dizer: `null`.
 */
export function combineHookOutputs(outputs, notices = [], contextNotices = []) {
  const parsed = outputs.map(parseHookOutput).filter((o) => o !== null);
  if (parsed.length === 0 && notices.length === 0 && contextNotices.length === 0) return null;

  let decided = null;
  for (const o of parsed) {
    const rank = DECISION_RANK[o.hookSpecificOutput?.permissionDecision] ?? 0;
    if (rank > 0 && (decided === null || rank > DECISION_RANK[decided.permissionDecision])) {
      decided = o.hookSpecificOutput;
    }
  }

  const result = {};
  const messages = parsed.map((o) => o.systemMessage).filter((m) => typeof m === "string" && m !== "");
  messages.push(...notices);
  if (messages.length > 0) result.systemMessage = messages.join("\n");
  for (const o of parsed) {
    for (const [key, value] of Object.entries(o)) {
      if (key === "systemMessage" || key === "hookSpecificOutput" || key in result) continue;
      result[key] = value;
    }
  }

  const specific = { hookEventName: "PreToolUse" };
  if (decided !== null) {
    specific.permissionDecision = decided.permissionDecision;
    if (decided.permissionDecisionReason !== undefined) {
      specific.permissionDecisionReason = decided.permissionDecisionReason;
    }
  }
  if (decided?.permissionDecision !== "deny") {
    const rewrite = parsed.find((o) => o.hookSpecificOutput?.updatedInput !== undefined);
    if (rewrite) specific.updatedInput = rewrite.hookSpecificOutput.updatedInput;
  }
  const contexts = parsed
    .map((o) => o.hookSpecificOutput?.additionalContext)
    .filter((c) => typeof c === "string" && c !== "");
  contexts.push(...contextNotices);
  if (contexts.length > 0) specific.additionalContext = contexts.join("\n");
  if (Object.keys(specific).length > 1) result.hookSpecificOutput = specific;

  return Object.keys(result).length > 0 ? result : null;
}

function isDeny(text) {
  return parseHookOutput(text)?.hookSpecificOutput?.permissionDecision === "deny";
}

function notice(file, what) {
  const line = `pretooluse-bash-dispatch (#14045): ${file} ${what}; guard sem decisão nesta chamada.`;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr indisponível: o aviso ainda vai no systemMessage.
  }
  return line;
}

/**
 * Guard numa Worker. Resolve `{ out, notice?, stop }`; `stop()` encerra a
 * Worker (quando a decisão sai antes de ela terminar).
 */
function runInWorker(guard, raw, hooksDir) {
  let worker;
  const stop = () => {
    try {
      worker?.terminate();
    } catch {
      // já saiu
    }
  };
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      stop();
      finish({ out: "", notice: notice(guard.file, `passou de ${guard.timeoutMs} ms`) });
    }, guard.timeoutMs);
    try {
      worker = new Worker(WORKER_SCRIPT, {
        workerData: { url: pathToFileURL(join(hooksDir, guard.file)).href, raw },
        // stdout da Worker separado e descartado: só a mensagem dela conta,
        // e escrita solta não corrompe o JSON do despachante.
        stdout: true,
        stderr: false,
      });
      worker.stdout.resume();
    } catch (err) {
      finish({ out: "", notice: notice(guard.file, `não abriu a Worker (${err?.message ?? err})`) });
      return;
    }
    worker.on("message", (m) =>
      finish(m?.error !== undefined ? { out: "", notice: notice(guard.file, String(m.error)) } : { out: String(m?.out ?? "") }),
    );
    worker.on("error", (err) => finish({ out: "", notice: notice(guard.file, `falhou (${err?.message ?? err})`) }));
    worker.on("exit", () => finish({ out: "", notice: notice(guard.file, "saiu sem resposta") }));
  });
  return { done, stop };
}

/**
 * Mata o processo do guard E os filhos dele (tsc, node --test, git): no
 * win32 `taskkill /T /F`, no POSIX o grupo de processos (o filho nasce
 * `detached`, líder do próprio grupo). Sem isso, matar só o guard deixaria
 * o tsc ou o teste órfão rodando.
 */
export function killProcessTree(child, { platform = process.platform, spawnFn = spawn, killFn = process.kill } = {}) {
  if (!child || typeof child.pid !== "number" || child.exitCode !== null || child.signalCode !== null) return;
  const fallback = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // já saiu
    }
  };
  try {
    if (platform === "win32") {
      const k = spawnFn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      k.on?.("error", fallback);
      k.unref?.();
    } else {
      killFn(-child.pid, "SIGKILL");
    }
  } catch {
    fallback();
  }
}

/** Guard em processo próprio, só quando o filtro dele diz que se aplica. */
function runSpawnIfApplies(guard, raw, payloadError, hooksDir) {
  let child;
  let stopped = false;
  let timer;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    killProcessTree(child);
  };
  const done = new Promise((resolve) => {
    let filterNotice;
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const notices = [filterNotice, value.notice].filter(Boolean);
      resolve({ out: value.out, notice: notices.length > 0 ? notices.join("\n") : undefined });
    };
    // Um teto único cobre import, filtro e CLI (#14302).
    timer = setTimeout(() => {
      stop();
      finish({ out: "", notice: notice(guard.file, `passou de ${guard.timeoutMs} ms`) });
    }, guard.timeoutMs);
    const runCli = () => {
      if (stopped || settled) return;
      try {
        child = spawn(process.execPath, [join(hooksDir, guard.file)], {
          stdio: ["pipe", "pipe", "inherit"],
          windowsHide: true,
          // POSIX: líder do próprio grupo, para `killProcessTree` levar os netos.
          detached: process.platform !== "win32",
        });
      } catch (err) {
        finish({ out: "", notice: notice(guard.file, `não spawnou (${err?.message ?? err})`) });
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (out += c));
      child.on("error", (err) => finish({ out: "", notice: notice(guard.file, `falhou (${err?.message ?? err})`) }));
      child.on("close", () => finish({ out }));
      child.stdin.on("error", () => {});
      child.stdin.end(raw);
    };
    const filterFailed = (error) => {
      const run = guard.onFilterError === "run";
      filterNotice = notice(guard.file, `filtro lançou (${error})${run ? ", guard rodado por precaução" : ""}`);
      if (run) runCli();
      else finish({ out: "" });
    };
    if (payloadError !== null) {
      if (guard.onFilterError === "run") runCli();
      else finish({ out: "" });
    } else {
      // Processo, não Worker: até import preso em I/O nativo pode ser morto.
      let filter;
      let answered = false;
      const answer = (message) => {
        if (answered || settled || stopped) return;
        answered = true;
        killProcessTree(filter);
        if (message.error !== undefined) filterFailed(message.error);
        else if (message.applies === true) runCli();
        else finish({ out: "" });
      };
      try {
        filter = child = spawn(process.execPath, [join(HOOK_DIR, "pretooluse-bash-dispatch-filter.mjs"), pathToFileURL(join(hooksDir, guard.file)).href], {
          stdio: ["pipe", "ignore", "inherit", "ipc"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
        filter.on("message", answer);
        filter.on("error", (err) => answer({ error: err.message }));
        filter.on("close", () => answer({ error: "filtro saiu sem resposta" }));
        filter.stdin.on("error", () => {});
        filter.stdin.end(raw);
      } catch (err) {
        answer({ error: err?.message ?? String(err) });
      }
    }
  });
  return { done, stop };
}

/**
 * Roda os guards em paralelo e resolve assim que a decisão está fechada:
 * - um deny cujos anteriores na ordem já terminaram (sem deny): na hora;
 * - senão, quando todos terminaram.
 * Devolve `{ outputs, notices, early }` (saídas na ordem de `guards`; as de
 * guard ainda pendente numa saída antecipada ficam `""`). Os pendentes são
 * encerrados antes de resolver.
 */
export function runGuards(raw, { guards = GUARDS, hooksDir = HOOK_DIR } = {}) {
  let payloadError = null;
  try {
    JSON.parse(raw || "{}");
  } catch (err) {
    payloadError = err;
  }
  const outputs = new Array(guards.length).fill("");
  const noticesByGuard = new Array(guards.length).fill(null);
  const settled = new Array(guards.length).fill(false);
  const runs = guards.map((g) =>
    g.mode === "spawn-if-applies"
      ? runSpawnIfApplies(g, raw, payloadError, hooksDir)
      : runInWorker(g, raw, hooksDir),
  );
  return new Promise((resolve) => {
    let resolved = false;
    const conclude = (early) => {
      if (resolved) return;
      resolved = true;
      for (const [i, r] of runs.entries()) if (!settled[i]) r.stop();
      const notices = noticesByGuard.filter(Boolean);
      if (payloadError !== null) notices.unshift(notice("stdin", `não é JSON (${payloadError.message})`));
      const contextNotices = noticesByGuard.filter((n, i) => n && guards[i].failureAsContext === true);
      resolve({ outputs: [...outputs], notices, contextNotices, early });
    };
    const check = () => {
      for (let i = 0; i < guards.length; i++) {
        if (!settled[i]) return; // anterior pendente: não decide ainda
        if (isDeny(outputs[i])) return conclude(i < guards.length - 1 && settled.some((s) => !s));
      }
      conclude(false);
    };
    runs.forEach((r, i) =>
      r.done.then((res) => {
        outputs[i] = res.out;
        noticesByGuard[i] = res.notice ?? null;
        settled[i] = true;
        check();
      }),
    );
    if (guards.length === 0) conclude(false);
  });
}

/** Saída final do despachante (texto JSON) ou `""` quando ninguém tem o que dizer. */
export async function dispatch(raw, opts) {
  const { outputs, notices, contextNotices } = await runGuards(raw, opts);
  const combined = combineHookOutputs(outputs, notices, contextNotices);
  return combined === null ? "" : JSON.stringify(combined);
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
  process.stdin.on("end", async () => {
    let out = "";
    try {
      out = await dispatch(data);
    } catch (err) {
      // O despachante quebrado não trava Bash, mas avisa.
      out = JSON.stringify({ systemMessage: notice("despachante", `lançou (${err?.message ?? err})`) });
    }
    // Sai explicitamente: Worker encerrada ou processo morto podem deixar
    // handle vivo por um instante.
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
