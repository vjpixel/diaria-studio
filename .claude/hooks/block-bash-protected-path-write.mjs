// PreToolUse hook (matcher Bash) — nega escrita via Bash em caminho protegido
// (`.claude/skills|agents|hooks|commands|...`, `.claude/settings*.json`,
// `.mcp.json`, `.git/hooks`, `.git/config`) em qualquer sessão (#12009).
//
// Incidente de origem: overnight 261103, unidade #11990 — o subagente alterou
// `.claude/skills/diaria-video-montagem/SKILL.md` por script Python no Bash,
// contornando a checagem de caminho protegido que o Claude Code aplica ao
// Edit/Write. Decisão do editor (briefing 261103): hook no Bash que nega.
//
// A lógica (lista de caminhos protegidos + detecção) é pura e mora em
// `scripts/lib/protected-path-bash-write.mjs`, JS sem dependência para rodar
// com o `node` cru do PATH do harness (#7836). Teste:
// `test/protected-path-bash-write-12009.test.ts`.
//
// Só nega quando o caminho protegido é ALVO de escrita; leitura segue livre.
// Fail-open em erro: um hook quebrado não pode travar Bash legítimo.

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  protectedPathWriteReason,
  shouldBlockProtectedPathWrite,
} from "../../scripts/lib/protected-path-bash-write.mjs";

const MAX_SCRIPT_BYTES = 512 * 1024;

/** Lê script fora do projeto (`/tmp/fix.py`) para a análise; `null` se não der. */
function readScript(path) {
  try {
    if (statSync(path).size > MAX_SCRIPT_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const finding = shouldBlockProtectedPathWrite(payload, {
        projectDirs: [process.env.CLAUDE_PROJECT_DIR ?? ""],
        readFile: readScript,
      });
      if (!finding) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: protectedPathWriteReason(finding),
          },
        }),
      );
    } catch (err) {
      // Fail-open, mas nunca calado: o erro vai para o stderr (review da PR
      // #12846). Erro de UM comando já não chega aqui — o laço da lib isola
      // por comando e bloqueia o que crashou citando caminho protegido.
      process.stderr.write(`block-bash-protected-path-write (#12009): erro, comando liberado: ${err?.stack ?? err}\n`);
    }
  });
}
