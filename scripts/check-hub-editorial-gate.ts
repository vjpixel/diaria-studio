#!/usr/bin/env node
/**
 * scripts/check-hub-editorial-gate.ts (#7101, #7103)
 *
 * Diagnóstico ANTES de rodar `generate-hub-sources.ts`/`build-hub-page.ts`
 * — roda `validateHubContent` sobre cada hub commitado hoje (via
 * `scripts/lib/hub-editorial-gate.ts`) e classifica o motivo de qualquer
 * falha: gate editorial esperado (#4911/#5124, ação = passada editorial,
 * não bug) vs. defeito real de conteúdo (`invalid`, ação = investigar).
 *
 * Não depende de `data/beehiiv-cache` (roda em qualquer worktree/sessão
 * cloud) e NÃO checa se o dataset está atrasado em relação às edições
 * publicadas — isso é `scripts/hub-staleness-check.ts`, que precisa do
 * cache Beehiiv e por isso é `cannot-verify` fora do checkout com `data/`
 * populado. Os dois se complementam:
 *
 *   check-hub-editorial-gate.ts   — "o que está commitado hoje é válido?"
 *   hub-staleness-check.ts        — "o que está commitado hoje é ATUAL?"
 *
 * Uso:
 *   npx tsx scripts/check-hub-editorial-gate.ts              # tabela humana
 *   npx tsx scripts/check-hub-editorial-gate.ts --json        # JSON (consumo programático)
 *   npx tsx scripts/check-hub-editorial-gate.ts --hub {slug}  # só 1 hub
 *
 * Exit code: 0 quando todo hub é `ok` ou `needs-editorial-review`
 * (informacional — o 2º é esperado depois de qualquer regen de dataset
 * sem passada editorial ainda, não é falha do script). Exit 1 se ≥1 hub é
 * `invalid` (defeito real) OU `cannot-verify` (não deu pra rodar o
 * diagnóstico — nunca sai 0 fingindo que está tudo bem, mesma regra dos
 * demais alarmes do repo).
 */
import { loadHubContent, HUB_LOADERS } from "./build-hub-page.ts";
import { checkHubEditorialGate, type HubEditorialGateResult } from "./lib/hub-editorial-gate.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";

export function runHubEditorialGateCheck(slugs: readonly string[]): HubEditorialGateResult[] {
  return slugs.map((slug) => {
    try {
      const hub = loadHubContent(slug);
      return checkHubEditorialGate(slug, hub);
    } catch (e) {
      return {
        slug,
        verdict: "cannot-verify" as const,
        violations: [],
        cannotVerifyReason: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

function formatHuman(results: HubEditorialGateResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.slug}: ${r.verdict}`);
    if (r.verdict === "needs-editorial-review") {
      lines.push(
        `  → gate #4911/#5124 (esperado, não é bug): updatedDate está atrás da edição mais recente citada.`,
      );
      lines.push(`  → ação: passada editorial (ler edição(ões) nova(s), decidir seção, bumpar UPDATED_DATE em scripts/lib/hubs/${r.slug}.ts) — ver PR #7258 como referência.`);
    } else if (r.verdict === "invalid") {
      lines.push(`  → defeito real (não é o gate #4911/#5124) — investigar antes de tentar regen:`);
      for (const v of r.violations) lines.push(`    - ${v}`);
    } else if (r.verdict === "cannot-verify") {
      lines.push(`  → não deu pra rodar o diagnóstico: ${r.cannotVerifyReason}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = hasFlag(argv, "json");
  const hubArg = getArg(argv, "hub");
  const slugs = hubArg ? [hubArg] : Object.keys(HUB_LOADERS);

  const unknown = slugs.filter((s) => !HUB_LOADERS[s]);
  if (unknown.length > 0) {
    console.error(
      `[check-hub-editorial-gate] hub(s) desconhecido(s): ${unknown.join(", ")}. Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  const results = runHubEditorialGateCheck(slugs);

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatHuman(results));
  }

  const hasProblem = results.some((r) => r.verdict === "invalid" || r.verdict === "cannot-verify");
  process.exitCode = hasProblem ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[check-hub-editorial-gate] erro:", e);
    process.exitCode = 1;
  });
}
