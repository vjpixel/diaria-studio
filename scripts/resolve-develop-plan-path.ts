#!/usr/bin/env npx tsx
/**
 * resolve-develop-plan-path.ts (#6265, generalizado no #6328)
 *
 * CLI para o resolver de colisão de `plan.json` do `/diaria-develop` — ver
 * `scripts/lib/plan-path-resolution.ts` pra lógica pura/documentação
 * completa (racional da escolha de desenho, escopo cross-máquina, etc —
 * módulo compartilhado com `scripts/resolve-overnight-plan-path.ts` desde
 * o #6328). Este arquivo só monta o probe real (leitura de
 * `data/develop/{AAMMDD}{suffix}/plan.json` do disco, via
 * `createFsPlanProbe`) e imprime o path resolvido — ponto de entrada de
 * linha de comando, mesmo padrão de `scripts/lib/machine-id.ts`.
 *
 * **Wrapper fino, sem mudança de contrato de saída nem de comportamento
 * observável (#6328):** continua importando `resolveDevelopPlanPath` de
 * `scripts/lib/develop-plan-collision.ts` (que por sua vez delega pro
 * miolo genérico) — o `/diaria-develop` está em produção agora e depende
 * deste caminho exatamente como estava.
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
 * @see scripts/lib/plan-path-resolution.ts (miolo puro, compartilhado)
 * @see scripts/lib/develop-plan-collision.ts (wrapper específico do develop)
 * @see scripts/resolve-overnight-plan-path.ts (CLI irmão, #6328)
 * @see .claude/skills/diaria-develop/SKILL.md
 */

import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveDevelopPlanPath } from "./lib/develop-plan-collision.ts";
import { createFsPlanProbe } from "./lib/plan-path-resolution.ts";

const DEVELOP_BASE_DIR = "data/develop";
const realProbe = createFsPlanProbe();

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
    // `resolved.collisions` é garantido pela união discriminada de
    // ResolvedPlanPath (#6328) — sem `?? []`: o narrowing por `mode` já
    // assegura o campo presente e não-vazio neste branch.
    const collisionList = resolved.collisions
      .map((c) => `${c.path} (session_id: ${c.sessionId ?? "ausente"})`)
      .join(", ");
    console.error(
      `[resolve-develop-plan-path] colisão detectada — plano(s) alheio(s) em voo: ${collisionList}. ` +
        `Usando ${resolved.path} (sufixo "${resolved.suffix}") pra esta sessão.`,
    );
  }

  process.stdout.write(JSON.stringify(resolved) + "\n");
}
