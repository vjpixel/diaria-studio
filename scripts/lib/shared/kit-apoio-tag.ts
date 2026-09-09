/**
 * scripts/lib/shared/kit-apoio-tag.ts (#7659)
 *
 * Decisões PURAS de qualquer canal do Kit cuja AUDIÊNCIA é "quem apoia a
 * partir de um certo nível" — resolução do alvo, diff de membresia e guard de
 * blast radius. Zero I/O: quem fala com o Kit são os CLIs
 * (`sync-apoio-*-tag-kit.ts`, `publish-*-kit.ts`).
 *
 * Nasceu genérico porque o 2º canal desse formato apareceu (#7659, e-mail do
 * Artigo Especial pra apoio R$10+) e a única diferença em relação ao 1º
 * (#7633, envio mensal pra Mantenedor/Patrono) é o CONJUNTO DE NÍVEIS e o
 * NOME DA TAG — todo o resto (por que tag e não segmento, como o diff casa,
 * quando o blast radius bloqueia) é idêntico e não deve ser reescrito por
 * canal.
 *
 * ## Por que TAG e não SEGMENT — a armadilha central destes canais
 *
 * O Kit não tem "lista" como a Brevo. `POST /v4/broadcasts` aceita
 * `subscriber_filter` só do tipo `tag` ou `segment` (confirmado ao vivo no
 * #6323: 422 "Only `segment` or `tag` filters allowed"), e a conta JÁ tem os
 * 6 segmentos `Apoio — {…}` condicionados no custom field `apoio_nivel`
 * (`apoio-segments-canonical-kit.ts`) — parece o alvo óbvio, e não é:
 * `GET /v4/subscribers?segment_id=X` **ignora silenciosamente** o parâmetro
 * (`pagination.total_count` volta com o total da CONTA, medido ao vivo nos 6
 * segmentos em 24/08/2026) e não existe rota que devolva "quem está no
 * segmento X". Mirar segmento é enviar às cegas — sem conferir a audiência
 * antes nem depois. Membresia de TAG é legível
 * (`GET /v4/tags/{id}/subscribers`), então a tag é o alvo e os segmentos
 * ficam como conveniência de navegação no painel.
 *
 * ## A tag é PROJEÇÃO do custom field, não uma 2ª fonte de verdade
 *
 * Quem decide o nível de cada pessoa é `sync-apoio-nivel-kit.ts` (#6049), que
 * grava `apoio_nivel` a partir do apoia.se com carência de 1 mês e guard de
 * blast radius próprio. Os syncs de tag só projetam esse campo em membresia
 * — não reimplementam carência nem consultam o apoia.se. Se a regra de quem é
 * Mantenedor mudar, ela muda LÁ, e as tags acompanham na próxima
 * sincronização.
 *
 * ## Relação com `lib/mensal/apoiadores-kit-channel.ts`
 *
 * Aquele módulo (#7633) é o irmão mais velho: mesmas regras, fixadas em
 * Mantenedor/Patrono. Ele NÃO foi reescrito sobre este aqui porque tem uma PR
 * em voo tocando-o (#7651) e o conflito custaria mais do que a duplicação
 * temporária vale — a dobra está registrada como issue de follow-up, e
 * `test/kit-apoio-tag-parity.test.ts` trava as duas implementações contra os
 * MESMOS casos, pra que não divirjam em silêncio enquanto convivem.
 */

import type { ApoioNivel } from "./apoio-nivel-types.ts";

// ── resolução do alvo ─────────────────────────────────────────────────────

export type TagNameResolution = { ok: true; tagName: string } | { ok: false; reason: string };

/**
 * Valida o nome de tag vindo da config antes de qualquer chamada de rede.
 * Ausente/vazio é erro, nunca default silencioso: sem tag não há filtro, e
 * `subscriber_filter` ausente no Kit significa **base INTEIRA** (#6126) — o
 * modo de falha destes canais é mandar conteúdo de apoiador pra todo mundo,
 * não deixar de mandar.
 *
 * `configPath` entra só na mensagem: é o que diz a quem lê o erro QUAL chave
 * de `platform.config.json` preencher, sem o módulo precisar saber de qual
 * canal veio.
 */
export function resolveAudienceTagName(rawTagName: unknown, configPath: string): TagNameResolution {
  const tagName = typeof rawTagName === "string" ? rawTagName.trim() : "";
  if (!tagName) {
    return {
      ok: false,
      reason:
        `platform.config.json → ${configPath} ausente/vazio. Sem nome de tag não há audiência: um ` +
        "subscriber_filter ausente no Kit significa a BASE INTEIRA (#6126), então recusar aqui é o modo " +
        "de falha seguro.",
    };
  }
  return { ok: true, tagName };
}

export type TagIdResolution = { ok: true; tagId: number } | { ok: false; reason: string };

/**
 * Valida o id resolvido por `findTagIdByName` (que NUNCA cria a tag). É o
 * guard que separa "não envia" de "envia pra base inteira".
 *
 * `syncCommand` é o comando que POPULA essa tag — a mensagem de erro só é
 * acionável se disser qual sync rodar, e isso varia por canal.
 */
export function resolveAudienceTagId(tagName: string, tagId: number | null, syncCommand: string): TagIdResolution {
  if (tagId === null) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" não existe no Kit — rode '${syncCommand}' antes (é ele quem cria/popula a ` +
        "audiência a partir do custom field apoio_nivel). Recusando: filtro não resolvido no Kit vira " +
        "audiência INTEIRA.",
    };
  }
  if (!Number.isInteger(tagId) || tagId <= 0) {
    return { ok: false, reason: `id de tag inválido para "${tagName}": ${String(tagId)}.` };
  }
  return { ok: true, tagId };
}

export type AudienceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Tag resolvida (id válido) mas VAZIA — recusa criar o broadcast. Mesmo
 * racional do #6582 no canal diário: um filtro válido com zero destinatários
 * produz um rascunho que reporta sucesso e não entrega a ninguém. Aqui o
 * cenário é ainda mais provável, porque a tag só existe depois de um `--push`
 * do sync de audiência — nunca "por padrão".
 */
export function checkAudienceNotEmpty(tagName: string, memberCount: number, syncCommand: string): AudienceCheck {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    return { ok: false, reason: `contagem de membros inválida para a tag "${tagName}": ${String(memberCount)}.` };
  }
  if (memberCount === 0) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" resolveu (id válido) mas está VAZIA — 0 membros. Recusando criar um broadcast ` +
        `que reportaria sucesso sem entregar a ninguém. Rode '${syncCommand}' e confira se há assinante ` +
        "com o apoio_nivel esperado gravado no Kit (sync-apoio-nivel-kit.ts).",
    };
  }
  return { ok: true };
}

// ── seleção de quem DEVE ter a tag ────────────────────────────────────────

/** Membro da tag no Kit — id + e-mail, os dois necessários (id pra mutar,
 *  e-mail pra casar contra o desejado). */
export interface KitTagMember {
  id: number;
  email: string;
}

/** Forma mínima de assinante que a seleção precisa — evita amarrar a função
 *  pura ao shape completo de `KitSubscriberSummary`. */
export interface SelectableKitSubscriber {
  id: number;
  email_address: string;
  state?: string;
  fields?: Record<string, string>;
}

/**
 * Pure: quem DEVE ter a tag — assinantes ATIVOS cujo `apoio_nivel` está nos
 * níveis-alvo. Duas decisões que valem teste:
 *
 * - **Filtro de `state` é client-side**, mesmo padrão de `fetchCurrentKitState`
 *   (`sync-apoio-nivel-kit.ts`): nenhum consumidor Kit deste repo validou o
 *   filtro server-side por estado, e inventar um não-verificado é pior que
 *   filtrar depois de ler tudo.
 * - **Comparação de nível normalizada** (trim + lowercase): o valor vem de um
 *   custom field de texto livre, e um `"Patrono "` gravado à mão não pode
 *   silenciosamente deixar alguém de fora do envio que ele paga pra receber.
 */
export function selectMembersByApoioNivel(
  subs: readonly SelectableKitSubscriber[],
  niveis: readonly ApoioNivel[],
  apoioNivelFieldKey: string,
): KitTagMember[] {
  const alvo = new Set<string>(niveis);
  return subs
    .filter((s) => s.state === "active")
    .filter((s) => alvo.has((s.fields?.[apoioNivelFieldKey] ?? "").trim().toLowerCase()))
    .map((s) => ({ id: s.id, email: s.email_address.trim().toLowerCase() }));
}

// ── diff de membresia ─────────────────────────────────────────────────────

export interface TagMembershipDiff {
  /** E-mails que DEVEM ganhar a tag (estão nos níveis-alvo e ainda não a têm). */
  toAdd: string[];
  /** E-mails que DEVEM perder a tag (a têm e não estão mais nos níveis-alvo). */
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
export function diffTagMembership(
  desiredEmails: readonly string[],
  currentEmails: readonly string[],
): TagMembershipDiff {
  const norm = (e: string) => e.trim().toLowerCase();
  const desired = new Set(desiredEmails.map(norm).filter(Boolean));
  const current = new Set(currentEmails.map(norm).filter(Boolean));
  const toAdd: string[] = [];
  const unchanged: string[] = [];
  for (const e of desired) (current.has(e) ? unchanged : toAdd).push(e);
  const toRemove = [...current].filter((e) => !desired.has(e));
  return { toAdd: toAdd.sort(), toRemove: toRemove.sort(), unchanged: unchanged.sort() };
}

// ── guard de blast radius ─────────────────────────────────────────────────

/** Mesma proporção do guard de `sync-apoio-nivel-beehiiv.ts` — remover mais
 *  de 30% da audiência numa rodada é sinal de dado parcial, não de 30% dos
 *  apoiadores terem cancelado no mesmo dia. */
export const APOIO_TAG_BLAST_RADIUS_THRESHOLD = 0.3;

export interface BlastRadiusResult {
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
export function evaluateTagBlastRadius(
  removalCount: number,
  currentCount: number,
  force: boolean,
): BlastRadiusResult {
  const ratio = currentCount > 0 ? removalCount / currentCount : 0;
  return { blocked: !force && ratio > APOIO_TAG_BLAST_RADIUS_THRESHOLD, removalCount, currentCount, ratio };
}
