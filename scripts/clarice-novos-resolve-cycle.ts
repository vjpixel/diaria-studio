#!/usr/bin/env node
/**
 * clarice-novos-resolve-cycle.ts (#4347 Etapa 3a)
 *
 * Wrapper CLI fino sobre `resolveLatestMonthlyCycleFromDisk`
 * (scripts/lib/mensal/monthly-paths.ts) — resolve qual ciclo mensal a skill
 * `/diaria-clarice-novos` deve redistribuir (preview pronto + gabarito É IA?
 * + assunto conhecido; cai no ciclo anterior — D3 — se o corrente não estiver
 * pronto; nunca aborta por causa disso, só se NENHUM ciclo estiver pronto).
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-resolve-cycle.ts [--subject "Assunto explícito"]
 */
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { resolveLatestMonthlyCycleFromDisk } from "./lib/mensal/monthly-paths.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const subjectOverride = getArg(argv, "subject") || undefined;
  const result = resolveLatestMonthlyCycleFromDisk(subjectOverride);
  if (!result.cycle) {
    console.error("❌ nenhum ciclo mensal pronto pra reenvio (preview + gabarito É IA? + assunto conhecido). Detalhe por ciclo candidato:");
    for (const c of result.checked) {
      console.error(`   ${c.cycle}: ${c.reasons.join("; ") || "ok"}`);
    }
    process.exit(1);
  }
  if (result.fallback) {
    console.error(`⚠️  ciclo mais recente não estava pronto — caindo em ${result.cycle} (D3, registrado no relatório da rodada).`);
  } else {
    console.error(`✓ ciclo resolvido: ${result.cycle}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
