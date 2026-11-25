// PreToolUse hook (matcher Write) — restringe o Write do subagente
// `writer-destaque` aos únicos 2 arquivos que ele produz (#9132): rascunho e
// prompt de imagem do destaque, `_internal/02-d{1,2,3}-{draft,prompt}.md`.
// Desde o #13884 restringe também o `writer-pool` a `_internal/02-pool-descriptions.json`.
// O agent lê texto bruto externo (potencial prompt injection); sem isto, um
// Write sem restrição de path poderia sobrescrever outros arquivos da edição/repo.
//
// Fail-open: sem `agent_type` no payload (harness que não o envia), qualquer
// outro agente, ou erro → não bloqueia. Self-contained (sem imports de scripts/).

import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALLOWED_RE =
  /^data\/editions\/(?:\d{4}\/)?\d{6}\/_internal\/02-d[123]-(?:draft|prompt)\.md$/;

export const WRITER_DESTAQUE_AGENT = "writer-destaque";

// #13884: o `writer-pool` também lê texto bruto de página (pool-sources/) e só
// grava o JSON de descrições.
export const WRITER_POOL_AGENT = "writer-pool";
const POOL_ALLOWED_RE =
  /^data\/editions\/(?:\d{4}\/)?\d{6}\/_internal\/02-pool-descriptions\.json$/;

// fileURLToPath já devolve path absoluto nativo; só normaliza barras (posix.resolve
// não reconhece `C:/...` como absoluto e colaria o cwd na frente — #9264).
export const rootFromFsPath = (fsPath) => fsPath.replaceAll("\\", "/");

const DEFAULT_ROOT = rootFromFsPath(fileURLToPath(new URL("../..", import.meta.url)));

function isAllowedPath(filePath, re, root) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  let normalized = posix.normalize(filePath.replaceAll("\\", "/"));
  const prefix = root.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  if (normalized.split("/").includes("..")) return false;
  return re.test(normalized);
}

export function isAllowedWriterDestaquePath(filePath, root = DEFAULT_ROOT) {
  return isAllowedPath(filePath, ALLOWED_RE, root);
}

export function isAllowedWriterPoolPath(filePath, root = DEFAULT_ROOT) {
  return isAllowedPath(filePath, POOL_ALLOWED_RE, root);
}

function agentTypeOf(payload) {
  return payload?.agent_type ?? payload?.agentType ?? payload?.subagent_type;
}

export function shouldBlockWrite(payload) {
  const agentType = agentTypeOf(payload);
  if (agentType !== WRITER_DESTAQUE_AGENT && agentType !== WRITER_POOL_AGENT) return false;
  if (payload.tool_name && payload.tool_name !== "Write") return false;
  const fp = payload.tool_input?.file_path;
  return agentType === WRITER_POOL_AGENT ? !isAllowedWriterPoolPath(fp) : !isAllowedWriterDestaquePath(fp);
}

export const WRITER_DESTAQUE_WRITE_BLOCK_REASON =
  "Write do writer-destaque restrito a data/editions/[AAMM/]AAMMDD/_internal/02-d{1,2,3}-{draft,prompt}.md (#9132): " +
  "o agent lê texto externo não confiável, então não pode gravar em outros paths. " +
  "Grave apenas out_path e image_prompt_out_path recebidos do coordenador.";

export const WRITER_POOL_WRITE_BLOCK_REASON =
  "Write do writer-pool restrito a data/editions/[AAMM/]AAMMDD/_internal/02-pool-descriptions.json (#13884): " +
  "o agent lê texto externo não confiável, então não pode gravar em outros paths. Grave apenas o out_path recebido.";

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (!shouldBlockWrite(payload)) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              agentTypeOf(payload) === WRITER_POOL_AGENT ? WRITER_POOL_WRITE_BLOCK_REASON : WRITER_DESTAQUE_WRITE_BLOCK_REASON,
          },
        }),
      );
    } catch {
      // Fail-open.
    }
  });
}
