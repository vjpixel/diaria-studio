#!/usr/bin/env tsx
/**
 * sync-eia-block.ts (#5459)
 *
 * Wrapper de I/O fino em torno de `syncEiaBlockFromReviewed`
 * (`scripts/lib/eia-sync.ts`) — lê `01-eia.md` + `02-reviewed.md` do
 * edition dir, e regrava `01-eia.md` se o bloco mirror pós-humanizador+
 * Clarice divergir. Rodar no Stage 2, LOGO APÓS Clarice terminar de
 * corrigir `02-reviewed.md` (ver `orchestrator-stage-2.md`) — antes disso,
 * `01-eia.md` ainda não tem o que sincronizar; depois disso, quanto antes
 * melhor (o Stage 4 nunca deve ver a divergência).
 *
 * Uso:
 *   npx tsx scripts/sync-eia-block.ts --edition-dir <dir>
 *
 * Exit codes:
 *   0 — sucesso (sincronizou OU já estava sincronizado OU sem mirror ainda —
 *       nenhum desses é erro; o Stage 3 pode não ter rodado ainda quando
 *       este script roda cedo demais, então "sem mirror" é esperado em
 *       alguns fluxos e nunca deve travar o Stage 2)
 *   1 — args inválidos
 *   3 — `02-reviewed.md` ausente (erro de verdade — Stage 2 não devia ter
 *       chegado até aqui sem esse arquivo)
 *
 * `01-eia.md` ausente é tratado como corpo vazio implícito (mesmo padrão de
 * `fallbackEIA` em `newsletter-parse.ts`) — se o Stage 3 ainda não rodou,
 * não há nada pra sincronizar (o mirror em `02-reviewed.md` nesse caso é o
 * placeholder "ainda processando", que não bate com nenhum credit real, mas
 * isso não é um erro de sync — é ordem de stages, fora de escopo aqui).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { syncEiaBlockFromReviewed } from "./lib/eia-sync.ts";

function parseArgs(argv: string[]): { editionDir: string } | null {
  const args = parseArgsSimple(argv);
  const editionDir = args["edition-dir"] ?? "";
  if (!editionDir) return null;
  return { editionDir };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: sync-eia-block.ts --edition-dir <dir>");
    process.exit(1);
  }

  const editionDir = resolve(args.editionDir);
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");

  if (!existsSync(reviewedPath)) {
    console.error(`[sync-eia-block] ${reviewedPath} não existe.`);
    process.exit(3);
  }

  const reviewedMd = readFileSync(reviewedPath, "utf8");
  const eiaMd = existsSync(eiaPath) ? readFileSync(eiaPath, "utf8") : "";

  const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, editionDir);

  if (!result.changed) {
    console.log(`[sync-eia-block] no-op (${result.reason}) — nada a sincronizar.`);
    return;
  }

  if (!existsSync(eiaPath)) {
    console.log(
      `[sync-eia-block] ${eiaPath} não existe ainda — mirror presente em 02-reviewed.md ` +
        "mas sem 01-eia.md real pra sincronizar (Stage 3 provavelmente ainda não rodou). No-op.",
    );
    return;
  }

  writeFileSync(eiaPath, result.newEiaMd, "utf8");
  console.log(`[sync-eia-block] ${eiaPath} sincronizado com o mirror pós-Clarice de 02-reviewed.md.`);
}

if (isMainModule(import.meta.url)) main();
