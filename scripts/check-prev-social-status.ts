#!/usr/bin/env node
/**
 * scripts/check-prev-social-status.ts (#5756)
 *
 * CLI do check 0l do Stage 0 — posts sociais da edição ANTERIOR que exigem
 * atenção do editor antes de começar a edição de hoje.
 *
 * Substitui o julgamento em prosa que vivia no playbook
 * (`orchestrator-stage-0-preflight.md` §0l). A regra antiga — "`scheduled` com
 * `scheduled_at < now` → alertar" — produzia um falso alarme de ~12 posts em
 * TODA edição, porque quatro dos cinco canais nunca saem de `scheduled` por
 * construção (ver `lib/prev-social-status.ts` para a medição). Isso é
 * exatamente o caso da regra do CLAUDE.md sobre validar estado externo com
 * TS determinístico (#573) em vez de deixar o modelo inferir.
 *
 * Sempre sai 0: é informativo, nunca bloqueia a edição.
 *
 * Uso:
 *   npx tsx scripts/check-prev-social-status.ts --file <06-social-published.json> [--json]
 *   npx tsx scripts/check-prev-social-status.ts --prev-dir <dir-da-edicao-anterior> [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { analyzePrevSocial, formatPrevSocialSummary, type SocialPostLike } from "./lib/prev-social-status.ts";

export function loadPosts(filePath: string): SocialPostLike[] {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as { posts?: SocialPostLike[] };
  return Array.isArray(parsed.posts) ? parsed.posts : [];
}

function main(): number {
  const { values, flags } = parseArgsLib(process.argv.slice(2));

  let filePath = values["file"];
  if (!filePath && values["prev-dir"]) {
    filePath = join(values["prev-dir"], "_internal", "06-social-published.json");
  }
  if (!filePath) {
    console.error(
      "Uso: npx tsx scripts/check-prev-social-status.ts --file <06-social-published.json> | --prev-dir <dir> [--json]",
    );
    return 2;
  }

  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    // Edição anterior sem posts sociais registrados é normal (primeira
    // edição, edição histórica). Silencioso, exit 0 — nunca um alarme.
    if (flags.has("json")) console.log(JSON.stringify({ findings: [], terminalByDesign: 0, total: 0, file: null }));
    return 0;
  }

  const posts = loadPosts(abs);
  const report = analyzePrevSocial(posts, new Date());
  const prevEdition = values["prev-edition"] ?? abs;

  if (flags.has("json")) {
    console.log(JSON.stringify({ ...report, file: abs }, null, 2));
    return 0;
  }

  const summary = formatPrevSocialSummary(report, prevEdition);
  if (summary) {
    console.log(summary);
  } else {
    console.log(
      `edição anterior: nenhum post social exige atenção ` +
        `(${report.terminalByDesign} em estado terminal por desenho, ${report.total} no total)`,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
