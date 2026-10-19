/**
 * scripts/lib/kit-diaria-audience.ts (#10437)
 *
 * Decide o `subscriber_filter` do broadcast PRINCIPAL da diária no Kit.
 *
 * Até o #10437 ele era sempre a base inteira (`buildAllSubscribersFilter`). A
 * issue tira do envio do Kit quem recebeu 6 edições sem abrir nenhuma e passa
 * essas pessoas pra Brevo, marcando-as com a tag `envio-brevo` (decisão do
 * editor, 19/10/2026: tag de exclusão, nunca descadastro). O broadcast passa a
 * mirar um SEGMENTO "ativos sem a tag `envio-brevo`", criado à mão no painel do
 * Kit (a API pública não cria segmento nem expõe a condição dele, ver
 * `apoio-segments-canonical-kit.ts`).
 *
 * ## Atrás de flag, desligada por default
 *
 * `platform.config.json` → `kit.diaria_exclusion_segment.enabled`. Com `false`
 * (ou o bloco ausente) o resultado é exatamente o de antes:
 * `buildAllSubscribersFilter()`, sem nenhuma chamada de rede. Ligar é decisão
 * do Gate B do #10437 (segmento confere ao vivo + recipients esperados).
 *
 * ## Falha segura (#6126, #7651)
 *
 * Com a flag ligada, qualquer coisa que impeça provar o segmento ABORTA:
 * `segment_id` ausente/inválido, `GET /v4/segments` falhando ou não listando o
 * id. Nunca cai pra base inteira — no Kit, filtro vazio = todo mundo, e cair
 * pra ele aqui mandaria a edição justamente pra quem acabou de ir pra Brevo
 * (envio duplicado em silêncio).
 *
 * ## Releitura (#6582)
 *
 * 2xx não prova o filtro. `verifyDiariaAudienceFilter` compara o
 * `subscriber_filter` relido do broadcast com o enviado. Com a flag ligada,
 * campo ausente na releitura também reprova (`verified: null` vira erro no
 * caller): o Gate B precisa provar que o Kit ecoa o campo antes de ligar.
 */
import { buildAllSubscribersFilter, buildSegmentFilter, type KitAudienceFilter, type KitSegment, type KitSubscriberFilter } from "./kit-broadcasts.ts";

/** Tag de exclusão do envio do Kit — quem a tem recebe a diária pela Brevo. */
export const KIT_ENVIO_BREVO_TAG_NAME = "envio-brevo";

/** Fatia de `platform.config.json` → `kit.diaria_exclusion_segment`. */
export interface DiariaExclusionSegmentConfig {
  enabled?: boolean;
  /** Id do segmento "ativos sem a tag envio-brevo", criado à mão no painel do Kit. */
  segment_id?: number | null;
}

export type DiariaAudienceResolution =
  | { ok: true; mode: "all"; filter: KitAudienceFilter }
  | { ok: true; mode: "segment"; segmentId: number; filter: KitSubscriberFilter }
  | { ok: false; reason: string };

/** Pura — a flag está ligada? Ausente ⇒ desligada. */
export function isDiariaExclusionSegmentEnabled(cfg: DiariaExclusionSegmentConfig | undefined): boolean {
  return cfg?.enabled === true;
}

/**
 * Resolve a audiência do broadcast principal da diária. Flag desligada ⇒ base
 * inteira, sem chamar `listSegments`. Flag ligada ⇒ segmento confirmado na
 * conta, ou `ok: false` (o caller aborta, nunca troca por base inteira).
 */
export async function resolveDiariaAudience(
  cfg: DiariaExclusionSegmentConfig | undefined,
  deps: { listSegments: () => Promise<KitSegment[]> },
): Promise<DiariaAudienceResolution> {
  if (!isDiariaExclusionSegmentEnabled(cfg)) {
    return { ok: true, mode: "all", filter: buildAllSubscribersFilter() };
  }
  const segmentId = cfg?.segment_id;
  if (typeof segmentId !== "number" || !Number.isInteger(segmentId) || segmentId <= 0) {
    return {
      ok: false,
      reason:
        `kit.diaria_exclusion_segment.enabled = true, mas segment_id (${JSON.stringify(segmentId)}) não é um id ` +
        "de segmento válido — abortando em vez de mandar pra base inteira (#10437, #6126).",
    };
  }
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
  if (JSON.stringify(reread) !== JSON.stringify(expected)) {
    return {
      ok: false,
      reason:
        `a releitura mostra subscriber_filter DIVERGENTE: esperado ${JSON.stringify(expected)}, ` +
        `recebido ${JSON.stringify(reread)} (#6582).`,
    };
  }
  return { ok: true };
}
