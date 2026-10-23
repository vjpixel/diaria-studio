/**
 * scripts/lib/hotmart-vendas-config.ts (#10991)
 *
 * Lê `hotmart.vendas_desde` de `platform.config.json`: o go-live do webhook de
 * vendas da Hotmart (21/10/2026). Nenhum dia anterior conta como coberto no
 * estado do espelho (`trechosCobertosDaJanela`) nem na receita do mês
 * (`computeHotmartMonthRevenue`). O parse é puro (`parseVendasDesde`,
 * `hotmart-vendas-espelho.ts`); aqui fica só o I/O, para `ltv.ts` e o miolo do
 * espelho seguirem sem fs.
 *
 * Consumido por `scripts/sync-hotmart-vendas.ts` (escrita da cobertura) e
 * `scripts/lib/hotmart-revenue-source.ts` (leitura no ARPU/LTV). Fail-soft:
 * arquivo ausente, JSON quebrado ou chave ausente/inválida devolvem
 * `vendasDesde: null` com `motivo` — nunca lança. `null` quer dizer "não dá
 * para saber desde quando o KV recebia vendas": nada vira coberto e a Hotmart
 * sai como fonte sem dado.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseVendasDesde } from "./hotmart-vendas-espelho.ts";

export interface VendasDesdeConfig {
  readonly vendasDesde: string | null;
  readonly motivo: string | null;
}

export function loadHotmartVendasDesde(rootDir: string): VendasDesdeConfig {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) {
    return { vendasDesde: null, motivo: `${path} ausente — sem hotmart.vendas_desde (go-live do webhook de vendas)` };
  }
  try {
    const vendasDesde = parseVendasDesde(JSON.parse(readFileSync(path, "utf8")));
    if (vendasDesde === null) {
      return { vendasDesde: null, motivo: `hotmart.vendas_desde ausente ou inválido em ${path} (esperado AAAA-MM-DD, go-live do webhook de vendas)` };
    }
    return { vendasDesde, motivo: null };
  } catch (e) {
    return { vendasDesde: null, motivo: `falha ao ler ${path} (${(e as Error).message})` };
  }
}
