#!/usr/bin/env npx tsx
/**
 * resolve-develop-plan-path.ts (#6265)
 *
 * CLI para o resolver de colisão de `plan.json` do `/diaria-develop` — ver
 * `scripts/lib/develop-plan-collision.ts` pra lógica pura/documentação
 * completa (racional da escolha de desenho, por que overnight não usa
 * isto, etc). Este arquivo só monta o `DevelopPlanProbe` real (leitura de
 * `data/develop/{AAMMDD}{suffix}/plan.json` do disco) e imprime o path
 * resolvido — ponto de entrada de linha de comando, mesmo padrão de
 * `scripts/lib/machine-id.ts`.
 *
 * Chamado pela Fase 0 passo 9 de `.claude/skills/diaria-develop/SKILL.md`
 * ANTES da escrita inicial de `plan.json` (e de novo em qualquer re-write
 * subsequente — é idempotente: uma sessão já dona do arquivo recebe
 * `mode: "resume"` com o MESMO path de volta).
 *
 * Uso:
 *   npx tsx scripts/resolve-develop-plan-path.ts --aammdd 260826 --session-id {sid}
 *   # → imprime JSON: { path, suffix, mode, collisions? }
 *
 * `--session-id` segue a mesma convenção do resto do repo — auto-injetado
 * por `.claude/hooks/inject-session-id.mjs` quando chamado como comando
 * standalone (nunca dentro de `&&`/`;`/pipe/heredoc — `context/overnight-
 * dispatch-rules.md` item 18); passar manualmente também funciona (uso em
 * teste/debug).
 *
 * @see scripts/lib/develop-plan-collision.ts
 * @see .claude/skills/diaria-develop/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  resolveDevelopPlanPath,
  type DevelopPlanProbeResult,
} from "./lib/develop-plan-collision.ts";

const DEVELOP_BASE_DIR = "data/develop";

function realProbe(path: string): DevelopPlanProbeResult {
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { session_id?: unknown };
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    return { exists: true, sessionId };
  } catch {
    // plan.json existente mas ilegível (JSON malformado, conflito de sync
    // do OneDrive em voo) — tratado como "existe, session_id desconhecido"
    // (nunca "não existe"): a checagem de colisão continua conservadora,
    // nunca escreve por cima de um arquivo que não conseguiu ler.
    return { exists: true, sessionId: null };
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const aammdd = values.aammdd;
  const sessionId = values["session-id"];

  if (!aammdd) {
    console.error("[resolve-develop-plan-path] uso: --aammdd AAMMDD --session-id {sid}");
    process.exit(2);
  }
  if (!sessionId) {
    console.error(
      "[resolve-develop-plan-path] --session-id ausente — chame como comando standalone " +
        "(nunca em &&/;/pipe/heredoc) pra inject-session-id.mjs injetar automaticamente, " +
        "ou passe --session-id explicitamente.",
    );
    process.exit(2);
  }

  let resolved;
  try {
    resolved = resolveDevelopPlanPath(DEVELOP_BASE_DIR, aammdd, sessionId, realProbe);
  } catch (e) {
    console.error(`[resolve-develop-plan-path] ${(e as Error).message}`);
    process.exit(1);
  }

  if (resolved.mode === "derived-after-collision") {
    const collisionList = (resolved.collisions ?? [])
      .map((c) => `${c.path} (session_id: ${c.sessionId ?? "ausente"})`)
      .join(", ");
    console.error(
      `[resolve-develop-plan-path] colisão detectada — plano(s) alheio(s) em voo: ${collisionList}. ` +
        `Usando ${resolved.path} (sufixo "${resolved.suffix}") pra esta sessão.`,
    );
  }

  process.stdout.write(JSON.stringify(resolved) + "\n");
}
