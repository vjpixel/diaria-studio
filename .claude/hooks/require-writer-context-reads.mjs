// Hook duplo (#11533) — obriga os agents de escrita a LER os arquivos de
// contexto obrigatórios antes de gravar o output.
//
// Problema (edição 261029): `writer-destaque` D1 leu 2 de 4 arquivos de
// contexto e devolveu `written: true`; o `social-writer` não leu
// `context/templates/social-instagram.md` nem `context/editorial-rules.md`.
// O playbook (orchestrator-stage-4 §4d.1b, #9871) mandava re-disparar quando o
// agente ADMITISSE não ter lido — o guard dependia da confissão. Este hook
// troca a confissão por registro mecânico:
//
//   - `PostToolUse` / matcher `Read`: quando quem lê é um dos agents de
//     `REQUIRED_READS`, registra o caminho lido no arquivo do `agent_id`
//     (append-only, em `os.tmpdir()/diaria-writer-agent-reads/`).
//   - `PreToolUse` / matcher `Write`: antes do 1º `Write` desses agents, nega
//     se algum arquivo obrigatório (que existe em disco) não aparece no
//     registro. A razão do deny lista os caminhos absolutos que faltam: o
//     agente lê e repete o `Write`, sem re-disparo do coordenador.
//
// Fonte da lista: a seção de contexto obrigatório / passo 1 do Processo de
// cada `.claude/agents/{agent}.md`. `test/require-writer-context-reads-hook.test.ts`
// trava a paridade (todo caminho daqui precisa estar citado no .md do agent).
//
// Fail-open (mesmo contrato dos outros hooks deste diretório): payload sem
// `agent_type`/`agent_id`, agent fora da lista, erro de I/O, JSON malformado
// → nunca bloqueia. Arquivo obrigatório inexistente no disco (clone sem
// `data/`) não é exigido. Teto de `MAX_DENIES` negações por `agent_id`:
// depois dele o `Write` passa e o evento vai para `data/run-log.jsonl` como
// `warn` — o guard nunca trava a edição num laço.
//
// Prova positiva (#11634): o 1º `Write` liberado de cada `agent_id` também vai
// ao `data/run-log.jsonl` (`info`, "Write liberado: contexto obrigatório lido").
// Sem isso, um Stage 2 sem nenhuma entrada do hook não distinguia "todos leram
// o contexto" de "o payload do subagente não traz `agent_id`/`agent_type`"
// (o hook pula em silêncio). Agora: alguma entrada `Write liberado`/`Write
// negado` = campos presentes; Stage 2 inteiro sem nenhuma = campos ausentes.
//
// Limpeza (#11634): o 1º registro de um `agent_id` novo apaga os registros com
// mais de `REGISTRY_MAX_AGE_MS` do diretório (antes nunca eram limpos).
//
// `.mjs` self-contained: só importa `./lib/` deste diretório.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendHookRunLog } from "./lib/hook-run-log.mjs";

/** Arquivos que cada agent precisa ter lido antes do 1º Write (relativos à raiz do repo). */
export const REQUIRED_READS = Object.freeze({
  "writer-destaque": Object.freeze([
    "context/editorial-rules.md",
    "context/templates/newsletter.md",
    "context/audience-profile.md",
    "data/past-editions-recent.md",
  ]),
  "social-writer": Object.freeze([
    "context/templates/social-instagram.md",
    "context/editorial-rules.md",
  ]),
  "social-curto": Object.freeze(["context/editorial-rules.md"]),
});

export const MAX_DENIES = 3;

/** Idade a partir da qual um registro de `agent_id` é apagado (#11634). */
export const REGISTRY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const DEFAULT_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replaceAll("\\", "/");

export function defaultRegistryDir() {
  return join(tmpdir(), "diaria-writer-agent-reads");
}

function readField(payload, ...names) {
  if (!payload || typeof payload !== "object") return undefined;
  for (const name of names) {
    const v = payload[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Normaliza para barras `/` e remove `./` repetido; nunca lança. */
export function normalizePath(p) {
  if (typeof p !== "string") return "";
  return p.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

/**
 * O caminho lido `readPath` cobre o obrigatório `required` (relativo à raiz)?
 * Casa por sufixo de segmento inteiro: o agente pode ler pelo checkout
 * principal ou por um worktree, com caminho absoluto ou relativo.
 */
export function readCovers(readPath, required) {
  const r = normalizePath(readPath);
  const req = normalizePath(required).replace(/^\.?\//, "");
  if (r === "" || req === "") return false;
  if (r.split("/").includes("..")) return false;
  const stripped = r.replace(/^\.\//, "");
  return stripped === req || stripped.endsWith("/" + req);
}

/** Obrigatórios ainda não lidos, ignorando os que não existem no disco. */
export function missingRequiredReads(agentType, readPaths, { root = DEFAULT_ROOT, exists = existsSync } = {}) {
  const required = REQUIRED_READS[agentType];
  if (!required) return [];
  return required.filter(
    (req) => exists(join(root, req)) && !readPaths.some((p) => readCovers(p, req)),
  );
}

function safeAgentId(agentId) {
  return String(agentId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function registryFile(dir, agentId) {
  return join(dir, `${safeAgentId(agentId)}.log`);
}

/**
 * Lê o registro do agent: `{ reads, denies, allowLogged }`. Ausente → vazio.
 * `allowLogged` = o 1º Write liberado já foi ao run-log (linha `A`).
 */
export function readRegistry(dir, agentId) {
  const file = registryFile(dir, agentId);
  if (!existsSync(file)) return { reads: [], denies: 0, allowLogged: false };
  const reads = [];
  let denies = 0;
  let allowLogged = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("R\t")) reads.push(line.slice(2));
    else if (line === "D") denies++;
    else if (line === "A") allowLogged = true;
  }
  return { reads, denies, allowLogged };
}

/**
 * Apaga os registros (`*.log`) com `mtime` mais velho que `maxAgeMs` (#11634).
 * Devolve quantos apagou; erro de I/O em um arquivo não interrompe os demais.
 */
export function pruneRegistry(dir, nowMs = Date.now(), maxAgeMs = REGISTRY_MAX_AGE_MS) {
  let removed = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      if (nowMs - statSync(file).mtimeMs > maxAgeMs) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      // Outro processo apagou ou o arquivo está preso: segue.
    }
  }
  return removed;
}

function appendRegistry(dir, agentId, line) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(registryFile(dir, agentId), line + "\n", "utf8");
}

export function denyReason(missing, root = DEFAULT_ROOT) {
  const abs = missing.map((m) => `  - ${join(root, m).replaceAll("\\", "/")}`).join("\n");
  return (
    "Contexto obrigatório não lido (#11533). Antes de gravar, faça Read de:\n" +
    abs +
    "\nDepois repita o Write. Escreva seguindo as regras desses arquivos; não grave sem lê-los."
  );
}

/**
 * Processa um payload de hook. Devolve `{ action: "record" | "deny" | "allow" | "skip", ... }`.
 * Efeitos (append no registro, run-log) só acontecem aqui; nunca lança.
 */
export function handlePayload(payload, { dir = defaultRegistryDir(), root = DEFAULT_ROOT, exists = existsSync, log = appendHookRunLog, nowMs = Date.now() } = {}) {
  try {
    const agentType = readField(payload, "agent_type", "agentType", "subagent_type");
    const agentId = readField(payload, "agent_id", "agentId");
    if (!agentType || !agentId || !REQUIRED_READS[agentType]) return { action: "skip" };
    const event = readField(payload, "hook_event_name", "hookEventName");
    const tool = readField(payload, "tool_name", "toolName");
    const filePath = payload?.tool_input?.file_path;

    if (tool === "Read" && event !== "PreToolUse") {
      if (typeof filePath !== "string" || filePath === "") return { action: "skip" };
      if (!existsSync(registryFile(dir, agentId))) pruneRegistry(dir, nowMs);
      appendRegistry(dir, agentId, "R\t" + normalizePath(filePath));
      return { action: "record" };
    }

    if (tool === "Write" && event !== "PostToolUse") {
      const { reads, denies, allowLogged } = readRegistry(dir, agentId);
      const missing = missingRequiredReads(agentType, reads, { root, exists });
      if (missing.length === 0) {
        if (!allowLogged) {
          appendRegistry(dir, agentId, "A");
          log(root, "require-writer-context-reads", "info", "Write liberado: contexto obrigatório lido", {
            agent_type: agentType,
            denies_before: denies,
          });
        }
        return { action: "allow" };
      }
      if (denies >= MAX_DENIES) {
        log(root, "require-writer-context-reads", "warn", "teto de negações atingido; Write liberado sem a leitura", {
          agent_type: agentType,
          missing,
        });
        return { action: "allow", capped: true, missing };
      }
      appendRegistry(dir, agentId, "D");
      log(root, "require-writer-context-reads", "info", "Write negado: contexto obrigatório não lido", {
        agent_type: agentType,
        missing,
      });
      return { action: "deny", missing, reason: denyReason(missing, root) };
    }
    return { action: "skip" };
  } catch {
    return { action: "skip" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const result = handlePayload(JSON.parse(data || "{}"));
      if (result.action !== "deny") return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: result.reason,
          },
        }),
      );
    } catch {
      // Fail-open.
    }
  });
}
