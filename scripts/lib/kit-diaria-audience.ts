/**
 * scripts/lib/kit-diaria-audience.ts (#10437)
 *
 * Decide o `subscriber_filter` do broadcast PRINCIPAL da diária no Kit.
 *
 * Até o #10437 ele era sempre a base inteira (`buildAllSubscribersFilter`). A
 * issue tira do envio do Kit quem recebeu `min_mature_sends` edições sem abrir
 * nenhuma e passa essas pessoas pra Brevo, marcando-as com a tag `envio-brevo`
 * (decisão do editor, 19/10/2026: tag de exclusão, nunca descadastro). O
 * broadcast passa a mirar um SEGMENTO "ativos sem a tag `envio-brevo`", criado
 * à mão no painel do Kit (a API pública não cria segmento nem expõe a condição
 * dele, ver `apoio-segments-canonical-kit.ts`).
 *
 * ## Atrás de flag, desligada por default
 *
 * `platform.config.json` → `kit.diaria_exclusion_segment.enabled`. Com `false`
 * (ou o bloco ausente) o resultado é exatamente o de antes:
 * `buildAllSubscribersFilter()`, sem nenhuma chamada de rede. Ligar é decisão
 * do Gate B do #10437 (segmento confere ao vivo + recipients esperados).
 * `parseDiariaExclusionSegment` é o parser ÚNICO dessa config: publish,
 * schedule e o sync do Passo 3c leem por ele, então as três pontas nunca
 * discordam sobre "ligado" ou sobre um `segment_id` inválido.
 *
 * ## Falha segura (#6126, #7651)
 *
 * Com a flag ligada, qualquer coisa que impeça provar o segmento ABORTA:
 * `segment_id` ausente/inválido, `GET /v4/segments` falhando ou não listando o
 * id. Nunca cai pra base inteira: no Kit, filtro vazio = todo mundo, e cair
 * pra ele aqui mandaria a edição justamente pra quem acabou de ir pra Brevo
 * (envio duplicado em silêncio).
 *
 * Com a flag DESLIGADA e gente já movida (store da Brevo com contatos
 * `kit-sem-abertura:` em `in_brevo`), também aborta: a base inteira incluiria
 * todo movido, que já recebe pela Brevo. Desligar a flag com gente movida é
 * desfazer a movimentação, não um default seguro.
 *
 * ## Releitura (#6582)
 *
 * 2xx não prova o filtro. `verifyDiariaAudienceFilter` compara o
 * `subscriber_filter` relido do broadcast com o enviado por ESTRUTURA (tipo +
 * ids de cada condição), não por `JSON.stringify`: a ordem de chaves que o Kit
 * devolve não pode reprovar um filtro correto. Campo ausente na releitura
 * reprova (`ok: false`): o Gate B precisa provar que o Kit ecoa o campo antes
 * de ligar.
 */
import {
  buildAllSubscribersFilter,
  buildSegmentFilter,
  type AllSubscribersFilter,
  type KitSegment,
  type KitSubscriberFilter,
} from "./kit-broadcasts.ts";

/** Tag de exclusão do envio do Kit — quem a tem recebe a diária pela Brevo. */
export const KIT_ENVIO_BREVO_TAG_NAME = "envio-brevo";

/** Fatia de `platform.config.json` → `kit.diaria_exclusion_segment`. */
export interface DiariaExclusionSegmentConfig {
  enabled?: boolean;
  /** Id do segmento "ativos sem a tag envio-brevo", criado à mão no painel do Kit. */
  segment_id?: number | null;
}

export type DiariaExclusionSegmentParse =
  | { enabled: false }
  | { enabled: true; segmentId: number }
  | { error: string };

/**
 * Pura — parser ÚNICO de `kit.diaria_exclusion_segment`. Ausente ou
 * `enabled: false` ⇒ desligada. `enabled` não booleano, ou ligada com
 * `segment_id` que não seja inteiro positivo, é ERRO (nunca "desligada").
 */
export function parseDiariaExclusionSegment(cfg: unknown): DiariaExclusionSegmentParse {
  if (cfg === undefined || cfg === null) return { enabled: false };
  if (typeof cfg !== "object") return { error: `kit.diaria_exclusion_segment não é um objeto (${JSON.stringify(cfg)}).` };
  const c = cfg as { enabled?: unknown; segment_id?: unknown };
  if (c.enabled === undefined || c.enabled === false) return { enabled: false };
  if (c.enabled !== true) {
    return { error: `kit.diaria_exclusion_segment.enabled precisa ser booleano (veio ${JSON.stringify(c.enabled)}).` };
  }
  const id = c.segment_id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return {
      error:
        `kit.diaria_exclusion_segment.enabled = true, mas segment_id (${JSON.stringify(id)}) não é um id ` +
        "de segmento válido — abortando em vez de mandar pra base inteira (#10437, #6126).",
    };
  }
  return { enabled: true, segmentId: id };
}

export type DiariaAudienceResolution =
  | { ok: true; mode: "all"; filter: AllSubscribersFilter }
  | { ok: true; mode: "segment"; segmentId: number; filter: KitSubscriberFilter }
  | { ok: false; reason: string };

/**
 * Resolve a audiência do broadcast principal da diária. Flag desligada ⇒ base
 * inteira, sem chamar `listSegments`, salvo se `movedToBrevoCount > 0` (gente
 * já movida, ver docstring do módulo), caso em que aborta. Flag ligada ⇒
 * segmento confirmado na conta, ou `ok: false` (o caller aborta, nunca troca
 * por base inteira).
 */
export async function resolveDiariaAudience(
  cfg: DiariaExclusionSegmentConfig | undefined,
  deps: { listSegments: () => Promise<KitSegment[]> },
  ctx: { movedToBrevoCount?: number } = {},
): Promise<DiariaAudienceResolution> {
  const parsed = parseDiariaExclusionSegment(cfg);
  if ("error" in parsed) return { ok: false, reason: parsed.error };
  if (!parsed.enabled) {
    const moved = ctx.movedToBrevoCount ?? 0;
    if (moved > 0) {
      return {
        ok: false,
        reason:
          `kit.diaria_exclusion_segment está desligado, mas o store da Brevo tem ${moved} contato(s) ` +
          "kit-sem-abertura: em in_brevo (movidos pelo #10437). A base inteira entregaria a edição em dobro a " +
          "todos eles — religue o segmento, ou devolva esses contatos ao Kit antes de desligar.",
      };
    }
    return { ok: true, mode: "all", filter: buildAllSubscribersFilter() };
  }
  const segmentId = parsed.segmentId;
  let segments: KitSegment[];
  try {
    segments = await deps.listSegments();
  } catch (e) {
    return {
      ok: false,
      reason:
        `não foi possível listar os segmentos do Kit pra confirmar o segmento ${segmentId} ` +
        `(${(e as Error).message}) — abortando em vez de mandar pra base inteira (#10437, #6126).`,
    };
  }
  if (!segments.some((s) => s.id === segmentId)) {
    return {
      ok: false,
      reason:
        `segmento ${segmentId} não existe na conta do Kit (GET /v4/segments devolveu ${segments.length} segmento(s)) ` +
        "— abortando em vez de mandar pra base inteira (#10437, #6126).",
    };
  }
  return { ok: true, mode: "segment", segmentId, filter: buildSegmentFilter(segmentId) };
}

export type DiariaAudienceVerification = { ok: true } | { ok: false; reason: string };

/** Pura — forma canônica (tipo + ids ordenados, por grupo) de um filtro; `null` se o shape não for de filtro. */
function canonicalFilter(raw: unknown): string[][] | null {
  if (!Array.isArray(raw)) return null;
  const groups: string[][] = [];
  for (const g of raw) {
    const all = (g as { all?: unknown } | null)?.all;
    if (!Array.isArray(all)) return null;
    const conds: string[] = [];
    for (const c of all) {
      const type = (c as { type?: unknown } | null)?.type;
      const ids = (c as { ids?: unknown } | null)?.ids;
      if (typeof type !== "string" || !Array.isArray(ids) || !ids.every((i) => typeof i === "number")) return null;
      conds.push(`${type}:${[...(ids as number[])].sort((a, b) => a - b).join(",")}`);
    }
    groups.push(conds.sort());
  }
  return groups;
}

/**
 * Pura — confere o `subscriber_filter` relido do broadcast contra o enviado.
 * Ausente reprova (ver docstring do módulo): sem eco do campo, nada prova que
 * o broadcast não saia pra base inteira.
 */
export function verifyDiariaAudienceFilter(reread: unknown, expected: KitSubscriberFilter): DiariaAudienceVerification {
  if (reread === undefined || reread === null) {
    return {
      ok: false,
      reason:
        "a releitura do broadcast não trouxe 'subscriber_filter' — o segmento não pode ser confirmado " +
        "(2xx não é prova, #6582).",
    };
  }
  const got = canonicalFilter(reread);
  const want = canonicalFilter(expected);
  if (got === null || want === null || JSON.stringify(got) !== JSON.stringify(want)) {
    return {
      ok: false,
      reason:
        `a releitura mostra subscriber_filter DIVERGENTE: esperado ${JSON.stringify(expected)}, ` +
        `recebido ${JSON.stringify(reread)} (#6582).`,
    };
  }
  return { ok: true };
}
