/**
 * check-session-leakage.ts (#5547 item 4)
 *
 * CLI do checklist de qualidade editorial — roda
 * `scripts/lib/session-leakage-checklist.ts` sobre a edição de TRATAMENTO da
 * #5419 e imprime um relatório ✓/✗ por valor conhecido (#5414) + candidatos
 * novos não cobertos encontrados nos playbooks.
 *
 * Uso:
 *   npx tsx scripts/check-session-leakage.ts --edition AAMMDD
 *   npx tsx scripts/check-session-leakage.ts --edition AAMMDD --json
 *
 * Exit code: 0 sempre — é um relatório de qualidade pra leitura humana antes
 * do gate do #5419, não um gate mecânico próprio (a `#5547` pede
 * "verificável programaticamente", não "bloqueante").
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { buildSessionLeakageReport } from "./lib/session-leakage-checklist.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function formatReport(report: ReturnType<typeof buildSessionLeakageReport>): string {
  const lines: string[] = [];
  lines.push(`# Checklist de vazamento de sessão — edição ${report.edition} (#5414/#5547)`);
  lines.push("");
  lines.push("## Os 9 valores conhecidos (#5414)");
  for (const c of report.persisted_state) {
    const mark = c.ok ? "✓" : c.optional ? "○" : "✗";
    lines.push(`${mark} ${c.key}  (${c.state_file})${c.note ? ` — ${c.note}` : ""}`);
  }
  lines.push("");
  lines.push("## Candidatos novos não cobertos (scan de playbooks)");
  if (report.uncovered_mentions.length === 0) {
    lines.push("Nenhum candidato novo encontrado — os playbooks atuais não têm menção de \"valor de sessão\" sem marcador #5414 próximo.");
  } else {
    for (const m of report.uncovered_mentions) {
      lines.push(`⚠ ${m.file}:${m.line} — ${m.text}`);
    }
    lines.push("");
    lines.push("Estes candidatos precisam de triagem humana — nem todo match é um bug (ex: valor trivialmente");
    lines.push("recomputável em 1 linha pode não valer persistência); o scan lista, não julga.");
  }
  lines.push("");
  lines.push(`**Veredito: ${report.clean ? "LIMPO" : "PENDÊNCIAS ENCONTRADAS"}**`);
  return lines.join("\n");
}

function main(): void {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition) {
    console.error("Uso: npx tsx scripts/check-session-leakage.ts --edition AAMMDD [--json] [--repo-root <path>]");
    process.exit(2);
  }

  const repoRoot = resolve(ROOT, values["repo-root"] ?? ".");
  const editionsDirsMap = enumerateEditionDirs(resolve(repoRoot, editionsRoot()));
  const editionDirPath = editionsDirsMap.get(edition);
  if (!editionDirPath) {
    console.log(JSON.stringify({ error: "edition_not_found", edition }));
    process.exit(1);
    return;
  }

  const agentsDir = resolve(repoRoot, ".claude", "agents");
  const report = buildSessionLeakageReport(editionDirPath, edition, agentsDir);

  if (flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
