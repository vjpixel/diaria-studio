/**
 * beehiiv-kit-reconcile.ts (#6269)
 *
 * Miolo PURO (sem I/O de rede) do guard de reconciliação Beehiiv×Kit —
 * pré-condição do switchover do #6114. O achado do #6269: as duas bases têm
 * a MESMA contagem de ativos (587 = 587), mas a interseção é menor (584) —
 * 3 e-mails só numa base, 3 só na outra. A divergência é SIMÉTRICA, então
 * qualquer verificação por CONTAGEM (a que qualquer um faria primeiro)
 * passa e o problema fica invisível. Este módulo compara os CONJUNTOS de
 * e-mail, nunca as contagens.
 *
 * O script CLI (`scripts/reconcile-beehiiv-kit.ts`) faz só o fetch paginado
 * das duas APIs e delega toda a lógica de comparação pra cá — é o que torna
 * este módulo testável sem rede (mesmo padrão de `apoios-diff-alarm.ts`,
 * `daily-carousel-card.ts` etc: I/O fino em `scripts/`, lógica em
 * `scripts/lib/`).
 *
 * ## Critério de saída — ASSIMÉTRICO de propósito (corpo da issue #6269)
 *
 * - `onlyInBeehiiv.length > 0` → **bloqueante** (exit != 0 no CLI). Ninguém
 *   que recebe hoje (ativo na Beehiiv) pode ficar de fora no Kit — é o
 *   invariante que o switchover do #6114 depende.
 * - `onlyInKit.length > 0` → **warning, não bloqueia**. Pode ser legítimo
 *   (alguém pediu pra sair da Beehiiv e ainda não saiu do Kit, ou o inverso
 *   de um fluxo de opt-out em andamento) — decisão editorial, não erro
 *   mecânico. Tratar como bloqueante faria o guard gritar por algo que às
 *   vezes é o comportamento correto.
 *
 * O SHA-256 de cada conjunto ORDENADO (não a lista bruta — ordem de chegada
 * da API não é estável) é o que torna a divergência simétrica DETECTÁVEL
 * sem depender de olhar a diferença item a item: dois conjuntos de mesmo
 * tamanho com conteúdo diferente produzem hashes diferentes mesmo quando a
 * contagem bate.
 */

import { createHash } from "node:crypto";

/** Pure: normaliza um e-mail pra comparação — trim + lowercase. Mesma regra
 *  usada em todo lugar do repo que compara e-mail entre Beehiiv/Kit/apoia.se
 *  (ex: `fetchCurrentBeehiivState`/`fetchCurrentKitState`). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pure: normaliza + deduplica uma lista de e-mails num Set. */
export function toNormalizedEmailSet(emails: readonly string[]): Set<string> {
  return new Set(emails.map(normalizeEmail).filter((e) => e.length > 0));
}

export interface NormalizationStats {
  /** Entradas normalizadas não-vazias que colapsaram em cima de outra já
   *  vista — duplicata de verdade (mesmo e-mail 2×). */
  duplicates: number;
  /** Entradas que normalizaram pra string vazia (whitespace/vazio) e foram
   *  descartadas — não é duplicata, é dado ausente/mal formado. Volume alto
   *  aqui é sinal de parsing quebrado do lado da API, não de gente
   *  cadastrada 2×. */
  emptyDiscarded: number;
}

/** Pure: separa, do total de entradas cruas menos o tamanho do set final
 *  (`raw.length - set.size`, o que antes o guard reportava como um único
 *  número "deduped"), quanto veio de duplicata real vs. entrada vazia
 *  descartada (#6269 finding — as duas causas eram conflacionadas num só
 *  contador, escondendo justamente o sinal de parsing quebrado). */
export function computeNormalizationStats(emails: readonly string[]): NormalizationStats {
  const seen = new Set<string>();
  let duplicates = 0;
  let emptyDiscarded = 0;
  for (const raw of emails) {
    const normalized = normalizeEmail(raw);
    if (normalized.length === 0) {
      emptyDiscarded++;
      continue;
    }
    if (seen.has(normalized)) duplicates++;
    else seen.add(normalized);
  }
  return { duplicates, emptyDiscarded };
}

/** Pure: SHA-256 hex de um conjunto de e-mails já normalizados — ORDENA
 *  antes de hashear (ordem de chegada da API não é estável, então hashear
 *  sem ordenar produziria hashes diferentes pro MESMO conjunto lógico entre
 *  duas rodadas). Junta com `\n` — separador que nunca aparece num e-mail
 *  válido, então não há ambiguidade de fronteira entre entradas. */
export function sha256OfSortedEmailSet(emails: Iterable<string>): string {
  const sorted = [...emails].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

export interface ReconcileEmailSetsResult {
  /** Total bruto informado por cada lado (após normalização+dedup — inclui
   *  qualquer duplicata já colapsada, ver `dedupedFrom*`). */
  beehiivTotal: number;
  kitTotal: number;
  /** Quantos e-mails de entrada foram colapsados por duplicata OU
   *  descartados por normalizar pra vazio — soma das duas causas em
   *  `NormalizationStats` (mantido para não quebrar consumidores do total;
   *  ver `beehiivStats`/`kitStats` pra causa discriminada). */
  dedupedFromBeehiiv: number;
  dedupedFromKit: number;
  /** Causa discriminada do descarte de cada lado (#6269 finding) —
   *  duplicata real vs. entrada vazia (sinal de parsing quebrado). */
  beehiivStats: NormalizationStats;
  kitStats: NormalizationStats;
  intersectionSize: number;
  /** Sorted — determinístico entre rodadas com o mesmo conjunto lógico. */
  onlyInBeehiiv: string[];
  onlyInKit: string[];
  /** SHA-256 do conjunto ORDENADO de cada lado — ver docstring do módulo. */
  beehiivHash: string;
  kitHash: string;
}

/**
 * Pure: compara os CONJUNTOS de e-mail ativo entre Beehiiv e Kit. Nunca
 * compara contagens — é exatamente a comparação que o achado do #6269 prova
 * insuficiente (587 == 587 com interseção 584).
 */
export function reconcileEmailSets(
  beehiivEmailsRaw: readonly string[],
  kitEmailsRaw: readonly string[],
): ReconcileEmailSetsResult {
  const beehiivSet = toNormalizedEmailSet(beehiivEmailsRaw);
  const kitSet = toNormalizedEmailSet(kitEmailsRaw);

  const onlyInBeehiiv: string[] = [];
  const onlyInKit: string[] = [];
  let intersectionSize = 0;

  for (const email of beehiivSet) {
    if (kitSet.has(email)) intersectionSize++;
    else onlyInBeehiiv.push(email);
  }
  for (const email of kitSet) {
    if (!beehiivSet.has(email)) onlyInKit.push(email);
  }
  onlyInBeehiiv.sort();
  onlyInKit.sort();

  const beehiivStats = computeNormalizationStats(beehiivEmailsRaw);
  const kitStats = computeNormalizationStats(kitEmailsRaw);

  return {
    beehiivTotal: beehiivSet.size,
    kitTotal: kitSet.size,
    dedupedFromBeehiiv: beehiivEmailsRaw.length - beehiivSet.size,
    dedupedFromKit: kitEmailsRaw.length - kitSet.size,
    beehiivStats,
    kitStats,
    intersectionSize,
    onlyInBeehiiv,
    onlyInKit,
    beehiivHash: sha256OfSortedEmailSet(beehiivSet),
    kitHash: sha256OfSortedEmailSet(kitSet),
  };
}

export interface GuardDecision {
  /** 0 = guard passa (switchover pode prosseguir); 1 = bloqueante. */
  exitCode: 0 | 1;
  /** true quando `onlyInBeehiiv.length > 0` — o invariante real (ver
   *  docstring do módulo). */
  blocking: boolean;
  /** true quando `onlyInKit.length > 0` — reportado, nunca bloqueia
   *  sozinho. */
  hasWarning: boolean;
}

/** Pure: decide o exit code do guard a partir do resultado da comparação —
 *  critério ASSIMÉTRICO (ver docstring do módulo). Só `onlyInBeehiiv`
 *  bloqueia; `onlyInKit` é warning. */
export function decideGuardExitCode(result: ReconcileEmailSetsResult): GuardDecision {
  const blocking = result.onlyInBeehiiv.length > 0;
  const hasWarning = result.onlyInKit.length > 0;
  return { exitCode: blocking ? 1 : 0, blocking, hasWarning };
}

/** Pure: mascara um e-mail pra saída que pode ir a stdout/log — mantém só o
 *  1º caractere do local-part + o domínio completo (ex: `joao@example.com`
 *  -> `j***@example.com`). Mesmo formato de `maskEmailForIssue` em
 *  `apoios-diff-alarm.ts` (não reimportado daqui de propósito: aquele
 *  módulo é do domínio apoio/Beehiiv-Kit-agnóstico só por acidente de onde
 *  nasceu; duplicar essa função de 3 linhas evita acoplar dois guards sem
 *  relação editorial entre si por um utilitário de string). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email.length > 0 ? `${email[0]}***` : "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Pure: versão de `ReconcileEmailSetsResult` segura pra `--json` — mesma
 * disciplina "sem PII crua no stdout" da issue (#6269), que a saída humana
 * já respeitava (`formatGuardReport`/`maskEmail`) mas `--json` não: antes
 * deste helper, o CLI serializava `onlyInBeehiiv`/`onlyInKit` com e-mail
 * cru, e esse é justamente o caminho de maior alcance — a saída `--json`
 * existe pra ser consumida por pipeline/log/CI (pré-condição do #6114),
 * não só lida por humano na hora. Reusa `maskEmail` — a MESMA máscara da
 * saída texto, nunca uma segunda implementação divergente. */
export interface ReconcileEmailSetsResultMasked
  extends Omit<ReconcileEmailSetsResult, "onlyInBeehiiv" | "onlyInKit"> {
  onlyInBeehiiv: string[];
  onlyInKit: string[];
}

/** Pure: mascara os e-mails de `onlyInBeehiiv`/`onlyInKit` — único uso
 *  pretendido é alimentar `JSON.stringify` no `--json` do CLI. Preserva a
 *  ordenação já garantida por `reconcileEmailSets`. */
export function maskResultForJson(result: ReconcileEmailSetsResult): ReconcileEmailSetsResultMasked {
  return {
    ...result,
    onlyInBeehiiv: result.onlyInBeehiiv.map(maskEmail),
    onlyInKit: result.onlyInKit.map(maskEmail),
  };
}

/**
 * Pure: monta o relatório humano (texto) do guard — contagens, interseção,
 * hashes, e-mails mascarados só-em-um-lado, e o veredito. Sem PII crua no
 * texto (e-mails sempre mascarados) — mesma disciplina do corpo da issue
 * ("Saída sem PII no stdout: contagens + e-mails mascarados").
 */
export function formatGuardReport(result: ReconcileEmailSetsResult, decision: GuardDecision): string {
  const lines: string[] = [];
  lines.push("[reconcile-beehiiv-kit] Reconciliação de conjuntos de e-mail ativo");
  lines.push(`  Beehiiv (ativos): ${result.beehiivTotal}`);
  lines.push(`  Kit (state=active): ${result.kitTotal}`);
  lines.push(`  interseção: ${result.intersectionSize}`);
  lines.push(`  só na Beehiiv: ${result.onlyInBeehiiv.length}`);
  lines.push(`  só no Kit: ${result.onlyInKit.length}`);
  lines.push(`  SHA-256 (Beehiiv, conjunto ordenado): ${result.beehiivHash}`);
  lines.push(`  SHA-256 (Kit, conjunto ordenado): ${result.kitHash}`);
  if (result.beehiivStats.duplicates > 0) {
    lines.push(`  aviso: ${result.beehiivStats.duplicates} duplicata(s) colapsada(s) do lado Beehiiv`);
  }
  if (result.beehiivStats.emptyDiscarded > 0) {
    lines.push(
      `  aviso: ${result.beehiivStats.emptyDiscarded} entrada(s) vazia(s) descartada(s) do lado Beehiiv — possível parsing quebrado`,
    );
  }
  if (result.kitStats.duplicates > 0) {
    lines.push(`  aviso: ${result.kitStats.duplicates} duplicata(s) colapsada(s) do lado Kit`);
  }
  if (result.kitStats.emptyDiscarded > 0) {
    lines.push(
      `  aviso: ${result.kitStats.emptyDiscarded} entrada(s) vazia(s) descartada(s) do lado Kit — possível parsing quebrado`,
    );
  }
  if (result.onlyInBeehiiv.length > 0) {
    lines.push(`  BLOQUEANTE — só na Beehiiv (${result.onlyInBeehiiv.length}):`);
    for (const e of result.onlyInBeehiiv) lines.push(`    - ${maskEmail(e)}`);
  }
  if (result.onlyInKit.length > 0) {
    lines.push(`  warning — só no Kit (${result.onlyInKit.length}), não bloqueia:`);
    for (const e of result.onlyInKit) lines.push(`    - ${maskEmail(e)}`);
  }
  lines.push(
    decision.blocking
      ? "  VEREDITO: DIVERGE (bloqueante) — switchover do #6114 NÃO deve prosseguir."
      : decision.hasWarning
        ? "  VEREDITO: OK (com warning só-no-Kit, não bloqueante) — switchover pode prosseguir."
        : "  VEREDITO: OK — conjuntos idênticos, switchover pode prosseguir.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// #7385 — guard "quem recebe × quem recebe" nas 3 plataformas
//
// O que existia até aqui (`reconcileEmailSets`/`decideGuardExitCode`/
// `formatGuardReport`) compara duas bases de ATIVOS ponto a ponto — o
// precondition do switchover #6114, que continua correto pro que se propõe
// a medir. O achado do #7385 é um problema DIFERENTE: comparar "ativos" em
// vez de "quem de fato recebe a edição" engana (medição de 03/09/2026: Kit
// tinha 629 ativos mas só 280 na tag `rampa-kit`, que é quem recebe; Beehiiv
// tinha 317 ativos e 314 destinatários reais do último post — os 349 que
// existem no Kit e fora da tag ficaram sem receber nada por 7 dias, #7357,
// sem nenhum guard acusando). As funções abaixo generalizam a comparação
// pra N fontes nomeadas (não só Beehiiv×Kit) e trocam "presença na base" por
// "presença na audiência de ENVIO" — o script `reconcile-send-audiences.ts`
// é quem alimenta com Kit=membros da tag `rampa-kit`, Beehiiv=ativos (ainda
// é audiência de envio real — todo ativo recebe o post principal, salvo o
// gap constante medido abaixo) e Brevo=contatos ativos da lista da campanha
// diária.
// ---------------------------------------------------------------------------

/** Uma fonte nomeada de e-mails — audiência de envio OU base de ativos,
 *  dependendo do que o caller está comparando (`reconcileSendAudiences` pra
 *  audiência, `findOrphans` recebe as duas separadamente). */
export interface EmailSource {
  name: string;
  emails: readonly string[];
}

export interface ReconcileSendAudiencesSourceSummary {
  name: string;
  total: number;
  hash: string;
}

/** 1 e-mail presente em ≥2 fontes de audiência de ENVIO simultaneamente —
 *  o invariante #4 da issue #7385 ("sobreposição"): hoje deveria ser
 *  sempre 0 (as 3 audiências são disjuntas por construção — Kit e Brevo
 *  cobrem quem a Beehiiv não alcança), e #7357/#7382 são precisamente os
 *  dois casos que ameaçam essa disjunção. */
export interface SendAudienceOverlapEntry {
  email: string;
  sources: string[];
}

export interface ReconcileSendAudiencesResult {
  sources: ReconcileSendAudiencesSourceSummary[];
  /** Total de e-mails distintos somando todas as fontes (união, não soma —
   *  um e-mail presente em 2 fontes conta 1×). */
  distinctTotal: number;
  /** Sorted por e-mail — determinístico entre rodadas com o mesmo conjunto. */
  overlaps: SendAudienceOverlapEntry[];
  overlapCount: number;
}

/**
 * Pure: reconcilia N fontes nomeadas de audiência de ENVIO — generaliza
 * `reconcileEmailSets` (que é Beehiiv×Kit, sempre 2 fontes, critério de
 * saída assimétrico) pro caso de 3+ plataformas com um critério simétrico:
 * qualquer sobreposição é reportada (o normal esperado é ZERO, não uma
 * direção que se tolera e outra que não — diferente do par histórico
 * Beehiiv×Kit, que tinha uma direção aditiva por design).
 */
export function reconcileSendAudiences(sources: readonly EmailSource[]): ReconcileSendAudiencesResult {
  const perSource = sources.map((s) => ({ name: s.name, set: toNormalizedEmailSet(s.emails) }));

  const membership = new Map<string, string[]>();
  for (const { name, set } of perSource) {
    for (const email of set) {
      const arr = membership.get(email);
      if (arr) arr.push(name);
      else membership.set(email, [name]);
    }
  }

  const overlaps: SendAudienceOverlapEntry[] = [];
  for (const [email, names] of membership) {
    if (names.length > 1) overlaps.push({ email, sources: [...names].sort() });
  }
  overlaps.sort((a, b) => a.email.localeCompare(b.email));

  return {
    sources: perSource.map(({ name, set }) => ({ name, total: set.size, hash: sha256OfSortedEmailSet(set) })),
    distinctTotal: membership.size,
    overlaps,
    overlapCount: overlaps.length,
  };
}

/** Mascara os e-mails de `overlaps` pra saída `--json` — mesma disciplina de
 *  `maskResultForJson` acima (sem PII crua no caminho de maior alcance). */
export function maskSendAudiencesResultForJson(
  result: ReconcileSendAudiencesResult,
): Omit<ReconcileSendAudiencesResult, "overlaps"> & { overlaps: SendAudienceOverlapEntry[] } {
  return {
    ...result,
    overlaps: result.overlaps.map((o) => ({ email: maskEmail(o.email), sources: o.sources })),
  };
}

export interface OrphanEntry {
  email: string;
  /** Em quais fontes de ATIVOS este e-mail aparece — nunca vazio (senão não
   *  seria órfão: um e-mail que não está ativo em plataforma nenhuma não é
   *  "ativo sem audiência", é simplesmente ausente). */
  activeIn: string[];
}

/**
 * Pure: e-mails ATIVOS em pelo menos 1 plataforma e AUSENTES de toda
 * audiência de envio — o invariante #3 da issue #7385 ("órfãos"). Hoje
 * seriam os 349 do achado (Kit ativos fora da tag `rampa-kit`, sem estar na
 * base ativa da Beehiiv nem na lista da campanha Brevo).
 *
 * `activeSources` e `sendAudienceSources` são propositalmente 2 listas
 * separadas — um e-mail pode estar ativo numa plataforma e a audiência de
 * envio ser a MESMA plataforma sob outro recorte (Kit ativo × Kit
 * `rampa-kit` é exatamente esse caso), então não dá pra assumir "a fonte de
 * ativos JÁ É a fonte de envio" — o caller decide o pareamento.
 */
export function findOrphans(
  activeSources: readonly EmailSource[],
  sendAudienceSources: readonly EmailSource[],
): OrphanEntry[] {
  const activeMembership = new Map<string, string[]>();
  for (const source of activeSources) {
    for (const email of toNormalizedEmailSet(source.emails)) {
      const arr = activeMembership.get(email);
      if (arr) arr.push(source.name);
      else activeMembership.set(email, [source.name]);
    }
  }

  const sendUnion = new Set<string>();
  for (const source of sendAudienceSources) {
    for (const email of toNormalizedEmailSet(source.emails)) sendUnion.add(email);
  }

  const orphans: OrphanEntry[] = [];
  for (const [email, activeIn] of activeMembership) {
    if (!sendUnion.has(email)) orphans.push({ email, activeIn: [...activeIn].sort() });
  }
  orphans.sort((a, b) => a.email.localeCompare(b.email));
  return orphans;
}

/** Mascara `email` de cada `OrphanEntry` — mesma disciplina de sempre. */
export function maskOrphansForJson(orphans: readonly OrphanEntry[]): OrphanEntry[] {
  return orphans.map((o) => ({ email: maskEmail(o.email), activeIn: o.activeIn }));
}

// ---------------------------------------------------------------------------
// Armadilha de medição #1 (#7385): a Beehiiv entrega uma quantidade
// CONSTANTE a menos do que tem de ativos — medido nos últimos 4 envios:
// 485/488, 463/466, 415/418, 314/317 (sempre ~3 a menos). Não é erro: são
// endereços `active` que a Beehiiv não entrega por razão própria (ver corpo
// da issue). Um guard que comparasse `recipients === activeCount` cru
// alarmaria TODO dia por causa deste gap normal — as duas constantes abaixo
// dão a tolerância.
// ---------------------------------------------------------------------------

/** Piso absoluto de tolerância — folga sobre o gap medido (~3) pra não
 *  alarmar por flutuação de 1-2 e-mails de edição pra edição. */
export const BEEHIIV_DELIVERY_GAP_TOLERANCE_ABS = 6;

/** Piso percentual de tolerância (1% dos ativos) — cresce com a base, pra
 *  quando a base for grande o bastante que 6 de folga absoluta fique
 *  apertado demais. O maior dos dois pisos vence (ver `checkBeehiivDeliveryGap`). */
export const BEEHIIV_DELIVERY_GAP_TOLERANCE_PCT = 0.01;

export interface DeliveryGapCheck {
  ok: boolean;
  /** `activeCount - recipientsCount`. `NaN` só quando a entrada é inválida
   *  (`ok: false` nesse caso, `reason` explica). */
  gap: number;
  tolerated: number;
  reason?: string;
}

/**
 * Pure: `true` (via `ok`) quando o gap entre ativos e destinatários reais da
 * Beehiiv está dentro da folga normal documentada acima — `false` quando o
 * gap é maior que o tolerado (investigar: entrega degradando de verdade) OU
 * quando `recipientsCount > activeCount` (inesperado — destinatário que não
 * está entre os ativos contados não devia existir).
 */
export function checkBeehiivDeliveryGap(activeCount: number, recipientsCount: number): DeliveryGapCheck {
  if (!Number.isInteger(activeCount) || activeCount < 0) {
    return { ok: false, gap: NaN, tolerated: NaN, reason: `activeCount inválido: ${String(activeCount)}.` };
  }
  if (!Number.isInteger(recipientsCount) || recipientsCount < 0) {
    return { ok: false, gap: NaN, tolerated: NaN, reason: `recipientsCount inválido: ${String(recipientsCount)}.` };
  }
  const tolerated = Math.max(BEEHIIV_DELIVERY_GAP_TOLERANCE_ABS, Math.ceil(activeCount * BEEHIIV_DELIVERY_GAP_TOLERANCE_PCT));
  const gap = activeCount - recipientsCount;
  if (gap < 0) {
    return {
      ok: false,
      gap,
      tolerated,
      reason: `destinatários reais (${recipientsCount}) > ativos contados (${activeCount}) — inesperado, investigar.`,
    };
  }
  if (gap > tolerated) {
    return {
      ok: false,
      gap,
      tolerated,
      reason: `gap de entrega (${gap}) excede a tolerância (${tolerated}) sobre ${activeCount} ativos — pode ser degradação real de entrega, não o gap normal (~3).`,
    };
  }
  return { ok: true, gap, tolerated };
}

// ---------------------------------------------------------------------------
// Armadilha de medição #2 (#7385): `GET /v3/emailCampaigns/{id}` da Brevo
// devolve `statistics.globalStats` ZERADO quando a chamada não pede
// `?statistics=globalStats` explicitamente — já documentado em
// `workers/brevo-dashboard/src/brevo-api.ts:2298-2302`. Sem o parâmetro, uma
// campanha `sent` de verdade parece "0 enviados", indistinguível de uma
// falha real de envio. As funções abaixo tornam esse estado DETECTÁVEL em
// vez de silenciosamente lido como zero — `brevoGetCampaignGlobalStats`
// (`scripts/lib/brevo-client.ts`) fecha o outro lado do problema (o
// parâmetro nunca fica de fora, é hardcoded na URL).
// ---------------------------------------------------------------------------

/** Subconjunto de `GET /v3/emailCampaigns/{id}?statistics=globalStats` que
 *  este guard consome — `statistics`/`statistics.globalStats` ausentes por
 *  completo (não `{}`, ausentes) é o sinal do #2298-2302: a API só omite o
 *  bloco inteiro quando o parâmetro não foi pedido, nunca devolve `{}` só
 *  porque uma campanha `sent` teve 0 envios de verdade. */
export interface BrevoCampaignStatsResponse {
  id: number;
  status: string;
  statistics?: { globalStats?: { sent?: number; delivered?: number; [k: string]: unknown } } | null;
}

/**
 * Pure: `true` quando a resposta indica que a chamada ESQUECEU
 * `?statistics=globalStats` — campanha com `status: "sent"` mas sem o bloco
 * `statistics.globalStats` nenhum. Uma campanha `sent` sempre carrega ALGUM
 * bloco de estatística quando o parâmetro é pedido (mesmo que os contadores
 * internos sejam 0) — bloco INTEIRO ausente é assinatura do parâmetro
 * faltando, não de "zero enviado real" (achado do corpo da issue, replicado
 * do docstring de `fetchRecentCampaigns` no Worker).
 */
export function looksLikeMissingGlobalStatsParam(response: BrevoCampaignStatsResponse): boolean {
  return response.status === "sent" && (response.statistics == null || response.statistics.globalStats == null);
}

export type BrevoRecipientsResolution =
  | { ok: true; sent: number }
  | { ok: false; reason: string };

/**
 * Pure: extrai `statistics.globalStats.sent` com o guard da armadilha #1
 * embutido — nunca devolve `0` quando o `0` é na verdade "não pedi
 * `?statistics=globalStats`". Caller trata `ok: false` como "não foi
 * possível medir", nunca como "zero destinatários reais".
 */
export function resolveBrevoCampaignRecipients(response: BrevoCampaignStatsResponse): BrevoRecipientsResolution {
  if (looksLikeMissingGlobalStatsParam(response)) {
    return {
      ok: false,
      reason:
        `campanha ${response.id} (status=sent) veio sem 'statistics.globalStats' — a chamada provavelmente ` +
        `esqueceu '?statistics=globalStats' (ver workers/brevo-dashboard/src/brevo-api.ts:2298-2302). ` +
        `Refetch com o parâmetro antes de ler 'sent'.`,
    };
  }
  const sent = response.statistics?.globalStats?.sent;
  if (typeof sent !== "number" || !Number.isFinite(sent)) {
    return {
      ok: false,
      reason: `campanha ${response.id}: 'statistics.globalStats.sent' ausente ou não-numérico (${String(sent)}).`,
    };
  }
  return { ok: true, sent };
}
