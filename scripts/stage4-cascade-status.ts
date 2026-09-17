/**
 * stage4-cascade-status.ts (#8123 Fatia 4 — cascatas com preview progressivo)
 *
 * CLI fino sobre `scripts/lib/stage4-cascade-status.ts` (miolo puro) —
 * chamado pelo orchestrator em `.claude/agents/orchestrator-stage-4.md`
 * §4d.1 passos 3/4 pra coordenar a cascata em background de
 * `image-generate.ts`/`gen-carousel-cards.ts`/`social-writer` sem bloquear
 * o preview de TEXTO (que já é servido antes de qualquer chamada deste
 * script — ver §4d.1a).
 *
 * Uso:
 *   # ao aplicar a edição que dispara a cascata (título mudou, ou reorder
 *   # que troca quem ocupa o slot D1 — image ratio 2:1 vs 1:1):
 *   npx tsx scripts/stage4-cascade-status.ts --edition-dir <dir> --start \
 *     --highlight d1 --pieces image,carousel,social --reason "título alterado"
 *
 *   # ao terminar cada peça em background (image-generate.ts, gen-carousel-
 *   # cards.ts, ou o dispatch do agente social-writer):
 *   npx tsx scripts/stage4-cascade-status.ts --edition-dir <dir> --mark \
 *     --highlight d1 --piece image --state done   # ou --state error
 *
 *   # consulta informativa — pro badge injector e pro gate saberem se ainda
 *   # há algo pendente antes de aceitar "sim" (nunca bloqueia sozinho: o
 *   # orchestrator decide o que fazer com o exit code):
 *   npx tsx scripts/stage4-cascade-status.ts --edition-dir <dir> --status
 *
 *   # cascata totalmente resolvida — remove o estado (o badge para de
 *   # aparecer na próxima re-renderização, mesmo sem chamar --apply-badge):
 *   npx tsx scripts/stage4-cascade-status.ts --edition-dir <dir> --clear
 *
 *   # injeta (ou remove, se nada estiver pendente) o banner "regenerando"
 *   # no HTML de preview já renderizado — chamado logo antes de cada
 *   # `serve-preview.ts` re-serve enquanto a cascata está ativa:
 *   npx tsx scripts/stage4-cascade-status.ts --edition-dir <dir> --apply-badge --html <path.html>
 *
 * Estado em `{edition-dir}/_internal/stage4-cascade-status.json`.
 *
 * Exit codes:
 *   --start/--mark/--clear/--apply-badge: 0 sempre que a operação em si não
 *     falhar por uso inválido (2); o CONTEÚDO da cascata nunca vira erro de
 *     processo — este script é infraestrutura de UX, não gate.
 *   --status: 0 = nada pendente (ou nenhuma cascata); 1 = há peça(s)
 *     pendente(s) — informativo, o caller decide o que fazer.
 *   uso inválido (flag obrigatória ausente): 2.
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  startCascade,
  markPiece,
  readCascadeStatus,
  clearCascadeStatus,
  isCascadePending,
  buildRegeneratingBadgeHtml,
  injectRegeneratingBadge,
  type CascadePieceName,
} from "./lib/stage4-cascade-status.ts";

const VALID_PIECES: CascadePieceName[] = ["image", "carousel", "social"];

function statusPathFor(editionDir: string): string {
  return resolve(editionDir, "_internal", "stage4-cascade-status.json");
}

function main(): void {
  const argv = process.argv.slice(2);
  const editionDirArg = getArg(argv, "edition-dir");
  if (!editionDirArg) {
    console.error(
      "Uso: stage4-cascade-status.ts --edition-dir <dir> --start|--mark|--status|--clear|--apply-badge [...]",
    );
    process.exit(2);
  }
  const statusPath = statusPathFor(editionDirArg);

  if (hasFlag(argv, "start")) {
    const highlight = getArg(argv, "highlight");
    const piecesArg = getArg(argv, "pieces");
    if (!highlight || !piecesArg) {
      console.error("--start requer --highlight e --pieces (ex: image,carousel,social)");
      process.exit(2);
    }
    const pieces = piecesArg
      .split(",")
      .map((p) => p.trim())
      .filter((p): p is CascadePieceName => (VALID_PIECES as string[]).includes(p));
    if (pieces.length === 0) {
      console.error(`--pieces sem nenhum valor reconhecido (válidos: ${VALID_PIECES.join(", ")})`);
      process.exit(2);
    }
    const reason = getArg(argv, "reason") || "ajuste no Stage 4";
    const status = startCascade(statusPath, { highlight, reason, pieces });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (hasFlag(argv, "mark")) {
    const highlight = getArg(argv, "highlight");
    const piece = getArg(argv, "piece");
    const state = getArg(argv, "state");
    if (!highlight || !piece || (state !== "done" && state !== "error")) {
      console.error("--mark requer --highlight, --piece e --state done|error");
      process.exit(2);
    }
    if (!(VALID_PIECES as string[]).includes(piece)) {
      console.error(`--piece inválido (válidos: ${VALID_PIECES.join(", ")})`);
      process.exit(2);
    }
    const status = markPiece(statusPath, highlight, piece as CascadePieceName, state);
    console.log(JSON.stringify(status));
    return;
  }

  if (hasFlag(argv, "clear")) {
    clearCascadeStatus(statusPath);
    console.log(JSON.stringify({ cleared: true }));
    return;
  }

  if (hasFlag(argv, "apply-badge")) {
    const htmlPath = getArg(argv, "html");
    if (!htmlPath) {
      console.error("--apply-badge requer --html <path.html>");
      process.exit(2);
    }
    const resolvedHtmlPath = resolve(htmlPath);
    const status = readCascadeStatus(statusPath);
    const badgeHtml = buildRegeneratingBadgeHtml(status);
    const html = readFileSync(resolvedHtmlPath, "utf8");
    writeFileSync(resolvedHtmlPath, injectRegeneratingBadge(html, badgeHtml), "utf8");
    console.log(JSON.stringify({ applied: badgeHtml !== null, html: resolvedHtmlPath }));
    return;
  }

  // Default (também `--status` explícito): só reporta o estado atual.
  const status = readCascadeStatus(statusPath);
  const pending = isCascadePending(status);
  console.log(JSON.stringify({ active: status !== null, pending, status }, null, 2));
  process.exit(pending ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
