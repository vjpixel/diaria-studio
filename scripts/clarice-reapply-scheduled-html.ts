#!/usr/bin/env node
/**
 * clarice-reapply-scheduled-html.ts (#2940, corrigido em #4082)
 *
 * Near-miss real em 2026-07-03/04: o editor pediu pra "atualizar a newsletter
 * na Brevo" após correções de branding na edição 2606-07. As campanhas A/B/C
 * daquele ciclo foram montadas MANUALMENTE na Brevo — então
 * `data/monthly/{ciclo}/sends/cells/campaigns-summary.json` não existia, e
 * `clarice-schedule-sends --update-html` só sabe ler esse arquivo. A
 * atualização virou um one-off manual (GET/diff/PUT via brevo-client.ts), com
 * risco real de: (1) sobrescrever a campanha errada — o handoff
 * `ab-test-plan.md` estava desatualizado; (2) tocar campanha `sent` (envio já
 * saiu, update vira ruído); (3) perder subject/scheduledAt/lista num PUT amplo.
 *
 * Este script formaliza esse one-off: descobre as campanhas QUEUED do ciclo
 * direto na Brevo API (nunca via campaigns-summary.json, que pode nem
 * existir), filtra por status pré-envio (`queued`/`scheduled`, nunca toca
 * `sent`/`in_process`), e reaplica o HTML preservando subject/scheduledAt/lista.
 *
 * #4082 — near-miss real em 260727 (campanha #99, faltando 5h pro disparo):
 * este script NÃO SERVIU, por dois defeitos independentes, e um terceiro
 * defeito de design descoberto na investigação:
 *
 *   1. `fetchQueuedCampaigns` pedia `limit=1000` — a Brevo passou a recusar
 *      (`{"code":"out_of_range","message":"Limit exceeds max value"}`). O
 *      script morria antes de descobrir campanha nenhuma, inclusive no
 *      dry-run. Corrigido: paginação `limit=100` + `offset` (mesmo padrão de
 *      `brevoListAllLists`/`fetchCampaignListIdsByStatus` em brevo-client.ts).
 *
 *   2. O matching por nome só reconhecia `Clarice News {yymm}` (fluxo
 *      antigo de `clarice-schedule-sends.ts`). Campanhas criadas por
 *      `clarice-schedule-group.ts` se chamam `Clarice {yymm} grupo:{key}`
 *      (ex: "Clarice 2606 grupo:envio10") e nunca casavam. Corrigido:
 *      `cycleNamePrefixes()` reconhece os dois prefixos, e `--campaign-id N`
 *      permite pular a descoberta por nome inteiramente (o operador quase
 *      sempre sabe qual campanha quer corrigir — o matching por nome é a
 *      parte frágil).
 *
 *   3. O caminho de escrita fazia só `PUT htmlContent` direto — a Brevo
 *      RECUSA esse PUT numa campanha `queued` (só aceita update de conteúdo
 *      em `draft`/`suspended`). Não há evidência de que este script alguma
 *      vez tenha sido exercitado contra uma campanha realmente agendada
 *      (nenhum teste cobria isso, e o incidente #4082 é o primeiro uso real
 *      documentado). Corrigido: fluxo suspend → update html (GET-verify) →
 *      reschedule (mesmo scheduledAt exato de antes), replicando a sequência
 *      validada manualmente no incidente (ver corpo da issue #4082) e o
 *      padrão já usado em `clarice-cta-ab-setup.ts` (`setStatus` +
 *      suspend-antes-de-editar).
 *
 * Nota de audiência (documentada no #4082, não resolvida — só verificada):
 * suspender e reagendar uma campanha **re-tira o snapshot de destinatários**
 * (a Brevo congela a lista no momento do agendamento, não no envio — ver
 * memória `brevo-recipients-snapshot`). Se a lista tiver mudado entre o
 * agendamento original e o reapply, o público muda sem aviso. Por isso o
 * script agora soma `totalSubscribers` das listas ANTES do suspend e DEPOIS
 * do reschedule e falha alto (banner + exit 1) se divergir.
 *
 * Nota de UTM (documentada, não resolvida): o GA tracking da Brevo reescreve
 * `utm_source`/`utm_medium`/`utm_campaign` no save do `htmlContent` — inclusive
 * via API — preservando só `utm_term` (ver memória
 * `brevo-ga-tracking-rewrites-utms-on-save`). Se esse toggle estiver ligado
 * na campanha, o PUT de htmlContent deste script pode reescrever UTMs sem
 * aviso. Este script não desliga/religa o toggle — só alerta aqui.
 *
 * Modo de falha mais sério (#4082 item 5): se qualquer passo entre o suspend
 * e o reschedule bem-sucedido falhar, a campanha fica PRESA em "suspended" —
 * o pior estado possível é ela sair da fila em silêncio e o envio
 * simplesmente não acontecer. Esse caminho SEMPRE termina em
 * `emitLoudBanner()` (banner vermelho estilo halt-banner, #737) nomeando a
 * campanha e o que fazer pra recolocá-la na fila, nunca em erro silencioso.
 *
 * Fases:
 *   (default, sem --apply) dry-run: lista o que faria, NÃO escreve nada.
 *   --apply                 executa: revalida status ao vivo campanha-a-campanha
 *                            imediatamente antes de suspender (evita corrida
 *                            queued->sent entre a descoberta e a escrita),
 *                            suspend → PUT htmlContent (GET-verify) →
 *                            PUT scheduledAt (mesmo valor de antes), depois
 *                            GET final comparando status/scheduledAt/subject/
 *                            listas/totalSubscribers contra o capturado antes
 *                            do suspend.
 *
 * Uso:
 *   npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2606-07                          # dry-run (default)
 *   npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2606-07 --apply                   # descoberta por nome, escreve
 *   npx tsx scripts/clarice-reapply-scheduled-html.ts --cycle 2606-07 --campaign-id 99 --apply  # pula a descoberta por nome (#4082)
 *
 * ATENÇÃO: este script NUNCA deve ser rodado contra a Brevo real a partir de
 * uma sessão automatizada sem supervisão direta do editor — ele existe pra
 * formalizar um one-off que antes era manual, não pra rodar autonomamente.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet, brevoPut, brevoGetList } from "./lib/brevo-client.ts";
import { parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { isMainModule, getArg } from "./lib/cli-args.ts";
import { renderHaltBanner } from "./lib/gate-banner.ts";

loadProjectEnv();

/** Shape mínimo de um item de `/emailCampaigns` (list ou detail). */
export interface BrevoCampaignListItem {
  id: number;
  name: string;
  status: string;
  subject?: string;
  scheduledAt?: string | null;
  /** #2994/#4082: campo real da Brevo API é `recipients.lists` (array de
   *  list_id), NÃO `recipients.listIds` — mesmo shape documentado em
   *  brevo-client.ts. Usado aqui pra somar totalSubscribers antes/depois. */
  recipients?: { lists?: number[] };
}

/** GET /emailCampaigns/{id} traz também htmlContent. */
export interface BrevoCampaignDetail extends BrevoCampaignListItem {
  htmlContent?: string;
}

/** Estados pré-envio seguros (agendada-não-enviada) — a Brevo reporta como
 *  "queued" OU "scheduled" dependendo da versão de API/timing (drift documentado
 *  em clarice-schedule-sends.ts). Nunca "sent"/"in_process". */
export function isSchedulableStatus(status: string | undefined): boolean {
  return status === "queued" || status === "scheduled";
}

/** #4082: a Brevo rejeita `limit=1000` (`out_of_range: Limit exceeds max
 *  value`). 100 é o valor já usado em outros paginadores deste repo
 *  (`fetchCampaignListIdsByStatus` em brevo-client.ts usa 50; usamos 100 aqui
 *  — dentro do teto aceito, menos páginas que 50). */
const DISCOVERY_PAGE_SIZE = 100;

/**
 * Descobre TODAS as campanhas (paginado) e filtra localmente por status
 * pré-envio (`queued`/`scheduled`).
 *
 * #2940 — o near-miss original escondeu as campanhas porque o código lia
 * `r.campaigns` em vez de `r.body.campaigns` (brevoGet retorna
 * `{status, body}`; o corpo HTTP mora em `.body`). Aqui o parsing correto é a
 * única forma suportada — falha alto (nunca retorna [] silenciosamente) se o
 * shape mudar.
 *
 * #4082 — antes pedia `limit=1000` numa chamada só; a Brevo passa a recusar
 * (400 `out_of_range`) e o script morria antes de achar campanha nenhuma,
 * inclusive em dry-run. Agora pagina em `DISCOVERY_PAGE_SIZE` (100) até a
 * página vir mais curta que o tamanho pedido (mesmo padrão de
 * `brevoListAllLists`).
 */
export async function fetchQueuedCampaigns(apiKey: string): Promise<BrevoCampaignListItem[]> {
  const all: BrevoCampaignListItem[] = [];
  let offset = 0;
  for (;;) {
    const { status, body } = await brevoGet(
      apiKey,
      `/emailCampaigns?limit=${DISCOVERY_PAGE_SIZE}&offset=${offset}`,
    );
    if (status !== 200) {
      throw new Error(`Brevo GET /emailCampaigns falhou: HTTP ${status}`);
    }
    const campaigns = (body as { campaigns?: unknown } | undefined)?.campaigns;
    if (!Array.isArray(campaigns)) {
      throw new Error(
        `/emailCampaigns: shape inesperado — esperava body.campaigns[] ` +
        `(recebido: ${JSON.stringify(body).slice(0, 300)}). ` +
        `Bug do near-miss #2940 era ler r.campaigns em vez de r.body.campaigns.`,
      );
    }
    all.push(...(campaigns as BrevoCampaignListItem[]));
    if (campaigns.length < DISCOVERY_PAGE_SIZE) break;
    offset += DISCOVERY_PAGE_SIZE;
  }
  return all.filter((c) => isSchedulableStatus(c.status));
}

/**
 * Busca uma campanha específica por ID — usado por `--campaign-id N` (#4082)
 * pra pular a descoberta por nome inteiramente. O operador quase sempre sabe
 * qual campanha quer corrigir; o matching por nome é a parte frágil (só
 * reconhece campanhas que sigam uma das duas convenções de nome).
 */
export async function fetchCampaignById(apiKey: string, campaignId: number): Promise<BrevoCampaignDetail> {
  const { status, body } = await brevoGet(apiKey, `/emailCampaigns/${campaignId}`);
  if (status !== 200) {
    throw new Error(`Brevo GET /emailCampaigns/${campaignId} falhou: HTTP ${status}`);
  }
  return body as BrevoCampaignDetail;
}

/**
 * Prefixos de nome reconhecidos pras campanhas do ciclo (#4082 item 2):
 *   - "Clarice News {yymm}"       — fluxo antigo (clarice-schedule-sends.ts).
 *   - "Clarice {yymm} grupo:"     — fluxo --group (clarice-schedule-group.ts),
 *                                    ex: "Clarice 2606 grupo:envio10". Nunca
 *                                    casava antes do #4082 — near-miss real.
 */
export function cycleNamePrefixes(cycle: string): string[] {
  const yymm = cycleToYymm(cycle);
  return [`Clarice News ${yymm}`, `Clarice ${yymm} grupo:`];
}

/** Prefixo canônico primário (fluxo antigo) — mantido pra mensagens/logs que
 *  só precisam de UM prefixo de referência. O filtro real usa
 *  `cycleNamePrefixes()` (aceita os dois formatos, #4082). */
export function cycleNamePrefix(cycle: string): string {
  return cycleNamePrefixes(cycle)[0];
}

/** Filtra campanhas cujo nome bate com QUALQUER prefixo reconhecido do ciclo. Pure. */
export function filterCycleCampaigns(campaigns: BrevoCampaignListItem[], cycle: string): BrevoCampaignListItem[] {
  const prefixes = cycleNamePrefixes(cycle);
  return campaigns.filter((c) => typeof c.name === "string" && prefixes.some((p) => c.name.startsWith(p)));
}

/**
 * Cross-check WARNING-ONLY pra `--campaign-id N` (finding 2 do review #4142):
 * o operador pediu explicitamente pra pular toda a descoberta/matching por
 * nome (#4082 item 2) — isso continua valendo, o script NUNCA bloqueia aqui.
 * Mas nada avisava se o ID apontasse pra uma campanha de outro ciclo (dedo
 * gordo ao colar o ID). Retorna a mensagem de aviso (para o caller imprimir)
 * ou `undefined` se o nome bate com algum prefixo esperado. Pure.
 */
export function campaignCycleMismatchWarning(
  campaign: Pick<BrevoCampaignListItem, "id" | "name">,
  cycle: string,
): string | undefined {
  const prefixes = cycleNamePrefixes(cycle);
  const name = typeof campaign.name === "string" ? campaign.name : "";
  if (prefixes.some((p) => name.startsWith(p))) return undefined;
  return (
    `⚠ campanha #${campaign.id} se chama "${campaign.name}", que não bate com nenhum prefixo esperado do ` +
    `ciclo ${cycle} (${prefixes.map((p) => `"${p}"`).join(" ou ")}) — prosseguindo mesmo assim porque ` +
    `--campaign-id é explícito. Confirme que é a campanha certa antes de responder a qualquer prompt.`
  );
}

/**
 * Separa as campanhas do ciclo em queued/scheduled (elegíveis a update) vs.
 * não-elegíveis (puladas — NUNCA recebem PUT). Defensivo: mesmo que a query
 * já tenha filtrado do lado da Brevo, este segundo filtro local garante que
 * uma campanha `sent`/`in_process` que apareça no conjunto por qualquer
 * motivo (cache, corrida, mudança de shape da API) nunca é tocada.
 */
export function partitionByQueuedStatus(
  campaigns: BrevoCampaignListItem[],
): { toUpdate: BrevoCampaignListItem[]; skipped: BrevoCampaignListItem[] } {
  const toUpdate: BrevoCampaignListItem[] = [];
  const skipped: BrevoCampaignListItem[] = [];
  for (const c of campaigns) {
    if (isSchedulableStatus(c.status)) toUpdate.push(c); // queued OU scheduled — pré-envio seguro
    else skipped.push(c);
  }
  return { toUpdate, skipped };
}

/** Monta as linhas de plano impressas em dry-run e antes de --apply. Pure. */
export function buildPlanLines(toUpdate: BrevoCampaignListItem[], skipped: BrevoCampaignListItem[]): string[] {
  const lines: string[] = [];
  lines.push(`${toUpdate.length} campanha(s) elegível(is) a atualizar (suspend → update → reschedule):`);
  for (const c of toUpdate) {
    lines.push(`  #${c.id} ${c.name} — scheduledAt=${c.scheduledAt ?? "?"} subject="${c.subject ?? "?"}"`);
  }
  if (skipped.length > 0) {
    lines.push(`${skipped.length} campanha(s) casaram o critério mas NÃO estão queued/scheduled (puladas, nunca recebem PUT):`);
    for (const c of skipped) {
      lines.push(`  #${c.id} ${c.name} — status=${c.status}`);
    }
  }
  return lines;
}

/**
 * PUT só de `htmlContent` — nunca subject/scheduledAt/recipients. Único
 * callsite de escrita de conteúdo deste script. Chamado com a campanha já
 * SUSPENSA (a Brevo recusa este PUT numa campanha `queued` — #4082 item 3).
 */
export async function reapplyHtml(apiKey: string, campaignId: number, html: string): Promise<unknown> {
  return brevoPut(apiKey, `/emailCampaigns/${campaignId}`, { htmlContent: html });
}

/** PUT /emailCampaigns/{id}/status — usado pra suspender (pré-requisito da
 *  Brevo pra editar htmlContent de uma campanha `queued`) e, no path de
 *  emergência puramente manual, pra tentar recolocar em `queued` de novo. */
export async function setCampaignStatus(apiKey: string, campaignId: number, status: string): Promise<unknown> {
  return brevoPut(apiKey, `/emailCampaigns/${campaignId}/status`, { status });
}

/** Soma `totalSubscribers` das listas informadas — usado pra comparar
 *  audiência ANTES do suspend vs. DEPOIS do reschedule (#4082 item 4: a
 *  Brevo re-tira o snapshot de destinatários ao reagendar). */
export async function sumListSubscribers(apiKey: string, listIds: number[]): Promise<number> {
  let total = 0;
  for (const id of listIds) {
    const list = await brevoGetList(apiKey, id);
    total += list.totalSubscribers ?? 0;
  }
  return total;
}

/**
 * Detecta audiência anômala (finding 3 do review #4142): `totalSubscribers`
 * zero, ou `recipients.lists` ausente/vazio, NÃO é sucesso — é estado
 * anômalo. Antes desta função, uma campanha com `recipients.lists` ausente
 * somava 0 antes e 0 depois, e `detectPostRescheduleDivergence` (que só
 * compara antes==depois) deixava passar silenciosamente. Chamado nos dois
 * momentos (`"antes"` do suspend, `"depois"` do reschedule) — a Brevo re-tira
 * o snapshot de destinatários ao reagendar, então uma lista que ficou vazia
 * só se manifesta no momento "depois". Pure — retorna a mensagem de erro ou
 * `undefined` se a audiência for normal.
 */
export function detectZeroAudienceAnomaly(
  moment: "antes" | "depois",
  listIds: number[],
  totalSubscribers: number,
): string | undefined {
  if (!Array.isArray(listIds) || listIds.length === 0) {
    return (
      `recipients.lists ausente/vazio ${moment} do reapply — 0 lista(s) associada(s) à campanha ` +
      `(estado anômalo, não sucesso).`
    );
  }
  if (totalSubscribers === 0) {
    return (
      `totalSubscribers = 0 ${moment} do reapply (listas: [${listIds.join(",")}]) — audiência vazia é ` +
      `estado anômalo, não sucesso.`
    );
  }
  return undefined;
}

export interface FinalStateExpectation {
  scheduledAt?: string | null;
  subject?: string;
  listIds: number[];
  totalSubscribers: number;
}

export interface FinalStateActual {
  status: string;
  scheduledAt?: string | null;
  subject?: string;
  listIds: number[];
  totalSubscribers: number;
}

/**
 * Compara o estado esperado (capturado ANTES do suspend) contra o estado real
 * pós-reschedule. Pure — nenhuma chamada de rede, testável sem mock de fetch.
 * Detecta as divergências que #4082 pede: status, scheduledAt (precisa ser
 * BYTE-IDÊNTICO ao original — a Brevo não deve mudar o formato sozinha),
 * subject, e lista/totalSubscribers (a Brevo re-tira o snapshot de
 * destinatários ao reagendar — ver doc do módulo).
 */
export function detectPostRescheduleDivergence(
  expected: FinalStateExpectation,
  actual: FinalStateActual,
): string[] {
  const problems: string[] = [];
  if (!isSchedulableStatus(actual.status)) {
    problems.push(`status final é "${actual.status}" (esperava queued/scheduled)`);
  }
  if (actual.scheduledAt !== expected.scheduledAt) {
    problems.push(`scheduledAt final "${actual.scheduledAt}" difere do original "${expected.scheduledAt}"`);
  }
  if (actual.subject !== expected.subject) {
    problems.push(`subject mudou: "${expected.subject}" -> "${actual.subject}"`);
  }
  const expectedSorted = [...expected.listIds].sort((a, b) => a - b);
  const actualSorted = [...actual.listIds].sort((a, b) => a - b);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    problems.push(`listas mudaram: [${expectedSorted.join(",")}] -> [${actualSorted.join(",")}]`);
  }
  if (actual.totalSubscribers !== expected.totalSubscribers) {
    problems.push(
      `totalSubscribers mudou: ${expected.totalSubscribers} -> ${actual.totalSubscribers} ` +
      `(a Brevo re-tira o snapshot de destinatários ao reagendar — a lista pode ter mudado ` +
      `desde o agendamento original)`,
    );
  }
  // Finding 3 (#4142): 0==0 passaria pelos checks acima sem soar alarme —
  // audiência zerada é anômala mesmo quando "antes" e "depois" concordam.
  const anomaly = detectZeroAudienceAnomaly("depois", actual.listIds, actual.totalSubscribers);
  if (anomaly) problems.push(anomaly);
  return problems;
}

const RED_BG_WHITE_FG = "\x1b[41m\x1b[97m";
const RESET = "\x1b[0m";

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

/**
 * Emite um banner "impossível de ignorar" (#4082 item 5) — reusa
 * `renderHaltBanner` (#737), o mesmo mecanismo do halt banner do
 * orchestrator, chamado aqui diretamente porque este script roda fora do
 * fluxo do orchestrator (ferramenta de emergência standalone, ver ATENÇÃO no
 * topo do arquivo). Único ponto do script que produz esse banner — chamado
 * sempre que uma campanha fica em estado divergente/preso após o suspend.
 */
export function emitLoudBanner(opts: { stage: string; reason: string; action: string }): void {
  const banner = renderHaltBanner(opts);
  const colored = shouldUseColor() ? `${RED_BG_WHITE_FG}${banner}${RESET}` : banner;
  console.error(colored);
  if (process.stdout.isTTY) process.stderr.write("\x07");
}

export interface ApplyResult {
  campaignId: number;
  finalScheduledAt?: string | null;
  totalSubscribersBefore: number;
  totalSubscribersAfter: number;
}

/**
 * Erro distinto (finding 1 do review #4142) pra sinalizar especificamente que
 * uma campanha ficou PRESA em "suspended" (falha na Fase A crítica, entre o
 * suspend bem-sucedido e o reschedule bem-sucedido) — o pior estado possível,
 * já coberto por `emitLoudBanner()` antes de chegar aqui. Distinto de um erro
 * genérico (ex: divergência pós-reschedule na Fase B, onde a campanha JÁ
 * voltou pra fila) pra permitir que o runner do lote (`runApplyBatch`) aborte
 * o processamento das próximas campanhas só neste caso específico.
 */
export class StuckSuspendedCampaignError extends Error {
  constructor(public readonly campaignId: number, message: string) {
    super(message);
    this.name = "StuckSuspendedCampaignError";
  }
}

/**
 * Aplica o reapply numa única campanha: suspend → PUT htmlContent (GET-verify)
 * → PUT scheduledAt (mesmo valor exato de antes) → GET final comparando
 * status/scheduledAt/subject/listas/totalSubscribers contra o estado
 * capturado ANTES do suspend.
 *
 * #4082 item 5 (modo de falha mais sério): qualquer erro entre o suspend
 * bem-sucedido e o reschedule bem-sucedido deixa a campanha PRESA em
 * "suspended" — o pior estado possível (sai da fila em silêncio, o envio
 * nunca dispara). Esse caminho SEMPRE emite `emitLoudBanner()` nomeando a
 * campanha e a ação de recuperação antes de relançar o erro. Divergências
 * detectadas DEPOIS do reschedule bem-sucedido (campanha já de volta na
 * fila, mas conteúdo/audiência/horário divergentes) também emitem banner,
 * com texto diferente (não é mais "presa suspensa").
 *
 * Retorna `null` se a campanha não estava mais queued/scheduled na
 * revalidação ao vivo (corrida — pulada, nada foi tocado).
 */
export async function applyReapply(
  apiKey: string,
  cycle: string,
  candidate: BrevoCampaignListItem,
  html: string,
): Promise<ApplyResult | null> {
  // #573: revalida AO VIVO imediatamente antes de tocar em qualquer coisa —
  // a lista de candidatos veio de uma chamada anterior e pode ter ficado
  // stale (corrida queued -> sent entre a descoberta e agora).
  const fresh = await fetchCampaignById(apiKey, candidate.id);
  if (!isSchedulableStatus(fresh.status)) {
    console.error(`⚠ #${candidate.id} não está mais queued/scheduled (agora "${fresh.status}") — pulando, nada foi tocado.`);
    return null;
  }
  if (!fresh.scheduledAt) {
    throw new Error(`Campanha #${candidate.id} sem scheduledAt — abortando antes de suspender (nada foi tocado).`);
  }

  const originalListIds = [...(fresh.recipients?.lists ?? [])];
  const expected: FinalStateExpectation = {
    scheduledAt: fresh.scheduledAt,
    subject: fresh.subject,
    listIds: originalListIds,
    totalSubscribers: await sumListSubscribers(apiKey, originalListIds),
  };

  // Finding 3 (#4142): audiência já anômala ANTES de qualquer PUT — falha alto
  // e não toca nada (nem suspende), em vez de deixar o suspend/reschedule
  // rodar sobre uma campanha com 0 destinatários.
  const beforeAnomaly = detectZeroAudienceAnomaly("antes", originalListIds, expected.totalSubscribers);
  if (beforeAnomaly) {
    throw new Error(`Campanha #${candidate.id}: ${beforeAnomaly} Abortando antes de suspender (nada foi tocado).`);
  }

  // Fase A (crítica): suspend -> update html -> reschedule. Qualquer falha
  // daqui pra baixo deixa a campanha PRESA em "suspended" — banner obrigatório.
  await setCampaignStatus(apiKey, candidate.id, "suspended");
  console.error(`✓ #${candidate.id} suspensa (era "${fresh.status}") — reaplicando html...`);

  try {
    await reapplyHtml(apiKey, candidate.id, html);

    const afterHtml = await fetchCampaignById(apiKey, candidate.id);
    if (afterHtml.htmlContent !== html) {
      throw new Error("GET-verify pós-PUT htmlContent: corpo não bate com o esperado.");
    }

    await brevoPut(apiKey, `/emailCampaigns/${candidate.id}`, { scheduledAt: expected.scheduledAt });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitLoudBanner({
      stage: `clarice-reapply-scheduled-html --cycle ${cycle}`,
      reason: `campanha #${candidate.id} (${candidate.name}) ficou SUSPENSA e NÃO foi reagendada: ${message}`,
      action:
        `AÇÃO IMEDIATA: abra a campanha #${candidate.id} na Brevo. Se o htmlContent estiver correto, ` +
        `reagende manualmente para ${expected.scheduledAt} (PUT /emailCampaigns/${candidate.id} ` +
        `{"scheduledAt":"${expected.scheduledAt}"} ou pela UI "Schedule"). Sem essa ação o envio NÃO VAI SAIR — ` +
        `a campanha fica presa em "suspended" indefinidamente.`,
    });
    // Finding 1 (#4142): erro distinto (não o `e` genérico) pra que
    // `runApplyBatch` consiga distinguir "presa suspensa" (abortar o lote)
    // de qualquer outra falha (ex: divergência pós-reschedule, Fase B).
    throw new StuckSuspendedCampaignError(candidate.id, message);
  }

  // Fase B: verificação pós-reschedule — a campanha JÁ voltou pra fila aqui;
  // divergências agora não são "presa suspensa", mas ainda são graves o
  // bastante pra falhar alto (#4082 item 4: totalSubscribers).
  const final = await fetchCampaignById(apiKey, candidate.id);
  const finalListIds = [...(final.recipients?.lists ?? [])];
  const totalAfter = await sumListSubscribers(apiKey, finalListIds);
  const problems = detectPostRescheduleDivergence(expected, {
    status: final.status,
    scheduledAt: final.scheduledAt,
    subject: final.subject,
    listIds: finalListIds,
    totalSubscribers: totalAfter,
  });

  if (problems.length > 0) {
    emitLoudBanner({
      stage: `clarice-reapply-scheduled-html --cycle ${cycle}`,
      reason: `campanha #${candidate.id} (${candidate.name}) foi reagendada mas o estado final diverge: ${problems.join(" | ")}`,
      action:
        `verifique a campanha #${candidate.id} na Brevo AGORA — o html foi trocado e ela está de volta na ` +
        `fila, mas ${problems.length === 1 ? "a divergência acima" : "as divergências acima"} pode(m) significar ` +
        `público/conteúdo/horário errado antes do disparo.`,
    });
    throw new Error(`Divergência pós-reschedule na campanha #${candidate.id}: ${problems.join(" | ")}`);
  }

  console.error(
    `✓ #${candidate.id} (${candidate.name}) reagendada: html reaplicado, scheduledAt=${final.scheduledAt} ` +
    `inalterado, ${totalAfter} destinatários (inalterado).`,
  );
  return {
    campaignId: candidate.id,
    finalScheduledAt: final.scheduledAt,
    totalSubscribersBefore: expected.totalSubscribers,
    totalSubscribersAfter: totalAfter,
  };
}

export interface BatchRunResult {
  /** Campanhas que passaram por `applyReapply` com sucesso. */
  succeeded: ApplyResult[];
  /** IDs de TODAS as campanhas que falharam (presas OU divergência pós-reschedule). */
  failedIds: number[];
  /** true se o lote foi interrompido por stuck-suspended (finding 1 #4142). */
  aborted: boolean;
  /** Campanhas do lote que NUNCA chegaram a ser tentadas por causa do abort. */
  notProcessed: BrevoCampaignListItem[];
}

/**
 * Roda `applyReapply` sequencialmente sobre `toUpdate`. Finding 1 (#4142):
 * na primeira campanha que fica PRESA em "suspended" (`StuckSuspendedCampaignError`),
 * aborta o lote inteiro em vez de seguir tentando as próximas — a atenção do
 * operador já foi consumida pelo banner de `applyReapply`, e continuar mexendo
 * noutras campanhas agendadas enquanto uma está presa multiplica o risco sem
 * supervisão. Emite um segundo banner nomeando quais campanhas NÃO chegaram a
 * ser processadas. Outras falhas (ex: divergência pós-reschedule na Fase B —
 * a campanha já está de volta na fila, não presa) NÃO abortam o lote, porque
 * não é o estado "sai da fila em silêncio" que motiva o abort.
 *
 * Extraído de `main()` pra ser testável sem depender do HTML em disco
 * (`html` já vem pronto como parâmetro).
 */
export async function runApplyBatch(
  apiKey: string,
  cycle: string,
  toUpdate: BrevoCampaignListItem[],
  html: string,
): Promise<BatchRunResult> {
  const succeeded: ApplyResult[] = [];
  const failedIds: number[] = [];
  for (let i = 0; i < toUpdate.length; i++) {
    const c = toUpdate[i];
    try {
      const result = await applyReapply(apiKey, cycle, c, html);
      if (result) succeeded.push(result);
    } catch (e) {
      failedIds.push(c.id);
      if (e instanceof StuckSuspendedCampaignError) {
        const notProcessed = toUpdate.slice(i + 1);
        if (notProcessed.length > 0) {
          emitLoudBanner({
            stage: `clarice-reapply-scheduled-html --cycle ${cycle}`,
            reason:
              `lote INTERROMPIDO: campanha #${c.id} ficou SUSPENSA (ver banner acima). ` +
              `${notProcessed.length} campanha(s) do lote NÃO foram processadas — nada foi tocado nelas.`,
            action:
              `resolva a campanha #${c.id} presa em "suspended" primeiro (ver ação no banner acima), ` +
              `depois rode o script de novo pras campanhas que faltam: ` +
              `#${notProcessed.map((x) => x.id).join(", #")}.`,
          });
        }
        return { succeeded, failedIds, aborted: true, notProcessed };
      }
      // Falha não-stuck (ex: divergência pós-reschedule) já emitiu seu
      // próprio banner em applyReapply — segue pras próximas campanhas.
    }
  }
  return { succeeded, failedIds, aborted: false, notProcessed: [] };
}

/** Parseia --apply (default false = dry-run). */
export function parseApplyArg(argv: string[]): boolean {
  return argv.includes("--apply");
}

/**
 * Parseia --campaign-id N (#4082 item 2) — quando presente, pula a
 * descoberta/matching por nome inteiramente. Lança se o valor não for um
 * inteiro positivo (nunca segue silenciosamente com um ID inválido).
 */
export function parseCampaignIdArg(argv: string[]): number | undefined {
  const raw = getArg(argv, "campaign-id");
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--campaign-id inválido: "${raw}" (esperado inteiro positivo).`);
  }
  return n;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const apply = parseApplyArg(argv);

  let campaignIdArg: number | undefined;
  try {
    campaignIdArg = parseCampaignIdArg(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }

  const htmlPath = resolve(resolveMonthlyDir(cycle), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");

  let toUpdate: BrevoCampaignListItem[];
  let skipped: BrevoCampaignListItem[];

  if (campaignIdArg !== undefined) {
    console.error(
      `\n📋 clarice-reapply-scheduled-html --cycle ${cycle} --campaign-id ${campaignIdArg} ` +
      `(descoberta por nome pulada — #4082)`,
    );
    const single = await fetchCampaignById(apiKey, campaignIdArg);
    const mismatchWarning = campaignCycleMismatchWarning(single, cycle);
    if (mismatchWarning) console.error(mismatchWarning);
    if (isSchedulableStatus(single.status)) {
      toUpdate = [single];
      skipped = [];
    } else {
      toUpdate = [];
      skipped = [single];
    }
  } else {
    console.error(
      `\n📋 clarice-reapply-scheduled-html --cycle ${cycle} ` +
      `(prefixos: ${cycleNamePrefixes(cycle).map((p) => `"${p}"`).join(", ")})`,
    );
    const all = await fetchQueuedCampaigns(apiKey);
    const matched = filterCycleCampaigns(all, cycle);
    ({ toUpdate, skipped } = partitionByQueuedStatus(matched));
  }

  for (const line of buildPlanLines(toUpdate, skipped)) console.error(`  ${line}`);

  if (!apply) {
    console.error(`\ndry-run (default) — use --apply para suspender/reaplicar/reagendar as campanhas acima.`);
    return;
  }

  if (toUpdate.length === 0) {
    console.error(`\nNenhuma campanha elegível encontrada — nada a fazer.`);
    return;
  }

  const { failedIds, aborted, notProcessed } = await runApplyBatch(apiKey, cycle, toUpdate, html);

  if (aborted) {
    console.error(
      `\n✗ lote abortado após stuck-suspended — ${notProcessed.length} campanha(s) NÃO processada(s): ` +
      `#${notProcessed.map((c) => c.id).join(", #")}.`,
    );
    process.exit(1);
  }

  if (failedIds.length > 0) {
    console.error(
      `\n✗ ${failedIds.length} campanha(s) com falha — ver banner(s) acima. IDs: #${failedIds.join(", #")}`,
    );
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
