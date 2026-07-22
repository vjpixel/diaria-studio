/**
 * studio-integrations.ts (#3848, fatia da EPIC "Studio UI" #3554)
 *
 * Camada de leitura pra `GET /api/integrations`: status de TODAS as
 * integrações que o projeto usa (APIs via key/token em `.env` + MCPs) num só
 * lugar — configurada? alcançável? última checagem? Arquivo próprio desta
 * fatia (mesma convenção de `studio-review.ts`/`studio-issues.ts`/
 * `studio-apoios.ts`, #3555) — `server.ts` só roteia.
 *
 * **Nunca expõe valor de secret** — só presença/ausência do NOME da env var
 * (`missingEnvVars: string[]`, nomes apenas). Nenhuma função aqui lê o valor
 * de uma env var pra além de um `Boolean(...)`/`trim()` interno; valores
 * nunca entram em `IntegrationStatus` nem em mensagens de erro (as
 * mensagens de erro vêm do CORPO da resposta HTTP das APIs de terceiro —
 * nunca ecoam de volta o token que a própria request enviou).
 *
 * **Probes reais (fetch de verdade) implementados pras integrações mais
 * críticas** (#3848 permite fatiar — "pelo menos as 3-4 mais críticas"):
 *   - Cloudflare — reusa `checkCloudflareToken` (`../check-cloudflare-token.ts`,
 *     já existente e testado, #2286).
 *   - Beehiiv — `GET /v2/publications/{id}` (mesma base de
 *     `beehiivApiBase()`, `../lib/beehiiv-config.ts`).
 *   - Facebook Graph — `GET /{version}/{pageId}?fields=id` (Graph API).
 *   - Instagram Graph — mesmo `probeGraphNode` genérico (mesma API
 *     `graph.facebook.com`, #3817).
 *   - Clarice cortex (REST) — reusa `checkClariceHealth`
 *     (`../clarice-healthcheck.ts`, já existente e testado, #1329). Aproxima
 *     (não prova) a saúde do MCP `clarice` — ver nota na entry MCP abaixo,
 *     domínio diferente (`mcp.clarice.ai` vs `cortex.clarice.ai`).
 *   - LinkedIn (via Worker) — `GET {cloudflare_worker_url}/health`
 *     (`workers/linkedin-cron`, sem auth, endpoint público de debug).
 *
 * As demais integrações da lista da issue (apoia.se, Brave Search,
 * Brevo/Clarice mensal, Gemini, MillionVerifier, OpenAI, Stripe, Telegram,
 * Google OAuth/Drive) ficam com probe **"configurada? sim/não" apenas**
 * (`ReachableState = "not_verified"`) — documentado no campo `note` de cada
 * uma. Motivos por integração:
 *   - apoia.se: rate limit apertado (5.000 req/mês, 5 req/s) — bater a cada
 *     carga de página arriscaria estourar o teto real de uso da campanha.
 *   - Demais: sem endpoint de "ping" leve conhecido/documentado sem
 *     consumir cota paga (MillionVerifier, OpenAI) ou sem side-effect
 *     (Stripe list endpoints custam uma chamada real de API).
 * Follow-up fica registrado no PR body — não é um TODO perdido no código.
 *
 * **MCPs nativos claude.ai são interativos** (#3612 é a mesma lacuna): o
 * studio-server headless não consegue "pingar"
 * `claude_ai_Beehiiv`/`claude_ai_Gmail`/`claude_ai_Google_Drive`/
 * `claude-in-chrome`/`claude_ai_Stripe` como faz via REST — não há API
 * server-side pra "quais MCPs este processo Claude Code tem conectado
 * agora". Marcados `configured: "unknown"` + `reachable: "not_verified"`
 * com nota explicando a lacuna — nunca fingido.
 *
 * **`local` vs `cloud` (#2643)**: o campo `execMode` no topo do payload
 * (`detectExecMode`, `../lib/exec-mode.ts`) deixa explícito que os
 * status refletem o ambiente ONDE O STUDIO-SERVER RODA — num clone cloud
 * sem o junction `data/` nem `.env.local`, quase tudo aparece
 * "não configurado", o que é esperado, não um bug.
 *
 * **Fail-soft total**: nenhum probe pode derrubar a página — qualquer
 * exceção (rede, parse, o que for) vira o campo `error` da integração
 * específica, nunca propaga. Mesmo padrão de `studio-apoios.ts::buildApoiosData`.
 *
 * **Cache + TTL** (5 min default) — mesmo padrão de `studio-issues.ts`
 * (`fetchTriageData`): evita bater a cada carga de página nas ~6 APIs reais
 * acima. `forceRefresh` (usado pelo botão "Atualizar" da UI, via
 * `?refresh=1`) bypassa o cache.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "../lib/env-loader.ts";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import { beehiivApiBase } from "../lib/beehiiv-config.ts";
import { checkCloudflareToken, type CloudflareTokenHealth } from "../check-cloudflare-token.ts";
import { checkClariceHealth } from "../clarice-healthcheck.ts";

// Garante que `.env.local`/`.env` estão carregados mesmo quando
// `studio-integrations.ts` é importado sem o processo ter passado por um
// entrypoint que já chamou isso — mesmo padrão de `dashboard-clarice.ts`
// (#3563). Idempotente, nunca sobrescreve vars já presentes.
loadProjectEnv();

// ─── tipos ──────────────────────────────────────────────────────────────

export type IntegrationKind = "api" | "mcp";

/** `"partial"` = alguns (não todos) os env vars OBRIGATÓRIOS presentes —
 * possível pra integrações com >1 var obrigatória (ex: Cloudflare). `"unknown"`
 * = integração sem sinal de configuração determinável server-side (MCPs
 * nativos claude.ai). */
export type ConfiguredState = "configured" | "partial" | "not_configured" | "unknown";

/** `"skipped"` = probe real existe mas não foi tentado porque a config
 * obrigatória está ausente (nada de útil pra checar). `"not_verified"` =
 * NENHUM probe implementado pra esta integração nesta fatia (documentado no
 * `note`) — distinção deliberada entre "não tentei porque falta credencial"
 * e "não tentei porque não escrevi o probe ainda". */
export type ReachableState = "reachable" | "unreachable" | "error" | "not_verified" | "skipped";

export type EnvMap = Record<string, string | undefined>;

export type ProbeStrategy =
  | "cloudflare"
  | "beehiiv"
  | "facebook-graph"
  | "instagram-graph"
  | "clarice-cortex"
  | "linkedin-worker"
  | "env-only"
  | "interactive-mcp";

export interface IntegrationDef {
  id: string;
  name: string;
  kind: IntegrationKind;
  /** Env vars obrigatórias — TODAS ausentes = not_configured; algumas = partial. */
  envVars: string[];
  /** Env vars opcionais — não afetam `configured`, só documentativas. */
  optionalEnvVars?: string[];
  probe: ProbeStrategy;
  /** Nota estática sempre mostrada (constraint conhecida, expiração de token, etc.). */
  note?: string;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  kind: IntegrationKind;
  configured: ConfiguredState;
  /** Nomes (nunca valores) das env vars obrigatórias ausentes. */
  missingEnvVars: string[];
  reachable: ReachableState;
  checkedAt: string;
  note: string | null;
  error: string | null;
}

export interface IntegrationsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  integrations: IntegrationStatus[];
}

// ─── notas reusadas ─────────────────────────────────────────────────────

export const ENV_ONLY_NOTE =
  "Probe de alcançabilidade não implementado nesta fatia (#3848) — mostrando apenas se a env var está configurada. Ver PR body pro motivo (rate limit / sem endpoint leve conhecido) e follow-up.";

export const MCP_INTERACTIVE_NOTE =
  "Conector nativo claude.ai — o studio-server headless não consegue pingar (mesma lacuna de beehiiv-open-rate.json, #3612). Status real só na sessão interativa; confirme com /mcp no terminal.";

// ─── lista mestra de integrações ───────────────────────────────────────

export const INTEGRATIONS: IntegrationDef[] = [
  // ── APIs ──
  {
    id: "apoia_se",
    name: "apoia.se",
    kind: "api",
    envVars: ["APOIA_SE_API_KEY", "APOIA_SE_API_SECRET"],
    optionalEnvVars: ["APOIA_SE_CAMPAIGN"],
    probe: "env-only",
    note:
      "CRM de apoios (checkBacker). Probe real fica de fora desta fatia — rate limit apertado da apoia.se (5.000 req/mês, 5 req/s) torna arriscado bater a cada carga de página.",
  },
  {
    id: "beehiiv",
    name: "Beehiiv",
    kind: "api",
    envVars: ["BEEHIIV_API_KEY", "BEEHIIV_PUBLICATION_ID"],
    probe: "beehiiv",
    note: "Newsletter — draft/schedule via API + Chrome (Stage 5/6).",
  },
  {
    id: "brave_search",
    name: "Brave Search",
    kind: "api",
    envVars: ["BRAVE_API_KEY"],
    probe: "env-only",
    note: "Free tier 2000 queries/mês (Stage 1). Sem BRAVE_API_KEY, cai pro fallback Path B (agents Haiku).",
  },
  {
    id: "brevo_clarice",
    name: "Brevo/Clarice (mensal)",
    kind: "api",
    envVars: ["BREVO_CLARICE_API_KEY"],
    probe: "env-only",
    note: "Digest mensal — envio de campanhas + waves da parceria Clarice.",
  },
  {
    id: "clarice_cortex",
    name: "Clarice cortex (correção)",
    kind: "api",
    envVars: ["CLARICE_API_KEY"],
    probe: "clarice-cortex",
    note: "REST fallback do Stage 2 quando o MCP `clarice` está offline. Mesma key do MCP — ver entry MCP abaixo.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    kind: "api",
    envVars: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    optionalEnvVars: ["CLOUDFLARE_WORKERS_TOKEN", "DASHBOARD_KV_NAMESPACE_ID"],
    probe: "cloudflare",
    note: "Workers/KV (poll, dashboards, leaderboard).",
  },
  {
    id: "facebook",
    name: "Facebook Graph",
    kind: "api",
    envVars: ["FACEBOOK_PAGE_ACCESS_TOKEN", "FACEBOOK_PAGE_ID"],
    optionalEnvVars: ["FACEBOOK_API_VERSION"],
    probe: "facebook-graph",
    note: "Token de página expira em ~60 dias — renovar em developers.facebook.com/tools/explorer/ (ver #3816).",
  },
  {
    id: "gemini",
    name: "Gemini",
    kind: "api",
    envVars: ["GEMINI_API_KEY"],
    probe: "env-only",
    note: "Geração de imagem (Stage 3) — default de platform.config.json > image_generator.",
  },
  {
    id: "instagram",
    name: "Instagram Graph",
    kind: "api",
    envVars: ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_BUSINESS_ACCOUNT_ID"],
    optionalEnvVars: ["INSTAGRAM_API_VERSION"],
    probe: "instagram-graph",
    note: "Publicação IG (#3817). Token de longa duração (~60 dias) — renovar antes de expirar.",
  },
  {
    id: "million_verifier",
    name: "MillionVerifier",
    kind: "api",
    envVars: ["MILLION_VERIFIER_API_KEY"],
    probe: "env-only",
    note: "Verificação de email (cohorts não-assinantes, #1297). Probe real consumiria cota paga — fora de escopo.",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "api",
    envVars: ["OPENAI_API_KEY"],
    probe: "env-only",
    note: "Fallback de geração de imagem — só necessário se platform.config.json > image_generator = 'openai'.",
  },
  {
    id: "stripe",
    name: "Stripe",
    kind: "api",
    envVars: ["STRIPE_API_KEY"],
    probe: "env-only",
    note: "Análise de cupons/assinaturas (read-only). Ver também o MCP claude_ai_Stripe abaixo.",
  },
  {
    id: "telegram",
    name: "Telegram",
    kind: "api",
    envVars: ["TELEGRAM_BOT_TOKEN"],
    optionalEnvVars: ["TELEGRAM_CHAT_ID", "TELEGRAM_WATCHDOG_CHAT_ID"],
    probe: "env-only",
    note: "Notificações do Studio (#3564) + watchdog overnight (#2688).",
  },
  {
    id: "google_oauth",
    name: "Google OAuth/Drive",
    kind: "api",
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    probe: "env-only",
    note: "Digest mensal — Drive sync + Gmail inbox drain. Setup: npx tsx scripts/oauth-setup.ts.",
  },
  {
    id: "linkedin_worker",
    name: "LinkedIn (via Worker)",
    kind: "api",
    envVars: [],
    optionalEnvVars: ["MAKE_LINKEDIN_WEBHOOK_URL"],
    probe: "linkedin-worker",
    note:
      "Sem key própria — via webhook Make + Worker diaria-linkedin-cron (platform.config.json > publishing.social.linkedin.cloudflare_worker_url).",
  },
  // ── MCPs ──
  {
    id: "mcp_clarice",
    name: "clarice (MCP)",
    kind: "mcp",
    envVars: ["CLARICE_API_KEY"],
    probe: "env-only",
    note:
      "HTTP header-auth (.mcp.json, X-Clarice-Api-Key) — mesma env var do REST cortex acima, mas endpoint DIFERENTE (mcp.clarice.ai vs cortex.clarice.ai). Alcançabilidade aproximada pelo probe REST acima, não uma checagem direta deste endpoint.",
  },
  {
    id: "mcp_beehiiv",
    name: "claude.ai Beehiiv (MCP)",
    kind: "mcp",
    envVars: [],
    probe: "interactive-mcp",
  },
  {
    id: "mcp_gmail",
    name: "claude.ai Gmail (MCP)",
    kind: "mcp",
    envVars: [],
    probe: "interactive-mcp",
  },
  {
    id: "mcp_google_drive",
    name: "claude.ai Google Drive (MCP)",
    kind: "mcp",
    envVars: [],
    probe: "interactive-mcp",
  },
  {
    id: "mcp_claude_in_chrome",
    name: "Claude in Chrome (MCP)",
    kind: "mcp",
    envVars: [],
    probe: "interactive-mcp",
  },
  {
    id: "mcp_stripe",
    name: "claude.ai Stripe (MCP)",
    kind: "mcp",
    envVars: [],
    probe: "interactive-mcp",
  },
];

// ─── configured (puro) ──────────────────────────────────────────────────

/**
 * Deriva `ConfiguredState` a partir de env vars obrigatórias — nunca lê o
 * VALOR pra além de checar presença/não-vazio (`missing` só carrega nomes).
 */
export function checkEnvConfigured(
  required: string[],
  env: EnvMap = process.env,
): { state: ConfiguredState; missing: string[] } {
  if (required.length === 0) return { state: "configured", missing: [] };
  const missing = required.filter((name) => !String(env[name] ?? "").trim());
  if (missing.length === 0) return { state: "configured", missing: [] };
  if (missing.length === required.length) return { state: "not_configured", missing };
  return { state: "partial", missing };
}

// ─── probes reais (fetch injetável, fail-soft, timeout curto) ──────────

export interface ProbeResult {
  reachable: ReachableState;
  error: string | null;
}

function mapCloudflareStatus(status: CloudflareTokenHealth["status"]): ReachableState {
  if (status === "active") return "reachable";
  if (status === "invalid") return "unreachable";
  if (status === "missing") return "skipped";
  return "error"; // "error" (transitório — rede/API fora do ar)
}

export async function probeCloudflare(token: string | undefined, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const health = await checkCloudflareToken(token, fetchImpl);
  return { reachable: mapCloudflareStatus(health.status), error: health.status === "active" ? null : health.error ?? null };
}

/** `GET /v2/publications/{id}` — leitura mínima, valida token + publicationId
 * de uma tacada (mesmo endpoint já usado por vários scripts do repo). */
export async function probeBeehiiv(apiKey: string, publicationId: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${beehiivApiBase()}/publications/${encodeURIComponent(publicationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { reachable: "unreachable", error: `HTTP ${res.status} — token inválido ou sem permissão` };
    }
    if (!res.ok) return { reachable: "error", error: `HTTP ${res.status}` };
    return { reachable: "reachable", error: null };
  } catch (e) {
    return { reachable: "error", error: (e as Error).message };
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number };
}

/** Probe genérico de leitura de UM node do Graph API (`graph.facebook.com`) —
 * usado tanto pra Facebook Page quanto Instagram Business Account (mesma
 * API, mesmo shape de erro OAuth).
 *
 * **Token vai SEMPRE via header `Authorization: Bearer`, nunca como query
 * param na URL** (Graph API aceita os 2 — header é suportado desde v2.3).
 * Deliberado: um erro de rede genérico (`fetch` lançando) pode, dependendo
 * do runtime, incluir a URL da request na mensagem — se o token estivesse
 * na URL, um `error` de rede vazaria o secret pro payload da página. Com o
 * token só no header, a mensagem de erro de rede nunca pode conter o
 * secret, mesmo em runtimes que ecoam a URL da request que falhou. */
export async function probeGraphNode(
  nodeId: string,
  accessToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  try {
    const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(nodeId)}?fields=id`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => null)) as GraphErrorBody | null;
    if (body?.error) {
      return {
        reachable: "unreachable",
        error: `Graph API: ${body.error.message ?? "erro"} (code ${body.error.code ?? "?"})`,
      };
    }
    if (!res.ok) return { reachable: "error", error: `HTTP ${res.status}` };
    return { reachable: "reachable", error: null };
  } catch (e) {
    return { reachable: "error", error: (e as Error).message };
  }
}

/** Reusa `checkClariceHealth` (`../clarice-healthcheck.ts`, #1329) com um
 * timeout mais curto que o default (30s) — o probe de status desta página
 * está sob cache de 5min e um clique de "Atualizar", não sob o SLA de
 * preflight do Stage 0; 20s já folga sobre a latência observada (~16.3s,
 * ver doc-comment de `clarice-healthcheck.ts`) sem travar a UI por meio
 * minuto. */
export async function probeClariceCortex(apiKey: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const result = await checkClariceHealth({ apiKey, fetchImpl, timeoutMs: 20_000 });
  return { reachable: result.ok ? "reachable" : "error", error: result.ok ? null : result.error ?? null };
}

/** `GET {workerUrl}/health` — sem auth, endpoint público de debug do Worker
 * `diaria-linkedin-cron` (`workers/linkedin-cron/src/index.ts`). */
export async function probeWorkerHealth(workerUrl: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${workerUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { reachable: "error", error: `HTTP ${res.status}` };
    return { reachable: "reachable", error: null };
  } catch (e) {
    return { reachable: "error", error: (e as Error).message };
  }
}

// ─── LinkedIn worker URL (platform.config.json, fail-soft) ─────────────

interface PlatformConfigShape {
  publishing?: { social?: { linkedin?: { cloudflare_worker_url?: string } } };
}

/** Lê `platform.config.json > publishing.social.linkedin.cloudflare_worker_url`
 * — fail-soft: arquivo ausente/corrompido ou campo ausente vira `null`,
 * nunca lança. LinkedIn não tem key própria (via webhook Make + Worker),
 * então "configurada?" pra esta integração é "o Worker está declarado?". */
export function readLinkedInWorkerUrl(rootDir: string): string | null {
  try {
    const raw = readFileSync(resolve(rootDir, "platform.config.json"), "utf8");
    const cfg = JSON.parse(raw) as PlatformConfigShape;
    const url = cfg.publishing?.social?.linkedin?.cloudflare_worker_url;
    return typeof url === "string" && url.trim() ? url.trim() : null;
  } catch {
    return null;
  }
}

// ─── orquestração por integração (fail-soft) ───────────────────────────

async function evaluateIntegration(
  def: IntegrationDef,
  rootDir: string,
  env: EnvMap,
  fetchImpl: typeof fetch,
  checkedAt: string,
): Promise<IntegrationStatus> {
  const base = { id: def.id, name: def.name, kind: def.kind, checkedAt, note: def.note ?? null };
  try {
    // LinkedIn: caso especial — "configurada?" vem de platform.config.json,
    // não de env var (sem key própria).
    if (def.id === "linkedin_worker") {
      const workerUrl = readLinkedInWorkerUrl(rootDir);
      if (!workerUrl) {
        return {
          ...base,
          configured: "not_configured",
          missingEnvVars: ["platform.config.json > publishing.social.linkedin.cloudflare_worker_url"],
          reachable: "skipped",
          error: null,
        };
      }
      const probe = await probeWorkerHealth(workerUrl, fetchImpl);
      return { ...base, configured: "configured", missingEnvVars: [], reachable: probe.reachable, error: probe.error };
    }

    if (def.probe === "interactive-mcp") {
      return {
        ...base,
        configured: "unknown",
        missingEnvVars: [],
        reachable: "not_verified",
        note: def.note ?? MCP_INTERACTIVE_NOTE,
        error: null,
      };
    }

    const { state: configured, missing } = checkEnvConfigured(def.envVars, env);

    if (def.probe === "env-only") {
      return {
        ...base,
        configured,
        missingEnvVars: missing,
        reachable: "not_verified",
        note: def.note ?? ENV_ONLY_NOTE,
        error: null,
      };
    }

    // Probes reais: só tentados quando há ALGUMA config presente — clone
    // fresco com zero env vars (cloud, #2643) nunca dispara chamada de rede.
    if (configured === "not_configured") {
      return { ...base, configured, missingEnvVars: missing, reachable: "skipped", error: null };
    }

    switch (def.probe) {
      case "cloudflare": {
        const probe = await probeCloudflare(env.CLOUDFLARE_API_TOKEN, fetchImpl);
        return { ...base, configured, missingEnvVars: missing, reachable: probe.reachable, error: probe.error };
      }
      case "beehiiv": {
        const probe = await probeBeehiiv(env.BEEHIIV_API_KEY ?? "", env.BEEHIIV_PUBLICATION_ID ?? "", fetchImpl);
        return { ...base, configured, missingEnvVars: missing, reachable: probe.reachable, error: probe.error };
      }
      case "facebook-graph": {
        const version = env.FACEBOOK_API_VERSION || "v25.0";
        const probe = await probeGraphNode(env.FACEBOOK_PAGE_ID ?? "", env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "", version, fetchImpl);
        return { ...base, configured, missingEnvVars: missing, reachable: probe.reachable, error: probe.error };
      }
      case "instagram-graph": {
        const version = env.INSTAGRAM_API_VERSION || "v25.0";
        const probe = await probeGraphNode(
          env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
          env.INSTAGRAM_ACCESS_TOKEN ?? "",
          version,
          fetchImpl,
        );
        return { ...base, configured, missingEnvVars: missing, reachable: probe.reachable, error: probe.error };
      }
      case "clarice-cortex": {
        const probe = await probeClariceCortex(env.CLARICE_API_KEY ?? "", fetchImpl);
        return { ...base, configured, missingEnvVars: missing, reachable: probe.reachable, error: probe.error };
      }
      default:
        return { ...base, configured, missingEnvVars: missing, reachable: "not_verified", error: null };
    }
  } catch (e) {
    // Rede de segurança final — nenhum probe individual deve lançar (todos
    // já têm try/catch próprio acima), mas uma 2ª camada aqui garante que um
    // bug futuro num probe novo nunca derruba a página inteira.
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      configured: "unknown",
      missingEnvVars: [],
      reachable: "error",
      checkedAt,
      note: def.note ?? null,
      error: (e as Error).message,
    };
  }
}

// ─── cache + entrada pública ────────────────────────────────────────────

interface CacheEntry {
  data: IntegrationsSnapshot;
  expiresAt: number;
}

/** Cache em memória por `rootDir` — mesmo espírito de `studio-issues.ts`
 * (`cacheByRoot`): evita bater nas ~6 APIs reais a cada carga de página. */
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearIntegrationsCache(): void {
  cacheByRoot.clear();
}

export interface BuildIntegrationsOptions {
  now?: () => number;
  /** Injetável pra testes — NUNCA bater em rede real (#3848: proibido testar
   * os probes ao vivo). Produção usa `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Injetável pra testes — evita depender do `process.env` real da máquina
   * (que pode ter credenciais reais persistidas, ex: CLARICE_API_KEY
   * exportado no shell — CLAUDE.md § Setup). Produção usa `process.env`. */
  env?: EnvMap;
  /** TTL do cache em ms (default 5min). */
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

/**
 * Monta o snapshot completo pra `GET /api/integrations`: status de TODAS as
 * integrações de `INTEGRATIONS`, com probe real quando aplicável. Sempre
 * resolve (nunca rejeita) — cada integração é avaliada isoladamente por
 * `evaluateIntegration` (fail-soft por design).
 */
export async function buildIntegrationsData(
  rootDir: string,
  opts: BuildIntegrationsOptions = {},
): Promise<IntegrationsSnapshot> {
  const now = opts.now ?? (() => Date.now());
  const nowMs = now();
  const cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const env = opts.env ?? (process.env as EnvMap);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const execMode = detectExecMode({ projectRoot: rootDir });
  const generatedAt = new Date(nowMs).toISOString();

  const integrations = await Promise.all(
    INTEGRATIONS.map((def) => evaluateIntegration(def, rootDir, env, fetchImpl, generatedAt)),
  );

  const data: IntegrationsSnapshot = { execMode, generatedAt, cached: false, integrations };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
