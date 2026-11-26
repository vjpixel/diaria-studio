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
//   fora do event loop daqui. Um guard síncrono que trava não segura os
//   timers do despachante: no teto dele, `terminate()` e ele fica sem saída.
//   São os guards que não leem `data/` nem chamam git sem timeout.
// - `spawn-if-applies`: em processo próprio, só quando o filtro dele
//   (`appliesTo`, exportado pelo hook, puro, sem disco) diz que ele tem o
//   que decidir. São os que leem `data/sessions/` (guard de merge, checkout,
//   rm/git destrutivo, commit em worktree alheio) e os de `gh pr create`
//   (git/tsc/teste por dezenas de segundos). Processo travado em disco ou em
//   rede é morto no teto dele, como o harness fazia. No Bash comum, nenhum
//   desses se aplica e não há spawn.
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
// Limite conhecido: Worker presa numa chamada nativa bloqueante (leitura de
// arquivo citado no comando, num disco de rede travado) não termina com
// `terminate()`, e o Node espera a thread antes de sair. O deny já calculado
// sai no stdout na hora; o processo só termina quando a chamada volta ou o
// harness o mata. Os guards que leem `data/` ficam fora disso (processo
// próprio).
//
// Equivalência travada em `test/pretooluse-bash-dispatch-14045.test.ts`.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HOOK_DIR, "pretooluse-bash-dispatch-worker.mjs");

/**
 * Os guards, na ordem do settings.json antes do #14045. `timeoutMs` é o
 * `timeout` que o hook tinha lá. `onFilterError` (só `spawn-if-applies`):
 * `"run"` roda o guard quando o `appliesTo` lança; `"skip"` (padrão) não.
 */
export const GUARDS = Object.freeze([
  { file: "inject-session-id.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-gh-pr-merge-subagent.mjs", mode: "spawn-if-applies", timeoutMs: 10_000, onFilterError: "run" },
  { file: "block-gh-comment-secrets.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-branch-checkout-main.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-pr-create-pii-runtime-artifacts.mjs", mode: "spawn-if-applies", timeoutMs: 30_000, onFilterError: "run" },
  { file: "block-pr-create-tsc-failure.mjs", mode: "spawn-if-applies", timeoutMs: 90_000 },
  { file: "block-pr-create-orchestrator-snapshot-stale.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-pr-create-test-runner-import.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-unsafe-shared-checkout-ops.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-worktree-bare-push.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-npm-install-node-modules-symlink.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-worktree-alien-commit.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
  { file: "block-continuo-master-commit.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-handwritten-pr-checks-loop.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-raw-pr-review-comment.mjs", mode: "worker", timeoutMs: 10_000 },
  { file: "block-bash-protected-path-write.mjs", mode: "worker", timeoutMs: 10_000 },
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
 * `notices` (falhas do próprio despachante) entram no fim do `systemMessage`.
 * Uma saída única, sem aviso, volta igual. Nada a dizer: `null`.
 */
export function combineHookOutputs(outputs, notices = []) {
  const parsed = outputs.map(parseHookOutput).filter((o) => o !== null);
  if (parsed.length === 0 && notices.length === 0) return null;

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

/** Avalia o `appliesTo` do guard: `{ applies, notice? }`. */
async function evaluateFilter(guard, payload, payloadError, hooksDir) {
  // stdin que não é JSON: um aviso só, em `runGuards`; o guard fail-closed roda.
  if (payloadError !== null) return { applies: guard.onFilterError === "run" };
  try {
    const mod = await import(pathToFileURL(join(hooksDir, guard.file)).href);
    if (typeof mod.appliesTo !== "function") throw new Error("não exporta appliesTo (contrato #14045)");
    return { applies: mod.appliesTo(payload) === true };
  } catch (err) {
    const run = guard.onFilterError === "run";
    const what = `filtro lançou (${err?.message ?? err})${run ? ", guard rodado por precaução" : ""}`;
    return { applies: run, notice: notice(guard.file, what) };
  }
}

/** Guard em processo próprio, só quando o filtro dele diz que se aplica. */
function runSpawnIfApplies(guard, raw, payload, payloadError, hooksDir) {
  let child;
  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      child?.kill();
    } catch {
      // já saiu
    }
  };
  const done = (async () => {
    const filter = await evaluateFilter(guard, payload, payloadError, hooksDir);
    // Quando o guard rodou por precaução, o aviso do filtro vai junto da saída dele.
    const filterNotice = filter.notice;
    if (!filter.applies || stopped) return { out: "", notice: filterNotice };
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const notices = [filterNotice, value.notice].filter(Boolean);
        resolve({ out: value.out, notice: notices.length > 0 ? notices.join("\n") : undefined });
      };
      const timer = setTimeout(() => {
        stop();
        finish({ out: "", notice: notice(guard.file, `passou de ${guard.timeoutMs} ms`) });
      }, guard.timeoutMs);
      try {
        child = spawn(process.execPath, [join(hooksDir, guard.file)], {
          stdio: ["pipe", "pipe", "inherit"],
          windowsHide: true,
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
    });
  })();
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
  let payload = null;
  let payloadError = null;
  try {
    payload = JSON.parse(raw || "{}");
  } catch (err) {
    payloadError = err;
  }
  const outputs = new Array(guards.length).fill("");
  const noticesByGuard = new Array(guards.length).fill(null);
  const settled = new Array(guards.length).fill(false);
  const runs = guards.map((g) =>
    g.mode === "spawn-if-applies"
      ? runSpawnIfApplies(g, raw, payload, payloadError, hooksDir)
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
      resolve({ outputs: [...outputs], notices, early });
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
  const { outputs, notices } = await runGuards(raw, opts);
  const combined = combineHookOutputs(outputs, notices);
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
