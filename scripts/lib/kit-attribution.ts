/**
 * scripts/lib/kit-attribution.ts (#6318)
 *
 * Miolo PURO do backfill de atribuição na base Kit — nenhuma rede, nenhum
 * disco, pra ser testável sem mock de API.
 *
 * ## O problema que isto resolve
 *
 * O switchover pro Kit (#6048/#6114) trouxe a base da Beehiiv sem a camada
 * de atribuição: `POST /v4/subscribers` não aceita UTM/referrer, e a
 * atribuição NATIVA do Kit é inalcançável por quem cria subscriber via API
 * (medido no #6318 — o `referrer` do endpoint de form persiste no vínculo
 * subscriber↔form, legível em `GET /v4/forms/{id}/subscribers`, mas nunca
 * chega ao bloco `attribution` do subscriber). Custom field é, hoje, o
 * único lugar onde essa informação fica ao lado do assinante.
 *
 * O dado de origem existe: `data/beehiiv-backup/{data}/subscribers.jsonl`
 * guarda os 7 campos que a Beehiiv mantinha por assinante. Medido em
 * 26/08/2026 **contra o snapshot de 23/08** (o de 26/08 ainda não tinha
 * `subscribers.jsonl` quando esta medição rodou): 586 dos 600 subscribers do
 * Kit casaram, e 100% desses tinham atribuição — recuperação exata por
 * e-mail, não inferência. Reconferir contra o `--push` real antes de tratar
 * 586 como número final; um snapshot mais novo tende a cobrir parte dos 14
 * restantes (quase todos contas de teste).
 *
 * ## Por que 7 campos, e não os 4 que os workers escrevem
 *
 * Os workers derivam um TRIPLO da superfície (`SUBSCRIBE_UTM_BY_SOURCE`) +
 * `referring_site`. A Beehiiv guardava 7, e `utm_channel` é o que separa
 * `website` de `boost`/`api`/`import` — sem ele, crescimento orgânico e
 * boost pago viram a mesma linha na série. Os campos existem para o dado
 * mais rico; que os funis só preencham 4 deles é esperado, não um bug.
 *
 * ## `atribuicao_fonte`
 *
 * Três confiabilidades convivem na mesma base e não podem ser lidas como
 * iguais: `beehiiv-import` (exato, do snapshot), `reconstruido-logs`
 * (inferido por timestamp a partir dos Workers Logs, #6318 Passo 4) e o que
 * os funis gravarem nativamente daqui pra frente. Mesma disciplina do
 * `reconciliacao-6269` no switchover — marcar a procedência em vez de
 * deixar dado de qualidade diferente indistinguível.
 */

/** Registro de assinante como o snapshot da Beehiiv o grava. */
export interface BeehiivSubscriberRecord {
  email: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_channel?: string;
  utm_term?: string;
  utm_content?: string;
  referring_site?: string;
}

/** Valor de `atribuicao_fonte` gravado por este backfill. */
export const ATRIBUICAO_FONTE_BEEHIIV = "beehiiv-import";

/**
 * Campos de atribuição prontos pra gravar no Kit — sempre com
 * `atribuicao_fonte` e ao menos 1 UTM, todos não-vazios e trimados.
 *
 * Existe como alias nomeado só pra que `AttributionFields | null` na
 * assinatura de `buildAttributionFields` faça o `null` significar alguma
 * coisa no hover: **`null` = nada a gravar**, nunca erro nem "não sei".
 * Deixar `Record<string, string> | null` cru obrigaria todo call site futuro
 * a abrir o docstring pra saber disso — a mesma classe de silêncio que esta
 * PR combate em outro lugar.
 */
export type AttributionFields = Record<string, string>;

/**
 * Os 7 campos de atribuição da Beehiiv, na ordem em que aparecem no
 * snapshot. Chave do custom field no Kit = mesmo nome (criados com esses
 * labels em 26/08).
 */
export const ATTRIBUTION_FIELD_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_channel",
  "utm_term",
  "utm_content",
  "referring_site",
] as const;

/**
 * Pura — monta o objeto `fields` do PATCH a partir de um registro da Beehiiv.
 *
 * Campo vazio na origem é OMITIDO, nunca gravado como string vazia: gravar
 * `""` tornaria "a Beehiiv não sabia" indistinguível de "ninguém
 * preencheu ainda", que é exatamente a ambiguidade que este backfill existe
 * pra desfazer. Devolve `null` quando não há atribuição nenhuma a gravar —
 * o caller pula o assinante em vez de fazer uma chamada que só escreveria o
 * marcador de procedência.
 */
export function buildAttributionFields(record: BeehiivSubscriberRecord): AttributionFields | null {
  const fields: AttributionFields = {};
  for (const key of ATTRIBUTION_FIELD_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") fields[key] = value.trim();
  }
  if (Object.keys(fields).length === 0) return null;
  fields.atribuicao_fonte = ATRIBUICAO_FONTE_BEEHIIV;
  return fields;
}

/**
 * Pura — este assinante do Kit já foi backfillado?
 *
 * Idempotência olha `atribuicao_fonte`, não os campos de UTM: um assinante
 * cuja origem na Beehiiv tinha só `utm_source` ficaria com os outros 6
 * vazios pra sempre, e checar "algum UTM preenchido" o reprocessaria a cada
 * rodada. O marcador de procedência é o único campo que o backfill sempre
 * grava, então é o único sinal confiável de "já passou por aqui".
 */
export function jaBackfillado(kitFields: Record<string, unknown> | undefined): boolean {
  const marcador = kitFields?.atribuicao_fonte;
  return typeof marcador === "string" && marcador.trim() !== "";
}

export interface PlanoEntry {
  readonly subscriberId: number;
  readonly email: string;
  readonly fields: AttributionFields;
}

/**
 * Resultado JÁ DECIDIDO do cruzamento — `readonly` de ponta a ponta de
 * propósito: é uma decisão computada, não um buffer pra acumular depois.
 * Sem isso nada impediria um caller de `plano.aplicar.push(...)` e quebrar a
 * partição que `montarPlano` garante.
 */
export interface PlanoBackfill {
  readonly aplicar: readonly PlanoEntry[];
  /** Já tinham `atribuicao_fonte` — pulados por idempotência. */
  readonly jaFeitos: number;
  /** Sem registro correspondente no snapshot da Beehiiv (nasceram no Kit). */
  readonly semOrigem: readonly string[];
  /** Casaram, mas a Beehiiv também não tinha atribuição nenhuma. */
  readonly origemVazia: readonly string[];
}

export interface KitSubscriberLite {
  id: number;
  email_address: string;
  fields?: Record<string, unknown>;
}

// ── Parte A do #6425 — atribuição NATIVA do form hospedado no Kit ─────────
//
// O docstring acima ("a atribuição NATIVA do Kit é inalcançável") só vale
// pra quem é criado via API. Quem se cadastra pelo form nativo
// (`https://diar-ia-br.kit.com/`) NÃO passa por `subscribeToKit`
// (`workers/poll/src/subscribe.ts`), então nenhum custom field é escrito —
// mas o Kit guarda a atribuição do form no bloco `attribution`, legível via
// `GET /v4/subscribers?include[]=attribution` (medido ao vivo no #6425:
// `referrer`, `source_type`, `source_name`, `source_mechanism` sempre
// presentes; `utm_*` só quando a visita trouxe parâmetro na URL). Isto é
// RECUPERAÇÃO EXATA de um dado que o Kit já guarda, não inferência — por
// isso ganha `atribuicao_fonte` PRÓPRIO (`kit-nativo-form`), distinto de
// `beehiiv-import`/`reconstruido-logs`: a confiabilidade é alta (dado
// nativo do próprio Kit), mas o UTM pode legitimamente vir vazio quando a
// visita não trouxe parâmetro nenhum — isso não é falha de recuperação.

/** `atribuicao_fonte` gravado por este 2º backfill (Parte A do #6425). */
export const ATRIBUICAO_FONTE_KIT_NATIVO_FORM = "kit-nativo-form";

/** Bloco `attribution` como `GET /v4/subscribers?include[]=attribution`
 *  devolve por subscriber. */
export interface KitNativeAttribution {
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  source_type?: string | null;
  source_name?: string | null;
  source_mechanism?: string | null;
}

export interface KitSubscriberComAtribuicao extends KitSubscriberLite {
  attribution?: KitNativeAttribution | null;
}

/**
 * Pura — monta os custom fields a partir do bloco `attribution` nativo do
 * Kit. Só os 4 campos que têm equivalente direto nos nossos custom fields
 * (`utm_source`/`utm_medium`/`utm_campaign`/`referring_site`, via
 * `referrer`) são copiados — `source_type`/`source_name`/`source_mechanism`
 * não têm campo próprio hoje (não existiam antes desta issue) e ficariam
 * sem nenhum consumidor; adicionar 3 custom fields novos só pra guardar
 * "form_subscription"/"Newsletter site"/"newsletter" (sempre os mesmos 3
 * valores pra todo mundo que vem do form, #6425) não paga o custo. Mesma
 * disciplina de `buildAttributionFields`: campo vazio é OMITIDO, nunca
 * gravado como `""`; devolve `null` quando não há nada a gravar (o form
 * respondeu, mas a visita não trouxe UTM nem referrer).
 */
export function buildNativeFormAttributionFields(
  attribution: KitNativeAttribution,
): AttributionFields | null {
  const fields: AttributionFields = {};
  const utmSource = attribution.utm_source?.trim();
  const utmMedium = attribution.utm_medium?.trim();
  const utmCampaign = attribution.utm_campaign?.trim();
  const referrer = attribution.referrer?.trim();
  if (utmSource) fields.utm_source = utmSource;
  if (utmMedium) fields.utm_medium = utmMedium;
  if (utmCampaign) fields.utm_campaign = utmCampaign;
  if (referrer) fields.referring_site = referrer;
  if (Object.keys(fields).length === 0) return null;
  fields.atribuicao_fonte = ATRIBUICAO_FONTE_KIT_NATIVO_FORM;
  return fields;
}

/**
 * Pura — mesmo formato de `PlanoBackfill`/`montarPlano` acima, mas cruzando
 * contra o bloco `attribution` nativo do Kit (Parte A do #6425) em vez do
 * snapshot da Beehiiv — não há "casar por e-mail" aqui, o dado já vem
 * anexado ao próprio subscriber. `semOrigem` = subscriber sem bloco
 * `attribution` nenhum (criado via API, cai fora do escopo desta função —
 * é candidato do backfill original, `montarPlano`, não deste); `origemVazia`
 * = tem `attribution`, mas nenhum campo útil (form sem UTM/referrer — caso
 * legítimo, não erro).
 */
export function montarPlanoNativo(
  kitSubscribers: KitSubscriberComAtribuicao[],
  opts: { force?: boolean } = {},
): PlanoBackfill {
  const aplicar: PlanoEntry[] = [];
  const semOrigem: string[] = [];
  const origemVazia: string[] = [];
  let jaFeitos = 0;
  for (const kit of kitSubscribers) {
    const email = kit.email_address.toLowerCase();
    if (!opts.force && jaBackfillado(kit.fields)) {
      jaFeitos++;
      continue;
    }
    if (!kit.attribution) {
      semOrigem.push(email);
      continue;
    }
    const fields = buildNativeFormAttributionFields(kit.attribution);
    if (!fields) {
      origemVazia.push(email);
      continue;
    }
    aplicar.push({ subscriberId: kit.id, email, fields });
  }
  return { aplicar, jaFeitos, semOrigem, origemVazia };
}

/**
 * Pura — cruza a base Kit com o snapshot Beehiiv e devolve o plano completo,
 * incluindo o que NÃO vai ser tocado e por quê. O caller imprime isso antes
 * de escrever: um backfill que só reporta os acertos esconde exatamente a
 * população que continua sem atribuição.
 */
export function montarPlano(
  kitSubscribers: KitSubscriberLite[],
  beehiivPorEmail: Map<string, BeehiivSubscriberRecord>,
  opts: { force?: boolean } = {},
): PlanoBackfill {
  const aplicar: PlanoEntry[] = [];
  const semOrigem: string[] = [];
  const origemVazia: string[] = [];
  let jaFeitos = 0;
  for (const kit of kitSubscribers) {
    const email = kit.email_address.toLowerCase();
    if (!opts.force && jaBackfillado(kit.fields)) {
      jaFeitos++;
      continue;
    }
    const origem = beehiivPorEmail.get(email);
    if (!origem) {
      semOrigem.push(email);
      continue;
    }
    const fields = buildAttributionFields(origem);
    if (!fields) {
      origemVazia.push(email);
      continue;
    }
    aplicar.push({ subscriberId: kit.id, email, fields });
  }
  return { aplicar, jaFeitos, semOrigem, origemVazia };
}
