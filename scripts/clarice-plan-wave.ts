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
 * campanha agendada, que só se corrige cancelando (API ou painel) e
 * recriando — não é gratuito, mesmo não sendo mais tratado como estado
 * terminal sem saída (#4935, incidente original 260703).
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
 *   --target-volume N  (#6075) override do volume-alvo do MV sob demanda —
 *                   usado por `clarice-envio-run.ts` quando `--volume N`
 *                   (editor) é maior que o volume que a política propôs.
 *                   Nunca passado em invocação manual normal.
 *
 * Env: `BREVO_CLARICE_API_KEY` (crédito + campanhas comprometidas). Sem ela o
 * script AINDA roda, mas a proposta sai com o bloqueio "crédito não
 * consultado" de pé — nunca finge que validou o que não validou.
 *
 * Exit codes: 0 sucesso · 2 sucesso com blockers (`proposal.blockers`) · 1 erro
 * estrutural · 3 falha TRANSITÓRIA (429/503 do dashboard, `#5058`) — imprime
 * `{transient:true, retryAfterSecs, status, reason}` no STDOUT antes de sair;
 * quem chama como subprocesso (`clarice-envio-run.ts`) deve retentar com
 * backoff em vez de abortar a rodada, nunca tratar como erro de lógica.
 */

import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import {
  excludeCommittedToQueuedCampaigns,
  segmentRampWarm,
  segmentNovos,
  type StoreRow,
} from "./lib/clarice-segment.ts";
import { loadSentOrQueuedEmails, excludeSentOrQueued } from "./clarice-build-segment.ts";
import { brevoGet, fetchCommittedCampaignListIds, fetchDraftCampaigns } from "./lib/brevo-client.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireCycleArg, CLARICE_BASE, REPO_ROOT, clariceSegmentsDir } from "./lib/clarice-paths.ts";
import { readClariceHourTestState } from "./lib/clarice-hour-test.ts";
import { readClariceAbcState, lockedSubjectFromState, describeAbcState } from "./lib/clarice-abc-state.ts";
import { readNovosState } from "./lib/clarice-novos-state.ts";
import { readNovosCutoff } from "./lib/clarice-novos-cutoff.ts";
import { readNovosRunStatus } from "./lib/clarice-novos-run-status.ts";
import {
  TransientDashboardError,
  TRANSIENT_DASHBOARD_STATUSES,
  parseRetryAfterSecs,
} from "./lib/transient-dashboard-error.ts";
import {
  buildWaveProposal,
  computeNextWaveNumber,
  measureNonOpenerExposure,
  measureNovosFreshness,
  mergeCampaignSources,
  proposeVolumes,
  recommendAbcAction,
  renderWaveProposal,
  summarizeAvailableFirstSendByCohort,
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

// ---------------------------------------------------------------------------
// #5058 — falha TRANSITÓRIA (429/503) do dashboard `/api/campaigns` é uma
// classe DIFERENTE de erro do resto deste script: rate limit da Brevo
// (`rateLimitResponse` em workers/brevo-dashboard/src/brevo-api.ts sempre
// devolve 503 + `Retry-After`, nunca 429 puro — mas 429 é aceito aqui também,
// defensivo) NÃO é um erro de lógica, é "espere e repita". Antes, `!res.ok`
// caía direto no `throw new Error(...)` genérico logo abaixo — indistinguível
// de qualquer outro erro estrutural pra quem chama este script como
// subprocesso (`clarice-envio-run.ts`), que morria na 1ª falha mesmo sabendo
// (pelo texto da mensagem, nunca pelo tipo) que era rate limit. Achado ao
// vivo: 260811, a task `Diaria-Clarice-Envio` das 19:00 morreu com
// `retryAfterSecs: 258` no corpo — 258s = ~4min de espera teria resolvido, e
// não havia mecanismo pra isso. `TransientDashboardError` é o sinal
// tipado que `main()` (abaixo) converte em exit code 3 + JSON no stdout, pra
// que o orquestrador retente com backoff em vez de abortar a rodada inteira.
// ---------------------------------------------------------------------------

// #5220 — `TransientDashboardError`/`TRANSIENT_DASHBOARD_STATUSES`/
// `parseRetryAfterSecs` moveram pra `lib/transient-dashboard-error.ts`
// (reuso por `clarice-envio-risk.ts`, que bate no mesmo dashboard). Reexport
// pra `TransientDashboardError` continuar importável deste path — mesma
// identidade de classe, `test/clarice-plan-wave.test.ts` não muda.
export { TransientDashboardError };

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
  /** #5395 — override de teste da raiz de `{ciclo}/segments/sent-or-queued.json`
   *  (mesmo padrão `baseDir` de `clariceSegmentsDir`). Default = `CLARICE_BASE` (produção). */
  segmentsBaseDir?: string;
  /** #5140 — raiz do repo pra ler `data/clarice-hour-test.json`. Injetável em teste. */
  hourTestRootDir?: string;
  /** #5058 — seam de teste (mesmo padrão de `resolveAutoRampVolumes` em
   *  clarice-schedule-ramp.ts). Default = `fetch` global (produção). */
  fetchImpl?: typeof fetch;
  /** #6075 — repassado direto pra `buildWaveProposal` (ver docstring lá).
   *  `undefined` = comportamento pré-#6075 (déficit de MV contra `volumes.total`). */
  targetVolume?: number;
}

export async function planWave(opts: PlanWaveOptions): Promise<WaveProposal> {
  const now = new Date();
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Dashboard ao vivo — fonte primária, nunca memória de sessão.
  // #4786: `includeScheduled=1` — sem isso, `/api/campaigns` só devolve
  // `status=sent` (filtro deliberado do dashboard, ver docstring de
  // `buildCampaignsResponse` no Worker) e `state.scheduledCount` fica
  // estruturalmente sempre 0, mesmo com campanha `queued` real agendada —
  // a verificação final da skill nunca enxergava a própria onda que acabou
  // de agendar.
  const res = await fetchImpl(`${opts.dashboardUrl}/api/campaigns?limit=${DEFAULT_DASHBOARD_LIMIT}&includeScheduled=1`);
  if (!res.ok) {
    // #5058 — 429/503 é TRANSITÓRIO (rate limit da Brevo repassado pelo
    // dashboard); qualquer outro status é erro estrutural (config, rede,
    // bug) e continua abortando direto, sem sinalizar retry pro chamador.
    if (TRANSIENT_DASHBOARD_STATUSES.has(res.status)) {
      throw new TransientDashboardError(
        `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}) — rate limit da Brevo, transitório.`,
        parseRetryAfterSecs(res.headers),
        res.status,
      );
    }
    throw new Error(
      `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}). ` +
        `429/503 = rate limit da Brevo; aguarde e repita — nunca planeje a onda sem o estado real.`,
    );
  }
  const stale = extractDashboardStaleInfo(res);
  const staleNote = stale ? `${stale.kind} (upstream=${stale.upstreamStatus}) — ${describeStaleAge(stale.since)}` : null;
  const rawCampaigns = (await res.json()) as BrevoCampaign[];

  // #5064 — campanhas DRAFT (`--create` rodou, `--schedule` ainda não) NUNCA
  // aparecem no dashboard acima (`includeScheduled=1` só devolve sent+queued
  // — ver docstring de `detectExistingWaveForSendDate` em clarice-envio-run.ts).
  // Busca direta à Brevo (mesma chave já usada pra crédito/comprometidas
  // abaixo) — fecha o guard de onda PARCIALMENTE MONTADA sem precisar de
  // endpoint novo no Worker `brevo-dashboard`. Fail-soft: é uma defesa
  // SECUNDÁRIA (o guard queued/sent continua sendo a proteção principal
  // contra dobrar o volume do dia), então uma falha aqui vira aviso, não
  // aborta a rodada inteira.
  let draftCampaigns: BrevoCampaign[] = [];
  if (apiKey) {
    try {
      const rawDrafts = await fetchDraftCampaigns(apiKey);
      draftCampaigns = rawDrafts.map((c) => ({
        id: c.id ?? -1,
        name: c.name ?? "",
        subject: c.subject ?? "",
        status: c.status ?? "draft",
        sentDate: c.sentDate ?? null,
        scheduledAt: c.scheduledAt ?? null,
        createdAt: c.createdAt ?? "",
        recipients: { lists: c.recipients?.lists ?? [] },
      }));
    } catch (err) {
      console.error(
        `⚠️  Consulta de campanhas draft falhou (#5064): ${err instanceof Error ? err.message : err} — ` +
          "guard de onda parcialmente montada fica cego nesta rodada (defesa secundária; o guard queued/sent continua ativo).",
      );
    }
  }
  const campaigns = await enrichWithLists(apiKey, mergeCampaignSources(rawCampaigns, draftCampaigns));

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
        // `created` (#5179) — sem ele, `compareContactRecency`/
        // `compareCohortEntriesByRecency` (segmentRampWarm, summarizeMvBacklog,
        // summarizeAvailableFirstSendByCohort) degradam sempre pro fallback de
        // `cohortSendRank`, silenciosamente, porque toda linha chegaria com
        // `created: undefined`.
        `SELECT email, tier, cohort, priority_points, send_eligible, ineligible_reason,
                sends_count, opens_count, last_sent_at, mv_bucket, brevo_list_ids, brevo_modified_at, created
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
  // #7007 — `err.message` sobrevive além do `console.error` (stderr de um
  // subprocesso que `clarice-envio-run.ts` nunca lê) e vira parte do bloqueio
  // que `buildWaveProposal` monta abaixo — 3 ocorrências do mesmo `-abort`
  // genérico (260827/260830/260901) exigiram investigação do zero cada vez
  // porque a causa real (429? erro de rede? 401?) nunca chegava no relatório.
  let committedLookupError: string | null = null;
  if (apiKey) {
    try {
      committed = await fetchCommittedCampaignListIds(apiKey);
    } catch (err) {
      committedLookupFailed = true;
      committedLookupError = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  Consulta de campanhas comprometidas falhou: ${committedLookupError}`);
    }
  } else {
    // Sem chave a checagem nem foi tentada — mesma consequência prática.
    committedLookupFailed = true;
    committedLookupError = "BREVO_CLARICE_API_KEY ausente — checagem nem foi tentada.";
  }
  // #5395 — `excludeCommittedToQueuedCampaigns` sozinho só cobre quem está
  // COMMITTED numa campanha Brevo queued/sent; um contato que entrou numa
  // lista cuja campanha foi suspensa/replanejada (nunca virou queued nem
  // sent) escapa desse guard mas já foi marcado como enviado/reservado em
  // `sent-or-queued.json` pelo `clarice-build-segment.ts` (#3227/#4759) — o
  // MESMO guard cycle-wide que a fila REAL (`--group ramp-warm`) aplica.
  // Sem replicar aqui, `availableFirstSend` conta esses órfãos como
  // disponíveis quando na prática já foram consumidos/reservados por outra
  // invocação do ciclo — a raiz do achado ao vivo de 260816 (onda saiu 25%
  // menor que o planejado, sem aviso).
  const sentOrQueuedEmails = loadSentOrQueuedEmails(clariceSegmentsDir(opts.cycle, opts.segmentsBaseDir ?? CLARICE_BASE));
  // #5410: mesmo cutoff que `clarice-build-segment.ts --group ramp-warm`
  // usa em produção — sem isto, a PRÉVIA contaria como "disponível" contatos
  // que a seleção REAL nunca incluiria (ainda dentro da janela `novos`),
  // superestimando a fila igual ao gap do #5395 (comentário acima).
  const novosCutoff = readNovosCutoff(opts.novosStateBaseDir ?? CLARICE_BASE);
  const availableFirstSendRows = excludeSentOrQueued(
    excludeCommittedToQueuedCampaigns(
      segmentRampWarm(rows, { cutoffNovosIso: novosCutoff?.cutoffIso ?? null }),
      committed,
    ),
    sentOrQueuedEmails,
  );
  const availableFirstSend = availableFirstSendRows.length;
  // #4787: composição por safra da MESMA fila que `availableFirstSend` conta
  // — alimenta o gatilho proativo de inversão de safra em buildWaveProposal.
  const availableFirstSendByCohort = summarizeAvailableFirstSendByCohort(availableFirstSendRows);

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

  // #5405 item 2 — desfecho da ÚLTIMA tentativa (sucesso ou abort), fonte
  // independente de `novosState` (que só avança em envio confirmado — ver
  // docstring de `clarice-novos-run-status.ts`). `undefined` (nenhuma
  // tentativa registrada ainda) → `buildWaveProposal` cai no comportamento
  // pré-#5405 (sem override de texto).
  const lastRunStatus = readNovosRunStatus(opts.novosStateBaseDir ?? CLARICE_BASE);
  const novosLastAbort =
    lastRunStatus && lastRunStatus.status === "other-error"
      ? { status: lastRunStatus.status, checkedAt: lastRunStatus.checkedAt, detail: lastRunStatus.detail }
      : null;

  // #5405 item 3 — fila represada na janela `novos` (mesmo cutoff do #5410
  // acima). Sem cutoff conhecido (base sem nenhuma rodada de `novos` ainda)
  // → `null`, omitido dos textos.
  const novosPending = novosCutoff
    ? (() => {
        const pending = segmentNovos(rows, { sinceIso: novosCutoff.cutoffIso });
        let earliest: string | null = null;
        for (const r of pending) {
          if (r.created && (earliest === null || r.created < earliest)) earliest = r.created;
        }
        return { count: pending.length, earliestCreatedIso: earliest };
      })()
    : null;

  // #5140: mesma leitura fail-soft do estado que `clarice-envio-run.ts` faz.
  // Sem isto a PRÉVIA mostraria 1 lista num dia em que a execução criaria 2
  // campanhas em horários diferentes — a prévia é o que o editor aprova.
  const hourTest = readClariceHourTestState(opts.hourTestRootDir ?? REPO_ROOT);

  return buildWaveProposal({
    cycle: opts.cycle,
    dates: opts.dates,
    volumes: volumeResult.proposal,
    abc,
    state,
    hourCellsBrt: hourTest.status === "ativo" ? hourTest.hoursBrt : undefined,
    availableFirstSend,
    availableFirstSendByCohort,
    mvBacklog: summarizeMvBacklog(rows),
    nonOpeners: measureNonOpenerExposure(rows),
    brevoCredits,
    staleNote,
    // Continua a numeração do ciclo — `d6` depois de `d5`, nunca reinicia.
    startingWaveNumber: computeNextWaveNumber(state.waves),
    committedLookupFailed,
    committedLookupError,
    novosFreshness,
    novosLastAbort,
    novosPending,
    targetVolume: opts.targetVolume,
  });
}

/**
 * `--target-volume N` (#6075): repassa o `--volume N` do editor
 * (`clarice-envio-run.ts`) pro dimensionamento do MV sob demanda. Só
 * `clarice-envio-run.ts` chama com este flag; invocação manual/gate sem
 * ele preserva o comportamento pré-#6075 (retorna `undefined`).
 *
 * Extraída de `main()` (regressão #6144) porque `getArg` NUNCA retorna
 * `undefined` — retorna `""` quando a flag está ausente (design documentado
 * em `lib/cli-args.ts`). A versão anterior checava `getArg(...) !==
 * undefined`, que é sempre `true`, então toda invocação SEM
 * `--target-volume` (inclusive `clarice-envio-run.ts --plan-only`) caía na
 * validação com `Number("") = 0` e abortava. `getIntArg` tem a semântica
 * certa: `undefined` quando a flag está genuinamente ausente, lança quando
 * presente mas inválida.
 */
export function parseTargetVolumeArg(argv: string[]): number | undefined {
  return getIntArg(argv, "target-volume", { min: 1 });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dates = parseDatesArg(getArg(argv, "dates"));
  // #5055: `--locked-subject` continua existindo (override pontual, ex:
  // simular o encerramento antes de gravá-lo), mas o caminho NORMAL é o
  // estado durável em `data/clarice-abc-state.json`. Sem esse fallback, a
  // decisão "o teste acabou" continuaria morrendo no fim de cada invocação —
  // era exatamente o buraco da #5055.
  // Raiz do REPO (não `process.cwd()`): este script é spawnado por
  // `clarice-envio-run.ts`, e um cwd diferente faria a leitura cair pro
  // default `aberto` — o orquestrador então abortaria por divergência com o
  // próprio estado que ele acabou de ler. `REPO_ROOT` (já importado de
  // `./lib/clarice-paths.ts`) resolve pro mesmo path absoluto que o `ROOT`
  // computado inline em `clarice-envio-run.ts`/`clarice-envio-guard.ts`
  // (mesmo padrão fileURLToPath, achado do review da PR do fix Windows).
  const abcState = readClariceAbcState(REPO_ROOT);
  const lockedSubject = getArg(argv, "locked-subject") || lockedSubjectFromState(abcState);

  let targetVolume: number | undefined;
  try {
    targetVolume = parseTargetVolumeArg(argv);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const proposal = await planWave({
    cycle,
    dates,
    dbPath: getArg(argv, "db") || DEFAULT_DB_PATH,
    dashboardUrl: getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL,
    lockedSubject,
    targetVolume,
  });

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(proposal, null, 2));
  } else {
    console.log(renderWaveProposal(proposal));
    // #5055 item 5 — o gate mostra de ONDE veio a recomendação A/B/C, com data
    // e motivo, pra que "por que isso saiu com 1 assunto?" não vire arqueologia.
    console.log(`\n── Estado do teste A/B/C (#5055) ──\n  ${describeAbcState(abcState)}`);
    if (abcState.rationale) console.log(`  motivo: ${abcState.rationale}`);
    if (abcState.invalidReason) console.log(`  ⚠️  estado ilegível (${abcState.invalidReason}) — recalculando como ABERTO.`);
  }
  // Exit 2 com bloqueio de pé — a skill checa o código, não o texto, pra
  // decidir se pode oferecer "sim" no gate.
  if (proposal.blockers.length > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    // #5058 — sinaliza a falha TRANSITÓRIA pro chamador (`clarice-envio-run.ts`)
    // por DOIS canais: exit code 3 (o chamador decide se retenta SEM parsear
    // texto) e um JSON de 1 linha no STDOUT (`retryAfterSecs`, quando a Brevo
    // informou — o chamador honra em vez de inventar um backoff próprio).
    // `console.error` continua com a mensagem legível pro humano que rodar
    // este script manualmente (skill /diaria-clarice-envio).
    if (err instanceof TransientDashboardError) {
      console.log(JSON.stringify({ transient: true, retryAfterSecs: err.retryAfterSecs, status: err.status, reason: err.message }));
      console.error(err.message);
      process.exit(3);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
