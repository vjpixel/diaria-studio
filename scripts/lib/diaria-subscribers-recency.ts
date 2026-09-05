/**
 * diaria-subscribers-recency.ts (#7163 fatia 13 — #7208)
 *
 * Recência de engajamento — `last_sent`/`last_delivered`/`last_opened`/
 * `last_clicked` e `sends_since_last_open`/`sends_since_last_click` — por
 * (subscriber × plataforma) e CROSS-plataforma, computada por SQL sobre
 * `event` (`diaria-subscribers-db.ts`), usando os índices já existentes
 * (`idx_event_subscriber_ts`, `idx_event_platform_ts`, `idx_event_type`).
 *
 * ## Decisão herdada da issue: SEM tabela derivada, sem mudança de schema
 *
 * Mesma disciplina do resto do módulo (`event` nunca ganha coluna de
 * derivada — ver docstring de `diaria-subscribers-db.ts`, "A decisão de
 * modelagem que não pode ser diluída"). Na escala atual (~1.400
 * subscribers, ~83k eventos), `MAX(ts)`/`COUNT(DISTINCT edicao)` sobre os
 * índices existentes não têm caso de performance que justifique
 * materializar — se isso mudar, é hora de medir de novo, não de assumir.
 *
 * ## Contaminação 1 — subscribers SINTÉTICOS ficam em quarentena
 *
 * `isSyntheticSubscriberEmail` reconhece os padrões de identidade NÃO-humana
 * já documentados em outros pontos do projeto:
 *
 *   - `@web.eia.diaria.local` — a identidade anônima que o Worker `poll`
 *     cria pra quem vota no "É IA?" sem se identificar (ver docstring de
 *     `contest-poll-ingest.ts`, "Identidade anônima do voto"). `ingestPollVotes`
 *     hoje NUNCA chama `ensureSubscriber` pra esse padrão (o voto anônimo é
 *     contado em `skippedAnonymous`, nunca vira `subscriber`), então — medido
 *     ao vivo nesta sessão (04-05/09/2026), 0 linhas do store batem este
 *     padrão. A checagem aqui é DEFENSIVA, não reage a um problema
 *     observado: cobre uma reingestão futura de dado histórico anterior a
 *     essa decisão, ou uma regressão no ingestor que volte a chamar
 *     `ensureSubscriber` pra voto anônimo.
 *   - `@vote.eia.diaria.local` — o pseudo-email de token de voto
 *     (`shared/poll-token.ts`, `VOTE_TOKEN_DOMAIN`) que o merge tag da
 *     newsletter usa pra montar o link de voto; nunca deveria aparecer como
 *     email de identidade real, mas por segurança entra na mesma lista.
 *   - sufixo de domínio `.local`, e os domínios reservados por RFC 2606
 *     pra teste (`example.com`/`.org`/`.net`) — nenhum provedor de e-mail
 *     real usa essas raízes.
 *   - local-part no formato `{prefixo}-{epoch-ms}[-rand]` (`collab-`,
 *     `regular-`, `test-`, `e2e-`, `qa-`) — o MESMO padrão que
 *     `merge-clarice-subscribers.ts` (`SYNTHETIC_E2E_LOCAL_PART`) já usa
 *     pra identificar endereço gerado por suíte E2E, independente de
 *     domínio (um domínio catch-all legítimo aceitaria qualquer local
 *     part). Repetido aqui (não importado de lá) porque os dois módulos
 *     nunca se importam um ao outro por design — `merge-clarice-subscribers.ts`
 *     é escopo Clarice, fora deste store (#7196).
 *
 * **Nota de proveniência:** a issue original (#7208) citava "264 subscribers
 * sintéticos (863 eventos)" a excluir, medidos numa auditoria anterior à
 * escrita desta issue. Medido de novo ao vivo nesta sessão contra o store
 * atual (`data/diaria-subscribers/diaria-subscribers.db`, 1.410 subscribers,
 * 82.690 eventos): **0 linhas batem qualquer um dos padrões acima hoje** — o
 * número da issue não reproduz neste snapshot (o store foi reconstruído ao
 * menos uma vez desde então, `.db.backup-2026-09-05T01-24-38-264Z` ao lado
 * do arquivo vivo). A quarentena é implementada mesmo assim, pela razão
 * DEFENSIVA acima — nunca assumir que "0 hoje" significa "sempre 0".
 *
 * `getSyntheticSubscriberIds`/`filterOutSyntheticSubscribers` são os dois
 * pontos de uso: qualquer consumidor que itere sobre TODOS os subscribers
 * (relatório, painel, export) deve filtrar por eles ANTES do loop — as
 * funções de recência abaixo (`computeSubscriberPlatformRecency`/
 * `computeSubscriberCrossPlatformRecency`) recebem 1 `subscriberId` já
 * resolvido e não fazem essa checagem sozinhas (o caller já sabe se está
 * iterando a base inteira ou respondendo 1 busca pontual do painel).
 *
 * ## Contaminação 2 — vício sistemático do Kit: `ts` é do BROADCAST, não da PESSOA
 *
 * **Isto vale para OS 4 EIXOS do Kit, não só "sent"** — achado desta issue,
 * mais amplo do que o corpo original sugeria. `ingestBroadcastAudience`
 * (`kit-subscribers-ingest.ts`) grava `sent`/`delivered`/`open`/`click`
 * TODOS com o mesmo `ts` (o `published_at`/`send_at` do broadcast) porque
 * `POST /v4/subscribers/filter` — a única chamada que devolve a LISTA de
 * quem está em cada eixo — nunca devolve timestamp por assinante, só o
 * e-mail. Consequência prática: para um subscriber só-Kit,
 * `last_opened`/`last_clicked` desta função não é "quando esta pessoa abriu
 * o e-mail" — é "quando o broadcast foi disparado", e todo assinante do
 * Kit que abriu qualquer edição aparenta ter aberto TODAS elas no mesmo
 * instante do disparo. `sends_since_last_open`/`sends_since_last_click`
 * herdam o mesmo viés (o "since" é medido contra uma âncora que já está
 * errada).
 *
 * **Avaliação de endpoint alternativo (pedido explícito da issue) — sem
 * solução simples encontrada:**
 *   - `list_stats_for_a_subscriber` (MCP `kit`) devolve exatamente estes
 *     campos (`last_sent`, `last_opened`, `last_clicked`,
 *     `sends_since_last_open`) PRONTOS, por pessoa — mas importar o
 *     agregado da própria plataforma como FONTE criaria um segundo número
 *     pra mesma pergunta que este módulo existe pra responder (decisão já
 *     registrada no corpo da #7208: "vale como auditoria de skew, não como
 *     fonte" — não reaberta aqui).
 *   - `get_link_clicks_for_a_broadcast` (usado por `kit-clicks-enricher`)
 *     devolve cliques ÚNICOS por LINK, agregados no nível do broadcast —
 *     sem timestamp por evento e sem identidade de quem clicou (confirmado
 *     no docstring do próprio agent: "não há passo de identidade de clique
 *     equivalente ao `list_post_click_subscribers` da Beehiiv — o Kit não
 *     expõe isso nesta MCP"). Não serve pra corrigir o `ts`.
 *   - Nenhum endpoint do Kit hoje devolve "quando ESTA pessoa abriu ESTE
 *     broadcast" de forma individual, fora do agregado acima. **Limitação
 *     conhecida, não TODO vago**: enquanto isso não mudar, recência do Kit
 *     é precisa no nível de "qual o broadcast mais recente com este tipo de
 *     evento" (útil — responde "está mais frio que a última edição?"), mas
 *     NUNCA no nível de "que horas". Beehiiv e Brevo não têm este vício —
 *     os dois gravam `ts` do evento real (webhook/API por-contato).
 *
 * @see scripts/lib/diaria-subscribers-db.ts — schema + primitivas (event, índices).
 * @see scripts/lib/diaria-subscribers-edicao-canonica.ts — dedup cross-plataforma por AAMMDD (#7204, EM VOO — ver nota abaixo).
 * @see scripts/lib/contest-poll-ingest.ts — identidade anônima do voto (`@web.eia.diaria.local`).
 * @see scripts/lib/kit-subscribers-ingest.ts — origem do viés de `ts` do Kit.
 * @see https://github.com/vjpixel/diaria-studio/issues/7208
 * @see https://github.com/vjpixel/diaria-studio/issues/7163 (épico)
 */

import type { DatabaseSync } from "node:sqlite";
import { type Platform, PLATFORMS } from "./diaria-subscribers-db.ts";
import {
  buildCanonicalEdicaoMapFromEvents,
  countDistinctCanonicalEditions,
  type EdicaoEventEntry,
} from "./diaria-subscribers-edicao-canonica.ts";

// ---------------------------------------------------------------------------
// Contaminação 1 — quarentena de subscribers sintéticos
// ---------------------------------------------------------------------------

/** Domínios/sufixos de e-mail que nunca correspondem a uma pessoa real —
 *  ver docstring do módulo pra proveniência de cada um. Checagem por
 *  IGUALDADE ou SUFIXO do domínio (não do e-mail inteiro). */
export const SYNTHETIC_EMAIL_DOMAIN_SUFFIXES: readonly string[] = [
  "web.eia.diaria.local",
  "vote.eia.diaria.local",
  ".local",
  "example.com",
  "example.org",
  "example.net",
];

/** Local-part no formato `{prefixo}-{epoch-ms}[-rand]` — mesmo padrão de
 *  `SYNTHETIC_E2E_LOCAL_PART` em `merge-clarice-subscribers.ts` (repetido
 *  aqui, não importado — os dois módulos não se importam por design, ver
 *  docstring do módulo). */
export const SYNTHETIC_EMAIL_LOCAL_PART_PATTERN = /^(collab|regular|test|e2e|qa)-\d{10,}(-[a-z0-9]{4,})?$/;

/**
 * `true` quando o e-mail bate um padrão conhecido de identidade sintética
 * (não-humana) — nunca deve contar em nenhuma recência. `email` `null`/vazio
 * nunca é sintético por si só (ausência de e-mail é um caso diferente, já
 * tratado por `ensureSubscriber` exigir `externalId` OU `email`).
 */
export function isSyntheticSubscriberEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  for (const suffix of SYNTHETIC_EMAIL_DOMAIN_SUFFIXES) {
    if (domain === suffix || domain.endsWith(`.${suffix}`) || domain.endsWith(suffix)) return true;
  }
  return SYNTHETIC_EMAIL_LOCAL_PART_PATTERN.test(local);
}

/**
 * Todos os `subscriber_id` com ao menos 1 `identity_alias.email` sintético,
 * em qualquer plataforma. Varredura única (`SELECT DISTINCT`), filtrada em
 * JS — o padrão de local-part não é expressável em `LIKE`/`GLOB` do SQLite
 * sem extensão de regex, e o volume atual (milhares de aliases, não
 * milhões) não justifica uma. Chamar 1x por rodada de relatório/painel e
 * reusar o `Set` resultante — nunca dentro de um loop por subscriber.
 */
export function getSyntheticSubscriberIds(db: DatabaseSync): Set<number> {
  const rows = db
    .prepare("SELECT DISTINCT subscriber_id, email FROM identity_alias WHERE email IS NOT NULL")
    .all() as unknown as Array<{ subscriber_id: number; email: string }>;
  const ids = new Set<number>();
  for (const row of rows) {
    if (isSyntheticSubscriberEmail(row.email)) ids.add(row.subscriber_id);
  }
  return ids;
}

/**
 * Remove da lista qualquer `subscriber_id` sintético — ponto de uso único
 * pra qualquer consumidor que itere a base inteira (relatório, export,
 * painel) ANTES de computar recência por subscriber. Calcula
 * `getSyntheticSubscriberIds` internamente (1 varredura), não requer o
 * caller gerenciar o `Set` à parte quando só precisa filtrar uma vez.
 */
export function filterOutSyntheticSubscribers(
  db: DatabaseSync,
  subscriberIds: readonly number[],
): number[] {
  const synthetic = getSyntheticSubscriberIds(db);
  return subscriberIds.filter((id) => !synthetic.has(id));
}

// ---------------------------------------------------------------------------
// Recência por (subscriber × plataforma)
// ---------------------------------------------------------------------------

/** Tipos de evento que compõem "um envio alcançou esta pessoa" — usados como
 *  âncora pra `sends_since_last_open`/`sends_since_last_click`. `sent` E
 *  `delivered` contam (não só um dos dois): nem toda plataforma grava os
 *  dois eixos (Beehiiv só grava `delivered`; Brevo hoje só grava `sent`,
 *  ver docstring do módulo) — `IN ('sent','delivered')` cobre qualquer uma
 *  sem precisar detectar capacidade por plataforma (diferente de
 *  `leitor-store.ts`, que PRECISA escolher um dos dois pra não somar duas
 *  vezes a mesma edição — aqui `COUNT(DISTINCT edicao)` já deduplica
 *  quando as duas coexistem pra mesma edição, ex: Kit). */
export const SEND_ANCHOR_EVENT_TYPES: readonly string[] = ["sent", "delivered"];

export interface SubscriberPlatformRecency {
  lastSent: string | null;
  lastDelivered: string | null;
  lastOpened: string | null;
  lastClicked: string | null;
  /** Edições distintas com `sent`/`delivered` desde a última abertura
   *  (exclusive). `null` quando não há nenhum envio registrado nesta
   *  plataforma. Quando NUNCA abriu, é o total de edições enviadas (ver
   *  docstring do módulo/função). */
  sendsSinceLastOpen: number | null;
  /** Mesma semântica de `sendsSinceLastOpen`, ancorada em `lastClicked`. */
  sendsSinceLastClick: number | null;
}

function maxTs(db: DatabaseSync, subscriberId: number, platform: Platform, type: string): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS max_ts FROM event WHERE subscriber_id = ? AND platform = ? AND type = ?")
    .get(subscriberId, platform, type) as { max_ts: string | null };
  return row.max_ts;
}

/**
 * Conta edições distintas (`COUNT(DISTINCT COALESCE(edicao, external_event_id))`
 * — mesmo fallback defensivo de `countDistinctEditions` em `leitor-store.ts`)
 * com evento de âncora de envio (`SEND_ANCHOR_EVENT_TYPES`) estritamente
 * DEPOIS de `afterTs` nesta plataforma. `afterTs: null` conta TODAS as
 * edições enviadas (semântica de "nunca abriu/clicou" — tudo desde sempre
 * conta como "desde a última vez").
 */
function countSendsAfter(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
  afterTs: string | null,
): number {
  const placeholders = SEND_ANCHOR_EVENT_TYPES.map(() => "?").join(", ");
  const row = afterTs
    ? (db
        .prepare(
          `SELECT COUNT(DISTINCT COALESCE(edicao, external_event_id)) AS n FROM event
           WHERE subscriber_id = ? AND platform = ? AND type IN (${placeholders}) AND ts > ?`,
        )
        .get(subscriberId, platform, ...SEND_ANCHOR_EVENT_TYPES, afterTs) as { n: number })
    : (db
        .prepare(
          `SELECT COUNT(DISTINCT COALESCE(edicao, external_event_id)) AS n FROM event
           WHERE subscriber_id = ? AND platform = ? AND type IN (${placeholders})`,
        )
        .get(subscriberId, platform, ...SEND_ANCHOR_EVENT_TYPES) as { n: number });
  return row.n;
}

/**
 * Recência de engajamento de 1 (subscriber × plataforma). Não checa
 * sintético — caller decide (ver "Contaminação 1" no docstring do módulo).
 * **Viés do Kit**: para `platform === "kit"`, todo campo de timestamp aqui
 * é o `ts` do BROADCAST, não da pessoa — ver "Contaminação 2" no docstring
 * do módulo antes de usar isto pra qualquer afirmação de "quando".
 */
export function computeSubscriberPlatformRecency(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
): SubscriberPlatformRecency {
  const lastSent = maxTs(db, subscriberId, platform, "sent");
  const lastDelivered = maxTs(db, subscriberId, platform, "delivered");
  const lastOpened = maxTs(db, subscriberId, platform, "open");
  const lastClicked = maxTs(db, subscriberId, platform, "click");

  const hasAnySend = lastSent !== null || lastDelivered !== null;
  const sendsSinceLastOpen = hasAnySend ? countSendsAfter(db, subscriberId, platform, lastOpened) : null;
  const sendsSinceLastClick = hasAnySend ? countSendsAfter(db, subscriberId, platform, lastClicked) : null;

  return { lastSent, lastDelivered, lastOpened, lastClicked, sendsSinceLastOpen, sendsSinceLastClick };
}

// ---------------------------------------------------------------------------
// Recência CROSS-plataforma
// ---------------------------------------------------------------------------

/**
 * Máximo (mais recente) entre valores ISO possivelmente `null` — `null`
 * vence só quando TODOS são `null`. Comparação lexicográfica basta pra ISO
 * 8601 com o mesmo formato (`event.ts` sempre grava nesse formato).
 */
function maxIso(...values: Array<string | null>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v && (!best || v > best)) best = v;
  }
  return best;
}

/**
 * Linha bruta de evento de âncora de envio (1 plataforma) — usada só pra
 * alimentar `countDistinctCanonicalEditions` na agregação cross-plataforma
 * abaixo (ver "Por que a chave canônica" na função pública).
 */
function fetchSendAnchorEntries(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
  afterTs: string | null,
): EdicaoEventEntry[] {
  const placeholders = SEND_ANCHOR_EVENT_TYPES.map(() => "?").join(", ");
  const rows = (
    afterTs
      ? db
          .prepare(
            `SELECT edicao, external_event_id FROM event
             WHERE subscriber_id = ? AND platform = ? AND type IN (${placeholders}) AND ts > ?`,
          )
          .all(subscriberId, platform, ...SEND_ANCHOR_EVENT_TYPES, afterTs)
      : db
          .prepare(
            `SELECT edicao, external_event_id FROM event
             WHERE subscriber_id = ? AND platform = ? AND type IN (${placeholders})`,
          )
          .all(subscriberId, platform, ...SEND_ANCHOR_EVENT_TYPES)
  ) as unknown as Array<{ edicao: string | null; external_event_id: string }>;
  return rows.map((r) => ({ platform, edicao: r.edicao, externalEventId: r.external_event_id }));
}

export interface SubscriberCrossPlatformRecency extends SubscriberPlatformRecency {}

/**
 * Recência cross-plataforma — agrega as 3 plataformas de `PLATFORMS`.
 * `lastSent`/`lastDelivered`/`lastOpened`/`lastClicked` são o MAIS RECENTE
 * entre as plataformas onde a pessoa existe; `sendsSinceLastOpen`/
 * `sendsSinceLastClick` contam edições distintas de envio, DE QUALQUER
 * plataforma, depois da última abertura/clique cross-plataforma.
 *
 * **Por que a chave CANÔNICA de edição, não `edicao` nativa direto (#7204)**:
 * `event.edicao` guarda o id NATIVO de cada plataforma (post id da Beehiiv,
 * broadcast id do Kit, campaignId da Brevo) — a MESMA edição do dia entra 3
 * vezes com 3 chaves diferentes quando a pessoa existe nas 3 plataformas, e
 * `COUNT(DISTINCT edicao)` cru contaria a mesma entrega até 3x (achado já
 * registrado no corpo do épico #7163, "Dois riscos de sequência"). A #7204
 * (fatia 9 do mesmo épico) segue ABERTA como issue — não fechada — mas o
 * módulo aditivo que ela já entregou (`diaria-subscribers-edicao-canonica.ts`,
 * mergeado no #7252) está disponível e testado: usamos
 * `buildCanonicalEdicaoMapFromEvents`/`countDistinctCanonicalEditions` aqui
 * em vez de esperar a issue fechar — ela cobre exatamente o dado que
 * `sends_since_last_*` cross-plataforma precisa (evitar contar a mesma
 * edição 3x), sem tocar caminho de produção nenhum além deste módulo novo.
 * Quando a #7204 fechar de vez (coluna gravada na ingestão, não mais
 * heurística por `MIN(ts)`), revisitar esta função pra usar a coluna direto
 * em vez do mapa recalculado — não é bloqueio, é melhoria de precisão
 * futura (a heurística já é testada e correta pro caso de uso de hoje).
 *
 * `lastSent`/`lastDelivered`/`lastOpened`/`lastClicked` NÃO passam pela
 * chave canônica (são só `MAX(ts)`, sem contagem de edições) — o viés de
 * dupla-contagem só afeta CONTAGEM (`sends_since_last_*`), nunca "qual foi
 * o timestamp mais recente".
 */
export function computeSubscriberCrossPlatformRecency(
  db: DatabaseSync,
  subscriberId: number,
  platforms: readonly Platform[] = PLATFORMS,
): SubscriberCrossPlatformRecency {
  const perPlatform = platforms.map((platform) => computeSubscriberPlatformRecency(db, subscriberId, platform));

  const lastSent = maxIso(...perPlatform.map((p) => p.lastSent));
  const lastDelivered = maxIso(...perPlatform.map((p) => p.lastDelivered));
  const lastOpened = maxIso(...perPlatform.map((p) => p.lastOpened));
  const lastClicked = maxIso(...perPlatform.map((p) => p.lastClicked));

  const hasAnySend = lastSent !== null || lastDelivered !== null;
  let sendsSinceLastOpen: number | null = null;
  let sendsSinceLastClick: number | null = null;

  if (hasAnySend) {
    const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
    const entriesSinceOpen: EdicaoEventEntry[] = [];
    const entriesSinceClick: EdicaoEventEntry[] = [];
    for (const platform of platforms) {
      entriesSinceOpen.push(...fetchSendAnchorEntries(db, subscriberId, platform, lastOpened));
      entriesSinceClick.push(...fetchSendAnchorEntries(db, subscriberId, platform, lastClicked));
    }
    sendsSinceLastOpen = countDistinctCanonicalEditions(entriesSinceOpen, canonicalMap);
    sendsSinceLastClick = countDistinctCanonicalEditions(entriesSinceClick, canonicalMap);
  }

  return { lastSent, lastDelivered, lastOpened, lastClicked, sendsSinceLastOpen, sendsSinceLastClick };
}
