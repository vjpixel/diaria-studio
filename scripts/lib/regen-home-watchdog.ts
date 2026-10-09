/**
 * scripts/lib/regen-home-watchdog.ts (#9974)
 *
 * Miolo do watchdog da home das 06:00 BRT. O `regen-home.yml` agenda
 * `12 9 * * *` (06:12 BRT), mas o `schedule` do GitHub Actions é best-effort:
 * medido em 04-09/10/2026, os disparos agendados chegaram de 5h a 9h
 * atrasados (#9974; a #8126 já tinha medido 3-6h em setembro e deslocado o
 * minuto, sem resolver). Resultado: a edição sai por e-mail às 06:00 e a home
 * (destino de campanha paga) fica sem ela até o fim da manhã.
 *
 * Este watchdog roda no `300` às 06:20 BRT (task `Diaria-Regen-Home-Watchdog`,
 * `scripts/lib/scheduled-tasks.ts`) e faz o que o editor fazia à mão:
 *
 *   1. Descobre a edição do dia pelo `sitemap.xml` PÚBLICO (`<lastmod>` = data
 *      de envio, já no ar desde o Stage 6 da véspera). Sem entrada com
 *      `lastmod` == hoje (BRT) → não há edição hoje, nada a fazer.
 *   2. Confere se a home pública já linka `/p/{slug}`. Se sim → ok.
 *   3. Se não, e não houver run de `regen-home.yml` em andamento criada hoje,
 *      dispara `gh workflow run regen-home.yml --ref master` (o workflow já tem
 *      `workflow_dispatch` e é idempotente: sem diff, termina sem PR).
 *   4. Reconfere a home a cada poucos minutos até o prazo (07:00 BRT); se ainda
 *      faltar, alarma o editor (`notifyEditor`, severidade `acao`).
 *
 * Tudo aqui é puro ou recebe as dependências injetadas (fetch, `gh`, relógio,
 * sleep, notify) — o teste `test/regen-home-watchdog-9974.test.ts` exercita o
 * fluxo inteiro com `gh` mockado, sem rede nem disparo real.
 */

import { parseSitemap } from "./fetch-sitemap.ts";
import { brtDateString, slugFromCanonicalUrl } from "./site-home-page.ts";

export const REGEN_HOME_WORKFLOW = "regen-home.yml";
export const HOME_URL = "https://diar.ia.br/";
export const SITEMAP_URL = "https://diar.ia.br/sitemap.xml";
/** UA explícito: `fetch` sem UA pode levar challenge da Cloudflare. */
export const REGEN_HOME_WATCHDOG_USER_AGENT = "diaria-studio-regen-home-watchdog/1 (+https://diar.ia.br)";

/** Prazo do alarme: 07:00 BRT = 10:00 UTC (BRT sem horário de verão desde 2019). */
export const ALARM_DEADLINE_UTC_HOUR = 10;
/** Janela mínima de espera depois de um disparo, mesmo rodando após o prazo
 * (execução manual tardia): o workflow leva ~3-6 min (npm ci + testes + deploy). */
export const MIN_POLL_WINDOW_MS = 20 * 60 * 1000;
export const POLL_INTERVAL_MS = 2 * 60 * 1000;

/** Slugs de edição cuja data de envio (`<lastmod>`, dia civil) é `todayBrt`. */
export function expectedSlugsForDay(sitemapXml: string, todayBrt: string): string[] {
  const slugs: string[] = [];
  for (const entry of parseSitemap(sitemapXml)) {
    if (!entry.lastmod || entry.lastmod.slice(0, 10) !== todayBrt) continue;
    const slug = slugFromCanonicalUrl(entry.loc);
    if (slug) slugs.push(slug);
  }
  return slugs;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A home linka `/p/{slug}`? Exige delimitador depois do slug pra que
 * `/p/foo` não case com `/p/foo-bar`. */
export function homeListsSlug(homeHtml: string, slug: string): boolean {
  return new RegExp(`/p/${escapeRegExp(slug)}(?:["'/?#<\\s]|$)`).test(homeHtml);
}

export interface WorkflowRun {
  databaseId?: number;
  status: string;
  conclusion?: string | null;
  createdAt: string;
  event?: string;
}

const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/** Run de `regen-home.yml` criada hoje (BRT) ainda não concluída — disparar
 * outra seria redundante (o workflow tem `concurrency: regen-home`, ela só
 * enfileiraria). */
export function findActiveRunToday(runs: WorkflowRun[], todayBrt: string): WorkflowRun | null {
  return (
    runs.find(
      (r) => ACTIVE_STATUSES.has(r.status) && brtDateString(new Date(r.createdAt)) === todayBrt,
    ) ?? null
  );
}

/** Instante do prazo do alarme (07:00 BRT) no dia de `now`. */
export function alarmDeadline(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(ALARM_DEADLINE_UTC_HOUR, 0, 0, 0);
  return d;
}

export type WatchdogOutcome =
  | { status: "sem-edicao"; todayBrt: string }
  | { status: "ok"; todayBrt: string; slug: string; dispatched: boolean }
  | { status: "atrasada"; todayBrt: string; slug: string; dispatched: boolean; detail: string }
  | { status: "cannot-verify"; todayBrt: string; detail: string };

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WatchdogDeps {
  fetchText: (url: string) => Promise<string>;
  gh: (args: string[]) => Promise<GhResult>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export async function listRegenHomeRuns(gh: WatchdogDeps["gh"]): Promise<WorkflowRun[]> {
  const r = await gh([
    "run", "list", "--workflow", REGEN_HOME_WORKFLOW, "--limit", "20",
    "--json", "databaseId,status,conclusion,createdAt,event",
  ]);
  if (r.code !== 0) throw new Error(`gh run list falhou (exit ${r.code}): ${r.stderr.trim()}`);
  return JSON.parse(r.stdout || "[]") as WorkflowRun[];
}

/**
 * Fluxo completo. Nunca lança por falha de rede na LEITURA do site
 * (`cannot-verify`, sem disparo e sem alarme — mesma regra do
 * `check-kv-image-binding.ts`: rede fora não vira falso alarme). Falha do
 * `gh` ao listar/disparar vira `atrasada` com o erro no detalhe — aí sim o
 * editor precisa saber, porque a home segue sem a edição.
 */
export async function runRegenHomeWatchdog(deps: WatchdogDeps): Promise<WatchdogOutcome> {
  const start = deps.now();
  const todayBrt = brtDateString(start);

  let slugs: string[];
  try {
    slugs = expectedSlugsForDay(await deps.fetchText(SITEMAP_URL), todayBrt);
  } catch (e) {
    return { status: "cannot-verify", todayBrt, detail: `sitemap: ${(e as Error).message}` };
  }
  if (slugs.length === 0) return { status: "sem-edicao", todayBrt };
  const slug = slugs[0];

  const homeHasEdition = async (): Promise<boolean> => homeListsSlug(await deps.fetchText(HOME_URL), slug);

  try {
    if (await homeHasEdition()) return { status: "ok", todayBrt, slug, dispatched: false };
  } catch (e) {
    return { status: "cannot-verify", todayBrt, detail: `home: ${(e as Error).message}` };
  }

  let dispatched = false;
  try {
    const active = findActiveRunToday(await listRegenHomeRuns(deps.gh), todayBrt);
    if (active) {
      deps.log(`run ${active.databaseId ?? "?"} de ${REGEN_HOME_WORKFLOW} já ${active.status} — não disparo outra`);
    } else {
      const r = await deps.gh(["workflow", "run", REGEN_HOME_WORKFLOW, "--ref", "master"]);
      if (r.code !== 0) throw new Error(`gh workflow run falhou (exit ${r.code}): ${r.stderr.trim()}`);
      dispatched = true;
      deps.log(`home sem /p/${slug} — disparei ${REGEN_HOME_WORKFLOW} (workflow_dispatch)`);
    }
  } catch (e) {
    return { status: "atrasada", todayBrt, slug, dispatched, detail: (e as Error).message };
  }

  const deadlineMs = Math.max(alarmDeadline(start).getTime(), start.getTime() + MIN_POLL_WINDOW_MS);
  let lastError = "";
  while (deps.now().getTime() < deadlineMs) {
    await deps.sleep(POLL_INTERVAL_MS);
    try {
      if (await homeHasEdition()) return { status: "ok", todayBrt, slug, dispatched };
      lastError = "";
    } catch (e) {
      lastError = ` (última leitura da home falhou: ${(e as Error).message})`;
    }
  }
  return {
    status: "atrasada",
    todayBrt,
    slug,
    dispatched,
    detail: `home ainda sem /p/${slug} no prazo de 07:00 BRT${lastError}`,
  };
}
