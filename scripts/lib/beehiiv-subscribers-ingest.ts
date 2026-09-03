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
 *   - `"unsub"`     — se `status === "unsubscribed"`.
 *
 * ## Sem `sent`, sem `bounce` (mesma limitação nomeada na issue #7104)
 *
 * O backup não tem eixo `sent` — só `delivered` em diante (a MCP
 * `list_post_subscriber_engagement` não expõe quem foi TENTADO, só quem
 * recebeu). `sent − delivered` (como o Kit deriva bounce) não é derivável
 * desta fonte — decisão explícita de não buscar `sent` na API pra fechar
 * esse eixo: `leitor-v1` não usa bounce, e o custo de rede não se paga por
 * um eixo que ninguém consome hoje (mesmo raciocínio do corpo da issue).
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureSubscriber, recordEvent, type EventType } from "./diaria-subscribers-db.ts";

/** Shape tolerante de 1 linha do JSONL — campos podem faltar (registro
 *  malformado, ou resposta parcial da MCP já gravada por uma corrida antiga
 *  da fatia 1). Nenhum campo é assumido presente sem checagem. */
export interface BeehiivEngagementRecord {
  subscriber_id?: unknown;
  email?: unknown;
  status?: unknown;
  timestamp?: unknown;
  total_clicked?: unknown;
  total_opened?: unknown;
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
    typeof record.subscriber_id === "string" && record.subscriber_id.trim() ? record.subscriber_id.trim() : null;
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
