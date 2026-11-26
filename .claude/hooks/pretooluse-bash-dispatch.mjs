// PreToolUse hook (matcher Bash) — despachante único dos 16 guards de Bash
// (#14045).
//
// Antes, `.claude/settings.json` registrava os 16 guards como 16 hooks
// separados: o harness spawnava 16 processos `node` em paralelo a cada Bash.
// Medido em 26/11/2026 no Neo: 16 spawns em paralelo custam ~0,3 s por Bash
// sem carga e passam de 1 s com outras sessões ativas; um processo só custa
// uma fração disso. Este arquivo é o único hook PreToolUse/Bash dos guards:
// roda cada um no próprio processo e devolve UMA saída combinada.
//
// O que é preservado, guard a guard:
// - Mesma entrada: cada guard recebe o stdin CRU original (o harness rodava
//   os 16 em paralelo, então nenhum via o `updatedInput` de outro; o
//   `--session-id` do `inject-session-id.mjs` também não é visto pelos
//   demais aqui).
// - Mesma decisão e mesma mensagem: a saída JSON de cada guard é a que o CLI
//   dele escreveria (os 12 guards rápidos expõem `runHook(data, write)`, e o
//   CLI de cada um chama a mesma função).
// - Mesma composição: `combineHookOutputs` aplica a precedência do harness
//   (deny > ask > allow; no empate, o primeiro na ordem de `GUARDS`, que é a
//   ordem antiga do settings.json), junta `systemMessage`/`additionalContext`
//   e só repassa `updatedInput` quando ninguém negou.
// - Fail-open isolado: guard que não carrega, lança ou estoura o tempo dele
//   fica sem saída, como o processo que morria antes; os outros seguem.
// - Mesmo teto de tempo por guard (`timeoutMs` = o `timeout` antigo).
//
// Os 4 guards de `gh pr create` (PII, typecheck, snapshot do orchestrator,
// import de test runner) rodam git/tsc/teste com `spawnSync`, por dezenas de
// segundos. No mesmo processo eles rodariam em série e sem o teto de tempo
// de cada um. Por isso ficam em processo próprio, em paralelo, como antes,
// mas só quando o filtro do próprio guard (`appliesTo`, exportado por ele e
// usado pelo CLI dele) diz que ele se aplica: no Bash comum, zero spawn.
//
// Os scripts individuais seguem rodando sozinhos pelo CLI (os testes de cada
// guard continuam valendo). Equivalência travada em
// `test/pretooluse-bash-dispatch-14045.test.ts`.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Os guards, na ordem do settings.json antes do #14045. `mode`:
 * - `in-process`: o módulo exporta `runHook(data, write)`;
 * - `spawn-if-applies`: o módulo exporta `appliesTo(payload)`; quando dá
 *   `true`, o script roda como processo filho, com o stdin original.
 * `timeoutMs` é o `timeout` que o hook tinha no settings.json.
 */
export const GUARDS = Object.freeze([
  { file: "inject-session-id.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-gh-pr-merge-subagent.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-gh-comment-secrets.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-branch-checkout-main.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-pr-create-pii-runtime-artifacts.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-pr-create-tsc-failure.mjs", mode: "spawn-if-applies", timeoutMs: 90_000 },
  { file: "block-pr-create-orchestrator-snapshot-stale.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-pr-create-test-runner-import.mjs", mode: "spawn-if-applies", timeoutMs: 30_000 },
  { file: "block-unsafe-shared-checkout-ops.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-worktree-bare-push.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-npm-install-node-modules-symlink.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-worktree-alien-commit.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-continuo-master-commit.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-handwritten-pr-checks-loop.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-raw-pr-review-comment.mjs", mode: "in-process", timeoutMs: 10_000 },
  { file: "block-bash-protected-path-write.mjs", mode: "in-process", timeoutMs: 10_000 },
]);

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
 * Uma saída única volta igual (mesmo conteúdo). Nenhuma saída: `null`.
 */
export function combineHookOutputs(outputs) {
  const parsed = outputs.map(parseHookOutput).filter((o) => o !== null);
  if (parsed.length === 0) return null;

  let decided = null;
  for (const o of parsed) {
    const rank = DECISION_RANK[o.hookSpecificOutput?.permissionDecision] ?? 0;
    if (rank > 0 && (decided === null || rank > DECISION_RANK[decided.permissionDecision])) {
      decided = o.hookSpecificOutput;
    }
  }

  const result = {};
  const messages = parsed.map((o) => o.systemMessage).filter((m) => typeof m === "string" && m !== "");
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

/** Corre `promise` contra o teto; estourou, resolve `onTimeout`. */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function logGuardError(file, what, err) {
  try {
    process.stderr.write(`pretooluse-bash-dispatch (#14045): ${file} ${what}, guard sem decisão nesta chamada (${err?.message ?? err}).\n`);
  } catch {
    // stderr indisponível: segue sem o diagnóstico.
  }
}

/** Carrega o módulo do guard; nunca rejeita (`{ err }` no lugar). */
function loadGuard(guard, hooksDir) {
  return import(pathToFileURL(join(hooksDir, guard.file)).href).then(
    (mod) => ({ mod }),
    (err) => ({ err }),
  );
}

/** Guard no próprio processo: a saída que o CLI dele escreveria, ou `""`. */
async function runInProcess(guard, raw, loading) {
  const { mod, err } = await loading;
  if (err !== undefined) {
    logGuardError(guard.file, "não carregou", err);
    return "";
  }
  if (typeof mod.runHook !== "function") {
    logGuardError(guard.file, "não exporta runHook", "contrato #14045");
    return "";
  }
  let out = "";
  let open = true;
  const write = (s) => {
    if (open) out += String(s);
    return true;
  };
  const run = (async () => {
    try {
      await mod.runHook(raw, write);
    } catch (err) {
      logGuardError(guard.file, "lançou", err);
    }
  })();
  const timedOut = Symbol("timeout");
  const finished = await withTimeout(run, guard.timeoutMs, timedOut);
  open = false;
  if (finished === timedOut) {
    logGuardError(guard.file, `passou de ${guard.timeoutMs} ms`, "timeout");
    return "";
  }
  return out;
}

/** Guard em processo próprio, só quando `appliesTo` diz que se aplica. */
async function runSpawnIfApplies(guard, raw, hooksDir, loading) {
  const script = join(hooksDir, guard.file);
  let applies;
  try {
    const { mod, err } = await loading;
    if (err !== undefined) throw err;
    if (typeof mod.appliesTo !== "function") {
      logGuardError(guard.file, "não exporta appliesTo", "contrato #14045");
      return "";
    }
    applies = mod.appliesTo(JSON.parse(raw || "{}"));
  } catch {
    // Mesmo resultado do CLI do guard: exceção no filtro = sem saída.
    return "";
  }
  if (!applies) return "";
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(process.execPath, [script], {
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
    } catch (err) {
      logGuardError(guard.file, "não spawnou", err);
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      logGuardError(guard.file, `passou de ${guard.timeoutMs} ms`, "timeout");
      try {
        child.kill();
      } catch {
        // já saiu
      }
      finish("");
    }, guard.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.on("error", (err) => {
      logGuardError(guard.file, "falhou", err);
      finish("");
    });
    child.on("close", () => finish(out));
    child.stdin.on("error", () => {});
    child.stdin.end(raw);
  });
}

/**
 * Roda todos os guards sobre o stdin cru e devolve as saídas na ordem de
 * `guards`. Os de processo próprio começam primeiro e correm em paralelo com
 * os de processo único, que rodam um depois do outro.
 */
export async function runGuards(raw, { guards = GUARDS, hooksDir = HOOK_DIR } = {}) {
  const outputs = new Array(guards.length).fill("");
  const loading = guards.map((g) => loadGuard(g, hooksDir));
  const spawned = guards.map((g, i) =>
    g.mode === "spawn-if-applies"
      ? runSpawnIfApplies(g, raw, hooksDir, loading[i]).then((o) => (outputs[i] = o))
      : null,
  );
  for (const [i, g] of guards.entries()) {
    if (g.mode === "in-process") outputs[i] = await runInProcess(g, raw, loading[i]);
  }
  await Promise.all(spawned.filter(Boolean));
  return outputs;
}

/** Saída final do despachante (texto JSON) ou `""` quando nenhum guard falou. */
export async function dispatch(raw, opts) {
  const combined = combineHookOutputs(await runGuards(raw, opts));
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
      // Fail-open, como cada guard era: o despachante quebrado não trava Bash.
      logGuardError("despachante", "lançou", err);
    }
    // Sai explicitamente: guard que estourou o tempo pode ter deixado timer
    // ou socket vivo (o processo dele seria morto pelo harness).
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
