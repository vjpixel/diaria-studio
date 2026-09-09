/**
 * scripts/lib/kit-apoio-tag-sync.ts (#7659)
 *
 * Runner de I/O que converge a membresia de UMA tag do Kit com quem tem
 * `apoio_nivel` num conjunto de níveis. Genérico por canal: o que muda entre
 * um uso e outro é o nome da tag, os níveis-alvo e o prefixo de log — nada
 * mais.
 *
 * As decisões (diff, blast radius, seleção) vivem puras em
 * `lib/shared/kit-apoio-tag.ts`; aqui está só a conversa com a API e a ordem
 * das operações.
 *
 * ## Não é um 2º sync de apoio — é uma PROJEÇÃO do que o outro já decidiu
 *
 * `sync-apoio-nivel-kit.ts` (#6049) é quem lê o apoia.se, aplica a carência de
 * 1 mês e grava o custom field `apoio_nivel` no Kit. Este runner NÃO toca o
 * apoia.se nem recalcula nível nenhum: lê o campo já gravado e projeta em
 * membresia de tag. A ordem importa — rodar este antes daquele numa virada de
 * mês projeta o estado velho.
 *
 * ## Disciplina de escrita
 *
 * - **Dry-run por padrão.** Só `push: true` grava.
 * - **Nunca confia no 2xx.** Cada `tagSubscriber`/`untagSubscriber` é
 *   verificado por releitura de `GET /subscribers/{id}/tags` (direção
 *   assinante→tags, a única sem atraso de propagação observado — ver
 *   `kit-client.ts`). O `DELETE` de tag no Kit tem histórico de responder 204
 *   sem remover em rota vizinha, então releitura aqui não é zelo, é o único
 *   jeito de saber.
 * - **Guard de blast radius** (30%): `forceBlastRadius` é a decisão
 *   consciente, sempre logada.
 * - A tag é CRIADA se ainda não existir (só em `push`) — diferente de
 *   `findTagIdByName` no caminho de ENVIO, que nunca cria: aqui a tag vazia é
 *   inofensiva (este runner está prestes a populá-la), lá ela seria um filtro
 *   que casa com ninguém ou, pior, um envio sem filtro.
 */
import type { KitConfig } from "./kit-config.ts";
import { KitApiError } from "./kit-client.ts";
import { listAllKitSubscribers } from "./kit-subscribers.ts";
import {
  createTag,
  findTagIdByName,
  listSubscriberTags,
  listTagSubscribersPage,
  tagSubscriber,
  untagSubscriber,
} from "./kit-broadcasts.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./apoio-segments-canonical-kit.ts";
import {
  diffTagMembership,
  evaluateTagBlastRadius,
  selectMembersByApoioNivel,
  type KitTagMember,
  type TagMembershipDiff,
} from "./shared/kit-apoio-tag.ts";
import type { ApoioNivel } from "./shared/apoio-nivel-types.ts";

/**
 * Pure: a falha é SISTÊMICA (credencial revogada, rate limit,
 * indisponibilidade do Kit) e não específica daquele contato?
 *
 * Sem esta distinção, uma credencial revogada no meio de um push faz o loop
 * tentar e falhar em CADA um dos N contatos restantes — N chamadas inúteis e
 * um relatório de "N falhas" que esconde a causa única.
 *
 * Só olha o status HTTP (`KitApiError.status`), nunca o texto da mensagem:
 * casar substring de erro é frágil e classificaria errado uma falha de
 * verificação por releitura (que é semântica, específica do contato, e DEVE
 * seguir pro próximo).
 *
 * @pure
 */
export function isSystemicKitFailure(err: unknown): boolean {
  if (!(err instanceof KitApiError)) return false;
  return err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500;
}

/**
 * I/O: pagina `GET /tags/{id}/subscribers` até o fim preservando o `id` de
 * cada membro. `listAllTagSubscriberEmails` (kit-broadcasts) devolve só os
 * e-mails — aqui a remoção precisa do id, então a paginação é feita local.
 */
export async function fetchTagMembers(tagId: number, config?: KitConfig): Promise<KitTagMember[]> {
  const out: KitTagMember[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await listTagSubscribersPage(tagId, { perPage: 500, after, config });
    for (const s of page.subscribers) out.push({ id: s.id, email: s.email_address.trim().toLowerCase() });
    if (!page.pagination.has_next_page || !page.pagination.end_cursor) break;
    after = page.pagination.end_cursor;
  }
  return out;
}

/** I/O: lê a base do Kit e aplica `selectMembersByApoioNivel`. */
export async function fetchDesiredMembers(
  niveis: readonly ApoioNivel[],
  config?: KitConfig,
): Promise<KitTagMember[]> {
  return selectMembersByApoioNivel(await listAllKitSubscribers(config), niveis, KIT_APOIO_NIVEL_FIELD_KEY);
}

/** I/O: aplica UMA adição e confirma por releitura (nunca só pelo 2xx). */
export async function applyAdd(member: KitTagMember, tagId: number, config?: KitConfig): Promise<void> {
  await tagSubscriber(tagId, member.id, config);
  const tags = await listSubscriberTags(member.id, config);
  if (!tags.some((t) => t.id === tagId)) {
    throw new Error(`releitura pós-tag NÃO confere pra ${member.email} (subscriber ${member.id}) — tag ${tagId} ausente.`);
  }
}

/** I/O: aplica UMA remoção e confirma por releitura (ver docstring do módulo
 *  sobre `DELETE` que responde 2xx sem remover). */
export async function applyRemove(member: KitTagMember, tagId: number, config?: KitConfig): Promise<void> {
  await untagSubscriber(tagId, member.id, config);
  const tags = await listSubscriberTags(member.id, config);
  if (tags.some((t) => t.id === tagId)) {
    throw new Error(
      `releitura pós-untag NÃO confere pra ${member.email} (subscriber ${member.id}) — tag ${tagId} ainda presente ` +
        "(o DELETE respondeu 2xx mas não removeu; mesma armadilha do DELETE /tags/{id} documentada em kit-client.ts).",
    );
  }
}

export interface KitApoioTagSyncOptions {
  tagName: string;
  niveis: readonly ApoioNivel[];
  push: boolean;
  forceBlastRadius: boolean;
  config?: KitConfig;
  log: (msg: string) => void;
}

export interface KitApoioTagSyncResult {
  /** `null` quando a tag ainda não existe e o run é dry-run (nada foi criado). */
  tagId: number | null;
  diff: TagMembershipDiff;
  applied: number;
  failed: number;
  /** Interrompido por falha sistêmica — o restante do push não foi tentado. */
  aborted: boolean;
  /** Bloqueado pelo guard de blast radius — NENHUMA mutação foi aplicada. */
  blastRadiusBlocked: boolean;
}

/** Log do diff, no mesmo formato dos outros syncs de apoio (lista explícita,
 *  nunca só contagem — quem revisa precisa ver QUEM entra e QUEM sai). */
export function logDiff(diff: TagMembershipDiff, log: (msg: string) => void): void {
  log(`diff: +${diff.toAdd.length} adicionar · -${diff.toRemove.length} remover · ${diff.unchanged.length} já corretos`);
  for (const e of diff.toAdd) log(`  + ${e}`);
  for (const e of diff.toRemove) log(`  - ${e}`);
}

export async function runKitApoioTagSync(options: KitApoioTagSyncOptions): Promise<KitApoioTagSyncResult> {
  const { tagName, niveis, push, forceBlastRadius, config, log } = options;

  log(`lendo assinantes do Kit (níveis alvo: ${niveis.join(", ")})…`);
  const desired = await fetchDesiredMembers(niveis, config);
  log(`${desired.length} assinante(s) ativo(s) com nível alvo.`);

  let tagId = await findTagIdByName(tagName, config);
  if (tagId === null) {
    if (!push) {
      log(
        `tag "${tagName}" ainda não existe no Kit — em --push ela SERIA criada e receberia ` +
          `${desired.length} membro(s). Nada aplicado (dry-run).`,
      );
      const diff = diffTagMembership(desired.map((m) => m.email), []);
      logDiff(diff, log);
      return { tagId: null, diff, applied: 0, failed: 0, aborted: false, blastRadiusBlocked: false };
    }
    log(`tag "${tagName}" não existe — criando.`);
    tagId = (await createTag(tagName, config)).id;
    log(`tag criada: id=${tagId}. (A listagem de tags do Kit leva ~1-2min pra refletir — normal.)`);
  }

  const current = await fetchTagMembers(tagId, config);
  log(`tag "${tagName}" (id=${tagId}) tem ${current.length} membro(s) hoje.`);

  const diff = diffTagMembership(desired.map((m) => m.email), current.map((m) => m.email));
  logDiff(diff, log);

  const blast = evaluateTagBlastRadius(diff.toRemove.length, current.length, forceBlastRadius);
  if (blast.removalCount > 0) {
    log(
      `blast radius: ${blast.removalCount}/${blast.currentCount} remoções (${(blast.ratio * 100).toFixed(1)}%)` +
        (blast.blocked ? " — ACIMA do limiar de 30%." : ""),
    );
  }

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return { tagId, diff, applied: 0, failed: 0, aborted: false, blastRadiusBlocked: false };
  }

  if (blast.blocked) {
    log(
      "RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação aplicada, nem adições " +
        "nem remoções. Confira se é virada de mês/leitura parcial antes de usar --force-blast-radius.",
    );
    return { tagId, diff, applied: 0, failed: 0, aborted: false, blastRadiusBlocked: true };
  }

  const byEmail = new Map<string, KitTagMember>();
  for (const m of [...desired, ...current]) byEmail.set(m.email, m);

  let applied = 0;
  let failed = 0;
  let aborted = false;

  // Um verbo só pros dois loops: a única diferença é a mutação e o rótulo, e
  // blocos espelhados são justamente onde `tagSubscriber`/`untagSubscriber`
  // trocam de lugar num refactor sem nada acusar.
  const applyAll = async (
    emails: readonly string[],
    verbo: "adicionar" | "remover",
    apply: (m: KitTagMember) => Promise<void>,
  ): Promise<void> => {
    for (const email of emails) {
      if (aborted) return;
      const member = byEmail.get(email);
      if (!member) {
        failed++;
        log(`FALHA em ${email}: sem id de assinante (não deveria acontecer — e-mail veio da própria leitura).`);
        continue;
      }
      try {
        await apply(member);
        applied++;
      } catch (e) {
        failed++;
        log(`FALHA ao ${verbo} ${email}: ${(e as Error).message}`);
        if (isSystemicKitFailure(e)) {
          aborted = true;
          log(
            "ABORTANDO o restante do --push: a falha acima é SISTÊMICA (credencial, rate limit ou " +
              "indisponibilidade do Kit), não específica deste contato — insistir nos demais só gastaria " +
              "chamadas e produziria um relatório de N falhas escondendo a causa única. Corrija e re-rode: " +
              "o sync é idempotente, quem já foi aplicado não é reaplicado.",
          );
          return;
        }
      }
    }
  };

  await applyAll(diff.toAdd, "adicionar", (m) => applyAdd(m, tagId, config));
  await applyAll(diff.toRemove, "remover", (m) => applyRemove(m, tagId, config));

  const pendentes = diff.toAdd.length + diff.toRemove.length - applied - failed;
  log(
    `push ${aborted ? "ABORTADO" : "concluído"}: ${applied} aplicada(s), ${failed} falha(s)` +
      (aborted ? `, ${pendentes} não tentada(s).` : "."),
  );

  return { tagId, diff, applied, failed, aborted, blastRadiusBlocked: false };
}
