#!/usr/bin/env node
/**
 * scripts/kit-verify-click-fields.ts (#6185)
 *
 * Sonda ao vivo que confirma os nomes de campo de
 * `GET /v4/broadcasts/{id}/clicks` contra um clique real — a única pergunta
 * que ainda bloqueia o eixo de cliques da migração (#463).
 *
 * A interpretação mora em `lib/kit-click-fields.ts` (pura, testada); aqui só
 * a I/O.
 *
 * ## Uso
 *
 *   npx tsx scripts/kit-verify-click-fields.ts --broadcast 25609304
 *
 * ## Exit codes
 *
 *   0 — CONFIRMADO: há clique real e os campos foram observados
 *   1 — uso: `--broadcast` ausente ou não numérico
 *   2 — INCONCLUSIVO: sem clique ainda. **Não é erro** — rodar de novo depois.
 *   3 — falha de API
 *
 * O `2` é deliberadamente distinto do `3`: "ninguém clicou" e "a chamada
 * falhou" levam a ações opostas (esperar vs. investigar), e colapsá-los num
 * código só foi exatamente o bug P1 do review em `schedule-kit-diaria.ts`
 * (#6162), onde o 2 virava 0.
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { getBroadcastClicks, getBroadcastStats } from "./lib/kit-client.ts";
import { interpretClicksResponse, renderVeredicto, type VeredictoClicks } from "./lib/kit-click-fields.ts";

export interface VerifyDeps {
  fetchClicks(id: number): Promise<{ clicks: unknown }>;
  fetchStats(id: number): Promise<{ total_clicks?: number; status?: string }>;
  log(line: string): void;
}

export function productionDeps(): VerifyDeps {
  return {
    fetchClicks: async (id) => {
      const r = await getBroadcastClicks(id, { perPage: 100 });
      return { clicks: r.clicks };
    },
    fetchStats: (id) => getBroadcastStats(id),
    log: (line) => console.log(line),
  };
}

export type VerifyResult =
  | { code: 0; veredicto: VeredictoClicks }
  | { code: 2; veredicto: VeredictoClicks }
  | { code: 3; reason: string };

export async function verifyClickFields(broadcastId: number, deps: VerifyDeps): Promise<VerifyResult> {
  // `stats` primeiro: é ele que distingue "enviado e ninguém clicou" de
  // "nem foi entregue ainda" — sem esse contexto, o array vazio fica mudo.
  let totalClicks: number | undefined;
  let broadcastStatus: string | undefined;
  try {
    const s = await deps.fetchStats(broadcastId);
    totalClicks = s.total_clicks;
    broadcastStatus = s.status;
  } catch (e) {
    // Falha aqui não impede a pergunta principal — só empobrece o diagnóstico.
    deps.log(`  (aviso: stats indisponível — ${(e as Error).message}; seguindo sem esse contexto)`);
  }

  let clicks: unknown;
  try {
    ({ clicks } = await deps.fetchClicks(broadcastId));
  } catch (e) {
    return { code: 3, reason: `GET /broadcasts/${broadcastId}/clicks falhou: ${(e as Error).message}` };
  }

  const veredicto = interpretClicksResponse({ clicks, totalClicks, broadcastStatus });
  deps.log(renderVeredicto(veredicto, broadcastId));
  return veredicto.status === "confirmado" ? { code: 0, veredicto } : { code: 2, veredicto };
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const raw = getArg(process.argv.slice(2), "broadcast");
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    console.error("uso: npx tsx scripts/kit-verify-click-fields.ts --broadcast <id>");
    process.exitCode = 1;
    return;
  }
  let result: VerifyResult;
  try {
    result = await verifyClickFields(id, productionDeps());
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
  }
  if (result.code === 3) console.error(`  FALHA — ${result.reason}`);
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}
