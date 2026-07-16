/**
 * dashboard-clarice.ts (#3563 — fatia 9 do epic #3554 "Studio UI", endereça #3553-A)
 *
 * Modo LOCAL do dashboard mensal (Clarice/Brevo) — reusa `renderDashboardHtml`
 * de `workers/brevo-dashboard/src/sections-core.ts` (zero fork de template),
 * mas monta os inputs a partir de fontes LOCAIS em vez do KV do Worker:
 *
 *   - campanhas enviadas/agendadas → Brevo API direto (`fetchRecentCampaigns`/
 *     `fetchScheduledCampaigns`/`fetchPlanCredits` de brevo-api.ts, com
 *     `BREVO_CLARICE_API_KEY` do `.env.local`) — dado vivo, não snapshot KV.
 *   - `contactsSummary` (aba Contatos) → store SQLite LOCAL direto
 *     (`scripts/lib/clarice-db.ts` + `computeStoreSummary` de
 *     `scripts/clarice-db-summary.ts`) — MELHOR que o snapshot KV (#3553): não
 *     depende do push diário das 03:40, sempre fresco.
 *   - coortes de engajamento / status MillionVerifier / cupons Stripe /
 *     engajamento É IA? → GAP CONHECIDO E DELIBERADO, não implementado nesta
 *     fatia. Esses 4 payloads são pré-computados OFFLINE por scripts caros
 *     (`clarice-engagement-cohorts.ts` faz ~40k GETs per-contato; cupons exige
 *     Stripe API) e só then empurrados pro KV — não são recomputáveis
 *     barato/on-demand a cada carregamento de página local. O painel local
 *     degrada essas 4 abas para "sem dados" (mesmo comportamento gracioso que
 *     o próprio Worker já tem em cold-start/KV vazio — não é uma regressão
 *     nova). #3553 permite explicitamente omitir a aba de cupons; as outras 3
 *     seguem o mesmo espírito. Follow-up possível: ler snapshots locais
 *     desses scripts se/quando eles passarem a escrever um arquivo local além
 *     do KV.
 *
 * Cache de página de 5min (mesmo TTL do edge cache do Worker, #2144) —
 * protege contra o limite HORÁRIO da Brevo em reloads repetidos do editor
 * (incidente documentado: investigação manual em loop já quebrou o
 * clarice-dashboard remoto). `fresh: true` bypassa (mesmo espírito do
 * `?fresh=1` do Worker).
 */

import { loadProjectEnv } from "../lib/env-loader.ts";
loadProjectEnv();

import { openClariceDb, DEFAULT_DB_PATH } from "../lib/clarice-db.ts";
import { computeStoreSummary, deriveCycleStart } from "../clarice-db-summary.ts";
import {
  fetchRecentCampaigns,
  fetchScheduledCampaigns,
  fetchPlanCredits,
  readKvTabs,
  CAMPAIGNS_FETCH_LIMIT,
  BrevoRateLimitError,
} from "../../workers/brevo-dashboard/src/brevo-api.ts";
import { renderDashboardHtml, escHtml } from "../../workers/brevo-dashboard/src/sections-core.ts";
import type { Env, ContactsSummary } from "../../workers/brevo-dashboard/src/types.ts";

// ─── Shim de KVNamespace em memória (processo local, sem Cloudflare) ────────
//
// `brevo-api.ts` só usa 2 métodos de KVNamespace em todos os call sites
// relevantes aqui: `get(key, "json"|"text")` e `put(key, value, {expirationTtl})`
// (confirmado por grep no arquivo-fonte) — implementar só esses 2 é suficiente
// e evita depender de `@cloudflare/workers-types` além da assinatura. Vive
// pela duração do processo do studio-server: TTLs (7d pra nomes de lista, sem
// TTL pra stats imutáveis >7d) funcionam como cache "morno" entre requests —
// não persiste entre reinícios do servidor, o que é aceitável (mesmo
// trade-off que o cold-start do Worker já aceita antes do 1º tick do cron).
interface MemoryKvEntry {
  value: string;
  expiresAt: number | null;
}

class MemoryKv {
  private store = new Map<string, MemoryKvEntry>();

  async get(key: string, type?: "json" | "text"): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    if (type === "json") {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }
}

const memoryKv = new MemoryKv();

function buildEnv(): Env {
  return {
    BREVO_API_KEY: process.env.BREVO_CLARICE_API_KEY ?? "",
    // KVNamespace real tem mais métodos (list/delete/getWithMetadata) que
    // nenhum call site usado aqui invoca (confirmado por grep) — cast direto
    // em vez de implementar a interface inteira, mesmo padrão já usado nos
    // testes do worker (ex: test/dashboard-coupons-tab.test.ts, `as any`).
    STATS_CACHE: memoryKv as unknown as Env["STATS_CACHE"],
    STRIPE_API_KEY: undefined,
    // #3553: cupons ficam fora do painel local por ora (issue permite omitir
    // com aviso) — evita depender de credenciais Stripe locais.
    COUPONS_TAB_ENABLED: undefined,
    AUTH_TOKEN: undefined,
  };
}

/** Lê o store SQLite local direto — mesma lógica de `clarice-db-summary.ts`
 * `main()`, sem o passo de push pro KV. Fail-soft: `data/` ausente (sessão
 * cloud, sem o junction OneDrive — label `local`, #2643) ou store corrompido
 * degradam para `null` (aba "Contatos" mostra "sem dados"), nunca lançam. */
function buildContactsSummaryLocal(): ContactsSummary | null {
  try {
    const db = openClariceDb(DEFAULT_DB_PATH);
    try {
      const cycleStart = deriveCycleStart();
      const summary = computeStoreSummary(db, cycleStart);
      return { generated_at: new Date().toISOString(), ...summary };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function notConfiguredHtml(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Painel Clarice — não configurado</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:60px auto;padding:0 20px">
<h1>Painel Clarice (local)</h1>
<p>Requer <code>BREVO_CLARICE_API_KEY</code> no ambiente ou em <code>.env.local</code> — sem ela, este painel não faz nenhuma chamada à Brevo API.</p>
<p>Ver <code>CLAUDE.md</code> §Setup, passo 1.</p>
</body></html>`;
}

function rateLimitedHtml(retryAfterSecs: number | null): string {
  const wait = retryAfterSecs !== null ? `~${retryAfterSecs}s` : "alguns minutos";
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Painel Clarice — rate limit</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:60px auto;padding:0 20px">
<h1>Painel Clarice (local)</h1>
<p>A Brevo API está em rate-limit no momento. Tente de novo em ${escHtml(wait)}.</p>
</body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Painel Clarice — erro</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:60px auto;padding:0 20px">
<h1>Painel Clarice (local) — erro</h1>
<p>${escHtml(message)}</p>
</body></html>`;
}

async function renderClariceDashboardHtmlUncached(): Promise<string> {
  const env = buildEnv();

  if (!env.BREVO_API_KEY) {
    return notConfiguredHtml();
  }

  try {
    // Mesma ordem sequencial (não paralela) do fetch ao vivo do Worker
    // (index.ts): créditos (barato) → agendadas (barato) → enviadas (caro,
    // ~100+ GETs) — preserva o mesmo perfil de concorrência contra a janela
    // de rate-limit da Brevo que a produção já assume como seguro.
    const planCredits = await fetchPlanCredits(env, "cached").catch(() => null);
    const scheduled = await fetchScheduledCampaigns(env, 50, false).catch((e) => {
      console.error("[dashboard-clarice] fetchScheduledCampaigns falhou — seção de agendadas oculta:", e instanceof Error ? e.message : e);
      return [];
    });
    const campaigns = await fetchRecentCampaigns(env, CAMPAIGNS_FETCH_LIMIT, false);

    // #3553: gap conhecido — cohorts/mvStatus/couponUsage/eiaEngagement vêm
    // todos null (memoryKv nunca foi populado com essas chaves) — ver
    // docstring do módulo. contactsSummary é sobrescrito pela leitura local
    // do store SQLite (melhor fidelidade que o KV, #3553).
    const { cohorts, mvStatus, couponUsage, eiaEngagement } = await readKvTabs(env, "cached");
    const contactsSummary = buildContactsSummaryLocal();

    const dataGeneratedAt = new Date().toISOString();
    return renderDashboardHtml(
      campaigns,
      scheduled,
      cohorts,
      mvStatus,
      contactsSummary,
      couponUsage,
      eiaEngagement,
      planCredits,
      dataGeneratedAt,
      CAMPAIGNS_FETCH_LIMIT,
    );
  } catch (e) {
    if (e instanceof BrevoRateLimitError) {
      return rateLimitedHtml(e.retryAfterSecs);
    }
    return errorHtml((e as Error).message);
  }
}

let cachedHtml: { html: string; expiresAt: number } | null = null;
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5min — mesmo TTL do edge cache do Worker (#2144)

/**
 * Monta o painel Clarice local completo. Cacheado em memória por 5min
 * (mesmo espírito do `Cache-Control: private, max-age=300` do Worker) —
 * chamadas repetidas (reload da página) dentro da janela não tocam a Brevo
 * de novo. `opts.fresh` bypassa o cache (mesmo espírito do `?fresh=1`).
 */
export async function buildClariceDashboardHtml(opts: { fresh?: boolean } = {}): Promise<string> {
  if (!opts.fresh && cachedHtml && cachedHtml.expiresAt > Date.now()) {
    return cachedHtml.html;
  }
  const html = await renderClariceDashboardHtmlUncached();
  cachedHtml = { html, expiresAt: Date.now() + PAGE_CACHE_TTL_MS };
  return html;
}

/** Exportado só para teste — permite resetar o cache de página entre casos. */
export function _resetClariceDashboardCache(): void {
  cachedHtml = null;
}
