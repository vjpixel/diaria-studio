/**
 * scripts/lib/mensal/apoiadores-kit-channel.ts (#7633, dobrado sobre o
 * genérico em #7681)
 *
 * O que este módulo tem de PRÓPRIO do envio mensal pra apoiadores é pequeno:
 * quais níveis recebem, qual chave de `platform.config.json` carrega o nome da
 * tag, e qual comando popula essa tag. Todo o resto — por que a audiência é
 * uma tag e não um segmento, como o diff casa, quando o blast radius bloqueia
 * — é idêntico a qualquer canal do Kit mirado por nível de apoio, e mora em
 * `lib/shared/kit-apoio-tag.ts`.
 *
 * ## A dobra (#7681)
 *
 * A versão original (#7633) implementava tudo aqui. Quando o 2º canal do mesmo
 * formato apareceu (#7659, e-mail do Artigo Especial pra apoio R$10+), o
 * genérico nasceu em `shared/` — mas este módulo NÃO foi reescrito na hora,
 * porque a #7651 estava em voo tocando-o e o conflito custaria mais do que a
 * duplicação temporária valia. Enquanto as duas conviveram,
 * `test/kit-apoio-tag-parity-7659.test.ts` travou as implementações contra os
 * mesmos casos pra que não divergissem em silêncio; com a dobra feita, aquele
 * teste perdeu o sentido e saiu junto.
 *
 * Os nomes exportados aqui foram PRESERVADOS (têm consumidores:
 * `publish-monthly-apoiadores-kit.ts`, `sync-apoio-mensal-tag-kit.ts`,
 * `send-monthly-apoiadores.ts`) — o que mudou é que agora são fachada fina, e
 * não uma segunda implementação.
 *
 * ## Por que TAG e não SEGMENT — a armadilha central deste canal
 *
 * Resumo; o detalhe medido está em `lib/shared/kit-apoio-tag.ts`. O Kit não
 * tem "lista" como a Brevo, e `POST /v4/broadcasts` só aceita
 * `subscriber_filter` de tipo `tag` ou `segment`. Os 6 segmentos `Apoio — {…}`
 * da conta parecem o alvo óbvio e não servem: a membresia de segmento não é
 * legível pela API (`GET /v4/subscribers?segment_id=X` ignora o parâmetro em
 * silêncio, medido nos 6 em 24/08/2026), então mirar segmento é enviar sem
 * poder conferir a audiência — nem antes, nem depois.
 *
 * ## A tag é PROJEÇÃO do custom field, não uma 2ª fonte de verdade
 *
 * Quem decide o nível de cada pessoa continua sendo `sync-apoio-nivel-kit.ts`
 * (#6049), que grava `apoio_nivel` a partir do apoia.se com carência de 1 mês.
 * `sync-apoio-mensal-tag-kit.ts` só projeta esse campo em membresia de tag.
 */

import type { ApoioNivel } from "../apoio-segments-canonical-kit.ts";
import {
  resolveAudienceTagName,
  resolveAudienceTagId,
  checkAudienceNotEmpty,
  diffTagMembership,
  evaluateTagBlastRadius,
  APOIO_TAG_BLAST_RADIUS_THRESHOLD,
  type TagNameResolution,
  type TagIdResolution,
  type AudienceCheck,
  type TagMembershipDiff,
  type BlastRadiusResult,
  type ResolvedAudience,
} from "../shared/kit-apoio-tag.ts";

/**
 * Níveis que recebem o envio extra — decisão 2 do #4482, preservada em todas
 * as trocas de canal (Beehiiv → Brevo → Kit): só quem apoia em Mantenedor ou
 * Patrono, nunca a base inteira nem os níveis abaixo.
 */
export const APOIADORES_MENSAL_NIVEIS: readonly ApoioNivel[] = ["mantenedor", "patrono"] as const;

/** Chave de `platform.config.json` que carrega o nome da tag deste canal. */
const CONFIG_PATH = "kit_apoiadores.audience_tag";

/** Comando que cria/popula a tag — entra nas mensagens de erro dos guards,
 *  que só são acionáveis se disserem o que rodar. */
export const APOIADORES_TAG_SYNC_COMMAND = "npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push";

/** Config de `platform.config.json` → `kit_apoiadores`. */
export interface KitApoiadoresChannelConfig {
  /** Nome da tag de audiência no Kit. Resolvida por NOME em runtime (o id é
   *  por-conta, nunca hardcoded — mesma disciplina de `kit_diaria`). */
  audience_tag?: string;
}

// ── fachada sobre os guards genéricos ─────────────────────────────────────
//
// Os aliases de tipo existem pros consumidores que já os importam pelo nome
// antigo; são o MESMO tipo, não cópias.

export type ApoiadoresTagNameResolution = TagNameResolution;
export type ApoiadoresTagIdResolution = TagIdResolution;
export type ApoiadoresAudienceCheck = AudienceCheck;
export type ApoiadoresTagDiff = TagMembershipDiff;
export type ApoiadoresBlastRadiusResult = BlastRadiusResult;

/**
 * Prova, no tipo, de que a audiência passou pelos três guards (#7651). Alias
 * do `ResolvedAudience` genérico — a marca é a mesma, então um valor produzido
 * aqui e um produzido pelo canal do Artigo Especial são intercambiáveis por
 * construção, o que é correto: os dois significam "tag existente, id válido,
 * pelo menos 1 membro".
 */
export type ResolvedAudienceTag = ResolvedAudience;

export function resolveApoiadoresTagName(
  config: KitApoiadoresChannelConfig | undefined | null,
): ApoiadoresTagNameResolution {
  return resolveAudienceTagName(config?.audience_tag, CONFIG_PATH);
}

export function resolveApoiadoresTagId(tagName: string, tagId: number | null): ApoiadoresTagIdResolution {
  return resolveAudienceTagId(tagName, tagId, APOIADORES_TAG_SYNC_COMMAND);
}

export function checkApoiadoresAudienceNotEmpty(tagName: string, memberCount: number): ApoiadoresAudienceCheck {
  return checkAudienceNotEmpty(tagName, memberCount, APOIADORES_TAG_SYNC_COMMAND);
}

/**
 * Fecha o encadeamento dos três guards num único valor que o construtor do
 * payload aceita. Devolve `null` se qualquer um deles reprovou — o caller já
 * reportou o motivo específico e não deve seguir.
 *
 * Recebe os RESULTADOS (não faz I/O nem revalida): manter a checagem e a prova
 * em funções separadas é o que permite ao caller logar a razão exata de cada
 * falha, que é o que o operador lê pra saber o que corrigir. É por isso que
 * este canal usa esta função em vez de `resolveVerifiedAudience` (a variante
 * genérica que faz o lookup ela mesma): aqui as três chamadas de rede já estão
 * espalhadas no `main()`, cada uma com seu log.
 */
export function resolveApoiadoresAudience(
  tagNameResolution: ApoiadoresTagNameResolution,
  tagIdResolution: ApoiadoresTagIdResolution,
  audienceCheck: ApoiadoresAudienceCheck,
): ResolvedAudienceTag | null {
  if (!tagNameResolution.ok || !tagIdResolution.ok || !audienceCheck.ok) return null;
  return {
    tagId: tagIdResolution.tagId,
    tagName: tagNameResolution.tagName,
    memberCount: audienceCheck.memberCount,
  } as ResolvedAudienceTag;
}

export function diffApoiadoresTagMembership(
  desiredEmails: readonly string[],
  currentEmails: readonly string[],
): ApoiadoresTagDiff {
  return diffTagMembership(desiredEmails, currentEmails);
}

/** Mesma proporção do guard de `sync-apoio-nivel-beehiiv.ts` — remover mais de
 *  30% da audiência numa rodada é sinal de dado parcial, não de 30% dos
 *  apoiadores terem cancelado no mesmo dia. */
export const APOIADORES_TAG_BLAST_RADIUS_THRESHOLD = APOIO_TAG_BLAST_RADIUS_THRESHOLD;

export function evaluateApoiadoresBlastRadius(
  removalCount: number,
  currentCount: number,
  force: boolean,
): ApoiadoresBlastRadiusResult {
  return evaluateTagBlastRadius(removalCount, currentCount, force);
}
