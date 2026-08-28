/**
 * scripts/lib/kit-diaria-channel.ts (#6126)
 *
 * Lógica PURA do canal Kit paralelo da edição diária — zero I/O, para ser
 * testável sem tocar rede, disco ou config real. O I/O vive em
 * `scripts/kit-diaria-stage5-dispatch.ts`.
 *
 * ## Por que este canal existe (e por que NÃO é o `backend: "kit"`)
 *
 * Há dois caminhos Kit para a newsletter, de propósito, e eles não se
 * substituem:
 *
 * 1. **Branch exclusivo por `publishing.newsletter.backend`** (#464/#6114) —
 *    `orchestrator-stage-5.md` §180: quando o backend é `"kit"`, o Passo 5c-1
 *    (Beehiiv) é PULADO inteiro. Serve o switchover final, quando a base
 *    legada da Beehiiv já tiver migrado em lote e existir uma audiência só.
 *
 * 2. **Este canal, PARALELO** (#6126) — roda ao lado da Beehiiv na mesma
 *    edição, cada um para sua audiência, no molde do canal Brevo diária
 *    (`brevo-diaria-stage5-dispatch.ts`, #5772). Serve a fase de PARTIÇÃO
 *    decidida pelo editor em 25/08 (inversão da ordem da migração, #6048):
 *
 *    | | audiência | recebe de |
 *    |---|---|---|
 *    | Beehiiv | base legada, congelada no corte | Beehiiv |
 *    | Kit | só quem se cadastrar DEPOIS do corte (tag `kit-nativo`) | Kit |
 *
 *    Disjuntas por construção — sem órfão e sem entrega dupla. É a mesma razão
 *    de o par Beehiiv+Brevo funcionar hoje: o `brevo_diaria` só atinge quem
 *    está `Pending` na Beehiiv, que por isso não recebe pela Beehiiv.
 *
 * **Não unificar os dois enquanto a partição estiver em uso** (nota registrada
 * na #6114). Parecem redundantes e não são.
 *
 * ## O modo de falha que governa o desenho deste módulo
 *
 * No Kit, um `subscriber_filter` ausente ou vazio significa **audiência
 * INTEIRA**, não audiência nenhuma. Um erro de resolução de tag aqui não
 * degrada para "não envia" — degrada para "envia pra base toda", incluindo os
 * 585 assinantes importados da Beehiiv, que receberiam a edição EM DOBRO.
 *
 * Por isso `decideKitChannelDispatch` trata tag ausente/não resolvida como
 * `skip`, nunca como "seguir com filtro default", e o dispatch valida o
 * `tagId` ANTES de montar o broadcast.
 */

/** Bloco `kit_diaria` de `platform.config.json`. Ausente ⇒ canal desligado. */
export interface KitDiariaChannelConfig {
  /** Interruptor explícito. Ausente ou `false` ⇒ canal não roda. */
  enabled?: boolean;
  /**
   * Nome da tag que delimita a audiência deste canal. Default
   * `KIT_NATIVE_SIGNUP_MARKER` ("kit-nativo", `lib/shared/kit-signup-origin.ts`,
   * PR #6127) — quem entrou pelos funis, nunca quem veio da importação.
   *
   * Configurável para permitir o rollout escalonado registrado na #6126:
   * apontar primeiro para um grupo curado e pequeno (`diaria-test-email`, ou o
   * segmento de apoio) antes de abrir para os cadastros nativos.
   */
  audience_tag?: string;
}

/** Estado persistido por edição — espelho de `brevo-diaria-published.json`. */
export interface KitDiariaPublished {
  broadcast_id: number;
  subject: string;
  /** #6183: `string | null` porque a API do Kit devolve `null` quando o
   *  editor remove o preview text no painel — e o estado local reflete o
   *  broadcast, não o que montamos no Stage 5. */
  preview_text: string | null;
  /** Nome da tag usada, gravado para auditoria: responde "para quem foi?". */
  audience_tag: string;
  /** Id resolvido no momento do dispatch — a tag pode ser recriada depois. */
  audience_tag_id: number;
  status: "draft" | "scheduled";
  scheduled_at?: string;
}

export type KitChannelDecision =
  | { action: "already_done"; broadcastId: number }
  | { action: "skip"; reason: string }
  | { action: "dispatch"; audienceTag: string };

export interface DecideKitChannelInput {
  /**
   * `publishing.newsletter.backend`. Existe aqui por um guard de exclusão
   * mútua (#6162, achado do review): quando o backend é `"kit"`, o Passo
   * 5c-1-kit do Stage 5 dispara pra audiência INTEIRA
   * (`buildAllSubscribersFilter`). Se este canal paralelo rodasse junto, quem
   * estivesse nos dois filtros receberia a edição EM DOBRO.
   *
   * Antes disto a proteção era só uma nota em prosa ("não unificar os dois
   * enquanto a partição estiver em uso") — e prosa não impede ninguém de
   * virar uma flag esquecendo a outra.
   */
  newsletterBackend?: string;
  /** Bloco de config, ou `undefined`/`null` se ausente. */
  config: KitDiariaChannelConfig | undefined | null;
  /** Estado já persistido desta edição, se houver (idempotência em resume). */
  existing: KitDiariaPublished | null;
  /** Default do nome da tag quando a config não especifica. */
  defaultAudienceTag: string;
}

/**
 * Decide o que o dispatch deve fazer, sem tocar em nada.
 *
 * Ordem das checagens é deliberada: **idempotência primeiro**. Um resume da
 * Etapa 5 nunca deve reprocessar uma edição cujo broadcast já existe, nem
 * mesmo para reavaliar config — mesmo princípio do `runStage5BrevoDispatch`
 * (#5772), onde a checagem de `campaign_id` precede a leitura de config.
 */
export function decideKitChannelDispatch(input: DecideKitChannelInput): KitChannelDecision {
  const { config, existing, defaultAudienceTag } = input;

  if (existing && typeof existing.broadcast_id === "number") {
    return { action: "already_done", broadcastId: existing.broadcast_id };
  }

  if (!config) {
    return { action: "skip", reason: "kit_diaria não configurado em platform.config.json." };
  }
  if (input.newsletterBackend === "kit") {
    return {
      action: "skip",
      reason:
        "publishing.newsletter.backend === \"kit\" — o switchover (#6114) já envia pra audiência INTEIRA. " +
        "Rodar o canal paralelo junto entregaria a edição EM DOBRO a quem está nos dois filtros. " +
        "Desligue `kit_diaria.enabled` ao virar o backend.",
    };
  }
  if (config.enabled !== true) {
    return {
      action: "skip",
      reason: "kit_diaria.enabled não é true — canal Kit paralelo desligado (default).",
    };
  }

  const audienceTag = (config.audience_tag ?? defaultAudienceTag).trim();
  if (audienceTag === "") {
    return {
      action: "skip",
      reason: "kit_diaria.audience_tag vazio — recusando dispatch (filtro vazio no Kit = audiência INTEIRA).",
    };
  }

  return { action: "dispatch", audienceTag };
}

export type TagResolution =
  | { ok: true; tagId: number }
  | { ok: false; reason: string };

/**
 * Valida o id de tag resolvido antes de virar `subscriber_filter`.
 *
 * Existe como função própria — em vez de um `if` solto no dispatch — porque é
 * o guard que separa "não envia" de "envia pra base inteira". Um `null` vindo
 * de `findTagIdByName` significa que o marcador de cadastro nativo ainda não
 * produziu nenhuma tag; seguir daí seria montar filtro inválido.
 */
export function resolveAudienceTagId(tagName: string, tagId: number | null): TagResolution {
  if (tagId === null) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" não existe no Kit — nenhum assinante nativo foi marcado ainda ` +
        `(ver #6048/PR #6127). Recusando dispatch: filtro não resolvido no Kit vira audiência INTEIRA.`,
    };
  }
  if (!Number.isInteger(tagId) || tagId <= 0) {
    return { ok: false, reason: `id de tag inválido para "${tagName}": ${String(tagId)}.` };
  }
  return { ok: true, tagId };
}

export type AudienceMembershipCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Guard de invariante (#6582) — tag RESOLVIDA (id válido) mas com ZERO
 * membros deixou de ser um estado normal em 28/08/2026.
 *
 * Antes da migração das ondas 0/1 (#6504), a tag `rampa-kit` era um canal
 * ADITIVO: quem estava nela também estava ativo na Beehiiv, então um
 * broadcast com 0 destinatários no Kit não custava nada — a pessoa recebia
 * pelo outro canal do mesmo jeito. Depois da migração, as 92 pessoas da
 * tag (11 da onda 0, nunca ativas na Beehiiv; 81 da onda 1, desativadas na
 * Beehiiv na mesma sessão que ganharam a tag) passaram a ter o Kit como
 * ÚNICO canal — ver `platform.config.json` → `kit_diaria.audience_tag_note`.
 *
 * `resolveAudienceTagId` acima só protege contra tag NÃO resolvida (id
 * `null`/inválido) — um id válido que resolve para uma tag VAZIA passava
 * batido, e o dispatch seguia normalmente criando um broadcast com filtro
 * válido e zero destinatários: `status: "ok"` no JSON de saída, ninguém
 * recebe, nada acusa. Esta função fecha essa lacuna — chamada DEPOIS de
 * `resolveAudienceTagId` ter aceitado o id, ANTES de montar o payload.
 */
export function checkAudienceTagHasMembers(tagName: string, memberCount: number): AudienceMembershipCheck {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    return {
      ok: false,
      reason: `contagem de membros inválida para a tag "${tagName}": ${String(memberCount)}.`,
    };
  }
  if (memberCount === 0) {
    return {
      ok: false,
      reason:
        `tag "${tagName}" resolveu (id válido) mas está VAZIA — 0 membros. Isto NÃO é o estado ` +
        `normal (#6582): desde a migração das ondas 0/1 (#6504), quem está nesta tag pode não ` +
        `estar ativo na Beehiiv, e o Kit é o ÚNICO canal alcançável. Uma tag vazia aqui indica ` +
        `nome errado, tag esvaziada por engano, ou config apontando pro lugar errado — recusando ` +
        `criar um broadcast com 0 destinatários que reportaria "ok" sem entregar a ninguém.`,
    };
  }
  return { ok: true };
}
