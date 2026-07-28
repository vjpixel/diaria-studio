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
 *   - coortes de engajamento / cupons Stripe / engajamento É IA?
 *     (`cohorts`/`couponUsage`/`eiaEngagement`, via `readKvTabs`) → #4165/#4173:
 *     agora lidas do namespace KV REAL do Worker `clarice-dashboard`
 *     (`STATS_CACHE`, id `2f87d65d735c499ab8f465774d0167e2`) via
 *     `RemoteKvNamespace` (`scripts/lib/cloudflare-kv-upload.ts`), não mais de
 *     um `MemoryKv` em processo sempre vazio. Fail-soft por construção: sem
 *     `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` no env, ou com
 *     qualquer falha de rede, `buildEnv()` degrada pro `MemoryKv` de antes —
 *     o painel NUNCA passa a depender de rede pra carregar. Quando um desses
 *     3 payloads vem `null` mesmo assim (credenciais ausentes, KV
 *     inalcançável, ou genuinamente nunca populado), `renderDashboardHtml`
 *     recebe `{ studioMode: true }` e cada seção mostra um aviso
 *     "indisponível no painel local" com link pro dashboard Cloudflare real,
 *     em vez de instruir "rode o script X" (que fazia sentido no Worker, não
 *     necessariamente aqui) ou — no caso da aba Cupons — sumir sem
 *     explicação (#4173).
 *   - `mvStatus` (status MillionVerifier por grupo): permanece `null` aqui,
 *     mas isso NÃO é o gap desta issue — a seção correspondente
 *     (`renderMvStatusSection`) foi deliberadamente removida da composição de
 *     `renderDashboardHtml` no #2736 (ruído, decisão do editor) e não tem
 *     mais nenhum ponto de render, no Worker OU no Studio. `readKvTabs`
 *     continua lendo a chave (custo desprezível, paralelo às outras) só
 *     porque reverter a leitura seria mais cirurgia do que o #2736 pediu.
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
import { createRemoteKvNamespace } from "../lib/cloudflare-kv-upload.ts";

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

// #4165/#4173: id do namespace `STATS_CACHE` do Worker `clarice-dashboard`
// (`workers/brevo-dashboard/wrangler.toml` `[[kv_namespaces]] id = ...`) —
// hardcoded como default (mesmo padrão de `POLL_KV_NAMESPACE_ID` em
// scripts/lib/poll-kv.ts), com override por env pra flexibilidade/teste.
// NÃO confundir com `DASHBOARD_KV_NAMESPACE_ID` (usado por
// build-diaria-dashboard-data.ts/studio-snapshot-push.ts) — é o namespace do
// Worker `diaria-dashboard`, um KV DIFERENTE.
const CLARICE_STATS_CACHE_KV_NAMESPACE_ID =
  process.env.CLARICE_DASHBOARD_KV_NAMESPACE_ID ?? "2f87d65d735c499ab8f465774d0167e2";

function buildEnv(): Env {
  // #4165/#4173: adaptador de KV real — lê/escreve o namespace `STATS_CACHE`
  // de verdade via API HTTP Cloudflare (CLOUDFLARE_ACCOUNT_ID +
  // CLOUDFLARE_WORKERS_TOKEN, mesmas credenciais já usadas por outros scripts
  // de push pro KV, ex: clarice-engagement-cohorts.ts). `createRemoteKvNamespace`
  // retorna `null` quando as credenciais faltam — fail-soft: degrada pro
  // `MemoryKv` de sempre (todas as abas KV-dependentes voltam a ficar `null`,
  // mas o painel carrega normalmente, sem tentar rede nenhuma). Com falha de
  // REDE (não de credencial), o `RemoteKvNamespace` já é fail-soft por dentro
  // (nunca lança — ver docstring em cloudflare-kv-upload.ts), então não há
  // caminho em que este `buildEnv()` trava ou derruba o render.
  const statsCache =
    createRemoteKvNamespace(CLARICE_STATS_CACHE_KV_NAMESPACE_ID) ?? memoryKv;

  return {
    BREVO_API_KEY: process.env.BREVO_CLARICE_API_KEY ?? "",
    // KVNamespace real tem mais métodos (list/delete/getWithMetadata) que
    // nenhum call site usado aqui invoca (confirmado por grep) — cast direto
    // em vez de implementar a interface inteira, mesmo padrão já usado nos
    // testes do worker (ex: test/dashboard-coupons-tab.test.ts, `as any`).
    STATS_CACHE: statsCache as unknown as Env["STATS_CACHE"],
    STRIPE_API_KEY: undefined,
    // #4165/#4173: antes ficava `undefined` — "evita depender de credenciais
    // Stripe locais" (comentário do #3553). Mas `getCouponUsage` checa esta
    // flag ANTES de sequer olhar o KV (`if (env.COUPONS_TAB_ENABLED !== "true")
    // return null`) — com a flag off, o adaptador de KV real acima nunca
    // teria chance de servir o cache, mesmo populado. A causa real do gap
    // sempre foi a ausência de KV, não a de Stripe (achado do #4173) — com
    // "true", `getCouponUsage(env, "cached")` serve o KV quando presente e só
    // cairia pro fetch Stripe ao vivo em KV MISS + STRIPE_API_KEY presente
    // (nunca o caso aqui, já que ela continua undefined).
    COUPONS_TAB_ENABLED: "true",
    AUTH_TOKEN: undefined,
  };
}

/** Exportado só para teste (#4165/#4173) — mesmo padrão de
 * `_resetClariceDashboardCache` abaixo. Permite inspecionar se `buildEnv()`
 * escolheu `RemoteKvNamespace` (creds presentes) ou `MemoryKv` (fallback
 * fail-soft) sem precisar montar o resto do pipeline (Brevo API, SQLite). */
export function _buildEnvForTest(): Env {
  return buildEnv();
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

    // #4165/#4173: cohorts/couponUsage/eiaEngagement agora vêm do namespace KV
    // REAL (ver `buildEnv()`/docstring do módulo) — só ficam `null` quando as
    // credenciais Cloudflare faltam, a rede falha, ou a chave genuinamente
    // nunca foi populada; nesses 3 casos, `{ studioMode: true }` abaixo troca
    // o texto/ação de cada seção pro aviso "indisponível no painel local".
    // `mvStatus` segue sempre `null` aqui — não é o gap desta issue (#2736
    // removeu a seção correspondente da composição, ver docstring do módulo).
    // contactsSummary é sobrescrito pela leitura local do store SQLite
    // (melhor fidelidade que o KV, #3553).
    const { cohorts, mvStatus, couponUsage, eiaEngagement, postmasterSpam } = await readKvTabs(env, "cached");
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
      postmasterSpam,
      { studioMode: true },
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
