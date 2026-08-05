#!/usr/bin/env node
/**
 * clarice-novos-resolve-cycle.ts (#4347 Etapa 3a, guard #4621)
 *
 * Wrapper CLI fino sobre `resolveLatestMonthlyCycleFromDisk`
 * (scripts/lib/mensal/monthly-paths.ts) — resolve qual ciclo mensal a skill
 * `/diaria-clarice-novos` deve redistribuir (preview pronto + gabarito É IA?
 * + assunto conhecido; cai no ciclo anterior — D3 — se o corrente não estiver
 * pronto; nunca aborta por causa disso, só se NENHUM ciclo estiver pronto).
 *
 * #4621: quando o fallback escolhido diverge por MAIS de 1 ciclo mensal do
 * ciclo mais recente com atividade real em `data/clarice-subscribers/`
 * (envios ad-hoc por grupo — `clarice-build-segment.ts`/`clarice-schedule-group.ts`
 * `--group` — que nunca escrevem em `campaigns-summary.json`, então o D3
 * acima não os enxerga), o script ABORTA exigindo `--subject` explícito em
 * vez de aceitar o fallback silenciosamente (achado ao vivo 260804: caiu 2
 * meses pra trás, no digest de junho, com o ciclo de agosto já em envio real).
 * Ver `evaluateClariceActivityGuard` pra a lógica pura.
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-resolve-cycle.ts [--subject "Assunto explícito"]
 */
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  resolveLatestMonthlyCycleFromDisk,
  clariceActivityDepsFromDisk,
  evaluateClariceActivityGuard,
  type ResolveLatestMonthlyCycleResult,
  type ClariceActivityDeps,
} from "./lib/mensal/monthly-paths.ts";

/** Overrides testáveis (produção usa os defaults reais de disco). */
export interface ResolveCycleMainOverrides {
  resolveCycle?: (subjectOverride?: string) => ResolveLatestMonthlyCycleResult;
  activityDeps?: ClariceActivityDeps;
}

export function main(argv: string[] = process.argv.slice(2), overrides: ResolveCycleMainOverrides = {}): void {
  const subjectOverride = getArg(argv, "subject") || undefined;
  const resolveCycle = overrides.resolveCycle ?? resolveLatestMonthlyCycleFromDisk;
  const result = resolveCycle(subjectOverride);
  if (!result.cycle) {
    console.error("❌ nenhum ciclo mensal pronto pra reenvio (preview + gabarito É IA? + assunto conhecido). Detalhe por ciclo candidato:");
    for (const c of result.checked) {
      console.error(`   ${c.cycle}: ${c.reasons.join("; ") || "ok"}`);
    }
    process.exit(1);
  }

  const activityDeps = overrides.activityDeps ?? clariceActivityDepsFromDisk();
  const guard = evaluateClariceActivityGuard(result.cycle, result.fallback, !!subjectOverride, activityDeps);
  if (guard.note) {
    console.error(`⚠️  ${guard.note}`);
  }
  if (guard.blocked) {
    console.error(
      `❌ fallback caiu mais de 1 ciclo mensal atrás do ciclo mais recente com atividade real em ` +
      `data/clarice-subscribers/ (${guard.activeCycle}) — abortando pra evitar reenviar conteúdo ` +
      `desatualizado (#4621). Passe --subject "Assunto explícito" pra confirmar ${result.cycle} mesmo assim.`,
    );
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
