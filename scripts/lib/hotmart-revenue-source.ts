/**
 * scripts/lib/hotmart-revenue-source.ts (#10734 item 4b)
 *
 * Fonte de receita Hotmart do ARPU/LTV: lê o espelho `data/hotmart/vendas.jsonl`
 * e o estado do sync (`vendas.estado.json`, cobertura de dias lidos), ambos
 * escritos por `scripts/sync-hotmart-vendas.ts`, e delega o cálculo a
 * `computeHotmartMonthRevenue` (puro, `ltv.ts`). Mesmo par de
 * `amazon-revenue-config.ts`: o I/O fica aqui porque `ltv.ts` é puro.
 *
 * Consumido por `scripts/cac-report.ts` e pelo bloco Valor do Studio
 * (`scripts/studio-ui/studio-metrics.ts`) — os dois montam o mesmo
 * `revenueBySource` (paridade #9023).
 *
 * Fail-soft: espelho ausente ou com linha inválida, estado ausente/ilegível,
 * `hotmart.vendas_desde` ausente em `platform.config.json` (#10991) ou mês
 * fora da cobertura devolvem `valorBrl: null` com `motivo` — a Hotmart segue no ARPU
 * como fonte SEM dado (o número sai PISO), como antes do #10734 4b. Nunca
 * lança, nunca devolve R$ 0 por falta de dado.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeHotmartMonthRevenue, type HotmartMonthRevenue } from "./ltv.ts";
import { ESPELHO_REL_PATH, estadoPathDoEspelho, lerEspelho, parseEstadoSync } from "./hotmart-vendas-espelho.ts";
import { loadHotmartVendasDesde } from "./hotmart-vendas-config.ts";

export function loadHotmartMonthRevenue(rootDir: string, month: string): HotmartMonthRevenue {
  const espelhoPath = resolve(rootDir, "data", ...ESPELHO_REL_PATH.split("/"));
  const estadoPath = estadoPathDoEspelho(espelhoPath);
  const semDado = (motivo: string): HotmartMonthRevenue => ({ valorBrl: null, pisoBrl: null, aprovadas: 0, estornos: 0, motivo });
  if (!existsSync(estadoPath)) {
    return semDado(`estado do sync Hotmart ausente em ${estadoPath} — sync ainda não rodou (task Diaria-Hotmart-Vendas-Sync)`);
  }
  try {
    const estado = parseEstadoSync(readFileSync(estadoPath, "utf8"));
    const texto = existsSync(espelhoPath) ? readFileSync(espelhoPath, "utf8") : "";
    const { registros, invalidas } = lerEspelho(texto);
    // #10892 review: linha inválida no espelho é venda que a soma não vê —
    // devolver um valor menor sem rótulo de PISO seria fabricar.
    if (invalidas > 0) {
      return semDado(`${invalidas} linha(s) inválida(s) no espelho Hotmart ${espelhoPath} — receita do mês não confiável`);
    }
    // #10991: go-live do webhook — dia anterior nunca conta como coberto.
    const { vendasDesde, motivo } = loadHotmartVendasDesde(rootDir);
    if (vendasDesde === null) return semDado(`Hotmart ${month}: ${motivo}`);
    return computeHotmartMonthRevenue({ registros, cobertura: estado.cobertura, month, vendasDesde });
  } catch (e) {
    return semDado(`falha ao ler o espelho Hotmart (${(e as Error).message})`);
  }
}
