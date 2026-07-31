#!/usr/bin/env node
/**
 * clarice-novos-resolve-key.ts (#4347 Etapa 4)
 *
 * Resolve a `--key` idempotente pra `clarice-schedule-group.ts` na rodada de
 * hoje da skill `/diaria-clarice-novos`: `novos-{AAMMDD}`, com sufixo
 * `-2`/`-3`… se a skill já rodou (e criou campanha) mais de uma vez no
 * mesmo dia — lê as keys já existentes em `{ciclo}/segments/group-campaigns.json`
 * (mesmo arquivo que `clarice-schedule-group.ts --create` escreve).
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-resolve-key.ts --cycle 2606-07 --date 260730
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir } from "./lib/clarice-paths.ts";
import { resolveNovosKey } from "./lib/clarice-novos-state.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const cycle = getArg(argv, "cycle");
  const date = getArg(argv, "date");
  if (!cycle || !date) {
    console.error("--cycle {conteúdo}-{envio} e --date {AAMMDD} são obrigatórios.");
    process.exit(1);
  }
  const dataRootArg = getArg(argv, "data-root") || undefined;
  const campaignsPath = resolve(clariceSegmentsDir(cycle, dataRootArg), "group-campaigns.json");
  let existingKeys: string[] = [];
  if (existsSync(campaignsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(campaignsPath, "utf8")) as Array<{ key?: string }>;
      if (Array.isArray(parsed)) existingKeys = parsed.map((c) => c.key ?? "").filter(Boolean);
    } catch {
      // JSON corrompido — trata como "nenhuma key existente" (fail-safe: pior
      // caso é reusar uma key que na verdade já existe, mas --create já tem
      // seu próprio guard idempotente/#3354 pra esse cenário).
    }
  }
  const key = resolveNovosKey(existingKeys, date);
  console.error(`✓ key resolvida: ${key}`);
  console.log(JSON.stringify({ key }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
