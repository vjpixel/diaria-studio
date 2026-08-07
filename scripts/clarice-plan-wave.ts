#!/usr/bin/env node
/**
 * clarice-plan-wave.ts (#4657) — CLI do planejamento da próxima onda de
 * envio da mensal pra base Clarice News.
 *
 * READ-ONLY POR CONSTRUÇÃO. Este script LÊ (dashboard ao vivo + store local)
 * e IMPRIME uma proposta. Não cria lista, não cria campanha, não agenda,
 * não escreve no store. O agendamento continua sendo os scripts já
 * existentes (`clarice-build-segment` → `clarice-import-waves` →
 * `clarice-schedule-group`), invocados DEPOIS da confirmação do editor pela
 * skill `/diaria-clarice-envio`.
 *
 * Essa separação é deliberada: o passo que decide "pra quem a edição vai" é
 * o de maior blast radius do projeto (dezenas de milhares de e-mails, e a
 * reputação do domínio `clarice.ai`, que é do PARCEIRO). Um script que
 * propõe e agenda na mesma invocação transforma um erro de digitação em
 * campanha agendada — e campanha agendada na Brevo é IMUTÁVEL (incidente
 * 260703).
 *
 * Toda a lógica de decisão mora em `scripts/lib/clarice-wave-plan.ts` (puro,
 * testável). Aqui só há I/O e a montagem dos argumentos.
 *
 * Uso:
 *   npx tsx scripts/clarice-plan-wave.ts --cycle 2607-08 --days 3 \
 *     --dates 2026-08-06,2026-08-07,2026-08-08
 *
 *   --cycle X       OBRIGATÓRIO — ciclo {conteúdo}-{envio}, ex: 2607-08.
 *   --dates A,B,C   OBRIGATÓRIO — datas EXPLÍCITAS (YYYY-MM-DD), uma por dia
 *                   de envio. Nunca inferidas de weekday nem de `today()`
 *                   ("data é sempre explícita", CLAUDE.md). O número de datas
 *                   define o horizonte da onda.
 *   --json          imprime a proposta como JSON (consumo pela skill) em vez
 *                   do texto do gate.
 *   --db PATH       override do store (default DEFAULT_DB_PATH).
 *   --dashboard-url override do dashboard.
 *   --locked-subject "…"  assunto único já travado em ciclo anterior — força
 *                   a recomendação A/B/C pra "travar" sem recalcular.
 *
 * Env: `BREVO_CLARICE_API_KEY` (crédito + campanhas comprometidas). Sem ela o
 * script AINDA roda, mas a proposta sai com o bloqueio "crédito não
 * consultado" de pé — nunca finge que validou o que não validou.
 */

import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import {
  excludeCommittedToQueuedCampaigns,
  segmentRampWarm,
  type StoreRow,
} from "./lib/clarice-segment.ts";
import { brevoGet, fetchCommittedCampaignListIds } from "./lib/brevo-client.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireCycleArg, CLARICE_BASE } from "./lib/clarice-paths.ts";
import { readNovosState } from "./lib/clarice-novos-state.ts";
import {
  buildWaveProposal,
  computeNextWaveNumber,
  measureNonOpenerExposure,
  measureNovosFreshness,
  proposeVolumes,
  recommendAbcAction,
  renderWaveProposal,
  summarizeCycleSends,
  summarizeMvBacklog,
  type WaveProposal,
} from "./lib/clarice-wave-plan.ts";
import {
  describeStaleAge,
  extractDashboardStaleInfo,
  fetchPostmasterSpamEntry,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_DASHBOARD_LIMIT,
} from "./clarice-schedule-ramp.ts";
import { aggregateAbcByAudience } from "../workers/brevo-dashboard/src/sections-core.ts";
import { extractPlanCredits } from "../workers/brevo-dashboard/src/brevo-api.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

loadProjectEnv();

/** Parse de `--dates A,B,C` — 1+ datas ISO, sem repetição, em ordem crescente. */
export function parseDatesArg(raw: string | undefined): string[] {
  if (!raw) throw new Error("--dates é obrigatório (YYYY-MM-DD, separadas por vírgula).");
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("--dates vazio.");
  for (const d of parts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`data inválida em --dates: "${d}" — esperado YYYY-MM-DD.`);
    }
  }
  const seen = new Set(parts);
  if (seen.size !== parts.length) throw new Error("--dates tem data repetida.");
  const sorted = [...parts].sort();
  if (sorted.join(",") !== parts.join(",")) {
    throw new Error("--dates fora de ordem crescente — ordem da onda importa (rampa morno→frio).");
  }
  return parts;
}

/**
 * Enriquece as campanhas com `listName`/`listSize` — `parseAbcAudienceCampaign`
 * DEPENDE do nome da lista pra extrair ciclo+célula do fluxo `--group`
 * (#4447: o nome da campanha não carrega nenhum dos dois). Sem esse
 * enriquecimento o Resumo A/B/C sai vazio e a recomendação viraria "iniciar"
 * mesmo com um teste em curso — falha silenciosa exatamente na direção
 * errada (recomeçar um teste já maduro).
 */
async function enrichWithLists(
  apiKey: string | undefined,
  campaigns: BrevoCampaign[],
): Promise<Array<BrevoCampaign & { listName?: string; listSize?: number }>> {
  if (!apiKey) return campaigns;
  const ids = new Set<number>();
  for (const c of campaigns) for (const id of c.recipients?.lists ?? []) ids.add(id);
  const info = new Map<number, { name: string; total: number }>();
  for (const id of ids) {
    try {
      const { body } = await brevoGet(apiKey, `/contacts/lists/${id}`);
      if (body && typeof body === "object") {
        info.set(id, {
          name: String((body as { name?: unknown }).name ?? ""),
          total: Number((body as { totalSubscribers?: unknown }).totalSubscribers ?? 0),
        });
      }
    } catch (err) {
      // Lista inacessível (removida, permissão, rede). NÃO é inócuo: sem
      // `listName` a campanha não pode ser atribuída a ciclo nenhum, e
      // `summarizeCycleSends` a exclui contando em `unscopedCount` (que vira
      // aviso). Antes este catch era vazio e o comentário afirmava que o
      // efeito aparecia via `suspectedDriftDays` — falso: aquele sinal só
      // existe dentro da tabela A/B/C, nunca tocava o resumo do ciclo.
      console.error(
        `⚠️  Metadados da lista ${id} indisponíveis: ${err instanceof Error ? err.message : err} — ` +
          `campanhas que apontam pra ela ficam fora do resumo do ciclo.`,
      );
    }
  }
  return campaigns.map((c) => {
    const id = c.recipients?.lists?.[0];
    const meta = typeof id === "number" ? info.get(id) : undefined;
    return meta ? { ...c, listName: meta.name, listSize: meta.total } : c;
  });
}

export interface PlanWaveOptions {
  cycle: string;
  dates: string[];
  dbPath: string;
  dashboardUrl: string;
  lockedSubject: string | null;
  /** #4664 — override de teste da raiz de `novos-state.json` (mesmo padrão
   *  `--data-root` do resto do projeto). Default = `CLARICE_BASE` (produção). */
  novosStateBaseDir?: string;
}

export async function planWave(opts: PlanWaveOptions): Promise<WaveProposal> {
  const now = new Date();
  const apiKey = process.env.BREVO_CLARICE_API_KEY;

  // 1. Dashboard ao vivo — fonte primária, nunca memória de sessão.
  const res = await fetch(`${opts.dashboardUrl}/api/campaigns?limit=${DEFAULT_DASHBOARD_LIMIT}`);
  if (!res.ok) {
    throw new Error(
      `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}). ` +
        `429 = rate limit da Brevo; aguarde e repita — nunca planeje a onda sem o estado real.`,
    );
  }
  const stale = extractDashboardStaleInfo(res);
  const staleNote = stale ? `${stale.kind} (upstream=${stale.upstreamStatus}) — ${describeStaleAge(stale.since)}` : null;
  const rawCampaigns = (await res.json()) as BrevoCampaign[];
  const campaigns = await enrichWithLists(apiKey, rawCampaigns);

  // 2. Estado do ciclo + teste A/B/C (ambos reusam máquina existente).
  const state = summarizeCycleSends(campaigns, opts.cycle, now);
  const abcTables = aggregateAbcByAudience(campaigns, opts.cycle);
  const abc = recommendAbcAction(abcTables.aggregate, { lockedSubject: opts.lockedSubject });

  // 3. Volume — delega ao semáforo do dashboard (herda o gate de spam).
  const spamEntry = await fetchPostmasterSpamEntry(opts.dashboardUrl, fetch);
  const volumeResult = proposeVolumes(campaigns, opts.dates.length, now, spamEntry);
  if (!volumeResult.ok) throw new Error(`Não foi possível propor volume: ${volumeResult.reason}`);

  // 4. Store local — fila disponível, backlog MV, não-abridores.
  const db = openClariceDb(opts.dbPath);
  let rows: StoreRow[];
  try {
    rows = db
      .prepare(
        `SELECT email, tier, cohort, priority_points, send_eligible, ineligible_reason,
                sends_count, opens_count, last_sent_at, mv_bucket, brevo_list_ids, brevo_modified_at
           FROM clarice_users`,
      )
      .all() as unknown as StoreRow[];
  } finally {
    // Windows: handle SQLite aberto segura o lock e trava um sync concorrente.
    db.close();
  }

  // `fetchCommittedCampaignListIds` é documentada pra FALHAR ALTO: sem ela o
  // set de exclusão fica vazio e a fila é superestimada (#3682 — reenvio 100%
  // pra quem já tinha recebido). Antes esta falha virava só um `console.error`,
  // que nem entra no `--json` que a skill de fato lê. Agora vira BLOQUEIO
  // estrutural, como o crédito não-consultado já fazia.
  let committed = new Set<string>();
  let committedLookupFailed = false;
  if (apiKey) {
    try {
      committed = await fetchCommittedCampaignListIds(apiKey);
    } catch (err) {
      committedLookupFailed = true;
      console.error(`⚠️  Consulta de campanhas comprometidas falhou: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    // Sem chave a checagem nem foi tentada — mesma consequência prática.
    committedLookupFailed = true;
  }
  const availableFirstSend = excludeCommittedToQueuedCampaigns(segmentRampWarm(rows), committed).length;

  // 5. Crédito Brevo — validado ANTES de qualquer proposta de escrita.
  let brevoCredits: number | null = null;
  if (apiKey) {
    try {
      const { body } = await brevoGet(apiKey, "/account");
      brevoCredits = extractPlanCredits(body);
    } catch (err) {
      console.error(`⚠️  Crédito Brevo não consultado: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 6. Frescor do /diaria-clarice-novos (#4664) — leitura local, mesma
  // disciplina fail-soft de `readNovosState` (arquivo ausente/corrompido →
  // `null`, nunca lança); `measureNovosFreshness` trata `null` como
  // "never-run" (ver docstring em clarice-wave-plan.ts).
  const novosState = readNovosState(opts.novosStateBaseDir ?? CLARICE_BASE);
  const novosFreshness = measureNovosFreshness(novosState?.lastRunAt ?? null, now);

  return buildWaveProposal({
    cycle: opts.cycle,
    dates: opts.dates,
    volumes: volumeResult.proposal,
    abc,
    state,
    availableFirstSend,
    mvBacklog: summarizeMvBacklog(rows),
    nonOpeners: measureNonOpenerExposure(rows),
    brevoCredits,
    staleNote,
    // Continua a numeração do ciclo — `d6` depois de `d5`, nunca reinicia.
    startingWaveNumber: computeNextWaveNumber(state.waves),
    committedLookupFailed,
    novosFreshness,
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dates = parseDatesArg(getArg(argv, "dates"));
  const proposal = await planWave({
    cycle,
    dates,
    dbPath: getArg(argv, "db") || DEFAULT_DB_PATH,
    dashboardUrl: getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL,
    lockedSubject: getArg(argv, "locked-subject") || null,
  });

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(proposal, null, 2));
  } else {
    console.log(renderWaveProposal(proposal));
  }
  // Exit 2 com bloqueio de pé — a skill checa o código, não o texto, pra
  // decidir se pode oferecer "sim" no gate.
  if (proposal.blockers.length > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
