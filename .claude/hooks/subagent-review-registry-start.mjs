// SubagentStart hook — grava o nonce/identidade de execução de um subagente
// REVISOR (#6956) num registro em disco que o hook irmão
// (`subagent-review-registry-stop.mjs`) completa quando o subagente termina.
//
// ## Por que isto existe (leia `scripts/lib/pr-review-authenticity.ts`
// primeiro — seção "Escopo do veredito `no_review`" e "Por que a direção
// óbvia não foi implementada aqui" antes deste PR)
//
// A pesquisa do #6956 (comentário na issue) mediu, em **Claude Code 2.1.258**:
//
//   - A tool `Agent` resolve no LANÇAMENTO, não na conclusão — 23/23
//     `tool_result` observados eram só `Async agent launched successfully` +
//     `agentId`, nunca o relatório do subagente. Um hook `PostToolUse` sobre
//     `Agent` te dá o dispatch, nunca a prova de que o review terminou.
//   - `SubagentStart` dispara depois do processo do subagente subir e antes
//     dele aceitar prompts, com `agent_id` e `agent_type` no payload
//     (documentado em code.claude.com/docs/en/sub-agents.md e hooks.md).
//   - `SubagentStop` traz `agent_id`, `agent_type` e `last_assistant_message`
//     — o texto final do subagente (mesma doc).
//
// Este par de hooks (Start aqui, Stop no arquivo irmão) usa esses dois
// eventos com schema PUBLICADO em vez do caminho `PostToolUse`/`Agent` sem
// precedente e sem schema verificado que a pesquisa descartou. O nonce nasce
// DENTRO do hook (nunca do modelo) — mesma exigência que fechou o #6849 pro
// marcador de `continuo-pr-review.sh`: o modelo não tem caneta sobre um
// registro que o runtime escreve.
//
// ⚠️ O schema exato de `tool_input`/payload da tool `Agent` (de onde viria
// `agent_id`/`agent_type` num `PostToolUse`) NÃO é documentado — mas o
// schema de `SubagentStart`/`SubagentStop` em si, usado aqui, É. Ainda
// assim, os NOMES DE CAMPO exatos (`agent_id` vs `agentId`, `agent_type` vs
// `subagent_type`) não foram observados ao vivo nesta máquina no momento
// deste commit — por isso `readField` abaixo tenta as duas grafias mais
// prováveis por campo, e por isso o contrato de fail-open (ver abaixo) é
// inegociável: se a suposição de nome de campo estiver errada, o hook não
// grava nada e NÃO lança, nunca derruba o dispatch.
//
// ## Consumidor
//
// Isto AINDA NÃO é lido por `scripts/lib/pr-review-authenticity.ts` nem por
// nenhum gate de merge — é só o mecanismo de registro que a issue #6956
// pediu ("registrando dois hooks novos"). Ligar um gate a este registro
// (comparar `head_sha` do registro contra o HEAD atual da PR, decidir
// pass/fail) é trabalho de acompanhamento, não deste PR — ver o comentário
// de fechamento do PR na issue.
//
// ## Contrato fail-open (INEGOCIÁVEL — molde: block-gh-pr-merge-subagent.mjs)
//
// Este hook roda a cada dispatch de subagente — dezenas de vezes numa
// rodada overnight/develop/continuo. Qualquer exceção, I/O falhando, JSON
// malformado, `agent_type` ausente, diretório ausente → o hook sai em
// silêncio SEM bloquear nada e SEM lançar. `SubagentStart` não documenta
// suporte a bloqueio de qualquer forma (ao contrário de `PreToolUse`), então
// mesmo um valor de saída "errado" aqui não pode travar o subagente — mas a
// disciplina de nunca lançar é mantida de qualquer forma, pelo mesmo motivo
// que todo hook deste repo segue essa regra: uma exceção não tratada num
// hook `command` pode ser tratada pelo harness como falha do hook, e o
// blast radius de "hook de registro quebra dispatch de subagente" é
// inaceitável frente ao ganho (um registro a mais).
//
// ## `.mjs` self-contained
//
// ZERO `import` de `scripts/*.ts` — import estático de `.ts` quebra o hook
// em silêncio num Node sem type-stripping (documentado em
// `pr-create-review.mjs` e `block-gh-pr-merge-subagent.mjs`). `randomUUID`
// vem de `node:crypto` (builtin), não precisa de lib externa.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";

/**
 * Agentes cujo dispatch conta como "revisor" pro registro. Superconjunto
 * deliberadamente permissivo — registrar um subagente a mais é inofensivo
 * (o registro não bloqueia nada por si só, é só um fato gravado); deixar de
 * registrar um revisor de verdade é que reabriria a lacuna. Nomes tirados
 * da seção "Effort do review automatizado" de CLAUDE.md e do fleet do
 * hook `pr-create-review.mjs` (#4234): o agente principal
 * (`pr-review-toolkit:code-reviewer`), os 4 do fleet `max`, e o fallback
 * `general-purpose` que o dispatch usa quando o plugin não está instalado
 * (sessão cloud, clone fresco — CLAUDE.md, "Effort do review automatizado").
 */
export const REVIEW_AGENT_TYPES = new Set([
  "pr-review-toolkit:code-reviewer",
  "pr-review-toolkit:silent-failure-hunter",
  "pr-review-toolkit:pr-test-analyzer",
  "pr-review-toolkit:comment-analyzer",
  "pr-review-toolkit:type-design-analyzer",
  "pr-review-toolkit:code-simplifier",
  "general-purpose",
]);

/** Diretório do registro — `data/sessions/` já é a área compartilhada
 * (OneDrive) de estado operacional entre sessões/máquinas deste projeto;
 * um subdiretório dedicado evita colidir com os arquivos de sessão
 * coordenadora que `block-gh-pr-merge-subagent.mjs` já lê ali. */
export function registryDir(repoRoot) {
  return join(repoRoot, "data", "sessions", "subagent-reviews");
}

/** Resolve a raiz do checkout — mesma estratégia dos hooks irmãos
 * (`git rev-parse --show-toplevel`, com fallback pra relativo ao arquivo
 * se o git não estiver disponível). Nunca lança. */
export function resolveRepoRoot(execFn = execFileSync) {
  try {
    const top = execFn("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (top) return top;
  } catch {
    // cai no fallback abaixo
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Lê o SHA do HEAD atual — best-effort, `null` se falhar (git ausente,
 * não é um repo, etc). Nunca lança. */
export function resolveHeadSha(repoRoot, execFn = execFileSync) {
  try {
    return execFn("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/** Tenta múltiplas grafias de campo (ver nota no docblock sobre schema não
 * observado ao vivo) — devolve a primeira string não-vazia encontrada, ou
 * `undefined`. */
function readField(payload, ...names) {
  if (!payload || typeof payload !== "object") return undefined;
  for (const name of names) {
    const v = payload[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Nonce aleatório gerado DENTRO do hook — nunca a partir de input do
 * modelo. `randomUUID` é suficiente entropia pra esta finalidade (não é um
 * segredo criptográfico, é um identificador de correlação — mesmo nível de
 * garantia que `run=` no marcador do `continuo-pr-review.sh`). */
export function generateNonce() {
  try {
    return randomUUID();
  } catch {
    // Fallback extremamente improvável de precisar (randomUUID é builtin
    // estável), mas mantém o contrato "nunca lança" mesmo aqui.
    return randomBytes(16).toString("hex");
  }
}

/**
 * Monta o registro a partir do payload do hook e do estado local (HEAD sha).
 * Pura, nunca lança — chamadores decidem o que fazer com exceções de I/O
 * separadamente.
 */
export function buildStartRecord(payload, { repoRoot, execFn = execFileSync, nonceFn = generateNonce } = {}) {
  const agentId = readField(payload, "agent_id", "agentId");
  const agentType = readField(payload, "agent_type", "agentType", "subagent_type");
  if (!agentId || !agentType) return null;
  if (!REVIEW_AGENT_TYPES.has(agentType)) return null;

  const root = repoRoot ?? resolveRepoRoot(execFn);
  return {
    nonce: nonceFn(),
    agent_id: agentId,
    agent_type: agentType,
    session_id: readField(payload, "session_id", "sessionId") ?? null,
    at: new Date().toISOString(),
    head_sha: resolveHeadSha(root, execFn),
    status: "started",
  };
}

/** Grava o registro em disco — best-effort, silenciosa em qualquer falha de
 * I/O (diretório ausente que não cria, disco cheio, corrida de escrita
 * concorrente). O registro é write-once por `agent_id`: se já existir
 * (dispatch duplicado improvável, mas não impossível), NÃO sobrescreve —
 * o hook Stop procura pelo primeiro que casar o `agent_id`, e reescrever
 * aqui poderia trocar o nonce debaixo de um Stop que já está a caminho. */
export function writeStartRecord(repoRoot, record) {
  if (!record) return false;
  try {
    const dir = registryDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${record.agent_id}.json`);
    if (existsSync(path)) return false; // já registrado — não sobrescrever
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por teste).
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
      const repoRoot = resolveRepoRoot();
      const record = buildStartRecord(payload, { repoRoot });
      writeStartRecord(repoRoot, record);
    } catch {
      // Fail-open: um hook de registro nunca pode derrubar o dispatch do
      // subagente. Silêncio total é o comportamento correto aqui.
    }
    // SubagentStart não bloqueia nem injeta contexto de forma útil pro
    // propósito deste hook — sem stdout estruturado, o harness segue o
    // fluxo normal.
  });
}
