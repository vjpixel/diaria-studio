#!/usr/bin/env npx tsx
/**
 * check-publish-session-boundary.ts (#14038) — a Etapa 5 não roda na mesma
 * sessão que aprovou o gate 4 (#6171). Lógica em
 * `scripts/lib/publish-session-boundary.ts`.
 *
 * Uso (Passo 0 do `/diaria-publica` e do `/diaria-5-publicacao`, depois do
 * sentinel do Stage 4):
 *   npx tsx scripts/check-publish-session-boundary.ts --edition AAMMDD
 *     [--dir DIR] [--session-id ID] [--allow-same-session]
 *
 * A sessão corrente vem de `CLAUDE_CODE_SESSION_ID`, lido do ambiente que o
 * Bash tool HERDOU do processo do Claude Code; `--session-id` sobrepõe. Nada
 * garante que `/clear` troque esse valor (persistiu até depois de um
 * reinício na sessão develop de 261125), então o halt pede uma sessão nova
 * (nova conversa ou janela), não `/clear`. `--allow-same-session` só quando o
 * editor pedir explicitamente seguir na mesma sessão: sai 0 com aviso.
 *
 * Exit: 0 = sessão nova, ou sem como comparar (aviso no stderr; inclui
 *           sentinel ilegível, fail-open);
 *       3 = mesma sessão do gate 4 (halt, pedir sessão nova e nova invocação);
 *       2 = uso inválido ou diretório da edição não resolvido.
 * Stdout: JSON com o veredito.
 */

import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { readSentinel, sentinelExists } from "./lib/pipeline-state.ts";
import { assessPublishSessionBoundary, describePublishSessionBoundary } from "./lib/publish-session-boundary.ts";
import { currentSessionId } from "./lib/session-transcript.ts";
import { resolveEditionDir } from "./pipeline-sentinel.ts";

export const SAME_SESSION_EXIT = 3;

/** Exceção ao resolver o diretório vira erro de uso (exit 2), nunca crash. */
export function resolveEditionDirSafe(
  args: { edition: string; dir?: string },
  resolver: (a: { edition?: string; dir?: string }, cwd: string) => string = resolveEditionDir,
  cwd: string = process.cwd(),
): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    return { ok: true, dir: resolver(args, cwd) };
  } catch (e) {
    return {
      ok: false,
      error: `[error] diretório da edição ${args.edition} não resolvido: ${e instanceof Error ? e.message : String(e)} (conferir --edition/--dir e o data/ desta máquina)`,
    };
  }
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values.edition?.trim();
  if (!edition) {
    console.error("[error] --edition é obrigatório");
    process.exit(2);
  }
  const resolved = resolveEditionDirSafe({ edition, dir: values.dir });
  if (!resolved.ok) {
    console.error(resolved.error);
    process.exit(2);
  }
  const editionDir = resolved.dir;
  const present = sentinelExists(editionDir, 4);
  const sentinel = present ? readSentinel(editionDir, 4) : null;
  const boundary = assessPublishSessionBoundary({
    sentinelPresent: present,
    sentinelUnreadable: present && sentinel === null,
    stage4SessionId: sentinel?.session_id,
    currentSessionId: values["session-id"]?.trim() || currentSessionId(),
  });
  const allow = flags.has("allow-same-session");
  console.log(JSON.stringify({ edition, edition_dir: editionDir, ...boundary, ...(allow ? { allow_same_session: true } : {}) }));
  const line = describePublishSessionBoundary(boundary, edition);
  if (boundary.verdict === "same-session" && allow) {
    console.error(`[aviso] mesma sessão do gate 4 (${boundary.sessionId}), seguindo por --allow-same-session (#14038).`);
    return;
  }
  if (line) console.error(line);
  if (boundary.verdict === "same-session") process.exit(SAME_SESSION_EXIT);
}

if (isMainModule(import.meta.url)) main();
