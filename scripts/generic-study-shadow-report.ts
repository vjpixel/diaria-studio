#!/usr/bin/env tsx
/**
 * generic-study-shadow-report.ts (#9673)
 *
 * Agregador para a decisão de ligar `selection.generic_study_penalty.enabled`
 * (#9462). Percorre as edições a partir de `--since` (default 261006, 1ª
 * edição com a pergunta explícita no gate 4), junta os
 * `_internal/04-generic-study-feedback.json` e reporta sim / não / não lido,
 * mais o dado secundário (tirou × manteve no `02-reviewed.md`).
 *
 * Regra embutida (comentário do editor de 05/10/2026 na #9673): a decisão usa
 * SÓ respostas explícitas. `nao_lido` — inclusive edição que tinha item 🔎 em
 * modo sombra mas nenhum registro gravado — nunca entra no veredito. Com
 * menos de 5 respostas explícitas: "insuficiente — continuar perguntando".
 *
 * Somente leitura.
 *
 * Uso:
 *   npx tsx scripts/generic-study-shadow-report.ts [--editions-dir data/editions] [--since 261006] [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { runMain } from "./lib/exit-handler.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { isValidEditionDir } from "./lib/edition-utils.ts";
import {
  FEEDBACK_FILE,
  aggregateShadowFeedback,
  buildFeedback,
  readShadowItems,
  type GenericStudyFeedbackItem,
  type ShadowEditionFeedback,
  type ShadowReport,
} from "./lib/generic-study-feedback.ts";

export const DEFAULT_SINCE = "261006";

/**
 * Coleta o feedback por edição. Edição com item em sombra e sem
 * `04-generic-study-feedback.json` entra com todos os itens `nao_lido`
 * (`sem_registro`). Arquivo ilegível conta igual a ausente.
 */
export function collectShadowFeedback(editionsDir: string, since = DEFAULT_SINCE): ShadowEditionFeedback[] {
  const dirs = enumerateEditionDirs(editionsDir);
  const out: ShadowEditionFeedback[] = [];
  for (const aammdd of [...dirs.keys()].filter(isValidEditionDir).sort()) {
    if (aammdd < since) continue;
    const dir = dirs.get(aammdd);
    if (!dir) continue;
    const fbPath = join(dir, "_internal", FEEDBACK_FILE);
    let items: GenericStudyFeedbackItem[] | null = null;
    if (existsSync(fbPath)) {
      try {
        const f = JSON.parse(readFileSync(fbPath, "utf8")) as { items?: unknown };
        if (Array.isArray(f.items)) items = f.items as GenericStudyFeedbackItem[];
      } catch {
        items = null;
      }
    }
    if (items) {
      if (items.length > 0) out.push({ edition: aammdd, items });
      continue;
    }
    const shadow = readShadowItems(dir);
    if (shadow.length === 0) continue;
    const reviewedPath = join(dir, "02-reviewed.md");
    const reviewedMd = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
    out.push({
      edition: aammdd,
      sem_registro: true,
      // Sem resposta nenhuma: todos nao_lido; acao_no_final ainda é derivável.
      items: buildFeedback({ items: shadow, answers: new Map(), reviewedMd, now: "" }),
    });
  }
  return out;
}

export function formatShadowReport(r: ShadowReport, since: string): string {
  const lines = [
    `Penalidade de estudo/case genérico (#9462) — modo sombra, edições ≥ ${since}`,
    `  Edições com item 🔎: ${r.editions} · itens: ${r.total}`,
    `  Respostas explícitas: sim ${r.sim} · não ${r.nao}  (total ${r.respondidos})`,
    `  Não lido: ${r.nao_lido}${r.sem_registro ? ` (${r.sem_registro} sem registro no gate)` : ""} — fora do veredito`,
    `  Dado secundário (02-reviewed.md, não é resposta): tirou ${r.acao.tirou} · manteve ${r.acao.manteve}` +
      (r.acao.desconhecida ? ` · desconhecido ${r.acao.desconhecida}` : ""),
  ];
  for (const n of r.nao_items) lines.push(`    ✗ não — ${n.edition}: ${n.titulo}`);
  lines.push(`  Veredito: ${r.verdict_text}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { flags, values } = parseCliArgs(process.argv.slice(2));
  const editionsDir = resolve(values["editions-dir"] ?? join("data", "editions"));
  const since = values["since"] ?? DEFAULT_SINCE;
  if (!/^\d{6}$/.test(since)) {
    console.error(`--since inválido: ${since} (esperado AAMMDD)`);
    process.exit(1);
  }
  const report = aggregateShadowFeedback(collectShadowFeedback(editionsDir, since));
  if (flags.has("json")) process.stdout.write(JSON.stringify({ since, ...report }, null, 2) + "\n");
  else process.stdout.write(formatShadowReport(report, since) + "\n");
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
