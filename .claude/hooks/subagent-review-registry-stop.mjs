// SubagentStop hook — completa o registro que `subagent-review-registry-
// start.mjs` grava no `SubagentStart` do mesmo subagente (#6956). Ver o
// docblock daquele arquivo para o desenho completo, a pesquisa que o
// motivou (Claude Code 2.1.258) e por que este par de hooks existe em vez
// do caminho `PostToolUse`/`Agent` descartado.
//
// Casa pelo mesmo `agent_id` que o Start gravou — traz `agent_type` e
// `last_assistant_message` (schema documentado em
// code.claude.com/docs/en/sub-agents.md), guarda o HASH da mensagem final
// (não o texto — o texto pode ser grande e o registro não precisa dele pra
// provar conclusão, só precisa de uma prova de que ALGO específico foi
// produzido).
//
// ## Contrato fail-open (INEGOCIÁVEL — mesmo do hook Start)
//
// Qualquer exceção, I/O falhando, JSON malformado, registro Start ausente
// (dispatch de um agent_type fora de `REVIEW_AGENT_TYPES`, ou hook Start
// que falhou silenciosamente) → sai em silêncio, nunca lança, nunca
// bloqueia. `SubagentStop` também não documenta suporte a bloqueio.
//
// ## `.mjs` self-contained — ZERO import de `scripts/*.ts`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { registryDir, resolveRepoRoot } from "./subagent-review-registry-start.mjs";

function readField(payload, ...names) {
  if (!payload || typeof payload !== "object") return undefined;
  for (const name of names) {
    const v = payload[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Hash estável (sha256, hex) da mensagem final do subagente — best-effort,
 * `null` se `lastAssistantMessage` não for string ou o hashing falhar
 * (nunca lança). */
export function hashLastAssistantMessage(lastAssistantMessage) {
  if (typeof lastAssistantMessage !== "string") return null;
  try {
    return createHash("sha256").update(lastAssistantMessage, "utf8").digest("hex");
  } catch {
    return null;
  }
}

/**
 * Lê o registro Start já gravado e devolve a versão completada — pura,
 * nunca lança. `null` quando não há como completar (registro ausente,
 * `agent_id` ausente do payload, JSON corrompido).
 */
export function buildCompletedRecord(existingRaw, payload) {
  const agentId = readField(payload, "agent_id", "agentId");
  if (!agentId) return null;

  let existing;
  try {
    existing = JSON.parse(existingRaw);
  } catch {
    return null;
  }
  if (!existing || typeof existing !== "object" || existing.agent_id !== agentId) return null;

  const lastMessage = readField(payload, "last_assistant_message", "lastAssistantMessage");
  return {
    ...existing,
    status: "completed",
    completed_at: new Date().toISOString(),
    agent_type_at_stop: readField(payload, "agent_type", "agentType", "subagent_type") ?? null,
    last_assistant_message_sha256: hashLastAssistantMessage(lastMessage),
  };
}

/** Lê + atualiza + regrava o arquivo de registro do `agent_id` do payload.
 * Best-effort — qualquer falha de I/O (arquivo Start ausente, corrida de
 * escrita) resulta em `false` sem lançar. */
export function completeStartRecord(repoRoot, payload) {
  try {
    const agentId = readField(payload, "agent_id", "agentId");
    if (!agentId) return false;
    const path = join(registryDir(repoRoot), `${agentId}.json`);
    if (!existsSync(path)) return false; // não era um revisor registrado — nada a fazer
    const raw = readFileSync(path, "utf8");
    const completed = buildCompletedRecord(raw, payload);
    if (!completed) return false;
    writeFileSync(path, JSON.stringify(completed, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

// #2019: CLI guard.
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
      const repoRoot = resolveRepoRoot(execFileSync);
      completeStartRecord(repoRoot, payload);
    } catch {
      // Fail-open: nunca derrubar o hook do subagente ao terminar.
    }
  });
}
