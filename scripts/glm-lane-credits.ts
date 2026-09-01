#!/usr/bin/env npx tsx
/**
 * glm-lane-credits.ts (#6930)
 *
 * Snapshot de `GET /api/v1/credits` do OpenRouter — usado por
 * `scripts/dispatch-glm-lane-unit.sh` ANTES e DEPOIS de cada unidade
 * (`docs/lane-glm.md`, condição (d): "Por unidade: snapshot de
 * `/api/v1/credits` antes e depois"). Devolve o TOTAL de crédito
 * restante/usado da conta — não separa GLM de Sonnet (isso só o
 * `/api/v1/activity`, por dia, consegue, e não cobre o dia corrente; ver
 * `scripts/track-quality-report.ts`, métrica 5). A separação por modelo
 * de uma unidade específica é reconciliada depois, no dia seguinte, por
 * quem for montar o relatório do piloto — não é isto que resolve isso.
 *
 * `OPENROUTER_MANAGEMENT_KEY` é carregada via `loadProjectEnv()`
 * (`scripts/lib/env-loader.ts`, usa o pacote `dotenv`) e NUNCA por
 * `grep`/`cut` cru sobre `.env` — achado do editor (#6930): `sync-env`
 * grava o valor ENTRE ASPAS, e um parser ingênuo passa as aspas adiante,
 * a API responde `401 Missing Authentication header`, e isso lê como
 * "key inválida" quando o problema real são as aspas.
 *
 * Uso:
 *   npx tsx scripts/glm-lane-credits.ts
 *   → imprime `{"ok":true,"totalCreditsUsd":X,"totalUsageUsd":Y,"timestampIso":"..."}`
 *   ou `{"ok":false,"warning":"..."}` (nunca lança, nunca fabrica 0).
 *
 * Exit codes: 0 sempre que o JSON foi impresso (mesmo `ok:false` —
 * quem chama lê o campo `ok`, não o exit code, mesmo padrão de
 * `fetchOpenRouterActivity`). Só sai != 0 em uso inválido de CLI, que
 * este script não tem (sem argumentos).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";

const OPENROUTER_CREDITS_TIMEOUT_MS = 15_000;

export interface OpenRouterCreditsSnapshot {
  ok: boolean;
  totalCreditsUsd?: number;
  totalUsageUsd?: number;
  timestampIso?: string;
  warning?: string;
}

interface OpenRouterCreditsResponseBody {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
}

/**
 * Único ponto de I/O — fail-soft por completo (mesmo contrato de
 * `fetchOpenRouterActivity` em `scripts/track-quality-report.ts`): chave
 * ausente, timeout, status != 200, ou corpo sem os campos esperados
 * degradam pra `ok: false` com aviso nomeado, nunca lançam e nunca
 * fabricam um número (um `0` fabricado aqui pareceria "custo zero" pra
 * quem monta o relatório da unidade, quando na verdade é "não sei").
 */
export async function fetchOpenRouterCredits(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterCreditsSnapshot> {
  if (!apiKey) {
    return { ok: false, warning: "OPENROUTER_MANAGEMENT_KEY ausente no env — snapshot de crédito indisponível, nunca 0 fabricado" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_CREDITS_TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const isForbidden = res.status === 401 || res.status === 403;
      const hint = isForbidden
        ? " (401/403 costuma ser key com aspas sobrando do .env, ou key de INFERÊNCIA em vez de management — confira OPENROUTER_MANAGEMENT_KEY)"
        : "";
      return { ok: false, warning: `GET /api/v1/credits respondeu ${res.status}${hint}` };
    }
    const body = (await res.json()) as OpenRouterCreditsResponseBody;
    const totalCreditsUsd = body.data?.total_credits;
    const totalUsageUsd = body.data?.total_usage;
    if (typeof totalCreditsUsd !== "number" || typeof totalUsageUsd !== "number") {
      return { ok: false, warning: "GET /api/v1/credits: corpo sem data.total_credits/data.total_usage numéricos" };
    }
    return { ok: true, totalCreditsUsd, totalUsageUsd, timestampIso: new Date().toISOString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `GET /api/v1/credits falhou: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv();
  fetchOpenRouterCredits(process.env.OPENROUTER_MANAGEMENT_KEY).then((snapshot) => {
    console.log(JSON.stringify(snapshot));
  });
}
