/**
 * scripts/lib/mensal/apoiadores-kit-channel.ts (#7633)
 *
 * Decisões PURAS do canal Kit do envio extra pra apoiadores Mantenedor/
 * Patrono — config, audiência e guards. Zero I/O: quem fala com o Kit é
 * `scripts/sync-apoio-mensal-tag-kit.ts` (audiência) e
 * `scripts/publish-monthly-apoiadores-kit.ts` (broadcast). Mesma divisão
 * pura/I/O do resto do projeto, e é o que permite testar os guards de blast
 * radius e de audiência vazia sem fixture de rede.
 *
 * ## Por que TAG e não SEGMENT — a armadilha central deste canal
 *
 * O Kit não tem "lista" como a Brevo. `POST /v4/broadcasts` aceita
 * `subscriber_filter` só do tipo `tag` ou `segment` (confirmado ao vivo no
 * #6323: 422 "Only `segment` or `tag` filters allowed"), e a conta JÁ tem os
 * 6 segmentos `Apoio — {…}` condicionados no custom field `apoio_nivel`
 * (`apoio-segments-canonical-kit.ts`) — parece o alvo óbvio, e não é:
 *
 *   - `GET /v4/subscribers?segment_id=X` **ignora silenciosamente** o
 *     parâmetro: `pagination.total_count` volta com o total da CONTA, não do
 *     segmento (medido ao vivo nos 6 segmentos em 24/08/2026). Não existe
 *     rota que devolva "quem está no segmento X" nem "qual é a condição do
 *     segmento X".
 *   - Consequência: mirar `segment` é enviar às cegas — não dá pra conferir a
 *     audiência antes do disparo, nem depois. Pra um envio pago-por-apoio a
 *     uma audiência de dezenas de pessoas, isso é o oposto do que se quer.
 *
 * Por isso a audiência é uma TAG dedicada (`kit_apoiadores.audience_tag`),
 * cuja membresia É legível (`GET /v4/tags/{id}/subscribers`) e portanto
 * auditável antes de qualquer envio. Os 6 segmentos continuam existindo como
 * conveniência de navegação no painel — nunca como alvo de envio.
 *
 * ## A tag é PROJEÇÃO do custom field, não uma 2ª fonte de verdade
 *
 * Quem decide o nível de cada pessoa continua sendo `sync-apoio-nivel-kit.ts`
 * (#6049), que grava `apoio_nivel` a partir do apoia.se com carência de 1 mês
 * e guard de blast radius. `sync-apoio-mensal-tag-kit.ts` só projeta esse
 * campo em membresia de tag — não reimplementa carência nem consulta o
 * apoia.se. Se a regra de quem é Mantenedor/Patrono mudar, ela muda LÁ, e a
 * tag acompanha na próxima sincronização.
 */

import type { ApoioNivel } from "../apoio-segments-canonical-kit.ts";

/**
 * Níveis que recebem o envio extra — decisão 2 do #4482, preservada em todas
 * as trocas de canal (Beehiiv → Brevo → Kit): só quem apoia em Mantenedor ou
 * Patrono, nunca a base inteira nem os níveis abaixo.
 */
export const APOIADORES_MENSAL_NIVEIS: readonly ApoioNivel[] = ["mantenedor", "patrono"] as const;

/** Config de `platform.config.json` → `kit_apoiadores`. */
export interface KitApoiadoresChannelConfig {
  /** Nome da tag de audiência no Kit. Resolvida por NOME em runtime (o id é
   *  por-conta, nunca hardcoded — mesma disciplina de `kit_diaria`). */
  audience_tag?: string;
}

export type ApoiadoresTagNameResolution = { ok: true; tagName: string } | { ok: false; reason: string };

/**
 * Valida o nome de tag vindo da config antes de qualquer chamada de rede.
 * Ausente/vazio é erro, nunca default silencioso: sem tag não há filtro, e
 * `subscriber_filter` ausente no Kit significa **base INTEIRA** (#6126) — o
 * modo de falha deste canal é mandar um digest de apoiador pra todo mundo,
 * não deixar de mandar.
 */
export function resolveApoiadoresTagName(config: KitApoiadoresChannelConfig | undefined | null): ApoiadoresTagNameResolution {
  const raw = config?.audience_tag;
  const tagName = typeof raw === "string" ? raw.trim() : "";
  if (!tagName) {
    return {
      ok: false,
      reason:
        "platform.config.json → kit_apoiadores.audience_tag ausente/vazio. Sem nome de tag não há " +
        "audiência: um subscriber_filter ausente no Kit significa a BASE INTEIRA (#6126), então " +
        "recusar aqui é o modo de falha seguro.",
    };
  }
  return { ok: true, tagName };
}

export type ApoiadoresTagIdResolution = { ok: true; tagId: number } | { ok: false; reason: string };

/**
 * Valida o id resolvido por `findTagIdByName` (que NUNCA cria a tag — ver
 * `kit-broadcasts.ts`). Gêmeo de `resolveAudienceTagId` do canal diário: é o
 * guard que separa "não envia" de "envia pra base inteira".
 */
export function resolveApoiadoresTagId(tagName: string, tagId: number | null): ApoiadoresTagIdResolution {
  if (tagId === null) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" não existe no Kit — rode 'npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push' ` +
        "antes (é ele quem cria/popula a audiência a partir do custom field apoio_nivel). Recusando: " +
        "filtro não resolvido no Kit vira audiência INTEIRA.",
    };
  }
  if (!Number.isInteger(tagId) || tagId <= 0) {
    return { ok: false, reason: `id de tag inválido para "${tagName}": ${String(tagId)}.` };
  }
  return { ok: true, tagId };
}

export type ApoiadoresAudienceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Tag resolvida (id válido) mas VAZIA — recusa criar o broadcast. Mesmo
 * racional do #6582 no canal diário: um filtro válido com zero destinatários
 * produz um rascunho que reporta sucesso e não entrega a ninguém. Aqui o
 * cenário é ainda mais provável, porque a tag só existe depois de um `--push`
 * do sync de audiência — nunca "por padrão".
 */
export function checkApoiadoresAudienceNotEmpty(tagName: string, memberCount: number): ApoiadoresAudienceCheck {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    return { ok: false, reason: `contagem de membros inválida para a tag "${tagName}": ${String(memberCount)}.` };
  }
  if (memberCount === 0) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" resolveu (id válido) mas está VAZIA — 0 membros. Recusando criar um broadcast ` +
        "que reportaria sucesso sem entregar a ninguém. Rode 'sync-apoio-mensal-tag-kit.ts --push' e " +
        "confira se há Mantenedor/Patrono com apoio_nivel gravado no Kit (sync-apoio-nivel-kit.ts).",
    };
  }
  return { ok: true };
}

// ── audiência resolvida (tipo nominal, #7651) ─────────────────────────────

declare const resolvedAudienceBrand: unique symbol;

/**
 * Prova, no tipo, de que a audiência passou pelos TRÊS guards acima — nome de
 * tag configurado, id resolvido e válido, e tag com pelo menos 1 membro
 * (#7651, achado do type-design-analyzer no review do #7633).
 *
 * Antes disto, `buildApoiadoresKitBroadcastInput` recebia um `tagId: number`
 * cru: estruturalmente idêntico a um id NÃO validado. O fato "esta audiência
 * foi conferida" vivia só na ORDEM das chamadas dentro do `main()`, e um
 * refactor que montasse o payload antes dos guards — ou um teste novo que
 * pulasse a etapa — compilava sem reclamar. Num canal cujo modo de falha é
 * mandar conteúdo pago pra base inteira, precondição por convenção é pouco.
 *
 * Só `resolveApoiadoresAudience` constrói este tipo, e ela exige os
 * resultados dos três guards.
 */
export interface ResolvedAudienceTag {
  readonly tagId: number;
  readonly tagName: string;
  readonly [resolvedAudienceBrand]: true;
}

/**
 * Fecha o encadeamento dos três guards num único valor que o construtor do
 * payload aceita. Devolve `null` se qualquer um deles reprovou — o caller já
 * reportou o motivo específico e não deve seguir.
 *
 * Recebe os RESULTADOS (não faz I/O nem revalida): manter a checagem e a
 * prova em funções separadas é o que permite ao caller logar a razão exata de
 * cada falha, que é o que o operador lê pra saber o que corrigir.
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
  } as ResolvedAudienceTag;
}

// ── diff de membresia (puro) ──────────────────────────────────────────────

export interface ApoiadoresTagDiff {
  /** E-mails que DEVEM ganhar a tag (são Mantenedor/Patrono e ainda não a têm). */
  toAdd: string[];
  /** E-mails que DEVEM perder a tag (a têm e não são mais Mantenedor/Patrono). */
  toRemove: string[];
  /** E-mails já corretos — só pra log/contagem. */
  unchanged: string[];
}

/**
 * Pure: diff de membresia desejada × atual, casando por e-mail normalizado
 * (trim + lowercase — mesma normalização de `fetchCurrentKitState`).
 *
 * Casar por E-MAIL e não por id é deliberado: o desejado vem da leitura de
 * assinantes (que traz id) mas o atual vem de `GET /tags/{id}/subscribers`, e
 * cruzar as duas listas por id assumiria que os dois endpoints falam do mesmo
 * espaço de identidade sem nunca ter sido medido. E-mail é o identificador
 * que o resto do projeto já usa pra casar pessoas entre plataformas.
 */
export function diffApoiadoresTagMembership(
  desiredEmails: readonly string[],
  currentEmails: readonly string[],
): ApoiadoresTagDiff {
  const norm = (e: string) => e.trim().toLowerCase();
  const desired = new Set(desiredEmails.map(norm).filter(Boolean));
  const current = new Set(currentEmails.map(norm).filter(Boolean));
  const toAdd: string[] = [];
  const unchanged: string[] = [];
  for (const e of desired) (current.has(e) ? unchanged : toAdd).push(e);
  const toRemove = [...current].filter((e) => !desired.has(e));
  return { toAdd: toAdd.sort(), toRemove: toRemove.sort(), unchanged: unchanged.sort() };
}

// ── guard de blast radius (puro) ──────────────────────────────────────────

/** Mesma proporção do guard de `sync-apoio-nivel-beehiiv.ts` — remover mais
 *  de 30% da audiência numa rodada é sinal de dado parcial, não de 30% dos
 *  apoiadores terem cancelado no mesmo dia. */
export const APOIADORES_TAG_BLAST_RADIUS_THRESHOLD = 0.3;

export interface ApoiadoresBlastRadiusResult {
  blocked: boolean;
  removalCount: number;
  currentCount: number;
  ratio: number;
}

/**
 * Pure: bloqueia o `--push` inteiro (adições inclusive) quando a proporção de
 * remoções passa do limiar — a falha típica que isso pega é uma leitura
 * parcial do Kit ou do apoia.se virando "todo mundo perdeu o nível". `force`
 * é a decisão consciente do editor, sempre logada pelo caller.
 *
 * Audiência vazia (`currentCount === 0`) nunca bloqueia: é o estado da 1ª
 * sincronização, em que só há adições.
 */
export function evaluateApoiadoresBlastRadius(
  removalCount: number,
  currentCount: number,
  force: boolean,
): ApoiadoresBlastRadiusResult {
  const ratio = currentCount > 0 ? removalCount / currentCount : 0;
  return { blocked: !force && ratio > APOIADORES_TAG_BLAST_RADIUS_THRESHOLD, removalCount, currentCount, ratio };
}
