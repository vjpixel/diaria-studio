/**
 * clarice-segment.ts — segmentação de waves a partir do store único (#2647).
 *
 * Núcleo PURO da redesign "store-driven" do clarice-build-waves (decisão do
 * editor: swap total + re-segmentação por priority_points). Aqui só a lógica
 * testável; o cutover do pipeline de wave (build-waves/import-waves/schedule)
 * consome `segmentFromStore` e fatia em W1..Wn. NÃO vira o default de produção
 * até o store estar populado + Brevo-sincronizado e o editor validar num dry-run.
 *
 * Modelo (os 3 eixos da #2647):
 *   - `send_eligible = 0`  → CORTE (vai pra `excluded` com a razão).
 *   - re-envio (`sends_count > 0`) → ordenado por `priority_points` DESC
 *     (mais engajado primeiro; quem ignorou/decaiu, por último).
 *   - 1º envio (`sends_count = 0`) → ordenado por `cohort` (#2857 fase B —
 *     antes era `tier` ASC; `cohortSendRank` é um sucessor PROVADO equivalente
 *     pros 10 cohorts derivados de tier, ver test/cohorts.test.ts): assinante
 *     ativo primeiro, depois ex-assinante, depois leads por recência
 *     decrescente (safra mensal mais nova primeiro), depois caudão; cohort
 *     nulo/desconhecido por último. `tier` permanece no `StoreRow` como coluna
 *     LEGADO read-only (cutover da fase C — ingest novo não escreve mais
 *     `tier`; `tierRank` foi removida deste módulo, ver `cohort-order-dryrun.ts`
 *     pro oráculo independente que ainda a usa).
 *
 * Desempate estável por email ASC em todos os grupos → output determinístico
 * (reproduzível, pré-requisito do pipeline).
 */

// cohortDisplayLabel/cohortFromSafra/compareContactRecency/isKnownCohortSlug:
// cohorts.ts é dependency-free/Workers-safe como este módulo (sem import de
// volta pra cá) — importar daqui não introduz ciclo nem dependência de
// node:sqlite.
import {
  cohortDisplayLabel,
  cohortFromSafra,
  compareContactRecency,
  isKnownCohortSlug,
  isMvExemptCohort,
  INTERNAL_EMAILS,
  isTestAccount,
} from "./cohorts.ts";
// isJuridicoEmail: mesmo módulo dependency-free/Workers-safe usado por
// clarice-hold.ts — seguro importar aqui pelo mesmo motivo (ver docstring de
// clarice-sector.ts: "dá pra importar do worker sem arrastar node:fs/sqlite").
import { isJuridicoEmail } from "./clarice-sector.ts";

export interface StoreRow {
  email: string;
  // LEGADO read-only (#2857 fase C — cutover). Só populado em linhas antigas
  // (dupla-escrita da fase A até a fase C); ingest novo não escreve mais esta
  // coluna. Mantido no StoreRow porque ainda tem consumidores informativos
  // (rótulo "1º envio (T0X)" em clarice-build-waves-store.ts/describeWave,
  // coluna TIER de clarice-build-edition-sends.ts) — NENHUM deles usa `tier`
  // pra ordenar/segmentar (isso é `cohort`, ver abaixo). Vai ficando vazio
  // (`null`) pra contatos novos conforme o tempo passa.
  tier: number | null;
  // #2857 fase B: coluna do store (slug de cohort nomeado — ver
  // scripts/lib/cohorts.ts). Governa a ordenação de 1º envio (ver
  // `segmentFromStore` abaixo). Opcional (compat): consumidores que não
  // passam pelo store real (ex: scripts/lib/clarice-waves-dryrun.ts, que só
  // mede elegibilidade/supressão, não ordem) continuam válidos sem popular o
  // campo — `cohortSendRank(undefined)` degrada com segurança pro fim da fila
  // (mesmo destino de `null`/desconhecido).
  cohort?: string | null;
  priority_points: number;
  send_eligible: number; // 0 | 1
  ineligible_reason: string | null;
  sends_count: number;
  // #2885: campos usados pelos grupos de envio NOMEADOS (`segmentEngajados`/
  // `segmentReativacao`/`segmentRampWarm` abaixo) — opcionais pra não quebrar
  // os fixtures existentes de `segmentFromStore`/`priorityQueue` (que não os
  // usam). `loadStoreRows` já seleciona os 3 do store real.
  opens_count?: number;
  last_sent_at?: string | null;
  mv_bucket?: string | null;
  // #2994: JSON array (string) de list_ids Brevo que o contato pertence, tal
  // como sincronizado pelo Brevo sync (`brevo_list_ids` — coluna TEXT em
  // clarice-db.ts). Opcional (mesmo padrão de opens_count/last_sent_at/
  // mv_bucket acima) — fixtures que não populam este campo continuam válidos;
  // `excludeCommittedToQueuedCampaigns` trata ausência/parse-falho como "sem
  // list nenhuma" (não exclui por engano).
  brevo_list_ids?: string | null;
  // #4347: ISO date/datetime (Stripe `created`, já persistido na coluna
  // `created` desde a Etapa 1 — ver clarice-db.ts). Opcional (mesmo padrão dos
  // campos acima) — só o grupo nomeado `novos` (segmentNovos abaixo) depende
  // dele; fixtures que não populam o campo continuam válidas pros demais
  // grupos/segmentFromStore.
  created?: string | null;
  // #4688: timestamp (ISO, com offset da Brevo) da ÚLTIMA vez que
  // `clarice-sync-brevo.ts` de fato escreveu esta linha via upsert — `null`
  // SEMPRE que o contato nunca foi tocado por um sync Brevo (nunca recebeu
  // `UPDATE ... brevo_modified_at = ?`). Diferente de `opens_count`/
  // `sends_count` (colunas `INTEGER DEFAULT 0` — um contato NUNCA sincronizado
  // já nasce com `opens_count=0`, indistinguível de "sincronizado, mediu
  // zero"), esta coluna não tem DEFAULT: seu `null` é sempre genuíno. É por
  // isso o único sinal barato pra `hasMeasuredOpens` (abaixo) distinguir as
  // duas leituras de `opens_count === 0`. Opcional (mesmo padrão dos campos
  // acima) — fixtures que não populam o campo continuam válidas pros grupos
  // que não checam engajamento (`segmentFromStore`/`priorityQueue`/`ramp-warm`).
  brevo_modified_at?: string | null;
  // #4763: flag manual (`clarice-optin.ts`) — "pediu pra entrar na lista de
  // prioridade". Opcional (mesmo padrão dos campos acima) — só consumido pelo
  // snapshot de priority_points (`buildPrioritySnapshotCsv`,
  // clarice-build-segment.ts), nunca pelos predicados/ordem de segmentação
  // deste arquivo. `0 | 1 | null` — o schema real é `INTEGER DEFAULT 0`
  // (clarice-db.ts); fixtures que não populam continuam válidas.
  priority_optin?: number | null;
}

/**
 * #4688: `opens_count === 0` só prova "nunca abriu" se o contato JÁ foi
 * sincronizado com a Brevo pelo menos 1x — a coluna nasce em 0
 * (`INTEGER DEFAULT 0`) mesmo pra quem nunca teve `clarice-sync-brevo.ts`
 * rodando sobre ele (contato só-Stripe recém-ingerido, por exemplo). Sem essa
 * distinção, `isReativacao` colocaria na fila de reativação um contato cujo
 * engajamento real é simplesmente DESCONHECIDO — rotulado como "confirmado
 * não-abridor" sem nenhuma medição por trás.
 *
 * Root-cause relacionado (mesma issue, achado por probe ao vivo, #4688):
 * mesmo um contato JÁ sincronizado pode ter `opens_count` DEFASADO (subconta)
 * se abriu um e-mail sem que isso tocasse o `modifiedAt` do contato na Brevo
 * (confirmado: `modifiedAt` idêntico antes/depois de uma abertura nova) — o
 * `--incremental` (`modifiedSince`) nunca re-sincroniza esse contato. Este
 * helper NÃO resolve esse 2º problema (staleness pós-1º-sync é indetectável
 * sem reconsultar a Brevo ao vivo, contato a contato) — só fecha a lacuna
 * MAIS BARATA e determinística: nunca tratar "nunca sincronizado" como
 * "sincronizado, mediu zero".
 */
export function hasMeasuredOpens(
  r: Pick<StoreRow, "brevo_modified_at">,
): boolean {
  return r.brevo_modified_at != null;
}

export interface Segmentation {
  /** Com histórico de envio, por priority_points DESC (re-envio). */
  reSend: StoreRow[];
  /** Sem histórico, por tier ASC (1º envio); tier nulo por último. */
  firstSend: StoreRow[];
  /** send_eligible = 0 (cortados), com a razão. */
  excluded: Array<{ email: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Predicados de segmentação — fonte ÚNICA (#2782)
// ---------------------------------------------------------------------------
// `segmentFromStore` (ação: fila real de wave) e os relatórios SQL do dashboard
// (visão: clarice-db-summary.ts `by_tier`) precisam concordar sobre o que é
// "firstSend". Antes eram 2 implementações paralelas (JS aqui, SQL cru lá) que
// divergiam silenciosamente a cada mudança de regra (#2732/#2735). Agora ambos
// consomem estes predicados; `test/clarice-segment.test.ts` assegura a
// equivalência JS ⇄ SQL sobre um store real.

/** Elegível pra envio? Falsy (0 OU null nunca-recomputado) → corte fail-safe. */
export function isSendEligible(r: Pick<StoreRow, "send_eligible">): boolean {
  return Boolean(r.send_eligible);
}

/**
 * 1º envio: elegível E nunca recebeu email (sends_count 0, null, negativo ou NaN).
 *
 * `!(sends_count > 0)` (não `=== 0`, #2812 item 5): sends_count é
 * COUNT-derivado e nunca deveria ser negativo/NaN no schema atual (coluna
 * INTEGER), mas um valor patológico (dado corrompido / migração futura /
 * StoreRow construído fora do SQLite) tratado como "nunca enviado" é a
 * leitura mais segura — restaura a partição implícita pré-#2782, onde
 * qualquer valor que não fosse estritamente positivo caía no `else`
 * (firstSend) por não bater a condição de re-envio. Com `=== 0` estrito, um
 * sends_count negativo OU NaN caía silenciosamente em reSend (partição
 * errada, sem sinalizar o dado ruim). `!(x > 0)` cobre os dois: `NaN > 0` e
 * `-1 > 0` são ambos `false`, então a negação é `true` em ambos os casos —
 * equivalente a `<= 0` para números reais, mas também correto para NaN
 * (onde `NaN <= 0` seria `false`, o oposto do desejado).
 */
export function isFirstSend(
  r: Pick<StoreRow, "send_eligible" | "sends_count">,
): boolean {
  return isSendEligible(r) && !((r.sends_count ?? 0) > 0);
}

/**
 * Cláusula SQL equivalente a `isFirstSend` (pra agregar via SQL sem carregar o
 * store em JS). Espelhos: `send_eligible=1` ⇄ truthy (a coluna só assume 0|1|
 * NULL — schema em clarice-db.ts); `COALESCE(sends_count,0)<=0` ⇄
 * `!((?? 0) > 0)` — equivalentes para os valores reais que a coluna INTEGER
 * pode assumir (SQLite não representa NaN numa coluna INTEGER, então `<=0`
 * já cobre o mesmo universo que `!(x>0)` cobre em JS; #2812 item 5:
 * sincronizado com o guard de negativo/NaN de `isFirstSend`).
 * Mudou a regra? Mude AQUI e em `isFirstSend` juntos — o teste de equivalência
 * pega drift.
 *
 * #2812 item 4: colunas qualificadas com `clarice_users.` — hoje o único
 * consumidor (`scripts/clarice-db-summary.ts`) usa esta cláusula num
 * `FROM clarice_users WHERE ...` single-table (grep confirmado), então a
 * qualificação é redundante no uso atual, mas documenta a premissa e blinda
 * contra ambiguidade silenciosa se um JOIN futuro introduzir outra tabela
 * com colunas de mesmo nome (`send_eligible`/`sends_count`).
 */
export const FIRST_SEND_SQL_PREDICATE =
  "clarice_users.send_eligible=1 AND COALESCE(clarice_users.sends_count,0)<=0";

/**
 * Segmenta o universo do store nos 3 grupos. Puro e determinístico.
 * A ordem de cada lista É a ordem de prioridade de envio — o cutover fatia em
 * waves de cima pra baixo.
 */
export function segmentFromStore(rows: StoreRow[]): Segmentation {
  const reSend: StoreRow[] = [];
  const firstSend: StoreRow[] = [];
  const excluded: Array<{ email: string; reason: string }> = [];

  for (const r of rows) {
    // #2895: defesa em profundidade — mesmo que uma conta de teste do editor
    // (vjpixel+test*@gmail.com) escape os guards de ingestão (ingestStripe/
    // ingestMv/makeBrevoUpsert em clarice-build-db.ts/clarice-db.ts) e chegue
    // até aqui, corta da fila de envio ANTES de checar elegibilidade —
    // checado primeiro pra nunca aparecer em firstSend/reSend por engano.
    if (isTestAccount(r.email)) {
      excluded.push({ email: r.email, reason: "test_account" });
      continue;
    }
    // Fail-safe: send_eligible falsy (0 OU null de uma linha nunca recomputada)
    // → CORTE. Na dúvida NÃO enviar é a direção segura pro pipeline de envio.
    if (!isSendEligible(r)) {
      excluded.push({ email: r.email, reason: r.ineligible_reason ?? "unknown" });
    } else if (isFirstSend(r)) {
      firstSend.push(r);
    } else {
      reSend.push(r);
    }
  }

  reSend.sort(
    (a, b) =>
      (b.priority_points ?? 0) - (a.priority_points ?? 0) ||
      a.email.localeCompare(b.email),
  );
  // #2857 fase B: cohortSendRank (não mais tierRank) governava a ordem de
  // BUCKET do 1º envio — sucessor PROVADO equivalente pros 10 cohorts
  // derivados de tier (test/cohorts.test.ts, propriedade testada).
  // #5169 (revisão 260812): `compareContactRecency` (cohorts.ts) sucede o
  // sort inline daqui — recência REAL de cadastro (`created`) é o critério,
  // cohort/bucket não entra na comparação (nem pra decidir bucket, nem pra
  // dar prioridade estrutural a assinantes-ativos/ex-assinantes/juridico) —
  // pedido explícito do editor, "independente do cohort". `cohortSendRank`
  // só volta como fallback quando NENHUM dos dois lados tem `created`
  // confiável.
  firstSend.sort(compareContactRecency);

  return { reSend, firstSend, excluded };
}

/**
 * Fila de prioridade de ENVIO a partir da segmentação (#2656 cutover). Ordem de
 * warm-up: re-envio ENGAJADO primeiro (priority_points > 0, mais alto antes),
 * depois 1º envio por tier (T01 ativo → leads), e por último o re-envio
 * DECAÍDO (quem ignorou — priority_points ≤ 0). Assim quem prova engajamento
 * encabeça a fila, contatos novos entram no meio, e re-tentar quem ignora fica
 * por último. Determinístico (reSend/firstSend já vêm ordenados de segmentFromStore).
 */
export function priorityQueue(seg: Segmentation): StoreRow[] {
  // `?? 0`: priority_points pode ser null (coluna sem NOT NULL / linha pré-recompute).
  // Sem o coalesce, `null > 0` e `null <= 0` são AMBOS false → a linha sumiria da
  // fila (perda silenciosa). null → 0 → cai em decaído.
  const engagedReSend = seg.reSend.filter((r) => (r.priority_points ?? 0) > 0);
  const decayedReSend = seg.reSend.filter((r) => (r.priority_points ?? 0) <= 0);
  return [...engagedReSend, ...seg.firstSend, ...decayedReSend];
}

/**
 * Fatia uma lista já ordenada em waves de no máximo `maxSize` (conveniência do
 * cutover). Preserva a ordem; a última wave pode ser menor. `maxSize <= 0` → 1
 * wave com tudo.
 */
export function sliceIntoWaves<T>(ordered: T[], maxSize: number): T[][] {
  if (maxSize <= 0) return ordered.length ? [ordered.slice()] : [];
  const out: T[][] = [];
  for (let i = 0; i < ordered.length; i += maxSize) {
    out.push(ordered.slice(i, i + maxSize));
  }
  return out;
}

/**
 * Lê as linhas relevantes pra segmentação do store SQLite. Inclui
 * `opens_count`/`last_sent_at`/`mv_bucket` (#2885) e `created`/`brevo_list_ids`
 * (#4347) — usados pelos grupos de envio NOMEADOS (`NAMED_GROUPS` — hoje
 * `segmentEngajados`/`segmentReativacao`/`segmentRampWarm`/`segmentNovos`),
 * não só pela rampa (`segmentFromStore`/`priorityQueue`, que ignoram esses
 * campos extras sem quebrar).
 */
export function loadStoreRows(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): StoreRow[] {
  return db
    .prepare(
      `SELECT email, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count,
              opens_count, last_sent_at, mv_bucket, brevo_list_ids, created
         FROM clarice_users`,
    )
    .all() as StoreRow[];
}

/**
 * Parseia `brevo_list_ids` (JSON array serializado na coluna TEXT) num array
 * de string de list_ids. Tolerante: ausente/vazio/JSON inválido/não-array →
 * `[]` (nunca lança) — trata dado corrompido como "sem membership conhecida"
 * em vez de derrubar o pipeline de seleção inteiro por um valor ruim.
 */
export function parseBrevoListIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v));
  } catch {
    return [];
  }
}

/**
 * #2994 (P0): exclui da seleção contatos que pertencem a alguma lista Brevo
 * com campanha AGENDADA (`queued`/`scheduled`) mas ainda NÃO enviada.
 *
 * Contexto do bug: o corte de segurança existente (`sends_count=0` via
 * `isFirstSend`/`isRampWarm`) só sabe distinguir "já recebeu" de "nunca
 * recebeu" — um contato cujo envio já foi AGENDADO (mas ainda não disparado)
 * continua com `sends_count=0` (só incrementa depois do envio de fato), então
 * a seleção atual o trataria como "fresh" e o selecionaria de novo pro
 * PRÓXIMO envio agendado antes do primeiro sair. Corrigir depois exigiria
 * cancelar a campanha via API/painel e recriar (#4935) — não é gratuito, e
 * sem este guard esse duplicado só seria descoberto tarde demais.
 *
 * `queuedListIds` vem de uma consulta FRESCA à Brevo (`GET /v3/emailCampaigns
 * ?status=queued` → `recipients.lists` de cada campanha) — ver
 * `fetchQueuedCampaignListIds` (scripts/lib/brevo-client.ts). Aqui só a parte
 * PURA/testável: cruza `brevo_list_ids` de cada linha contra o Set de listas
 * comprometidas — a função é agnóstica a QUAL status alimentou o Set.
 *
 * #3682: os callers de PRIMEIRO ENVIO passam a UNIÃO de `queued` + `sent`
 * (`fetchCommittedCampaignListIds`, brevo-client.ts) — `sends_count=0` local
 * não distingue "nunca recebeu" de "recebeu, mas o sync incremental do store
 * ainda não propagou" (lag observado ~1 dia no incidente 260716-260721). Para
 * esses grupos, passar só `queued` cobriria só a metade AGENDADA do problema.
 *
 * 260731: isso vale para 1º envio, NÃO para todos os callers. Os grupos de
 * RE-envio (`engajados`, `reativacao`) passam deliberadamente só `queued` — ali
 * "já recebeu" é pré-requisito de entrada, não impedimento, e incluir `sent`
 * zerava os dois grupos por construção. Não é regressão do #3682: é o mesmo
 * raciocínio aplicado a um predicado de sinal oposto. Ver `CommittedGuardScope`
 * mais abaixo, que é quem decide o escopo por grupo.
 *
 * Não distingue send_eligible/isFirstSend — é uma camada adicional aplicada
 * SOBRE o resultado de `segmentRampWarm`/`segmentFromStore`/etc, não um
 * substituto. Puro, testável sem rede.
 */
export function excludeCommittedToQueuedCampaigns<T extends Pick<StoreRow, "brevo_list_ids">>(
  rows: T[],
  // Nome mantido por compat (#2994). O Set pode conter só `queued` OU
  // `queued ∪ sent`, conforme o `guardScope` do grupo que chamou.
  queuedListIds: ReadonlySet<string>,
): T[] {
  if (queuedListIds.size === 0) return rows.slice();
  return rows.filter((r) => {
    const lists = parseBrevoListIds(r.brevo_list_ids);
    return !lists.some((id) => queuedListIds.has(id));
  });
}

// ---------------------------------------------------------------------------
// Grupos de envio NOMEADOS (#2885) — predicado + ordem sobre o store, cada um
// re-derivado FRESCO a partir de `loadStoreRows` no momento do build (nunca um
// CSV congelado). Complementam a rampa (`segmentFromStore`/`priorityQueue` —
// o grupo "crescer alcance") com grupos por OBJETIVO: retenção (`engajados`),
// re-ativação (`reativacao`), 1º-envio-seguro (`ramp-warm`). Cada grupo é uma
// função pura `(rows: StoreRow[]) => StoreRow[]` já FILTRADA + ORDENADA —
// `scripts/clarice-build-segment.ts` só corta pelo `--budget` e serializa.
//
// Desempate estável por email ASC em todos os grupos (mesmo padrão de
// `segmentFromStore`) → output determinístico.
// ---------------------------------------------------------------------------

const INTERNAL_EMAILS_LOWER = new Set(INTERNAL_EMAILS.map((e) => e.toLowerCase()));

/**
 * `email` pertence à lista de internos (#2809 — editor/parceiro Clarice)?
 * NÃO usada por `isEngajados`/`isReativacao` desde #4434 (decisão do editor:
 * interno não é mais excluído da fila de envio) — a exclusão de exibição que
 * resta (`cohort_stats`/médias) vive num caminho SEPARADO e não chama esta
 * função: `NOT_INTERNAL_SQL` em `scripts/clarice-db-summary.ts` monta a
 * cláusula SQL direto a partir de `INTERNAL_EMAILS` (a lista, não este
 * predicado) porque roda como filtro de query, não em memória sobre um
 * `StoreRow` já carregado. Mantida exportada (testada em `test/clarice-
 * segment.test.ts`) como utilidade Workers-safe caso um consumidor em
 * memória precise do mesmo predicado no futuro.
 */
export function isInternalEmail(email: string): boolean {
  return INTERNAL_EMAILS_LOWER.has(email.trim().toLowerCase());
}

/**
 * `engajados` (retenção): elegível, com histórico de envio, e engajado
 * (priority_points > 0 — mesmo eixo de `priorityQueue`). NÃO exclui internos
 * (#4434 — decisão do editor 260801, opção (a): `INTERNAL_EMAILS` passou a
 * significar só "fora das agregações de exibição", nunca "fora do envio").
 * A exclusão anterior (#2809) deixava um interno com histórico de envio
 * (`sends_count > 0`) inalcançável por qualquer grupo nomeado — `ramp-warm`
 * exige `sends_count = 0` e não o alcança — sumindo da fila pra sempre; caso
 * real: `felipe@clarice.ai`, top 0,04% da base por `priority_points`, nunca
 * recebia. Ver `isInternalEmail` acima pra onde a exclusão de exibição
 * realmente vive hoje. Exclui contas de teste do editor (#2895/#2920) —
 * mesmo guard de defesa em profundidade que `segmentFromStore` já aplica;
 * sem ele, um `vjpixel+test*@gmail.com` ainda presente no store (até o
 * próximo rebuild purgar, ver #2911) entraria aqui como assinante real caso
 * satisfaça as demais condições.
 */
export function isEngajados(
  r: Pick<StoreRow, "email" | "send_eligible" | "sends_count" | "priority_points">,
): boolean {
  return (
    isSendEligible(r) &&
    (r.sends_count ?? 0) > 0 &&
    (r.priority_points ?? 0) > 0 &&
    !isTestAccount(r.email)
  );
}

/** Ordem de `engajados`: priority_points DESC, email ASC desempata. */
export function segmentEngajados(rows: StoreRow[]): StoreRow[] {
  return rows
    .filter(isEngajados)
    .slice()
    .sort(
      (a, b) =>
        (b.priority_points ?? 0) - (a.priority_points ?? 0) || a.email.localeCompare(b.email),
    );
}

/**
 * `reativacao`: elegível, com histórico de envio, mas NUNCA abriu
 * (opens_count = 0 — o não-abridor puro, distinto do "decaído" de
 * `priorityQueue` que só olha priority_points ≤ 0, que também inclui quem
 * abriu pouco). NÃO exclui internos (#4434 — mesma decisão/motivo de
 * `isEngajados` acima). Exclui contas de teste do editor (#2895/#2920 —
 * mesmo motivo de `isEngajados`).
 *
 * #4688: exige `hasMeasuredOpens` — sem isso, um contato NUNCA sincronizado
 * pela Brevo (`opens_count=0` só pelo `DEFAULT 0` do schema, nunca medido de
 * fato) entraria como "confirmado não-abridor" por acidente de dado, não por
 * comportamento real. Fail-safe pro lado conservador: fica de fora de
 * `reativacao` até o sync rodar sobre ele pelo menos 1x.
 */
export function isReativacao(
  r: Pick<
    StoreRow,
    "email" | "send_eligible" | "sends_count" | "opens_count" | "brevo_modified_at"
  >,
): boolean {
  return (
    isSendEligible(r) &&
    (r.sends_count ?? 0) > 0 &&
    (r.opens_count ?? 0) === 0 &&
    hasMeasuredOpens(r) &&
    !isTestAccount(r.email)
  );
}

/**
 * Ordem de `reativacao`: last_sent_at DESC (não-abridores mais RECENTES
 * primeiro — reativar quem sumiu há pouco tempo é mais provável que reativar
 * quem nunca abriu em anos). `last_sent_at` ausente/inválido vai pro fim
 * (-Infinity — nunca "fura" a fila de propósito, mesmo padrão fail-safe dos
 * demais ranks deste módulo). Email ASC desempata.
 */
export function segmentReativacao(rows: StoreRow[]): StoreRow[] {
  const ms = (v: string | null | undefined): number => {
    if (!v) return -Infinity;
    const t = Date.parse(v);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return rows
    .filter(isReativacao)
    .slice()
    .sort((a, b) => {
      const ta = ms(a.last_sent_at);
      const tb = ms(b.last_sent_at);
      if (ta !== tb) return tb - ta;
      return a.email.localeCompare(b.email);
    });
}

/**
 * `ramp-warm` (1º envio seguro): reusa `isFirstSend` (elegível + nunca
 * enviado) restrito a `mv_bucket='verified'` — só quem já passou pelo
 * MillionVerifier com resultado limpo (não confunde com `catch_all`/ausente).
 * NÃO exclui internos (não pedido pela #2885 — ao contrário de
 * `engajados`/`reativacao`, este grupo é sobre segurança de 1º contato, não
 * sobre métrica de retenção/reativação). MAS exclui contas de teste do editor
 * (#2895/#2920) — diferente de internos (audiência real mantida no store por
 * decisão do editor), `vjpixel+test*@gmail.com` nunca deveria ser destinatário
 * de envio nenhum, gated ou não; mesmo guard de defesa em profundidade que
 * `segmentFromStore`/`isEngajados`/`isReativacao` já aplicam.
 *
 * #3826: cohort MV-ISENTO (`isMvExemptCohort` — hoje só `assinantes-ativos`,
 * cohorts.ts) DISPENSA `mv_bucket='verified'`. Sem isso, um pagante recém-
 * importado (send_eligible=1 garantido por #3819, sends_count=0, sem
 * mv_bucket porque nunca é submetido ao MV — é isento) nunca satisfazia
 * `mv_bucket==='verified'` e ficava fora dos 3 grupos nomeados: não tem
 * `sends_count>0` pra entrar em `engajados`/`reativacao`, e não tinha
 * verificação MV pra entrar em `ramp-warm` — chicken-and-egg, ponto cego
 * total (achado 260721, 45 assinantes ativos de julho, 0 alcançáveis por
 * qualquer segmento). Mesmo racional de #3819: pagamento Stripe já valida o
 * e-mail, MV é redundante pra esse cohort. Não reimplementa a lista de
 * cohorts isentos — reusa `isMvExemptCohort` (fonte única compartilhada com
 * `classifyEligibility` em clarice-db.ts e `verify-emails-mv.ts`).
 *
 * Ordenação (histórico #3826, superado pelo #5169 revisão 260812):
 * `segmentRampWarm` já ordenava por `cohortSendRank`, que atribuía
 * `assinantes-ativos` ao rank 0 fixo (sempre mais quente da fila) — não
 * precisou de mudança pra atender "cohort assinantes-ativos rank 0" pedido
 * então. Isso NÃO é mais verdade: `compareContactRecency` (cohorts.ts,
 * #5169) ordena por `created` real pra qualquer contato, cohort estrutural
 * incluso — um `assinantes-ativos` antigo agora fica atrás de um lead mais
 * recente. `cohortSendRank` só volta a decidir no fallback (nenhum dos dois
 * lados com `created` confiável).
 *
 * #5410: `cutoffNovosIso` (opcional) exclui quem está DENTRO da janela
 * `novos` (`created >= cutoffNovosIso`) — o corte complementar de `isNovos`
 * abaixo, que faz os dois predicados PARTICIONAREM a fila de 1º envio em vez
 * de se conterem (antes, `isRampWarm` não tinha corte nenhum por `created` e
 * era superconjunto estrito de `isNovos` — a separação real dependia só de
 * ORDEM DE EXECUÇÃO, e um `novos` que abortava — semáforo vermelho, #5405 —
 * deixava a onda de rampa engolir em silêncio os cadastros represados).
 * `cutoffNovosIso` vem SEMPRE do mesmo lugar que `isNovos` usa —
 * `readNovosCutoff` (clarice-novos-cutoff.ts), persistido por
 * `clarice-novos-run.ts` — nunca um valor calculado ad-hoc aqui, pra não
 * reabrir a divergência entre os dois lados que a issue #5410 corrigiu.
 * Ausente/`created` inválido/ausente → sem exclusão (fail-safe: na dúvida,
 * o comportamento é o pré-#5410 — nunca pior que o estado anterior).
 * **Decisão do editor (#5410, 16/08/2026): separação ABSOLUTA, sem regra de
 * envelhecimento** — não há teto de dias que faça um contato "expirar" da
 * janela `novos` e cair aqui; o represamento é visível via o alarme do
 * #5405, não por um corte temporal nesta função.
 */
export function isRampWarm(
  r: Pick<StoreRow, "email" | "send_eligible" | "sends_count" | "mv_bucket" | "cohort" | "created">,
  cutoffNovosIso?: string | null,
): boolean {
  if (!isFirstSend(r)) return false;
  if (cutoffNovosIso) {
    const cutoffMs = Date.parse(cutoffNovosIso);
    const createdMs = r.created ? Date.parse(r.created) : NaN;
    if (!Number.isNaN(cutoffMs) && !Number.isNaN(createdMs) && createdMs >= cutoffMs) {
      // Dentro da janela `novos` — espera o `novos`, nunca cai na rampa (#5410).
      return false;
    }
  }
  return (r.mv_bucket === "verified" || isMvExemptCohort(r.cohort)) && !isTestAccount(r.email);
}

/**
 * Ordem de `ramp-warm`: `compareContactRecency` (cohorts.ts, #5169) —
 * recência real de cadastro (`created` DESC), cohort não entra na
 * comparação (nem bucket, nem prioridade estrutural pra assinantes-ativos/
 * ex-assinantes/juridico).
 *
 * `opts.cutoffNovosIso` (#5410) — ver docstring de `isRampWarm` acima.
 */
export function segmentRampWarm(rows: StoreRow[], opts?: { cutoffNovosIso?: string | null }): StoreRow[] {
  return rows
    .filter((r) => isRampWarm(r, opts?.cutoffNovosIso))
    .slice()
    .sort(compareContactRecency);
}

/**
 * `novos` (#4347 — cadastro novo, laço Stripe→MV→envio imediato): reusa
 * `isFirstSend` (elegível + nunca enviado) restrito a `created >= sinceIso` E
 * `mv_bucket='verified' OU cohort MV-isento (#3826)` — mesmo racional de
 * `isRampWarm`, com o corte temporal extra que distingue "cadastro recente"
 * da base fria inteira que `ramp-warm` cobre. `mv_bucket='unknown'` fica de
 * fora (D9, decisão do editor #4347 — sem flag de opt-in, mesmo padrão de
 * `isRampWarm`). Exclui contas de teste do editor (#2895/#2920), mesmo guard
 * de defesa em profundidade dos demais grupos.
 *
 * `sinceIso` é comparado via epoch (Date.parse), não string — robusto a
 * `created` vir como ISO datetime completo e `sinceIso` como data pura
 * (`YYYY-MM-DD`, meia-noite UTC implícita). `created` ausente/inválido nunca
 * satisfaz (fail-safe: sem data de cadastro conhecida, não é "novo").
 */
export function isNovos(
  r: Pick<StoreRow, "email" | "send_eligible" | "sends_count" | "created" | "mv_bucket" | "cohort">,
  sinceIso: string,
): boolean {
  if (!isFirstSend(r)) return false;
  const createdMs = r.created ? Date.parse(r.created) : NaN;
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(createdMs) || Number.isNaN(sinceMs) || createdMs < sinceMs) return false;
  return (r.mv_bucket === "verified" || isMvExemptCohort(r.cohort)) && !isTestAccount(r.email);
}

/**
 * Ordem de `novos`: `compareContactRecency` (cohorts.ts, #5169) — recência
 * real de cadastro, cohort não entra na comparação. Mesmo comparador de
 * `segmentRampWarm` — antes do #5169 este grupo já tinha `created` como
 * desempate dentro do mesmo cohort (o único dos 4 grupos que já tinha essa
 * disciplina, por causa da janela `sinceIso`); `compareContactRecency`
 * generaliza e estende a mesma regra pros outros grupos de 1º envio.
 */
export function segmentNovos(rows: StoreRow[], opts: { sinceIso: string }): StoreRow[] {
  return rows
    .filter((r) => isNovos(r, opts.sinceIso))
    .slice()
    .sort(compareContactRecency);
}

/**
 * Uma violação de monotonicidade de recência (#5169): um contato mais ANTIGO
 * entrou na onda enquanto um contato mais NOVO — ainda elegível, mas fora
 * dela — deveria ter entrado primeiro.
 */
export interface RecencyMonotonicityViolation {
  selectedEmail: string;
  selectedCohort: string | null;
  selectedCreated: string | null;
  /** O contato mais NOVO ainda elegível e de fora que "deveria ter entrado primeiro". */
  excludedEmail: string;
  excludedCohort: string | null;
  excludedCreated: string | null;
}

/**
 * Guard (#5169, pedido explícito do editor): confirma que `selected` (a onda
 * que vai subir pra Brevo) respeita a monotonicidade de recência real —
 * `compareContactRecency` — antes do upload. Não reimplementa a regra de
 * prioridade: usa o MESMO comparador que `segmentRampWarm`/`segmentNovos`/
 * `firstSend.sort` já usam pra ordenar, só verifica que a seleção de fato
 * respeitou o corte de topo dessa ordem.
 *
 * Pura/determinística, NUNCA lança sozinha (pedido explícito da issue) —
 * devolve a lista de violações encontradas; quem chama decide se bloqueia
 * (mesmo padrão de `checkRoundSizeCap`, clarice-build-segment.ts: função pura
 * retorna o veredito, o CLI decide o `process.exit`).
 *
 * Implementação: acha o contato mais QUENTE (`compareContactRecency`) entre
 * `stillEligibleElsewhere` — se algum `selected` for mais FRIO que esse, é
 * uma violação (um contato mais novo ficou de fora enquanto um mais antigo
 * entrou). Pareia cada violação com ESSE contato mais quente de fora (a
 * evidência mais forte de "deveria ter entrado primeiro"), não com todo par
 * possível — mantém a saída legível mesmo com filas de dezenas de milhares
 * de contatos.
 *
 * `selected`/`stillEligibleElsewhere` vazios → `[]` (nada a comparar).
 */
export function assertRecencySelectionMonotonic(
  selected: readonly Pick<StoreRow, "email" | "cohort" | "created">[],
  stillEligibleElsewhere: readonly Pick<StoreRow, "email" | "cohort" | "created">[],
): RecencyMonotonicityViolation[] {
  if (selected.length === 0 || stillEligibleElsewhere.length === 0) return [];

  let warmestExcluded = stillEligibleElsewhere[0];
  for (const row of stillEligibleElsewhere) {
    if (compareContactRecency(row, warmestExcluded) < 0) warmestExcluded = row;
  }

  const violations: RecencyMonotonicityViolation[] = [];
  for (const row of selected) {
    if (compareContactRecency(row, warmestExcluded) > 0) {
      violations.push({
        selectedEmail: row.email,
        selectedCohort: row.cohort ?? null,
        selectedCreated: row.created ?? null,
        excludedEmail: warmestExcluded.email,
        excludedCohort: warmestExcluded.cohort ?? null,
        excludedCreated: warmestExcluded.created ?? null,
      });
    }
  }
  return violations;
}

/** Registro dos grupos nomeados — fonte única pro CLI (`clarice-build-segment.ts`)
 *  validar `--group` e despachar pro predicado certo. */
export type NamedGroupKey = "engajados" | "reativacao" | "ramp-warm" | "novos";

/** Contexto extra que um predicado de grupo pode precisar — `novos`
 *  (`sinceIso`, obrigatório pra esse grupo) e `ramp-warm` (`cutoffNovosIso`,
 *  opcional — #5410, ver `isRampWarm`). `engajados`/`reativacao` ignoram `ctx`. */
export interface NamedGroupContext {
  sinceIso?: string;
  cutoffNovosIso?: string | null;
}

/**
 * Que conjunto de listas Brevo o guard de campanha comprometida deve excluir
 * neste grupo (#4347 Etapa 2c, corrigido em 260731).
 *
 *   "committed" — queued ∪ sent. Correto pros grupos de PRIMEIRO envio
 *                 (`ramp-warm`, `novos`): ali "já está numa lista que recebeu
 *                 campanha" é exatamente a condição que desqualifica, e
 *                 `sends_count` local não serve porque o sync do Brevo é
 *                 1×/dia (até 24h de defasagem).
 *   "queued"    — só campanhas AGENDADAS e ainda não disparadas. É o correto
 *                 pros grupos de RE-ENVIO (`engajados`, `reativacao`): eles
 *                 existem justamente pra alcançar de novo quem já recebeu, com
 *                 conteúdo novo. Usar "committed" aqui zera o grupo por
 *                 CONSTRUÇÃO — todo engajado, por definição do predicado
 *                 (`sends_count > 0`), está em alguma lista com campanha
 *                 `sent`. Medido em 260731: 15.123 de 15.123 engajados
 *                 excluídos, 0 deles por campanha agendada. A proteção real
 *                 que o guard oferece a estes grupos (não duplicar um envio já
 *                 AGENDADO — corrigir depois exigiria cancelar/recriar via
 *                 API/painel, #4935, não é gratuito) é preservada — só a parte
 *                 `sent`, que aqui não descreve risco nenhum, sai.
 */
export type CommittedGuardScope = "committed" | "queued";

export interface NamedGroupDef {
  key: NamedGroupKey;
  /** Rótulo curto (vira `desc` no manifest, mesma convenção de `describeWave`). */
  label: string;
  segment: (rows: StoreRow[], ctx?: NamedGroupContext) => StoreRow[];
  /** Ver `CommittedGuardScope` — 1º envio exclui queued∪sent; re-envio, só queued. */
  guardScope: CommittedGuardScope;
}

export const NAMED_GROUPS: Record<NamedGroupKey, NamedGroupDef> = {
  engajados: {
    key: "engajados",
    label: "Engajados (retenção)",
    segment: (rows) => segmentEngajados(rows),
    guardScope: "queued",
  },
  reativacao: {
    key: "reativacao",
    label: "Reativação",
    segment: (rows) => segmentReativacao(rows),
    guardScope: "queued",
  },
  "ramp-warm": {
    key: "ramp-warm",
    label: "Ramp warm (1º envio seguro)",
    // #5410: ctx?.cutoffNovosIso — sempre `readNovosCutoff()` no call site
    // (clarice-build-segment.ts), nunca recalculado aqui.
    segment: (rows, ctx) => segmentRampWarm(rows, { cutoffNovosIso: ctx?.cutoffNovosIso }),
    guardScope: "committed",
  },
  novos: {
    key: "novos",
    label: "Novos (cadastro recente)",
    segment: (rows, ctx) => {
      if (!ctx?.sinceIso) {
        throw new Error(
          "grupo 'novos' requer sinceIso (via --since) — ver scripts/clarice-build-segment.ts.",
        );
      }
      return segmentNovos(rows, { sinceIso: ctx.sinceIso });
    },
    guardScope: "committed",
  },
};

/** `key` é um grupo nomeado reconhecido? (type guard pro CLI validar `--group`). */
export function isNamedGroupKey(key: string): key is NamedGroupKey {
  return Object.prototype.hasOwnProperty.call(NAMED_GROUPS, key);
}

// ---------------------------------------------------------------------------
// Fila única do envio diário (#7406) — substitui a escolha de grupo
// `engajados`/`ramp-warm` por UMA fila ordenada por `priority_points DESC`.
// Decisão do editor (04/09/2026): "não faz mais sentido ter grupos
// diferentes... a gente pode trabalhar tudo só a partir do score." O
// agendamento das 20:15 (`Diaria-Clarice-Envio-Engajados`, #6945) nunca
// deveria ter existido como automação separada — era engano, não decisão de
// produto (ver corpo da #7406).
//
// Não é um `SELECT * ORDER BY priority_points DESC` cru: o `guardScope`
// diferente por eixo (medido em #7236, ver `CommittedGuardScope` acima)
// continua necessário — usar o guard errado ZERA quem já recebeu (todo
// contato com `sends_count>0` está em alguma lista `sent`) ou perde a
// proteção contra o lag de sync do Brevo pra quem nunca recebeu. A diferença
// vira um detalhe de implementação POR CONTATO (não por grupo escolhido pelo
// editor): `sends_count>0` → guard `queued`; `sends_count=0` → guard
// `committed` (`queued ∪ sent`). Editor nunca escolhe/vê isso — só a fila
// única, ordenada por score.
// ---------------------------------------------------------------------------

/**
 * Elegível pra fila única do envio diário? Une os dois predicados que hoje
 * são `isEngajados`/`isRampWarm` (`clarice-segment.ts`):
 *
 *   - `sends_count > 0` (já recebeu): mesma condição de `isEngajados` —
 *     `priority_points > 0`. Quem já recebeu e decaiu pra score ≤ 0 fica de
 *     fora (mesmo comportamento de hoje — território de `reativacao`, fora
 *     de escopo desta unificação).
 *   - `sends_count = 0` (nunca recebeu): mesma condição de `isRampWarm` —
 *     `mv_bucket='verified'` OU cohort MV-isento, excluindo quem está dentro
 *     da janela `novos` (`cutoffNovosIso`, #5410 — esse público continua
 *     servido pelo pipeline `/diaria-clarice-novos` separado, não pela fila
 *     diária).
 *
 * `isSendEligible` + exclusão de conta de teste do editor valem pros dois
 * ramos (mesmo guard de defesa em profundidade dos predicados originais).
 */
/** Já recebeu envio antes? Eixo único que decide qual metade de
 *  `isDailyQueueEligible`/`buildDailySendQueue` se aplica a uma linha —
 *  extraído pra não deixar as duas checagens divergirem por edição futura. */
function hasSendHistory(r: Pick<StoreRow, "sends_count">): boolean {
  return (r.sends_count ?? 0) > 0;
}

export function isDailyQueueEligible(
  r: Pick<
    StoreRow,
    "email" | "send_eligible" | "sends_count" | "priority_points" | "mv_bucket" | "cohort" | "created"
  >,
  cutoffNovosIso?: string | null,
): boolean {
  if (!isSendEligible(r) || isTestAccount(r.email)) return false;
  if (hasSendHistory(r)) return (r.priority_points ?? 0) > 0;
  return isRampWarm(r, cutoffNovosIso);
}

/**
 * Ordem da fila única: `priority_points DESC`, sem nenhuma lógica de corte
 * por tier — a decisão do editor registrada na #7236 ("engajados tem
 * prioridade TOTAL sobre ramp-warm até esgotar a fila ou o budget do dia")
 * fica sendo consequência do SORT, não uma regra à parte.
 *
 * **Não é garantido que `priority_points` de quem nunca recebeu seja sempre
 * 0** (achado do review da PR #7408): a flag manual `priority_optin`
 * (`clarice-optin.ts`, `computePriorityPoints` em `clarice-db.ts`) soma +40
 * independente de `sends_count` — um contato nunca-enviado mas opt-in entra
 * na fila ACIMA de engajados com score < 40. Isso é **esperado, não bug**:
 * é exatamente o propósito do opt-in ("pediu pra entrar na lista de
 * prioridade") e é consistente com "trabalha tudo só a partir do score"
 * (decisão do editor, #7406) — o opt-in não distingue 1º envio de re-envio
 * de propósito, então esta fila também não deveria. No design ANTERIOR isso
 * era inofensivo (`segmentRampWarm` ignora `priority_points`, ordena só por
 * recência); aqui vira visível porque a fila única de fato lê o campo pros
 * dois lados — documentado, não corrigido, porque o comportamento em si
 * está certo (`test/clarice-segment.test.ts` cobre o caso).
 *
 * Desempate PRESERVA o comportamento de cada grupo original (não introduz
 * ordenação nova): `priority_points > 0` (ex-engajados) desempata por email
 * ASC, igual `segmentEngajados`; `priority_points = 0` (ex-ramp-warm)
 * desempata por `compareContactRecency` (cadastro mais recente primeiro),
 * igual `segmentRampWarm`.
 */
export function compareDailyQueueOrder(
  a: Pick<StoreRow, "email" | "priority_points" | "created" | "cohort">,
  b: Pick<StoreRow, "email" | "priority_points" | "created" | "cohort">,
): number {
  const pa = a.priority_points ?? 0;
  const pb = b.priority_points ?? 0;
  if (pa !== pb) return pb - pa;
  if (pa > 0) return a.email.localeCompare(b.email);
  return compareContactRecency(a, b);
}

/**
 * Fila única do envio diário (#7406): filtra por `isDailyQueueEligible` e
 * ordena por `compareDailyQueueOrder`. Substitui a escolha entre
 * `segmentEngajados`/`segmentRampWarm` — quem chama não escolhe grupo, só
 * fornece as duas listas de guard (uma por eixo, ver cabeçalho da seção
 * acima) e recebe UMA fila pronta.
 *
 * Puro, testável sem rede — os Sets de guard vêm de `fetchQueuedCampaignListIds`/
 * `fetchCommittedCampaignListIds` (brevo-client.ts) no call site.
 */
export function buildDailySendQueue<
  T extends Pick<
    StoreRow,
    | "email"
    | "send_eligible"
    | "sends_count"
    | "priority_points"
    | "mv_bucket"
    | "cohort"
    | "created"
    | "brevo_list_ids"
  >,
>(
  rows: T[],
  guards: { queuedListIds: ReadonlySet<string>; committedListIds: ReadonlySet<string> },
  cutoffNovosIso?: string | null,
): T[] {
  return rows
    .filter((r) => isDailyQueueEligible(r, cutoffNovosIso))
    .filter((r) => {
      const scope = hasSendHistory(r) ? guards.queuedListIds : guards.committedListIds;
      if (scope.size === 0) return true;
      const lists = parseBrevoListIds(r.brevo_list_ids);
      return !lists.some((id) => scope.has(id));
    })
    .sort(compareDailyQueueOrder);
}

// ---------------------------------------------------------------------------
// cohort (#2817) — safra mensal derivada de `created` (Stripe), dimensão
// independente do `tier` numérico (que continua governando SÓ a ordenação de
// 1º envio). Pedido do editor 260702: "coloque todos os contatos de junho no
// tier junho e os de maio no maio" — modelado como coluna nova em vez de
// tiers nomeados (ver decisão registrada na issue #2817).
//
// Funções puras aqui (não em clarice-db.ts, que importa `node:sqlite` — o
// worker `brevo-dashboard` importa deste arquivo diretamente, igual `tierRank`,
// porque o runtime do Worker não tem `node:sqlite`).
// ---------------------------------------------------------------------------

/** Primeiro mês com safra rotulada (decisão do editor, #2817). Anterior → NULL. */
const COHORT_EPOCH_YEAR = 2026;
const COHORT_EPOCH_MONTH = 5; // maio (1-indexed)

/**
 * Deriva a safra mensal ('YYYY-MM', forma canônica) a partir de `created`
 * (ISO date/datetime da Stripe). NULL se `created` ausente/inválido ou
 * anterior a 2026-05 (dado histórico sem safra rotulada). Extensível: qualquer
 * mês >= 2026-05 vira 'YYYY-MM' sem precisar de mudança de código (não há
 * lista hardcoded de meses futuros).
 */
export function deriveCohort(created: string | null | undefined): string | null {
  if (!created) return null;
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  if (year < COHORT_EPOCH_YEAR || (year === COHORT_EPOCH_YEAR && month < COHORT_EPOCH_MONTH)) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Deriva o slug de cohort de LEAD (já com prefixo `leads-`) a partir do
 * PERÍODO REAL de `created` — #2857 fase B.1, correção pós dry-run no store
 * real (achado: o mapa estático `TIER_TO_COHORT` herdava rótulo de período do
 * tiering DESLIZANTE do momento do merge, que desalinha do `created` real a
 * cada virada de semestre — ex: bucket 'leads-2025h2' continha `created`
 * jan-abr/2026). Esta função é a fonte PRIMÁRIA do cohort de qualquer lead
 * (tier != 1/2) com `created` presente — nunca o rótulo estático herdado do
 * tier (`TIER_TO_COHORT`, que vira fallback só pra `created` ausente/inválido,
 * ver `computeCohort` em `clarice-db.ts`):
 *
 *   - `created >= epoch da safra (2026-05)` → safra mensal ('leads-YYYY-MM',
 *     via `deriveCohort` + `cohortFromSafra`).
 *   - `created` válido mas ANTERIOR ao epoch → semestre REAL do created
 *     ('leads-YYYYh1' jan-jun / 'leads-YYYYh2' jul-dez) — QUALQUER ano, sem
 *     lista hardcoda (`cohortSendRank` em cohorts.ts também parseia
 *     'leads-YYYYhN' genericamente, mesmo padrão).
 *   - `created` ausente/inválido → `null` (quem chama decide o fallback).
 *
 * Consequência direta: o range especial 'leads-2026-jan-abr'
 * (`TIER_TO_COHORT[3]`, nome herdado do corte parcial do export no momento do
 * freeze da fase A) NUNCA é emitido por esta função — `created` 2026-01..04
 * vira 'leads-2026h1' (semestre real), não o range. O slug antigo continua
 * aceito em `isKnownCohortSlug`/`cohortDisplayLabel`/`resolveCohortArg`
 * (legado-lido — dado KV/CSV pré-fase-B.1, ou o fallback de tier em casos
 * raros de `created` ausente) — só não é mais EMITIDO por esta derivação.
 */
export function deriveLeadCohort(created: string | null | undefined): string | null {
  const safra = deriveCohort(created);
  if (safra) return cohortFromSafra(safra);
  if (!created) return null;
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const half = d.getUTCMonth() + 1 <= 6 ? 1 : 2;
  return `leads-${year}h${half}`;
}

const PT_MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/**
 * Rótulo de exibição pro dashboard. #2857 fase A: a coluna `cohort` do store
 * passou a guardar o slug da taxonomia unificada (`assinantes-ativos`,
 * `leads-2026-06`, `leads-2025h2`, `leads-caudao`...) em vez de só a safra
 * crua 'YYYY-MM' (#2817) — delega pra `cohortDisplayLabel` (scripts/lib/
 * cohorts.ts), que cobre todos os slugs da taxonomia. Mantido aqui (thin
 * wrapper, mesma assinatura) porque é o símbolo que os callers existentes
 * (`workers/brevo-dashboard`) importam — trocar o import em todo consumidor
 * não é escopo da fase A.
 */
export function cohortLabel(cohort: string | null): string {
  return cohortDisplayLabel(cohort);
}

/**
 * Resolve o valor de `--cohort` passado na CLI pro valor exato armazenado na
 * coluna `cohort`. Formas aceitas, nesta ordem de tentativa:
 *   1. forma canônica de safra "YYYY-MM" → `cohortFromSafra`.
 *   2. rótulo pt-BR do mês ("junho") → resolvido pro ano-epoch (2026).
 *   3. slug canônico da taxonomia já resolvido ("assinantes-ativos",
 *      "leads-2025h2", "leads-2026-06", ...) → devolvido como está
 *      (`isKnownCohortSlug`), depois de rejeitar as 2 formas acima.
 * Rótulo pt-BR (forma 2) só é reconhecido pra o ano corrente da epoch (2026 —
 * único ano com safras rotuladas até agora); pra outro ano, use a forma
 * canônica direto ("2027-01"). Lança se o input não bater com NENHUMA das 3
 * formas — preferível a um filtro silenciosamente vazio.
 *
 * #2857 fase C (cutover): o alias de tier LEGADO ("t04"/"T4", introduzido na
 * fase B como ponte de migração) foi REMOVIDO — `tier` não é mais um
 * identificador aceito em `--cohort`, use o slug nomeado diretamente.
 *
 * #2857 fase A: a coluna `cohort` guarda o slug `leads-YYYY-MM` (não mais a
 * safra crua) — o retorno das formas 1/2 passa pelo mesmo `cohortFromSafra`
 * que `recomputeDerived` usa pra popular a coluna, então o resultado sempre
 * bate com o valor armazenado (`resolveCohortArg('junho')` → `'leads-2026-06'`).
 * Assinatura preservada (string → string) — nenhum caller precisa mudar.
 */
export function resolveCohortArg(input: string): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return cohortFromSafra(trimmed);
  const idx = PT_MONTH_NAMES.indexOf(trimmed.toLowerCase());
  if (idx !== -1) {
    return cohortFromSafra(`${COHORT_EPOCH_YEAR}-${String(idx + 1).padStart(2, "0")}`);
  }
  if (isKnownCohortSlug(trimmed)) return trimmed;
  throw new Error(
    `--cohort "${input}" não reconhecido — use um rótulo pt-BR (ex: junho), ` +
      `a forma canônica YYYY-MM (ex: ${COHORT_EPOCH_YEAR}-06) ou um slug da ` +
      `taxonomia (ex: assinantes-ativos, leads-2025h2).`,
  );
}

// ---------------------------------------------------------------------------
// Waterfall multi-tier (#4979) — composição declarativa de múltiplos
// predicados com budget COMPARTILHADO, waterfall (cada tier consome o que
// sobrar do budget na ordem declarada). Generaliza o script one-off
// `clarice-build-wave-260812-especial.ts` (nunca commitado — decisão do
// editor #4979, "vira feature — implementar") pra uma composição orientada a
// DADO (JSON, via `--tiers` em `clarice-build-segment.ts`) em vez de um `.ts`
// novo por onda custom. Os 6 tiers daquele one-off (jurídico; não-jurídico
// engajado; 3 cohorts score=0; 1 cohort score=0 ordenado por `created` DESC)
// são todos expressáveis com os eixos abaixo — nenhum eixo novo foi inventado
// além do que aquele caso concreto precisou.
//
// Reusa os MESMOS guards que os NAMED_GROUPS já passam (dedup por ciclo,
// recência automática, campanha comprometida, `--hold`) — a composição de
// tiers entra SOBRE o universo já guardado (mesmo ponto de entrada de
// `buildSegmentArtifact`, ver `clarice-build-segment.ts`), nunca os
// substitui ou bypassa. Este módulo só sabe filtrar+ordenar+cortar por
// budget — puro, sem I/O, mesmo padrão do resto do arquivo.
// ---------------------------------------------------------------------------

/** Filtro de score dentro de um tier: "positive" = priority_points>0; "zero" = ===0. Omitido = qualquer valor. */
export type WaterfallScoreFilter = "positive" | "zero";

/** Ordem dentro de um tier. Default (omitido): priority_points DESC. Email ASC sempre desempata. */
export type WaterfallOrderBy = "priority_points_desc" | "created_desc";

export interface WaterfallTierSpec {
  /** Rótulo do tier — só para relatório/auditoria (`tier_stats` no summary), não participa do predicado. */
  name: string;
  /** true = só jurídico (isJuridicoEmail); false = exclui jurídico; omitido = ambos. */
  juridico?: boolean;
  /** Restringe à coluna `cohort` (igualdade exata). Omitido = qualquer cohort. */
  cohort?: string;
  /** Filtro por priority_points. Omitido = qualquer valor. */
  score?: WaterfallScoreFilter;
  /** Ordem do tier. Default: priority_points_desc. */
  orderBy?: WaterfallOrderBy;
}

/** `r` casa com os eixos declarados de `spec`? Eixos omitidos sempre casam (predicado permissivo por omissão). */
export function matchesWaterfallTier(
  r: Pick<StoreRow, "email" | "cohort" | "priority_points">,
  spec: Pick<WaterfallTierSpec, "juridico" | "cohort" | "score">,
): boolean {
  if (spec.juridico === true && !isJuridicoEmail(r.email)) return false;
  if (spec.juridico === false && isJuridicoEmail(r.email)) return false;
  if (spec.cohort !== undefined && (r.cohort ?? null) !== spec.cohort) return false;
  if (spec.score === "positive" && !((r.priority_points ?? 0) > 0)) return false;
  if (spec.score === "zero" && (r.priority_points ?? 0) !== 0) return false;
  return true;
}

/**
 * Ordena um tier já filtrado. `orderBy` default (omitido): priority_points
 * DESC — mesmo eixo default de `segmentEngajados`/`priorityQueue`. Email ASC
 * desempata sempre (mesmo padrão determinístico do resto do módulo).
 */
export function orderWaterfallTier<T extends Pick<StoreRow, "email" | "priority_points" | "created">>(
  rows: T[],
  orderBy?: WaterfallOrderBy,
): T[] {
  const sorted = rows.slice();
  if (orderBy === "created_desc") {
    sorted.sort((a, b) => {
      const ta = a.created ? Date.parse(a.created) : -Infinity;
      const tb = b.created ? Date.parse(b.created) : -Infinity;
      if (ta !== tb) return tb - ta;
      return a.email.localeCompare(b.email);
    });
    return sorted;
  }
  sorted.sort(
    (a, b) => (b.priority_points ?? 0) - (a.priority_points ?? 0) || a.email.localeCompare(b.email),
  );
  return sorted;
}

export interface WaterfallTierStat {
  name: string;
  /** Quantos casaram o predicado do tier, ANTES do corte de budget. */
  available: number;
  /** Quantos o waterfall de fato tomou deste tier (≤ available, sujeito ao budget restante). */
  taken: number;
}

export interface WaterfallResult<T> {
  selected: T[];
  tierStats: WaterfallTierStat[];
  /** budget pedido (0 = sem teto — cada tier entra inteiro). */
  budget: number;
  totalSelected: number;
}

/**
 * Waterfall multi-tier: aplica cada `WaterfallTierSpec`, NA ORDEM declarada,
 * sobre `rows` (já pós-guards) — cada tier consome o que sobrar do `budget`
 * COMPARTILHADO (mesmo mecanismo do one-off #4979: tier 1 pega o que precisar
 * primeiro, tier 2 pega do resto, etc., até o budget zerar ou os tiers
 * acabarem). `budget<=0` = sem teto (cada tier entra inteiro, nenhum corte).
 * Um contato já selecionado por um tier anterior NUNCA é contado 2× num tier
 * seguinte (guard defensivo — tiers bem desenhados são disjuntos por
 * construção via `cohort`/`juridico`/`score`, mas overlap acidental não
 * deveria inflar a contagem nem duplicar a linha no CSV de saída).
 */
export function buildWaterfallSelection<T extends StoreRow>(
  rows: T[],
  tiers: WaterfallTierSpec[],
  budget: number,
): WaterfallResult<T> {
  let remaining = budget > 0 ? budget : Infinity;
  const selected: T[] = [];
  const seen = new Set<string>();
  const tierStats: WaterfallTierStat[] = [];

  for (const spec of tiers) {
    const matched = rows.filter((r) => matchesWaterfallTier(r, spec));
    const ordered = orderWaterfallTier(matched, spec.orderBy);
    const take = Number.isFinite(remaining) ? Math.max(0, Math.min(ordered.length, remaining)) : ordered.length;
    let taken = 0;
    for (const r of ordered) {
      if (taken >= take) break;
      const key = r.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(r);
      taken++;
    }
    if (Number.isFinite(remaining)) remaining -= taken;
    tierStats.push({ name: spec.name, available: ordered.length, taken });
  }

  return { selected, tierStats, budget, totalSelected: selected.length };
}

/**
 * Valida a forma de um plano de tiers cru (JSON parseado, tipo `unknown` —
 * vem de `--tiers <arquivo.json>` em `clarice-build-segment.ts`) e devolve
 * `WaterfallTierSpec[]` tipado. Lança com mensagem específica no primeiro
 * problema encontrado — nunca degrada um tier malformado em silêncio (mesma
 * disciplina de `parseHoldArg`/`resolveCohortArg` neste módulo).
 */
export function validateWaterfallTiers(tiers: unknown): WaterfallTierSpec[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error("plano de tiers vazio ou 'tiers' não é um array — ver formato esperado em --tiers.");
  }
  const seenNames = new Set<string>();
  const out: WaterfallTierSpec[] = [];
  for (const [i, raw] of tiers.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`tier[${i}] não é um objeto.`);
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name.trim() === "") {
      throw new Error(`tier[${i}] sem 'name' (string não-vazia obrigatória).`);
    }
    if (seenNames.has(t.name)) {
      throw new Error(`tier '${t.name}' duplicado — nomes de tier devem ser únicos.`);
    }
    seenNames.add(t.name);
    if (t.juridico !== undefined && typeof t.juridico !== "boolean") {
      throw new Error(`tier '${t.name}': 'juridico' deve ser boolean.`);
    }
    if (t.cohort !== undefined && typeof t.cohort !== "string") {
      throw new Error(`tier '${t.name}': 'cohort' deve ser string.`);
    }
    if (t.score !== undefined && t.score !== "positive" && t.score !== "zero") {
      throw new Error(`tier '${t.name}': 'score' deve ser "positive" ou "zero".`);
    }
    if (t.orderBy !== undefined && t.orderBy !== "priority_points_desc" && t.orderBy !== "created_desc") {
      throw new Error(`tier '${t.name}': 'orderBy' deve ser "priority_points_desc" ou "created_desc".`);
    }
    out.push({
      name: t.name,
      juridico: t.juridico as boolean | undefined,
      cohort: t.cohort as string | undefined,
      score: t.score as WaterfallScoreFilter | undefined,
      orderBy: t.orderBy as WaterfallOrderBy | undefined,
    });
  }
  return out;
}
