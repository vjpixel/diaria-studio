/** #10819: preparação de horários de divulgação, sem mutations externas.
 * Defaults antigos viram preferências. Stage 5 nunca passa por este módulo.
 * Janela 06–22 BRT, 2h e picos gerais são as premissas do planner existente.
 * Facebook direto e X/Buffer continuam fora da grade desta integração.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { editionDir } from "./lib/edition-paths.ts";
import { loadWorkerQueueForGrid } from "./publish-shorts.ts";
import { gridFromSocialPublished, gridFromShortsPublished, gridFromLinkedInPersonalIntent, gridFromWorkerQueue, mergeGrids, planSlots, type ScheduledSlot } from "./lib/social-slot-planner.ts";
import { addMinutesIso, localDateInTz, localIsoAt } from "./lib/mensal/retrospectiva-schedule.ts";

export interface DivulgacaoRequest { key: string; account: string; preferredAt: string }
export function planDivulgacao(grid: readonly ScheduledSlot[], requests: readonly DivulgacaoRequest[], now = Date.now()) {
  const decisions = planSlots(grid, requests.map((r) => {
    const day = localDateInTz(Date.parse(r.preferredAt), "America/Sao_Paulo");
    return { account: r.account, preferredAt: r.preferredAt,
      window: { start: localIsoAt(day, "06:00"), end: localIsoAt(day, "22:00") },
      notBefore: new Date(now + 10 * 60_000).toISOString() };
  }));
  return decisions.map((d, i) => {
    if (!d.at || d.warning) throw new Error(`Grade #10819 sem slot seguro para ${requests[i].key}: ${d.warning ?? d.premise}`);
    return { ...d, key: requests[i].key, at: addMinutesIso(d.at, 0) };
  });
}

/** Só GET /list + leitura dos stores das datas pedidas. Fila fail-soft como #11001. */
interface GridConfig {
  publishing?: {
    social?: { linkedin?: { cloudflare_worker_url?: string } };
    shorts?: { instagram_author_page?: string | null; instagram_collaborators?: string[] };
  };
}
export async function loadDivulgacaoGrid(rawConfig: unknown, dates: readonly string[], warn = console.error,
  deps: { loadQueue?: typeof loadWorkerQueueForGrid; editionDir?: typeof editionDir } = {},
): Promise<ScheduledSlot[]> {
  const config = rawConfig as GridConfig;
  const social = config.publishing?.social;
  const queue = await (deps.loadQueue ?? loadWorkerQueueForGrid)(process.env.DIARIA_LINKEDIN_CRON_URL ?? social?.linkedin?.cloudflare_worker_url ?? "", process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "", fetch, warn);
  const read = (path: string): unknown => {
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { warn(`Grade #10819: ${path} ilegível: ${(e as Error).message}`); return undefined; }
  };
  const shorts = config.publishing?.shorts;
  const grids = [...new Set(dates)].map((day) => {
    const dir = join((deps.editionDir ?? editionDir)(day.replaceAll("-", "").slice(2)), "_internal");
    return mergeGrids(
      gridFromSocialPublished(read(join(dir, "06-social-published.json"))).filter((s) => !/^(facebook|twitter):/.test(s.account)),
      gridFromShortsPublished(read(join(dir, "06-shorts-published.json")), shorts?.instagram_author_page ?? "diaria", shorts?.instagram_collaborators ?? []).filter((s) => !/^(facebook|twitter):/.test(s.account)),
      gridFromLinkedInPersonalIntent(read(join(dir, "06-linkedin-personal.json"))),
    );
  });
  return mergeGrids(gridFromWorkerQueue(queue), ...grids);
}
