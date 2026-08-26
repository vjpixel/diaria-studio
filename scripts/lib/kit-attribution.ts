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
 * guarda os 7 campos que a Beehiiv mantinha por assinante. Medido em 26/08:
 * 586 dos 600 subscribers do Kit casam com o snapshot, e 100% desses têm
 * atribuição — é recuperação exata por e-mail, não inferência.
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
 * Pura — monta o objeto `fields` do PUT a partir de um registro da Beehiiv.
 *
 * Campo vazio na origem é OMITIDO, nunca gravado como string vazia: gravar
 * `""` tornaria "a Beehiiv não sabia" indistinguível de "ninguém
 * preencheu ainda", que é exatamente a ambiguidade que este backfill existe
 * pra desfazer. Devolve `null` quando não há atribuição nenhuma a gravar —
 * o caller pula o assinante em vez de fazer uma chamada que só escreveria o
 * marcador de procedência.
 */
export function buildAttributionFields(record: BeehiivSubscriberRecord): Record<string, string> | null {
  const fields: Record<string, string> = {};
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
  subscriberId: number;
  email: string;
  fields: Record<string, string>;
}

export interface PlanoBackfill {
  aplicar: PlanoEntry[];
  /** Já tinham `atribuicao_fonte` — pulados por idempotência. */
  jaFeitos: number;
  /** Sem registro correspondente no snapshot da Beehiiv (nasceram no Kit). */
  semOrigem: string[];
  /** Casaram, mas a Beehiiv também não tinha atribuição nenhuma. */
  origemVazia: string[];
}

export interface KitSubscriberLite {
  id: number;
  email_address: string;
  fields?: Record<string, unknown>;
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
  const plano: PlanoBackfill = { aplicar: [], jaFeitos: 0, semOrigem: [], origemVazia: [] };
  for (const kit of kitSubscribers) {
    const email = kit.email_address.toLowerCase();
    if (!opts.force && jaBackfillado(kit.fields)) {
      plano.jaFeitos++;
      continue;
    }
    const origem = beehiivPorEmail.get(email);
    if (!origem) {
      plano.semOrigem.push(email);
      continue;
    }
    const fields = buildAttributionFields(origem);
    if (!fields) {
      plano.origemVazia.push(email);
      continue;
    }
    plano.aplicar.push({ subscriberId: kit.id, email, fields });
  }
  return plano;
}
