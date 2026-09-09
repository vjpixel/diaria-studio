#!/usr/bin/env node
// SessionStart hook — avisa quando o diretório de memória local
// (`~/.claude/projects/{slug}/memory/`) está FORA do mecanismo de sync do
// #7533 (repo git próprio + `_index.json` como manifesto de curadoria),
// item 2 do resíduo #7759.
//
// Wired em .claude/settings.json sob hooks.SessionStart — SEGUNDO hook
// desse tipo neste repo, ao lado de `session-start-claude-config-sync.mjs`
// (não substitui, os dois coexistem no mesmo array).
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUE UM HOOK VENDORADO AQUI, EM VEZ DE UM ITEM NO ALARME DE DRIFT
// EXISTENTE (a 2ª opção que a issue oferecia)
// ─────────────────────────────────────────────────────────────────────────
//
// Um alarme de drift, neste repo, é uma scheduled task — e scheduled tasks
// só rodam no `helios`/servidor (decisão já em vigor: máquinas locais não
// rodam mais tasks agendadas, ver CLAUDE.md e
// `docs/scheduled-tasks-registry.md`). O `helios` já É uma máquina
// conectada — um alarme rodando lá nunca alcança o estado LOCAL de uma
// máquina que está justamente fora do mecanismo (não há como o `helios`
// enxergar `~/.claude/projects/.../memory/` do ZenBook sem que o ZenBook
// primeiro sincronize algo, o que é exatamente o que falhou em acontecer).
// Um `SessionStart` vendorado no `diaria-studio`, em vez disso, chega a
// QUALQUER máquina via `git pull` normal do próprio repo de trabalho —
// mesma inversão de dependência que `session-start-claude-config-sync.mjs`
// já usou pro problema irmão (#6310, ver `docs/claude-config-sync.md`
// §"Auto-arme via `diaria-studio`"). É por isso que este hook, e não um
// item no alarme de drift, é a escolha deste PR.
//
// ─────────────────────────────────────────────────────────────────────────
// CONTRATO DE SEGURANÇA (fail-soft obrigatório, #7759)
// ─────────────────────────────────────────────────────────────────────────
//
//   - NUNCA bloqueia nem atrasa o início da sessão: só leitura síncrona e
//     rápida (2 `statSync`/`existsSync` no máximo), sem rede, sem spawn.
//   - NUNCA escreve nada em disco (nem log, nem estado de debounce) — é
//     puramente um avisador. Repetir o aviso a cada sessão até a máquina
//     ser conectada é aceito de propósito: o alternativa (debounce
//     silencioso) reintroduziria a mesma classe de "verde silencioso" que
//     a issue proíbe.
//   - NUNCA lança: todo o corpo roda dentro de um try/catch único; qualquer
//     falha inesperada (JSON de stdin malformado, erro de IO não previsto)
//     vira silêncio — nunca um `exit != 0` nem um throw não capturado.
//   - NUNCA conserta nada (não roda `git init`, não escreve `_index.json`,
//     não conecta remote) — só relata.
//
// ─────────────────────────────────────────────────────────────────────────
// TRI-ESTADO (regra inegociável do dispatch — ver scripts/lib/memory-sync-guard.ts)
// ─────────────────────────────────────────────────────────────────────────
//
//   - "ok": diretório existe, tem `.git` E `_index.json` -> silencioso.
//   - "not-connected": diretório existe mas falta `.git` e/ou
//     `_index.json` -> ÚNICO status que emite aviso (additionalContext).
//   - "cannot-verify": diretório ausente (sessão cloud/CI/worktree efêmero
//     — o caso comum) ou ilegível -> silencioso de propósito (ver
//     docstring de `scripts/lib/memory-sync-guard.ts`: alarmar em toda
//     sessão cloud/worktree seria ruído puro, mas o status nunca é
//     maquiado como "ok").
//
// A lógica de decisão é DUPLICADA (não importada) de
// `scripts/lib/memory-sync-guard.ts` — mesmo padrão do hook irmão: um
// import estático de `.ts` quebraria este hook, em silêncio, num Node sem
// type-stripping nativo. `test/memory-sync-guard.test.ts` é a fonte da
// verdade do comportamento esperado; ao editar a decisão, editar os DOIS
// lugares e conferir que continuam batendo.

import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Espelha encodeProjectDirName() de scripts/lib/session-transcript.ts.
function encodeProjectDirName(cwd) {
  return cwd.replace(/[:\\/]/g, "-");
}

// Espelha resolveMemoryDir() de scripts/lib/memory-sync-guard.ts.
function resolveMemoryDir(cwd, homeDir) {
  return join(homeDir, ".claude", "projects", encodeProjectDirName(cwd), "memory");
}

// Espelha probeMemoryDirState() — distingue ausente de ilegível via código
// de erro, nunca via existsSync (que engole toda exceção e devolve só
// `false`, apagando a distinção que este guard precisa preservar).
function probeMemoryDirState(memoryDir) {
  let stats;
  try {
    stats = statSync(memoryDir);
  } catch (e) {
    return e && e.code === "ENOENT" ? "missing" : "unreadable";
  }
  if (!stats.isDirectory()) return "missing";
  return "present";
}

// Espelha evaluateMemorySyncGuard() + checkMemorySyncGuardOnDisk().
function checkMemorySyncGuard(memoryDir) {
  const dirState = probeMemoryDirState(memoryDir);
  if (dirState !== "present") {
    return { status: "cannot-verify", missing: [] };
  }
  const missing = [];
  if (!existsSync(join(memoryDir, ".git"))) missing.push(".git");
  if (!existsSync(join(memoryDir, "_index.json"))) missing.push("_index.json");
  if (missing.length === 0) return { status: "ok", missing: [] };
  return { status: "not-connected", missing };
}

// Espelha buildMemorySyncGuardWarning().
function buildWarning(result, memoryDir) {
  if (result.status !== "not-connected") return null;
  return (
    `Memória local (${memoryDir}) está fora do mecanismo de sync (#7533/#7759): ` +
    `faltando ${result.missing.join(" e ")}. Editar MEMORY.md à mão aqui parece funcionar, ` +
    `mas some na próxima regeneração e nenhuma outra máquina enxerga o que for escrito. ` +
    `Setup de 1x nesta máquina: docs/claude-config-sync.md §"Política de \`memory/\`" ` +
    `(bloco "nas demais máquinas").`
  );
}

function emitAdditionalContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
      },
    }),
  );
}

function run(rawStdin) {
  let cwd = process.cwd();
  try {
    const payload = JSON.parse(rawStdin || "{}");
    if (typeof payload.cwd === "string" && payload.cwd.trim() !== "") cwd = payload.cwd;
  } catch {
    // stdin ilegível/ausente: segue com process.cwd() como fallback, nunca lança
  }

  const memoryDir = resolveMemoryDir(cwd, homedir());
  const result = checkMemorySyncGuard(memoryDir);
  const warning = buildWarning(result, memoryDir);
  if (warning) emitAdditionalContext(warning);
  // "ok" e "cannot-verify": sem output nenhum -> harness trata como sucesso
  // silencioso (exit 0 padrão, sem hookSpecificOutput).
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    run(data);
  } catch {
    // nunca propagar — fail-soft total, este hook não pode atrapalhar a sessão
  }
});
// Sem stdin conectado (raro, mas defensivo): garante que 'end' dispare mesmo
// se nada for escrito.
process.stdin.on("error", () => {
  try {
    run(data);
  } catch {
    /* idem acima */
  }
});
