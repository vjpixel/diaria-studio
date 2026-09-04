/**
 * beehiiv-subscribers-ingest.ts (#6464 fatia 3b — #7104)
 *
 * Miolo PURO da ingestão Beehiiv → store unificado `diaria-subscribers-db.ts`.
 * Molde exato do par Kit (`kit-subscribers-ingest.ts`): mapeamento
 * registro→eventos, chave natural determinística (`external_event_id`), o
 * guard anti-fabricação (#6496) e a escrita idempotente — tudo testável sem
 * rede, injetando `DatabaseSync` `:memory:` e registros já parseados.
 *
 * ## Diferença de desenho vs. o Kit: sem rede nenhuma
 *
 * O Kit busca ao vivo (`fetchAudience`/`drainPages` contra a API). A Beehiiv
 * **não precisa** — o backup per-subscriber engagement já existe em disco
 * (`data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl`, drenado pela
 * fatia 1, #6465/#6733) no formato exato que o store precisa. Este módulo só
 * INTERPRETA o que já está lá; o CLI irmão (`diaria-subscribers-ingest-
 * beehiiv.ts`) é I/O de disco, não de rede.
 *
 * ## `status` do registro → eixos gravados
 *
 * Cada linha do JSONL é 1 registro cru de `list_post_subscriber_engagement`
 * — 1 por (assinante × post). Campos observados ao vivo (#7104, issue body):
 * `subscriber_id`, `email`, `status` (`"delivered"`|`"opened"`|`"clicked"`|
 * `"unsubscribed"`), `timestamp`, `total_clicked`, `total_opened`.
 *
 * Premissa documentada (decisão de quem implementou, #7104 — nenhuma das 4
 * exceções de "Perguntar é exceção" do CLAUDE.md bate: reversível, sem
 * trade-off editorial visível ao leitor, sem gasto, e a resposta não muda o
 * critério de pronto): a presença de um registro na lista prova que o
 * subscriber RECEBEU o post — inclusive quando `status === "unsubscribed"`
 * (o assinante só teria como se descadastrar A PARTIR desse envio se o
 * recebeu). Por isso `"delivered"` é gravado para **todo** registro, e os
 * eixos adicionais são derivados independentemente do `status` categórico,
 * a partir dos contadores (`total_opened`/`total_clicked`) — mais robusto
 * que confiar só no `status` (o exemplo do próprio corpo da issue tem
 * `status: "delivered"` com `total_opened: 1`, provando que os dois campos
 * não são estritamente redundantes):
 *
 *   - `"delivered"` — sempre.
 *   - `"open"`      — se `status` for `"opened"`/`"clicked"` OU `total_opened > 0`.
 *   - `"click"`     — se `status` for `"clicked"` OU `total_clicked > 0`.
 *   - `"unsub"`     — se `status === "unsubscribed"`. Grava 1 por POST (a
 *     chave natural inclui o `postId`) — NÃO deduplica contra o `unsub`
 *     de `ingestBeehiivRoster` abaixo, que é a transição de roster
 *     (#7233 finding 2, ver docstring de `ingestBeehiivRoster`).
 *
 * ## Click-identity records (`list_post_click_subscribers`) — NUNCA fabricam `delivered` (#7206)
 *
 * O mesmo JSONL pode conter registros de uma 2ª fonte: `list_post_click_subscribers`
 * (docstring de `apply-mcp-subscriber-engagement.ts`, mesclada por
 * `subscriber_id` no MESMO arquivo). Medição ao vivo de 02/09/2026: 261
 * linhas com `url_hash`, em 2 shapes — 199 FLAT (`{subscription_id, email,
 * url, url_hash, clicked_at}`, 1 clique por linha) e 62 NESTED (um array de
 * cliques dentro do registro). Nenhum dos dois shapes carrega `status` — o
 * bug corrigido aqui era `deriveBeehiivEventTypes` receber essas linhas como
 * se fossem engagement genérico e SEMPRE prefixar `"delivered"` (a lógica
 * `types: EventType[] = ["delivered"]` acima não checa a origem do
 * registro), fabricando uma entrega que a fonte nunca confirmou, e
 * descartando a URL do clique (nunca lida). `isBeehiivClickIdentityRecord`/
 * `extractBeehiivClickEntries` abaixo detectam e tratam os dois shapes à
 * parte, ANTES de `deriveBeehiivEventTypes` rodar — grava só `"click"` (1
 * por link, com `url`), nunca `"delivered"`.
 *
 * ## Sem `sent`, sem `bounce` (mesma limitação nomeada na issue #7104)
 *
 * O backup não tem eixo `sent` — só `delivered` em diante (a MCP
 * `list_post_subscriber_engagement` não expõe quem foi TENTADO, só quem
 * recebeu). `sent − delivered` (como o Kit deriva bounce) não é derivável
 * desta fonte — decisão explícita de não buscar `sent` na API pra fechar
 * esse eixo: `leitor-v1` não usa bounce, e o custo de rede não se paga por
 * um eixo que ninguém consome hoje (mesmo raciocínio do corpo da issue).
 *
 * **Bounce (hard/soft) nunca vira `event.subtype` aqui, de propósito
 * (#7203).** A Beehiiv expõe `total_soft_bounced`/`total_hard_bounced` só
 * AGREGADO **por post** (endpoint de stats do post) — nunca por assinante.
 * Diferente da Brevo (`brevo-subscribers-ingest.ts`, que grava `hard`/`soft`
 * em `event.subtype` a partir de `contact.statistics`, um eixo genuinamente
 * por-contato), fabricar um bounce individual aqui exigiria adivinhar QUAL
 * assinante do post bateu o agregado — informação que a fonte não confirma
 * por pessoa. Registrado aqui explicitamente (não implementado) pra não
 * reabrir a pergunta a cada nova leitura do módulo.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ensureSubscriber,
  recordEvent,
  upsertSubscription,
  upsertAttribute,
  coerceAttributeValue,
  type EventType,
} from "./diaria-subscribers-db.ts";
import type { BeehiivBackupSubscriber, BeehiivBackupCustomField } from "./beehiiv-backup-snapshots.ts";
import { extractOrigemOriginalFromCustomFields } from "./shared/beehiiv-origem-original.ts";
import type { BeehiivExitHistoryRecord } from "./beehiiv-exit-history.ts";

/** Shape tolerante de 1 linha do JSONL — campos podem faltar (registro
 *  malformado, ou resposta parcial da MCP já gravada por uma corrida antiga
 *  da fatia 1). Nenhum campo é assumido presente sem checagem. */
export interface BeehiivEngagementRecord {
  subscriber_id?: unknown;
  /** #7206: alguns click-identity records de `list_post_click_subscribers`
   *  usam este nome no lugar de `subscriber_id` (medido ao vivo, 02/09/2026)
   *  — mesmo UUID de assinante, campo diferente. `extractBeehiivIdentity`
   *  tenta os dois. */
  subscription_id?: unknown;
  email?: unknown;
  status?: unknown;
  timestamp?: unknown;
  total_clicked?: unknown;
  total_opened?: unknown;
  /** #7206: shape FLAT de click-identity record — 1 clique por linha. */
  url?: unknown;
  url_hash?: unknown;
  clicked_at?: unknown;
  /** #7206: shape NESTED de click-identity record — vários cliques por
   *  linha, cada entrada com o mesmo formato de `url`/`url_hash`/`clicked_at`. */
  clicks?: unknown;
}

/**
 * Deriva os eixos (`EventType`) presentes num registro — ver docstring do
 * módulo pra a lógica completa. Ordem do array não importa (o chamador
 * grava cada um como evento independente).
 */
export function deriveBeehiivEventTypes(record: BeehiivEngagementRecord): EventType[] {
  const status = typeof record.status === "string" ? record.status : undefined;
  const totalOpened = typeof record.total_opened === "number" ? record.total_opened : 0;
  const totalClicked = typeof record.total_clicked === "number" ? record.total_clicked : 0;

  const types: EventType[] = ["delivered"];
  if (status === "opened" || status === "clicked" || totalOpened > 0) types.push("open");
  if (status === "clicked" || totalClicked > 0) types.push("click");
  if (status === "unsubscribed") types.push("unsub");
  return types;
}

/** 1 clique extraído de um click-identity record (#7206) — `ts` é `null`
 *  quando `clicked_at` está ausente/malformado (o chamador cai pro `ts` do
 *  registro pai, mesma disciplina do resto do módulo: nunca inventa data). */
export interface BeehiivClickEntry {
  url: string;
  ts: string | null;
}

function parseClickLike(raw: unknown): BeehiivClickEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === "string" && obj.url ? obj.url : null;
  if (!url) return null;
  const ts = typeof obj.clicked_at === "string" && obj.clicked_at ? obj.clicked_at : null;
  return { url, ts };
}

/**
 * Extrai os cliques (url + ts) de 1 registro de `list_post_click_subscribers`
 * (#7206) — tolera os 2 shapes medidos ao vivo: FLAT (`url`/`clicked_at` no
 * nível do próprio registro) e NESTED (`clicks: [...]`, cada entrada no mesmo
 * formato). Os dois podem coexistir em teoria (registro flat com `clicks[]`
 * também presente) — soma os dois sem duplicar lógica. `[]` quando o
 * registro não é um click-identity record (nem `url` nem `clicks[]`
 * utilizável) — nunca lança.
 */
export function extractBeehiivClickEntries(record: BeehiivEngagementRecord): BeehiivClickEntry[] {
  const out: BeehiivClickEntry[] = [];
  const own = parseClickLike(record);
  if (own) out.push(own);
  if (Array.isArray(record.clicks)) {
    for (const raw of record.clicks) {
      const entry = parseClickLike(raw);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/**
 * `true` quando o registro é um click-identity record (`list_post_click_subscribers`)
 * em vez de um engagement record (`list_post_subscriber_engagement`) — nunca
 * carrega `status`, mas carrega ao menos 1 clique utilizável (#7206).
 * Discriminador usado pra NUNCA fabricar `"delivered"` a partir de um
 * registro de clique: a presença numa lista de cliques prova o clique, não a
 * entrega (quem prova entrega é o registro de engagement, se existir —
 * ingerido separadamente, nunca inferido daqui).
 */
export function isBeehiivClickIdentityRecord(record: BeehiivEngagementRecord): boolean {
  return typeof record.status !== "string" && extractBeehiivClickEntries(record).length > 0;
}

/**
 * Chave natural de 1 clique de click-identity record — inclui `url` (2
 * links diferentes do mesmo post não podem colidir na mesma chave, mesmo
 * padrão de `buildBrevoEventExternalId` pra `clicked`). Deliberadamente
 * DIFERENTE de `buildBeehiivEventExternalId(identity, postId, "click")`
 * (sem sufixo de url, usado pelo `"click"` derivado de engagement genérico)
 * — as duas chaves nunca colidem (strings distintas), então um post que tem
 * TANTO um registro de engagement com `total_clicked > 0` QUANTO um
 * click-identity record grava 2 eventos "click" (1 sem url, 1 com) em vez de
 * um sobrescrever o outro — aceito: a leitura por `COUNT(DISTINCT edicao)`
 * em `leitor-store.ts` já colapsa isso pra "1 edição clicada".
 */
export function buildBeehiivClickExternalId(identity: BeehiivIdentity, postId: string, url: string): string {
  const key = identity.externalId ?? identity.email;
  if (!key) {
    throw new Error("buildBeehiivClickExternalId: identidade vazia (nem externalId nem email)");
  }
  return `${key}:${postId}:click:${url}`;
}

/**
 * Identidade utilizável do registro: `subscriber_id` (UUID nativo da
 * Beehiiv — preferido, é o `external_id` real) e/ou `email`. `null` quando
 * nenhum dos dois está presente/utilizável — registro sem identidade não
 * pode virar `subscriber` (mesmo guard de `ensureSubscriber`).
 */
export interface BeehiivIdentity {
  externalId: string | null;
  email: string | null;
}

export function extractBeehiivIdentity(record: BeehiivEngagementRecord): BeehiivIdentity | null {
  const externalId =
    typeof record.subscriber_id === "string" && record.subscriber_id.trim()
      ? record.subscriber_id.trim()
      // #7206: click-identity records de list_post_click_subscribers usam
      // `subscription_id` no lugar de `subscriber_id` (medido ao vivo).
      : typeof record.subscription_id === "string" && record.subscription_id.trim()
        ? record.subscription_id.trim()
        : null;
  let email =
    typeof record.email === "string" && record.email.trim() ? record.email.trim().toLowerCase() : null;

  // Classe C (#7181): 100 dos 1.198 aliases reais do backup local têm o
  // e-mail gravado no campo `subscriber_id` em vez de `email` (achado ao
  // vivo — arquivo `post_048a8526…`, "Post 11/20" no manifest: 100/100
  // linhas contêm "@" em `subscriber_id`, nenhuma tem a chave `email`).
  // Sem este remap essas 100 linhas cairiam no mesmo guard que bloqueia
  // stub sintético (classe A) — mas aqui o e-mail EXISTE, só está no campo
  // errado; recuperar em vez de descartar.
  if (!email && externalId && externalId.includes("@")) {
    email = externalId.toLowerCase();
  }

  if (!externalId && !email) return null;
  return { externalId, email };
}

/** Insere o alias `(platform='beehiiv', externalId, email)` se ele ainda não
 *  existir, apontando pro `subscriberId` JÁ RESOLVIDO (nunca cria um
 *  subscriber novo) — usado por `resolveOrCreateBeehiivSubscriber` pra
 *  registrar a combinação exata vista nesta linha, mesmo quando ela funde
 *  com um alias diferente do mesmo assinante. */
function insertBeehiivAliasIfMissing(
  db: DatabaseSync,
  subscriberId: number,
  externalId: string | null,
  email: string | null,
  now: string,
): void {
  const existing = db
    .prepare(
      "SELECT id FROM identity_alias WHERE platform = 'beehiiv' AND external_id IS ? AND email IS ?",
    )
    .get(externalId, email) as { id: number } | undefined;
  if (existing) return;
  db.prepare(
    `INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at)
     VALUES (?, 'beehiiv', ?, ?, ?)`,
  ).run(subscriberId, externalId, email, now);
}

/**
 * Find-or-create de subscriber ESPECÍFICO pra Beehiiv (#7104, achado de
 * review P2 do PR #7135) — `ensureSubscriber` genérico faz find-or-create
 * pela chave EXATA `(platform, external_id, email)`, o que é certo pro Kit
 * (só tem e-mail, chave estável por design) mas errado pra Beehiiv: a Beehiiv
 * costuma ter os DOIS campos, e o MESMO assinante real pode aparecer em
 * linhas diferentes com combinações diferentes (ex: uma linha com
 * `subscriber_id+email`, outra com só `subscriber_id` por e-mail nulo ou
 * malformado numa página da MCP) — a chave exata trataria isso como 2
 * pessoas, criando 2 `subscriber` DENTRO da própria Beehiiv (nunca fundidos
 * até `resolveIdentitiesByEmail` rodar, e só quando as DUAS linhas têm
 * e-mail, o que corrompe `leitor-v1`, o objetivo da issue).
 *
 * Resolução em ordem de preferência:
 *   1. `subscriber_id` nativo da Beehiiv (identidade real) — casa contra
 *      QUALQUER alias já visto sob esse `external_id`, ignorando se o
 *      e-mail da linha atual bate ou não.
 *   2. `email` como chave secundária — só quando a linha não tem
 *      `subscriber_id` (ou ele nunca foi visto antes), casa contra um alias
 *      já resolvido pra esse e-mail.
 *   3. Nenhum dos dois casou — subscriber genuinamente novo, MAS só se
 *      houver e-mail válido (`ensureSubscriber` cuida da criação).
 *
 * Em qualquer caso que funde com um alias existente, a combinação exata
 * `(externalId, email)` desta linha é registrada como um alias A MAIS do
 * MESMO subscriber (`insertBeehiivAliasIfMissing`) — não perde a variação
 * observada, só evita duplicar a pessoa.
 *
 * ## Guard anti-fantasma (#7181)
 *
 * O passo 3 (criar um `subscriber` NOVO) **exige e-mail válido**. Um
 * registro cujo único dado é um `subscriber_id` opaco (stub sintético —
 * classe A do backup local de engajamento, ex: `{"subscriber_id":"s1"}`)
 * não prova identidade real; sem este guard ele criava um `subscriber`
 * fantasma (307 dos 1.131 no store real, medição de 02/09/2026 — 27% da
 * base). A checagem NÃO pode viver em `extractBeehiivIdentity` (função
 * pura, sem acesso ao DB): um registro com só `subscriber_id`, já visto
 * antes com e-mail noutra linha (passo 1 acima), precisa continuar se
 * FUNDINDO ao alias existente — é exatamente o cenário do teste de
 * regressão do #7135 (`resolveOrCreateBeehiivSubscriber — funde
 * combinações inconsistentes`). Só a CRIAÇÃO de um subscriber novo sem
 * nenhum match prévio é bloqueada; retorna `null` nesse caso — o chamador
 * (`ingestPostEngagement`) conta o registro em `recordsSkippedNoIdentity`
 * e não grava nenhum evento pra ele.
 */
/**
 * Busca (SEM criar) o `subscriber` já resolvido pra esta identidade Beehiiv
 * — mesma ordem de preferência de `resolveOrCreateBeehiivSubscriber` (passos
 * 1-2 dela: `external_id` nativo primeiro, `email` como chave secundária),
 * extraída em #7248 pra quem só quer REFINAR uma linha `subscription` já
 * existente e nunca deve criar um `subscriber`/`subscription` novo a partir
 * desta fonte (`applyBeehiivExitHistory` abaixo — exit-history não carrega
 * `entered_at`/UTM/etc., então não é fonte primária de cadastro). `null`
 * quando nenhum alias prévio casa — o chamador decide o que fazer (nunca
 * cria aqui, ao contrário da função irmã).
 *
 * Duplica (não reusa) as duas queries de `resolveOrCreateBeehiivSubscriber`
 * em vez de extrair um helper compartilhado — são ~10 linhas estáveis, e a
 * função irmã já é coberta por teste de regressão pesado (#7135/#7181); um
 * refactor de extração arriscaria essa cobertura por uma duplicação pequena
 * e de baixo custo de manutenção.
 */
export function findExistingBeehiivSubscriberId(db: DatabaseSync, identity: BeehiivIdentity): number | null {
  const { externalId, email } = identity;
  const normalizedEmail = email ? email.trim().toLowerCase() : null;

  if (externalId) {
    const bySubscriberId = db
      .prepare("SELECT subscriber_id FROM identity_alias WHERE platform = 'beehiiv' AND external_id = ? LIMIT 1")
      .get(externalId) as { subscriber_id: number } | undefined;
    if (bySubscriberId) return bySubscriberId.subscriber_id;
  }

  if (normalizedEmail) {
    const byEmail = db
      .prepare("SELECT subscriber_id FROM identity_alias WHERE platform = 'beehiiv' AND email = ? LIMIT 1")
      .get(normalizedEmail) as { subscriber_id: number } | undefined;
    if (byEmail) return byEmail.subscriber_id;
  }

  return null;
}

export function resolveOrCreateBeehiivSubscriber(
  db: DatabaseSync,
  identity: BeehiivIdentity,
  now: string = new Date().toISOString(),
): number | null {
  const { externalId, email } = identity;
  if (!externalId && !email) {
    throw new Error("resolveOrCreateBeehiivSubscriber: identidade vazia (nem externalId nem email)");
  }
  const normalizedEmail = email ? email.trim().toLowerCase() : null;

  if (externalId) {
    const bySubscriberId = db
      .prepare("SELECT subscriber_id FROM identity_alias WHERE platform = 'beehiiv' AND external_id = ? LIMIT 1")
      .get(externalId) as { subscriber_id: number } | undefined;
    if (bySubscriberId) {
      insertBeehiivAliasIfMissing(db, bySubscriberId.subscriber_id, externalId, normalizedEmail, now);
      return bySubscriberId.subscriber_id;
    }
  }

  if (normalizedEmail) {
    const byEmail = db
      .prepare("SELECT subscriber_id FROM identity_alias WHERE platform = 'beehiiv' AND email = ? LIMIT 1")
      .get(normalizedEmail) as { subscriber_id: number } | undefined;
    if (byEmail) {
      insertBeehiivAliasIfMissing(db, byEmail.subscriber_id, externalId, normalizedEmail, now);
      return byEmail.subscriber_id;
    }
  }

  // Guard anti-fantasma (#7181): nenhum alias prévio casou — criar um
  // `subscriber` novo exige e-mail válido.
  if (!normalizedEmail) return null;

  return ensureSubscriber(db, "beehiiv", externalId, normalizedEmail, now);
}

/**
 * Chave natural determinística do evento — a chave preferida usa o
 * `subscriber_id` nativo da Beehiiv (identidade real, ao contrário do Kit
 * que não tem id nativo e cai pro e-mail); só cai pro e-mail quando o
 * `subscriber_id` está ausente no registro. `platform` já escopa "beehiiv"
 * na chave natural do `event` (UNIQUE(platform, type, external_event_id)),
 * não precisa repetir aqui.
 */
export function buildBeehiivEventExternalId(identity: BeehiivIdentity, postId: string, axis: EventType): string {
  const key = identity.externalId ?? identity.email;
  if (!key) {
    throw new Error("buildBeehiivEventExternalId: identidade vazia (nem externalId nem email)");
  }
  return `${key}:${postId}:${axis}`;
}

export interface BeehiivIngestionGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Guard anti-fabricação (#6496, mesmo padrão do Kit — `verifyKitIngestion`).
 * Compara quantos registros deste post foram efetivamente processados
 * (identidade resolvida com sucesso) contra o `count` que o manifest da
 * fatia 1 (`beehiiv-engagement-manifest.ts`) registrou pra ESSE post —
 * confirma que o JSONL local não foi truncado/corrompido entre a extração
 * via MCP e esta ingestão. Divergência não aborta a ingestão (o que foi
 * processado é gravado — idempotente), só impede marcar o post como `ok`
 * no manifest desta ingestão — ele volta em `pendingManifestEntries` até
 * bater (ex: depois de o backup da fatia 1 ser corrigido).
 */
export function verifyBeehiivIngestion(recordsProcessed: number, manifestCount: number): BeehiivIngestionGuardResult {
  if (recordsProcessed === manifestCount) return { ok: true };
  return {
    ok: false,
    reason:
      `registros processados (${recordsProcessed}) != manifest.count da fatia 1 (${manifestCount}) — ` +
      `JSONL local pode estar truncado/divergente; não marcando "ok" (guard anti-fabricação, #6496).`,
  };
}

export interface BeehiivIngestPostResult {
  recordsProcessed: number;
  recordsSkippedNoIdentity: number;
  newEvents: number;
  alreadyKnown: number;
  subscribersTouched: number;
}

/**
 * Ingerir todos os registros de 1 post: para cada registro com identidade
 * utilizável, resolve/cria o `subscriber` (`resolveOrCreateBeehiivSubscriber`,
 * platform "beehiiv" — funde combinações inconsistentes de subscriber_id/email
 * do mesmo assinante real, #7135 finding 3) e grava 1 `event` idempotente por eixo derivado
 * (`deriveBeehiivEventTypes`). Registro sem `subscriber_id` nem `email` é
 * contado em `recordsSkippedNoIdentity`, nunca vira subscriber fantasma —
 * mesmo destino (contado, sem evento gravado) pra um registro que TEM
 * `subscriber_id` mas nenhum e-mail válido em lugar nenhum e nenhum alias
 * prévio pra fundir (`resolveOrCreateBeehiivSubscriber` devolve `null`
 * nesse caso — guard anti-fantasma, #7181).
 *
 * `ts` de cada evento é o `timestamp` do PRÓPRIO registro quando presente
 * (mais preciso que o Kit, que só tem o timestamp do broadcast — a Beehiiv
 * devolve por assinante); cai pro `now` do chamador só quando o campo
 * estiver ausente/malformado.
 */
export function ingestPostEngagement(
  db: DatabaseSync,
  postId: string,
  records: BeehiivEngagementRecord[],
  now: string = new Date().toISOString(),
): BeehiivIngestPostResult {
  let recordsProcessed = 0;
  let recordsSkippedNoIdentity = 0;
  let newEvents = 0;
  let alreadyKnown = 0;
  const touchedSubscribers = new Set<number>();

  for (const record of records) {
    const identity = extractBeehiivIdentity(record);
    if (!identity) {
      recordsSkippedNoIdentity++;
      continue;
    }

    const subscriberId = resolveOrCreateBeehiivSubscriber(db, identity, now);
    if (subscriberId === null) {
      // Guard anti-fantasma (#7181): `subscriber_id` opaco sem e-mail
      // válido e sem alias prévio pra fundir — não é assinante real.
      recordsSkippedNoIdentity++;
      continue;
    }
    recordsProcessed++;

    const ts = typeof record.timestamp === "string" && record.timestamp ? record.timestamp : now;
    touchedSubscribers.add(subscriberId);

    if (isBeehiivClickIdentityRecord(record)) {
      // #7206: click-identity record (`list_post_click_subscribers`) —
      // NUNCA passa por `deriveBeehiivEventTypes` (que sempre prefixaria
      // "delivered", fabricando uma entrega que este registro não prova).
      // Grava 1 "click" POR LINK, com a URL — antes descartada.
      for (const entry of extractBeehiivClickEntries(record)) {
        const { inserted } = recordEvent(db, {
          subscriberId,
          platform: "beehiiv",
          type: "click",
          externalEventId: buildBeehiivClickExternalId(identity, postId, entry.url),
          edicao: postId,
          url: entry.url,
          ts: entry.ts ?? ts,
        });
        if (inserted) newEvents++;
        else alreadyKnown++;
      }
      continue;
    }

    for (const type of deriveBeehiivEventTypes(record)) {
      const { inserted } = recordEvent(db, {
        subscriberId,
        platform: "beehiiv",
        type,
        externalEventId: buildBeehiivEventExternalId(identity, postId, type),
        edicao: postId,
        ts,
      });
      if (inserted) newEvents++;
      else alreadyKnown++;
    }
  }

  return {
    recordsProcessed,
    recordsSkippedNoIdentity,
    newEvents,
    alreadyKnown,
    subscribersTouched: touchedSubscribers.size,
  };
}

// ---------------------------------------------------------------------------
// ingestBeehiivRoster (#7229) — popula a dimensão `subscription`
// ---------------------------------------------------------------------------
//
// `ingestPostEngagement` acima só vê `data/beehiiv-backup/subscriber-
// engagement/{post_id}.jsonl` (fato: recebeu/abriu/clicou 1 post) — esse
// registro nunca teve `status`/`created`/UTM de assinatura, então nenhum
// ingest Beehiiv chamava `upsertSubscription` (#7229, medido em master:
// 825 `subscriber`, 991 `identity_alias`, ZERO `subscription`). Quem tem
// esse dado é o snapshot semanal `data/beehiiv-backup/{data}/
// subscribers.jsonl` (`backup-beehiiv.ts`, 1 linha = 1 objeto de
// assinatura cru da API) — `ingestBeehiivRoster` é o par desta fonte,
// molde exato de `ingestKitRoster` (`kit-subscribers-ingest.ts`).

/**
 * Estado da Beehiiv que representa "saiu da base".
 *
 * **A afirmação anterior aqui era falsa** — dizia que "a Beehiiv só tem
 * `active`/`inactive`". Medição real do snapshot desta máquina
 * (`data/beehiiv-backup/2026-08-30/subscribers.jsonl`, 1495 linhas) mostra
 * **5** estados distintos:
 *
 *   active 500 · pending 579 · inactive 343 · invalid 72 · paused 1
 *
 * `pending` já era reconhecido em outro ponto do repo (`evaluate-brevo-
 * diaria.ts`, releitura pós-promoção, que também trata `invalid` e
 * `validating`) — a afirmação nem era nova para o codebase, só estava
 * errada aqui. Classificação explícita, decidida no review deste módulo
 * (não deixar por omissão, #7233 finding 1):
 *
 *   - `invalid`  → CONTA como saída. E-mail inválido/bounce não recebe
 *     mais a newsletter — pra efeito de assinatura ativa é indistinguível
 *     de ter saído, e deixar de fora infla a base ativa.
 *   - `inactive` → CONTA como saída (sinal original, #7229 — descadastro/
 *     promoção fora da Beehiiv, já usado por `evaluate-brevo-diaria.ts`).
 *   - `paused`   → NÃO conta. Pausa é reversível por desenho — o
 *     assinante não saiu, só está temporariamente sem receber.
 *   - `pending`  → NÃO conta. Nunca chegou a ENTRAR — é cadastro travado
 *     sem confirmação (double opt-in). Tratar como saída contaria como
 *     churn quem nunca foi assinante; são 579 registros no snapshot acima
 *     (39% do roster), então classificar isto errado distorceria qualquer
 *     métrica de retenção derivada daqui.
 *   - `active`   → NÃO conta (óbvio, mantido por completude da lista).
 */
const BEEHIIV_EXITED_STATES: ReadonlySet<string> = new Set(["inactive", "invalid"]);

/**
 * Extrai `(key, value)` de `sub.custom_fields` — apoio_nivel, respostas de
 * survey (`Nível`, `Interesses 1`, `Setor 1`, `Área`), `poll_sig`, `RH_*`
 * (#7202, corpo da issue). `name` ausente/vazio é ignorado (entry
 * inutilizável — nunca vira chave `"undefined"`); `value` passa por
 * `coerceAttributeValue` — `null`/`undefined`/string vazia viram "atributo
 * ausente" (entry omitida, nunca gravada com valor vazio fingindo resposta).
 *
 * `tags`/`tiers`/`referrals` (também citados na tabela da issue) FICAM DE
 * FORA desta 1ª passada — `BeehiivBackupSubscriber` não os tipa hoje (ver
 * docstring do módulo em `beehiiv-backup-snapshots.ts`: "nenhum consumidor
 * atual precisa deles") e tipá-los exigiria confirmar o shape real ao vivo;
 * decisão explícita de escopo, não descuido — `custom_fields` sozinho já
 * cobre a maior fatia de valor citada no corpo da issue (apoio_nivel +
 * survey + poll_sig + RH_*).
 */
export function extractBeehiivCustomFieldAttributes(
  sub: Pick<BeehiivBackupSubscriber, "custom_fields">,
): Array<{ key: string; value: string }> {
  const fields: BeehiivBackupCustomField[] = Array.isArray(sub.custom_fields) ? sub.custom_fields : [];
  const out: Array<{ key: string; value: string }> = [];
  for (const f of fields) {
    const key = typeof f.name === "string" ? f.name.trim() : "";
    if (!key) continue;
    const value = coerceAttributeValue(f.value);
    if (value === null) continue;
    out.push({ key, value });
  }
  return out;
}

export interface BeehiivRosterIngestResult {
  processed: number;
  subscriptionsWritten: number;
  subscribeEvents: { newEvents: number; alreadyKnown: number };
  unsubEvents: { newEvents: number; alreadyKnown: number };
  recordsSkippedNoEmail: number;
  attributesWritten: number;
}

/**
 * Ingerir o ROSTER completo da Beehiiv (`subscribers.jsonl` de 1 snapshot)
 * — 1 `subscriber` + 1 `subscription` + (no mínimo) 1 evento `subscribe`
 * por assinante, gravados via `resolveOrCreateBeehiivSubscriber` (mesma
 * resolução de identidade da ingestão de engajamento — funde com um
 * subscriber já criado por post engagement, nunca duplica) +
 * `upsertSubscription`/`recordEvent`. Não classifica (F1/F4 do épico #7172
 * fazem isso na leitura); grava a atribuição CRUA como veio da Beehiiv.
 *
 * **De onde sai cada campo (`utm_source` dedicado + precedência do custom
 * field somados em #7207, fatia 12 do épico #7163):**
 * - `external_id` ← `id`; `status` ← `status`; `entered_at` ← `created`
 *   (Unix segundos → ISO); identidade ← `email`.
 * - `utm_source`/`utm_medium`/`utm_campaign`/`referring_site`: o custom
 *   field `origem_original` (#5231, JSON in-band gravado no momento de uma
 *   promoção Pending→ativo — ver `beehiiv-origem-original.ts`) tem
 *   PRECEDÊNCIA sobre os campos de TOPO do objeto quando presente — mesma
 *   regra que `build-origem-map.ts` já aplica na reconstrução histórica
 *   (#5842): é a origem verdadeira, os campos de topo podem já ter sido
 *   sobrescritos pelo evento de reativação. Sem o custom field, cai pros
 *   campos de topo (a Beehiiv, ao contrário do Kit, não esconde UTM atrás
 *   de `attribution` — ver `BeehiivBackupSubscriber`); sem os dois,
 *   `acquisition_source` (rastreamento de aquisição da própria Beehiiv,
 *   nunca confirmado ao vivo neste repo — ver docstring do campo em
 *   `BeehiivBackupSubscriber`) é o ÚLTIMO fallback só pra `utm_source`.
 *   `source` (coluna legada, #7174) grava o MESMO valor resolvido de
 *   `utm_source` — duplicado de propósito (ver docstring de
 *   `SubscriptionFields.utmSource`).
 * - `utm_channel` ← `acquisition_channel` (Beehiiv não tem campo `utm_channel`
 *   nativo nem no custom field `origem_original`). `origem_cadastro` não
 *   tem campo correspondente na Beehiiv — gravado `null`, mesma disciplina
 *   de "plataforma que não traz o campo" já documentada em
 *   `SubscriptionFields`.
 *
 * **Sem timestamp de saída** — a Beehiiv não expõe quando `status` virou
 * `inactive` (mesma limitação nomeada no docstring do módulo pra `sent`/
 * `bounce`), então `exitedAt` só pode ser o `now` da captura, gravado
 * **apenas na TRANSIÇÃO** (`wasExitedBefore`, lido ANTES do
 * `upsertSubscription` sobrescrever `exited_at` — mesmo padrão do #7222
 * finding 1 em `kit-subscribers-ingest.ts`, que corrigiu exatamente esta
 * classe de bug: sem o guard de transição, todo dia em que o snapshot
 * repete `status: "inactive"` reinseriria o evento `unsub` pra sempre,
 * porque a chave natural inclui o dia da captura).
 *
 * Idempotente: `upsertSubscription` faz `ON CONFLICT DO UPDATE` (nunca
 * duplica linha), `recordEvent` faz `INSERT OR IGNORE` sobre a chave
 * natural (nunca duplica evento).
 *
 * **`unsub` gravado aqui NÃO deduplica contra o `unsub` de
 * `ingestPostEngagement` (#7233 finding 2)** — chaves naturais diferentes
 * de propósito (`identity:unsub:status:capturaDay` aqui vs.
 * `identity:postId:unsub` lá), porque representam granularidades
 * diferentes do mesmo fato (transição de roster vs. status por post) sem
 * campo comum pra colidir sem perder informação. Ver docstring de
 * `getSubscriberTimeline` em `diaria-subscribers-db.ts` pra como ler
 * "assinante já se descadastrou" sem contar 2x.
 *
 * Registro sem `email` utilizável é contado em `recordsSkippedNoEmail` e
 * nunca vira subscriber — `parseSubscribersJsonl` já filtra por
 * `typeof email === "string"` na leitura, então isto é defesa em
 * profundidade, não o caminho esperado.
 */
export function ingestBeehiivRoster(
  db: DatabaseSync,
  subscribers: readonly BeehiivBackupSubscriber[],
  now: string = new Date().toISOString(),
): BeehiivRosterIngestResult {
  let processed = 0;
  let subscriptionsWritten = 0;
  let subscribeNew = 0;
  let subscribeKnown = 0;
  let unsubNew = 0;
  let unsubKnown = 0;
  let recordsSkippedNoEmail = 0;
  let attributesWritten = 0;

  for (const sub of subscribers) {
    const email = typeof sub.email === "string" ? sub.email.trim().toLowerCase() : "";
    if (!email) {
      recordsSkippedNoEmail++;
      continue;
    }
    const externalId = typeof sub.id === "string" && sub.id.trim() ? sub.id.trim() : null;

    const subscriberId = resolveOrCreateBeehiivSubscriber(db, { externalId, email }, now);
    if (subscriberId === null) {
      // Não deveria acontecer (email presente sempre permite criar via
      // `ensureSubscriber` dentro de `resolveOrCreateBeehiivSubscriber`) —
      // guard defensivo, mesmo destino de qualquer registro sem identidade
      // utilizável.
      recordsSkippedNoEmail++;
      continue;
    }
    processed++;

    const status = typeof sub.status === "string" && sub.status ? sub.status : null;
    const exited = status != null && BEEHIIV_EXITED_STATES.has(status);
    const enteredAt = typeof sub.created === "number" && Number.isFinite(sub.created)
      ? new Date(sub.created * 1000).toISOString()
      : null;

    // #7222 finding 1: ler ANTES do upsertSubscription abaixo sobrescrever
    // `exited_at` — só assim dá pra distinguir "já estava exited numa
    // rodada anterior" de "está transicionando para exited agora".
    const previousSubscription = db
      .prepare("SELECT exited_at FROM subscription WHERE subscriber_id = ? AND platform = 'beehiiv'")
      .get(subscriberId) as { exited_at: string | null } | undefined;
    const wasExitedBefore = previousSubscription != null && previousSubscription.exited_at != null;

    // #7207: `origem_original` (custom field in-band) tem precedência sobre
    // os campos de TOPO — mesma regra de `build-origem-map.ts` (#5842).
    // `acquisition_source` é o último fallback, só pra `utm_source`.
    const fromOrigemField = extractOrigemOriginalFromCustomFields(sub.custom_fields);
    const topLevelUtmSource = typeof sub.utm_source === "string" && sub.utm_source ? sub.utm_source : null;
    const acquisitionSource =
      typeof sub.acquisition_source === "string" && sub.acquisition_source ? sub.acquisition_source : null;
    const resolvedUtmSource = fromOrigemField?.utm_source ?? topLevelUtmSource ?? acquisitionSource;
    const resolvedUtmMedium =
      fromOrigemField?.utm_medium ??
      (typeof sub.utm_medium === "string" && sub.utm_medium ? sub.utm_medium : null);
    const resolvedUtmCampaign =
      fromOrigemField?.utm_campaign ??
      (typeof sub.utm_campaign === "string" && sub.utm_campaign ? sub.utm_campaign : null);
    const resolvedReferringSite =
      fromOrigemField?.referring_site ??
      (typeof sub.referring_site === "string" && sub.referring_site ? sub.referring_site : null);
    const utmChannel =
      typeof sub.acquisition_channel === "string" && sub.acquisition_channel ? sub.acquisition_channel : null;

    upsertSubscription(
      db,
      subscriberId,
      "beehiiv",
      {
        status,
        enteredAt,
        exitedAt: exited ? now : null,
        source: resolvedUtmSource,
        utmMedium: resolvedUtmMedium,
        utmCampaign: resolvedUtmCampaign,
        utmChannel,
        referringSite: resolvedReferringSite,
        utmSource: resolvedUtmSource,
      },
      now,
    );
    subscriptionsWritten++;

    const identityKey = externalId ?? email;

    if (enteredAt) {
      const { inserted } = recordEvent(db, {
        subscriberId,
        platform: "beehiiv",
        type: "subscribe",
        externalEventId: `${identityKey}:subscribe:${enteredAt}`,
        ts: enteredAt,
      });
      if (inserted) subscribeNew++;
      else subscribeKnown++;
    }

    if (exited && !wasExitedBefore) {
      // A Beehiiv não expõe timestamp de saída (ver docstring da função) —
      // só o ESTADO ATUAL, repetido em TODO snapshot enquanto o assinante
      // seguir `inactive`. Gravar só na TRANSIÇÃO é o que impede
      // reinserção sem limite (#7222 finding 1); chave natural usa o dia
      // da captura como camada extra de segurança, não como a regra.
      const captureDay = now.slice(0, 10);
      const { inserted } = recordEvent(db, {
        subscriberId,
        platform: "beehiiv",
        type: "unsub",
        externalEventId: `${identityKey}:unsub:${status}:${captureDay}`,
        ts: now,
      });
      if (inserted) unsubNew++;
      else unsubKnown++;
    } else if (exited) {
      unsubKnown++;
    }

    for (const attr of extractBeehiivCustomFieldAttributes(sub)) {
      upsertAttribute(db, subscriberId, "beehiiv", attr.key, attr.value, now);
      attributesWritten++;
    }
  }

  return {
    processed,
    subscriptionsWritten,
    subscribeEvents: { newEvents: subscribeNew, alreadyKnown: subscribeKnown },
    unsubEvents: { newEvents: unsubNew, alreadyKnown: unsubKnown },
    attributesWritten,
    recordsSkippedNoEmail,
  };
}

// ---------------------------------------------------------------------------
// applyBeehiivExitHistory (#7248) — refina `exited_at` de aproximação pra real
// ---------------------------------------------------------------------------
//
// `ingestBeehiivRoster` acima só sabe gravar em `exited_at` a data em que a
// TRANSIÇÃO foi DETECTADA (aproximação — a Beehiiv nunca devolveu esse
// campo pra REST). `applyBeehiivExitHistory` é o passo SEGUINTE, opcional:
// lê `data/beehiiv-backup/exit-history/subscribers.jsonl` (drenado via MCP
// `list_subscriptions`, ver `scripts/lib/beehiiv-exit-history.ts` e o agent
// `beehiiv-exit-history-drain`) e SUBSTITUI a aproximação pelo
// `unsubscribed_on` REAL, sempre que a MCP tiver confirmado esse assinante.

/** Linha crua de `subscription` lida de volta do SQLite pra refinar — só os
 *  campos que `upsertSubscription` exige repassar intactos (nenhum é
 *  recalculado aqui, exceto `exited_at`). */
interface ExistingBeehiivSubscriptionRow {
  status: string | null;
  entered_at: string | null;
  exited_at: string | null;
  source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_channel: string | null;
  referring_site: string | null;
  origem_cadastro: string | null;
  utm_source: string | null;
  utm_term: string | null;
  utm_content: string | null;
  atribuicao_fonte: string | null;
  reativado: number | null;
  origem_serie: string | null;
}

export interface BeehiivExitHistoryApplyResult {
  processed: number;
  /** `exited_at` foi sobrescrito com o valor real desta rodada. */
  updated: number;
  /** `exited_at` já era exatamente o valor real (rodada repetida). */
  unchanged: number;
  /** Sem `subscriber`/`subscription(beehiiv)` prévio pra refinar — exit-
   *  history nunca cria um do zero (ver docstring do módulo). */
  skippedNoSubscription: number;
  /** `subscription.status` gravado não é `"inactive"` no momento desta
   *  rodada — o registro de exit-history é de uma captura mais antiga (ou
   *  mais nova) que já não bate com o estado atual; nunca grava `exited_at`
   *  sobre um estado que discorda dele. */
  skippedStatusMismatch: number;
  skippedNoIdentity: number;
}

/**
 * Aplica os registros de `data/beehiiv-backup/exit-history/subscribers.jsonl`
 * — para cada um, encontra o `subscriber` já conhecido (nunca cria, ver
 * `findExistingBeehiivSubscriberId`) e, se a `subscription(beehiiv)` dele
 * estiver `status: "inactive"` no momento desta rodada, sobrescreve só
 * `exited_at` com o `unsubscribedOn` REAL — todos os outros campos são
 * relidos do banco e repassados intactos (`upsertSubscription` faz UPDATE
 * total da linha, não PATCH — ver docstring da função).
 *
 * **Idempotente e nunca regressivo**: reaplicar o mesmo registro não muda
 * nada (`unchanged`); um `exited_at` já real nunca é substituído por outro
 * valor sem ser literalmente o mesmo registro reaplicado (a única fonte que
 * escreve aqui é este módulo, com a mesma chave natural de identidade).
 *
 * **Nunca toca a coorte `invalid`** — não por um filtro explícito, mas por
 * CONSTRUÇÃO: nenhum registro de `invalid` chega a este array (a MCP não
 * expõe essa coorte, ver docstring de `beehiiv-exit-history.ts`), e mesmo
 * que um chegasse por engano, o guard `status !== "inactive"` (um
 * `subscriber` `invalid` está gravado com `status: "invalid"`, nunca
 * `"inactive"`) o rejeitaria. A aproximação de `ingestBeehiivRoster`
 * permanece a única fonte pra essa coorte — documentado, não esquecido.
 */
export function applyBeehiivExitHistory(
  db: DatabaseSync,
  records: readonly BeehiivExitHistoryRecord[],
  now: string = new Date().toISOString(),
): BeehiivExitHistoryApplyResult {
  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  let skippedNoSubscription = 0;
  let skippedStatusMismatch = 0;
  let skippedNoIdentity = 0;

  const selectExisting = db.prepare(
    `SELECT status, entered_at, exited_at, source, utm_medium, utm_campaign, utm_channel,
            referring_site, origem_cadastro, utm_source, utm_term, utm_content,
            atribuicao_fonte, reativado, origem_serie
     FROM subscription WHERE subscriber_id = ? AND platform = 'beehiiv'`,
  );

  for (const record of records) {
    processed++;
    const identity: BeehiivIdentity = { externalId: record.externalId, email: record.email };
    if (!identity.externalId && !identity.email) {
      skippedNoIdentity++;
      continue;
    }

    const subscriberId = findExistingBeehiivSubscriberId(db, identity);
    if (subscriberId === null) {
      skippedNoSubscription++;
      continue;
    }

    const existing = selectExisting.get(subscriberId) as ExistingBeehiivSubscriptionRow | undefined;
    if (!existing) {
      skippedNoSubscription++;
      continue;
    }
    if (existing.status !== "inactive") {
      skippedStatusMismatch++;
      continue;
    }
    if (existing.exited_at === record.unsubscribedOn) {
      unchanged++;
      continue;
    }

    upsertSubscription(
      db,
      subscriberId,
      "beehiiv",
      {
        status: existing.status,
        enteredAt: existing.entered_at,
        exitedAt: record.unsubscribedOn, // única mudança: aproximação -> real
        source: existing.source,
        utmMedium: existing.utm_medium,
        utmCampaign: existing.utm_campaign,
        utmChannel: existing.utm_channel,
        referringSite: existing.referring_site,
        origemCadastro: existing.origem_cadastro,
        utmSource: existing.utm_source,
        utmTerm: existing.utm_term,
        utmContent: existing.utm_content,
        atribuicaoFonte: existing.atribuicao_fonte,
        reativado: existing.reativado == null ? null : existing.reativado === 1,
        origemSerie: existing.origem_serie,
      },
      now,
    );
    updated++;
  }

  return { processed, updated, unchanged, skippedNoSubscription, skippedStatusMismatch, skippedNoIdentity };
}
