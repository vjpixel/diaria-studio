/**
 * beehiiv-engagement-read.ts (#7460, residual do #7181/#7172)
 *
 * Leitor CANÔNICO do backup de per-subscriber engagement
 * (`data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl`) — a metade
 * que faltou no #7185, que corrigiu só o STORE
 * (`extractBeehiivIdentity`/`resolveOrCreateBeehiivSubscriber`, PR #7135,
 * teste de regressão das classes A e C). Sem este módulo, a fonte segue sem
 * guard: qualquer consumidor que faça `JSON.parse` direto no `.jsonl` cru
 * herda as mesmas 5 classes de contaminação que o #7181 mediu (1.147/51.620
 * linhas, 2,2%).
 *
 * ## As 5 classes medidas pelo #7181 (auditoria por assinatura de chaves)
 *
 * Assinatura canônica de referência:
 * `(acquisition_channel, acquisition_source, email, status, subscriber_id,
 * timestamp, total_clicked, total_opened)` — 50.473 linhas do acervo casam
 * por igualdade exata e trazem e-mail.
 *
 *   A — stub sintético: `{"subscriber_id":"s1"}`, o objeto INTEIRO. Nenhum
 *       dado real (nem status, nem timestamp) — descartado, nunca contado
 *       como registro utilizável.
 *   B — schema de `list_post_click_subscribers` (outro endpoint MCP,
 *       identidade de clique): `{subscription_id, email, url, url_hash,
 *       clicked_at, …}`. Payload LEGÍTIMO, mas de uma fonte diferente — não
 *       pertence ao `.jsonl` de engagement (roteado, nunca gravado lá).
 *   C — e-mail gravado no campo `subscriber_id` em vez de `email` (a chave
 *       `email` está AUSENTE). Recuperável: o leitor remapeia
 *       `subscriber_id → email` quando o valor casa `/@/`, preservando o
 *       registro em vez de descartá-lo.
 *   D — `email` presente mas `null` (ou ausente e `subscriber_id` não é
 *       e-mail) — evento real, mas sem identidade de e-mail para JOIN.
 *       Contado, nunca descartado, nunca fundido por engano com outro
 *       assinante.
 *   E — canônica **mais** `clicks: [...]` aninhado (múltiplos cliques por
 *       linha, cada entrada com `{subscription_id, url_hash, clicked_at}`).
 *       É o registro MAIS RICO do acervo — por isso o validador precisa ser
 *       por SUPERCONJUNTO, nunca por igualdade exata de chaves: um leitor
 *       que exigisse igualdade descartaria essas linhas por terem 1 chave
 *       "a mais".
 *
 * Núcleo mínimo exigido para uma linha contar como "engagement usável":
 * `subscriber_id` (ou `subscription_id`, alias observado ao vivo em
 * click-identity records, #7206) presente E (`status` de
 * `ENGAGEMENT_EVENT_STATUSES` OU `timestamp` presente) — `total_clicked`/
 * `total_opened`/`acquisition_channel`/`acquisition_source` são OPCIONAIS: o
 * acervo real tem variantes de resposta da MCP sem esses 2 últimos campos
 * (medido ao vivo, post `post_077f565f…`, 397/497 linhas re-drenadas em
 * 2026-09-04 sem `acquisition_channel`/`acquisition_source`) que são dado
 * genuíno, não contaminação — exigi-los quebraria essa variante real.
 *
 * ## Ordem de classificação (primeira que casa vence)
 *
 * 1. click-identity (classe B) — tem `clicked_at`/`url_hash`/
 *    `subscription_id` (ou `clicks[]` aninhado só de cliques) e NÃO tem
 *    `status` — é um registro de OUTRO endpoint, roteado, nunca gravado no
 *    `.jsonl` de engagement.
 * 2. stub sintético (classe A) — objeto com só a chave `subscriber_id` (ou
 *    `subscriber_id`+`subscription_id`, nenhuma outra) — descartado.
 * 3. malformado — não é objeto, ou não tem identidade nenhuma utilizável
 *    (nem `subscriber_id`/`subscription_id`, nem `email`) — descartado.
 * 4. e-mail remapeado (classe C) — sem chave `email`, mas `subscriber_id`
 *    contém `@` — remapeado, `email_recuperado: true`.
 * 5. sem e-mail (classe D) — `email` ausente/null e `subscriber_id` não é
 *    e-mail — contado, `has_email: false`.
 * 6. canônico (inclui classe E) — tudo o resto; `clicks[]`, se presente, é
 *    preservado verbatim em `clicks_preserved`.
 *
 * Tudo aqui é puro (sem IO) — o único consumidor de leitura analítica do
 * `.jsonl` cru (`readPostRecords` em `scripts/diaria-subscribers-ingest-
 * beehiiv.ts`) passa a chamar `readCanonicalEngagementFile`/
 * `classifyEngagementRecord` em vez de `JSON.parse` direto (troca de 1 call
 * site, fora do escopo desta issue — ver #7181 escopo).
 *
 * ## O caminho de escrita é exceção explícita
 *
 * `apply-mcp-subscriber-engagement.ts` (modo `--append`) continua lendo o
 * `.jsonl` cru direto (`readExistingRecords`), de propósito — filtrar ali
 * apagaria as linhas B/C do disco na próxima página aplicada, perda
 * irreversível numa fonte que só a MCP repõe. Este módulo é para LEITURA
 * analítica; o guard de escrita (`schema-fora-do-canonico`) usa
 * `classifyEngagementRecord` só para CONTAR a proporção não-canônica de um
 * lote recém-chegado, nunca para filtrar o que já está em disco.
 */

/** Shape tolerante de 1 linha do `.jsonl` — nenhum campo é assumido presente. */
export interface RawEngagementLine {
  subscriber_id?: unknown;
  subscription_id?: unknown;
  email?: unknown;
  status?: unknown;
  timestamp?: unknown;
  total_clicked?: unknown;
  total_opened?: unknown;
  acquisition_channel?: unknown;
  acquisition_source?: unknown;
  url?: unknown;
  url_hash?: unknown;
  clicked_at?: unknown;
  clicks?: unknown;
}

/** Valores de `status` que a MCP `list_post_subscriber_engagement` pode
 *  retornar (mesmo conjunto fechado de `beehiiv-engagement-manifest.ts`). */
export const ENGAGEMENT_EVENT_STATUSES = ["delivered", "opened", "clicked", "unsubscribed"] as const;

export type EngagementLineClass =
  | "canonical"
  | "click-identity"
  | "stub"
  | "email-remapped"
  | "no-email"
  | "malformed";

export interface ClassifiedEngagementLine {
  class: EngagementLineClass;
  /** Registro pronto pra uso analítico — `null` para `stub`/`malformed`/
   *  `click-identity` (roteados/descartados, nunca ficam no `.jsonl` de
   *  engagement). Para `email-remapped`, já vem com `email` preenchido a
   *  partir de `subscriber_id`. */
  record: Record<string, unknown> | null;
  /** Só presente em `email-remapped` (classe C). */
  email_recuperado?: true;
  /** Só presente em `no-email` (classe D) — `false` sempre, documentando a
   *  ausência (nunca omitido silenciosamente). */
  has_email?: false;
  /** Só presente quando o registro `canonical` carrega `clicks[]` aninhado
   *  (classe E) — preserva o array verbatim. */
  clicks_preserved?: unknown[];
  /** Motivo legível — só para `stub`/`malformed`/`click-identity`, usado em
   *  relatórios de migração/guard. */
  reason?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `true` quando o valor parece um e-mail (mesmo teste frouxo usado por
 *  `extractBeehiivIdentity` em `beehiiv-subscribers-ingest.ts` — só precisa
 *  de 1 `@`, não valida domínio: é remap de dado já observado no acervo,
 *  não validação de entrada nova). */
function looksLikeEmail(v: string): boolean {
  return v.includes("@");
}

/** Extrai os cliques (verbatim) de um possível `clicks: [...]` aninhado —
 *  `[]` se ausente/malformado, nunca lança. */
function extractClicksArray(record: RawEngagementLine): unknown[] {
  return Array.isArray(record.clicks) ? record.clicks : [];
}

/**
 * `true` quando 1 entrada solta (não aninhada) tem forma de clique —
 * `url`/`url_hash`/`clicked_at` no nível do próprio registro (shape FLAT de
 * `list_post_click_subscribers`, #7206). Deliberadamente NÃO inclui
 * `subscription_id` sozinho: esse campo também aparece como alias de
 * identidade em registros de engagement genuínos (#7206, `extractBeehiivIdentity`
 * tenta `subscription_id` quando `subscriber_id` falta) — exigir só ele
 * classificaria como clique um registro de engagement que meramente usa
 * `subscription_id` no lugar de `subscriber_id`.
 */
function hasFlatClickFields(record: RawEngagementLine): boolean {
  return typeof record.clicked_at === "string" || typeof record.url_hash === "string" || typeof record.url === "string";
}

/**
 * Classifica 1 linha crua do `.jsonl` de engagement (ou de um payload MCP
 * recém-chegado, antes de gravar) — ver docstring do módulo pra a ordem
 * completa e a semântica de cada classe.
 */
export function classifyEngagementRecord(raw: unknown): ClassifiedEngagementLine {
  if (!isPlainObject(raw)) {
    return { class: "malformed", record: null, reason: "linha não é um objeto JSON" };
  }
  const record = raw as RawEngagementLine;
  const hasStatus = typeof record.status === "string";
  const keys = Object.keys(record);

  // 1. click-identity (classe B) — nunca tem `status`; prova o clique via
  // campos flat OU `clicks[]` só de cliques (sem os outros campos de
  // engagement). Vem de list_post_click_subscribers, outro endpoint.
  if (!hasStatus && (hasFlatClickFields(record) || extractClicksArray(record).length > 0)) {
    return { class: "click-identity", record: null, reason: "schema de list_post_click_subscribers (classe B) — outro endpoint, roteado" };
  }

  // 2. stub sintético (classe A) — objeto cuja ÚNICA chave (ou única chave
  // além de `subscription_id`, alias observado) é `subscriber_id`, sem
  // nenhum dado de engagement real.
  const onlyIdentityKeys = keys.every((k) => k === "subscriber_id" || k === "subscription_id");
  if (onlyIdentityKeys && keys.length > 0 && !hasStatus && record.timestamp === undefined) {
    return { class: "stub", record: null, reason: `stub sintético (classe A) — só ${JSON.stringify(keys)}, nenhum dado de engagement` };
  }

  const externalId = nonEmptyString(record.subscriber_id) ?? nonEmptyString(record.subscription_id);
  const emailField = nonEmptyString(record.email);

  // 3. malformado — sem identidade nenhuma utilizável.
  if (!externalId && !emailField) {
    return { class: "malformed", record: null, reason: "sem subscriber_id/subscription_id nem email" };
  }

  const clicks = extractClicksArray(record);

  // 4. e-mail remapeado (classe C) — sem chave `email`, mas o e-mail está
  // no campo `subscriber_id`.
  if (!emailField && externalId && looksLikeEmail(externalId)) {
    const { subscriber_id: _sid, ...rest } = record as Record<string, unknown>;
    const remapped: Record<string, unknown> = { ...rest, subscriber_id: externalId, email: externalId.toLowerCase() };
    return {
      class: "email-remapped",
      record: remapped,
      email_recuperado: true,
      ...(clicks.length > 0 ? { clicks_preserved: clicks } : {}),
    };
  }

  // 5. sem e-mail (classe D) — `email` ausente/null e subscriber_id não é
  // e-mail (ou não há subscriber_id, só subscription_id opaco).
  if (!emailField) {
    return {
      class: "no-email",
      record: { ...record },
      has_email: false,
      ...(clicks.length > 0 ? { clicks_preserved: clicks } : {}),
    };
  }

  // 6. canônico (inclui classe E, com clicks[] preservado).
  return {
    class: "canonical",
    record: { ...record },
    ...(clicks.length > 0 ? { clicks_preserved: clicks } : {}),
  };
}

/** Classifica um array inteiro — usado tanto pelo leitor (arquivo já em
 *  disco) quanto pelo guard de escrita (payload recém-chegado, antes de
 *  gravar). */
export function classifyEngagementRecords(records: unknown[]): ClassifiedEngagementLine[] {
  return records.map((r) => classifyEngagementRecord(r));
}

export interface EngagementReadSummary {
  total: number;
  canonical: number;
  click_identity: number;
  stub: number;
  email_remapped: number;
  no_email: number;
  malformed: number;
}

export interface EngagementReadResult {
  /** Registros utilizáveis para análise — canonical + email-remapped +
   *  no-email (as 3 classes que carregam dado real de engagement). Nunca
   *  inclui stub/malformed/click-identity. */
  usable: Record<string, unknown>[];
  /** Registros classe B (click-identity), roteados — nunca gravados no
   *  `.jsonl` de engagement; o chamador decide o destino (migração escreve
   *  em `click-subscribers/{post_id}.jsonl`). */
  clickIdentity: Record<string, unknown>[];
  summary: EngagementReadSummary;
}

/**
 * Lê um array de linhas já parseadas (o chamador faz o `JSON.parse` por
 * linha — este módulo não faz IO) e separa nas populações que os
 * consumidores analíticos precisam: `usable` (dado real, com `email`
 * remapeado quando aplicável) e `clickIdentity` (classe B, nunca deveria
 * estar aqui). `summary` conta cada classe pra relatório/guard.
 */
export function readCanonicalEngagementRecords(rawRecords: unknown[]): EngagementReadResult {
  const classified = classifyEngagementRecords(rawRecords);
  const summary: EngagementReadSummary = {
    total: rawRecords.length,
    canonical: 0,
    click_identity: 0,
    stub: 0,
    email_remapped: 0,
    no_email: 0,
    malformed: 0,
  };
  const usable: Record<string, unknown>[] = [];
  const clickIdentity: Record<string, unknown>[] = [];

  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    switch (c.class) {
      case "canonical":
        summary.canonical++;
        usable.push(c.record!);
        break;
      case "email-remapped":
        summary.email_remapped++;
        usable.push(c.record!);
        break;
      case "no-email":
        summary.no_email++;
        usable.push(c.record!);
        break;
      case "click-identity":
        summary.click_identity++;
        clickIdentity.push(rawRecords[i] as Record<string, unknown>);
        break;
      case "stub":
        summary.stub++;
        break;
      case "malformed":
        summary.malformed++;
        break;
    }
  }

  return { usable, clickIdentity, summary };
}

/**
 * Proporção de linhas que NÃO são canônicas e TAMBÉM não casam o schema
 * legítimo de click-identity (classe B) — é a métrica do guard
 * `schema-fora-do-canonico` em `apply-mcp-subscriber-engagement.ts`: só
 * conta `stub`/`malformed` (lixo de verdade). `email-remapped`/`no-email`
 * são dado real (classes C/D, recuperável/contável) e não entram no
 * numerador — um lote inteiro de classe C não deveria virar `error`.
 */
export function nonCanonicalFraction(rawRecords: unknown[]): number {
  if (rawRecords.length === 0) return 0;
  const classified = classifyEngagementRecords(rawRecords);
  const garbage = classified.filter((c) => c.class === "stub" || c.class === "malformed").length;
  return garbage / rawRecords.length;
}
