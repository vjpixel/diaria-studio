// PreToolUse hook (matcher Write) — restringe o Write do subagente
// `writer-destaque` aos únicos 2 arquivos que ele produz (#9132): rascunho e
// prompt de imagem do destaque, `_internal/02-d{1,2,3}-{draft,prompt}.md`.
// O agent lê texto bruto externo (potencial prompt injection); sem isto, um
// Write sem restrição de path poderia sobrescrever outros arquivos da edição/repo.
//
// Fail-open: sem `agent_type` no payload (harness que não o envia), qualquer
// outro agente, ou erro → não bloqueia. Self-contained (sem imports de scripts/).

import { posix } from "node:path";

const ALLOWED_RE =
  /(?:^|\/)data\/editions\/(?:\d{4}\/)?\d{6}\/_internal\/02-d[123]-(?:draft|prompt)\.md$/;

export const WRITER_DESTAQUE_AGENT = "writer-destaque";

export function isAllowedWriterDestaquePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const normalized = posix.normalize(filePath.replaceAll("\\", "/"));
  if (normalized.split("/").includes("..")) return false;
  return ALLOWED_RE.test(normalized);
}

export function shouldBlockWrite(payload) {
  const agentType = payload?.agent_type ?? payload?.agentType ?? payload?.subagent_type;
  if (agentType !== WRITER_DESTAQUE_AGENT) return false;
  if (payload.tool_name && payload.tool_name !== "Write") return false;
  return !isAllowedWriterDestaquePath(payload.tool_input?.file_path);
}

export const WRITER_DESTAQUE_WRITE_BLOCK_REASON =
  "Write do writer-destaque restrito a data/editions/[AAMM/]AAMMDD/_internal/02-d{1,2,3}-{draft,prompt}.md (#9132): " +
  "o agent lê texto externo não confiável, então não pode gravar em outros paths. " +
  "Grave apenas out_path e image_prompt_out_path recebidos do coordenador.";

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
      if (!shouldBlockWrite(JSON.parse(data || "{}"))) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: WRITER_DESTAQUE_WRITE_BLOCK_REASON,
          },
        }),
      );
    } catch {
      // Fail-open.
    }
  });
}
