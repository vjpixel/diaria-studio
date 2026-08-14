#!/usr/bin/env node
/**
 * scripts/clarice-dashboard-precompute.ts (#5217)
 *
 * Precompute HORÁRIO do dashboard `clarice-dashboard` (workers/brevo-dashboard):
 * bate `GET /` (SEM `?fresh=1`) autenticado via `Authorization: Bearer
 * <AUTH_TOKEN>` — auth máquina-a-máquina que reusa o MESMO token do login
 * humano por cookie (decisão do editor, 13/08/2026: nenhum secret novo; ver
 * docstring de `isAuthenticated` em `workers/brevo-dashboard/src/index.ts`
 * e `.env.example` pro trade-off aceito). A request roda o MESMO caminho de
 * código que uma visita humana normal (`buildDashboardResponse`) — não
 * duplica `fetchRecentCampaigns` nem nenhuma outra lógica de fetch. Fora de
 * `?fresh=1`, ela é tratada como `!isFresh` e aciona o write-through gated
 * por hash de `dash:lastgood:campaigns` (#5216) — só grava quando o
 * conteúdo mudou desde o último write bem-sucedido.
 *
 * **Causa raiz que esta task resolve (não é rate-limit, é cache órfão):**
 * o Cron Trigger que pré-computava esse KV foi removido de propósito
 * (#3553/#3639 — "a dashboard não deve mais se atualizar sozinha, só no
 * reload"). Só que o painel virou 100% read-only do KV no fallback de
 * rate-limit (#4206/#4212) e nada mais reabastecia esse KV entre visitas
 * humanas — o clique em "Atualizar agora" (`?fresh=1`) faz fetch ao vivo
 * mas NUNCA persiste (`!isFresh` gate em buildDashboardResponse). Resultado:
 * sem um visitante humano regular, `dash:lastgood:campaigns` fica órfão e o
 * fallback de rate-limit degrada pra um snapshot cada vez mais velho.
 *
 * **Por que isso não contraria a decisão do #3553** ("a dashboard não deve
 * mais se atualizar sozinha"): 5 das 6 chaves de KV do painel já são
 * mantidas quentes por job externo agendado (`Diaria-Clarice-Sync`,
 * `Diaria-Clarice-Cohorts-Crawl`, `Diaria-Postmaster-Spam-Sync`, pushes
 * próprios) — só `dash:lastgood:campaigns` não tinha zelador. O editor já
 * abençoou esse padrão na própria #3553: "o push local das 03:40 permanece.
 * O 'não atualizar sozinha' se refere só ao Cron Trigger do Worker". Este
 * script é exatamente esse tipo de push externo — não reintroduz o Cron
 * Trigger dentro do Worker.
 *
 * Cadência: HORÁRIA (24 execuções/dia) — decisão do editor, 13/08/2026.
 * Custo medido: execução morna ~2 chamadas Brevo; a cadência horária usa
 * ~44/100 do teto real de 100 req/hora da Brevo (ver #5215). O editor checa
 * o painel a partir das 10:00 — a cadência horária garante dado fresco já
 * na 1ª olhada do dia sem precisar de um horário-âncora dedicado.
 *
 * Uso:
 *   npx tsx scripts/clarice-dashboard-precompute.ts               # GET / autenticado, best-effort
 *   npx tsx scripts/clarice-dashboard-precompute.ts --dry-run      # imprime o que faria, NÃO bate a rede
 *
 * Env: `CLARICE_DASHBOARD_AUTH_TOKEN` — MESMO valor do secret `AUTH_TOKEN`
 * do Worker (ver `.env.example`). Sem ele, aborta com exit 1 (fail loud —
 * nunca silenciosamente "sucesso" sem ter feito nada).
 *
 * Registro da task: `scripts/lib/scheduled-tasks.ts` →
 * `Diaria-Clarice-Dashboard-Precompute`. Arme (Linux/systemd, rodar da
 * checkout compartilhada, NUNCA de um worktree isolado — ver
 * `docs/clarice-dashboard-precompute-setup.md`):
 *   npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Dashboard-Precompute && \
 *     systemctl --user daemon-reload && \
 *     systemctl --user enable --now diaria-clarice-dashboard-precompute.timer
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[clarice-dashboard-precompute]";
export const DASHBOARD_URL = "https://clarice-dashboard.diaria.workers.dev";
// #5217: fetch ao vivo completo (créditos + agendadas + enviadas + abas KV)
// pode levar dezenas de segundos com a Brevo sob carga — generoso o
// suficiente para não abortar prematuramente numa run legítima só lenta,
// curto o suficiente para não travar a task horária indefinidamente numa
// Brevo travada (mesma ordem de grandeza do orçamento de retry do guard
// Clarice-Envio, ver CLAUDE.md).
export const FETCH_TIMEOUT_MS = 60_000;

/**
 * Bate `GET {DASHBOARD_URL}/` autenticado via Bearer — exportado pra teste
 * direto com `fetchFn` injetado (mock), sem rede real. Nunca lança: uma
 * falha de rede/timeout vira `{ ok: false, error }` em vez de propagar.
 */
export async function runPrecompute(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const res = await fetchFn(`${DASHBOARD_URL}/`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: body.slice(0, 300) };
    }
    return { ok: true, status: res.status, error: null };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");

  const token = process.env.CLARICE_DASHBOARD_AUTH_TOKEN;
  if (!token) {
    console.error(
      `${LOG_PREFIX} CLARICE_DASHBOARD_AUTH_TOKEN não configurado no ambiente — abortando (ver .env.example).`,
    );
    process.exitCode = 1;
    return;
  }

  if (isDryRun) {
    console.log(
      `${LOG_PREFIX} --dry-run: faria GET ${DASHBOARD_URL}/ (sem ?fresh=1) com Authorization: Bearer <token> — não executado.`,
    );
    return;
  }

  const result = await runPrecompute(token);
  if (!result.ok) {
    console.error(
      `${LOG_PREFIX} GET ${DASHBOARD_URL}/ falhou (status=${result.status ?? "n/a"}): ${result.error}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${LOG_PREFIX} precompute ok (status=${result.status}) — dash:lastgood:campaigns atualizado se o conteúdo mudou (gate por hash, #5216).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
