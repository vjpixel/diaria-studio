#!/usr/bin/env npx tsx
/**
 * resolve-overnight-plan-path.ts (#6328)
 *
 * CLI para o resolver de colisão de `plan.json` do `/diaria-overnight` —
 * porta pro overnight o mecanismo que o #6309/#6265 já tinha dado ao
 * `/diaria-develop`. Ver `scripts/lib/plan-path-resolution.ts` pra lógica
 * pura/documentação completa (racional da escolha de desenho, escopo
 * cross-máquina, etc). Este arquivo só monta o probe real (leitura de
 * `data/overnight/{AAMMDD}{suffix}/plan.json` do disco, via
 * `createFsPlanProbe`) e imprime o path resolvido — ponto de entrada de
 * linha de comando, mesmo padrão de `scripts/resolve-develop-plan-path.ts`
 * e `scripts/lib/machine-id.ts`.
 *
 * **Por que o overnight precisava disto tanto quanto o develop, senão
 * mais (#6328):** `data/overnight/{AAMMDD}/plan.json` é chaveado só por
 * data — sem `session_id` no path. Uma 2ª máquina rodando
 * `/diaria-overnight` no mesmo dia (`data/` é o MESMO OneDrive entre
 * máquinas) encontrava o `plan.json` da 1ª máquina e concluía "é retomada"
 * pelo simples `existsSync`, **pulando o briefing** e corrompendo
 * mutuamente o plano da rodada viva — desassistido, sem alarme. O
 * `/diaria-develop` roda supervisionado (editor pode notar); o overnight,
 * não.
 *
 * Chamado pelo passo 0 (Resume) de `.claude/skills/diaria-overnight/
 * SKILL.md` ANTES de decidir se é retomada, e de novo no passo 7 (escrita
 * do `plan.json`) ANTES da 1ª escrita — idempotente: uma sessão já dona do
 * arquivo recebe `mode: "resume"` com o MESMO path de volta em ambos os
 * pontos.
 *
 * Uso:
 *   npx tsx scripts/resolve-overnight-plan-path.ts --aammdd 260826 --session-id {sid}
 *   # → imprime JSON: { path, suffix, mode, collisions? }
 *
 * `--session-id` segue a mesma convenção do resto do repo — auto-injetado
 * por `.claude/hooks/inject-session-id.mjs` quando chamado como comando
 * standalone (nunca dentro de `&&`/`;`/pipe/heredoc — `context/overnight-
 * dispatch-rules.md` item 18); passar manualmente também funciona (uso em
 * teste/debug).
 *
 * @see scripts/lib/plan-path-resolution.ts (miolo puro, compartilhado)
 * @see scripts/resolve-develop-plan-path.ts (CLI irmão, #6265/#6309)
 * @see .claude/skills/diaria-overnight/SKILL.md
 */

import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolvePlanPath, createFsPlanProbe } from "./lib/plan-path-resolution.ts";

const OVERNIGHT_BASE_DIR = "data/overnight";
const realProbe = createFsPlanProbe();

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const aammdd = values.aammdd;
  const sessionId = values["session-id"];

  if (!aammdd) {
    console.error("[resolve-overnight-plan-path] uso: --aammdd AAMMDD --session-id {sid}");
    process.exit(2);
  }
  if (!sessionId) {
    console.error(
      "[resolve-overnight-plan-path] --session-id ausente — chame como comando standalone " +
        "(nunca em &&/;/pipe/heredoc) pra inject-session-id.mjs injetar automaticamente, " +
        "ou passe --session-id explicitamente.",
    );
    process.exit(2);
  }

  let resolved;
  try {
    resolved = resolvePlanPath(OVERNIGHT_BASE_DIR, aammdd, sessionId, realProbe);
  } catch (e) {
    console.error(`[resolve-overnight-plan-path] ${(e as Error).message}`);
    process.exit(1);
  }

  if (resolved.mode === "derived-after-collision") {
    const collisionList = (resolved.collisions ?? [])
      .map((c) => `${c.path} (session_id: ${c.sessionId ?? "ausente"})`)
      .join(", ");
    console.error(
      `[resolve-overnight-plan-path] colisão detectada — plano(s) alheio(s) em voo: ${collisionList}. ` +
        `Usando ${resolved.path} (sufixo "${resolved.suffix}") pra esta sessão.`,
    );
  }

  process.stdout.write(JSON.stringify(resolved) + "\n");
}
