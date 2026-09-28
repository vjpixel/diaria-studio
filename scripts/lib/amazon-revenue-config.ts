/**
 * scripts/lib/amazon-revenue-config.ts (#8423 fleet review item 8)
 *
 * Extraído de `scripts/studio-ui/studio-metrics.ts`/`scripts/cac-report.ts`
 * — as duas cópias liam o mesmo `data/ltv/amazon-revenue.json` com a MESMA
 * lógica fail-soft (arquivo ausente/malformado nunca lança, só devolve
 * `valorMensalBrl: null` com `motivo`); a de `cac-report.ts` descartava o
 * `motivo` no caminho de sucesso. Este módulo faz o I/O (por isso não vive
 * em `scripts/lib/ltv.ts`, que é PURO — ver docstring de lá) e delega o
 * parse a `parseAmazonRevenueConfig` (puro, `ltv.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAmazonRevenueConfig, type AmazonRevenueConfig } from "./ltv.ts";

export interface AmazonRevenueConfigResult {
  valorMensalBrl: number | null;
  atualizadoEm: string | null;
  motivo: string | null;
}

/** Config manual da receita Amazon — fail-soft (arquivo ausente/malformado
 *  nunca lança, só devolve `valorMensalBrl: null` com `motivo`). */
export function loadAmazonRevenueConfig(rootDir: string): AmazonRevenueConfigResult {
  const path = resolve(rootDir, "data", "ltv", "amazon-revenue.json");
  if (!existsSync(path)) {
    return {
      valorMensalBrl: null,
      atualizadoEm: null,
      motivo: `config ausente em ${path} — receita Amazon não tem fonte automatizada (#8423); crie o arquivo com { "valorMensalBrl": <número>, "atualizadoEm": "<ISO>" }`,
    };
  }
  try {
    const parsed: AmazonRevenueConfig | null = parseAmazonRevenueConfig(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) {
      return { valorMensalBrl: null, atualizadoEm: null, motivo: `config malformada em ${path} — esperado { valorMensalBrl: number, atualizadoEm: string }` };
    }
    return { valorMensalBrl: parsed.valorMensalBrl, atualizadoEm: parsed.atualizadoEm, motivo: null };
  } catch (e) {
    return { valorMensalBrl: null, atualizadoEm: null, motivo: `falha ao ler ${path}: ${(e as Error).message}` };
  }
}
