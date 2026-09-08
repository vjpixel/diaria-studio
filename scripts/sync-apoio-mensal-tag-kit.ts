#!/usr/bin/env node
/**
 * scripts/sync-apoio-mensal-tag-kit.ts (#7633)
 *
 * Converge a membresia da TAG de audiência do envio extra mensal pros
 * apoiadores (`platform.config.json` → `kit_apoiadores.audience_tag`) com
 * quem tem `apoio_nivel` Mantenedor/Patrono no Kit. É a ponte de audiência do
 * canal Kit — o equivalente de `sync-apoio-nivel-brevo.ts` (que convergia a
 * membresia de uma LISTA Brevo) no canal que substituiu a Brevo.
 *
 * ## Não é um 2º sync de apoio — é uma PROJEÇÃO do que o outro já decidiu
 *
 * `sync-apoio-nivel-kit.ts` (#6049) é quem lê o apoia.se, aplica a carência
 * de 1 mês e grava o custom field `apoio_nivel` no Kit. Este script NÃO toca
 * o apoia.se nem recalcula nível nenhum: lê o campo já gravado e projeta em
 * membresia de tag. A ordem importa — rodar este antes daquele numa virada de
 * mês projeta o estado velho, não o novo (ver "Ordem de execução" abaixo).
 *
 * ## Por que tag e não segmento
 *
 * A conta já tem os 6 segmentos `Apoio — {…}` condicionados no mesmo custom
 * field, e eles seriam o alvo óbvio de `subscriber_filter type: "segment"`.
 * Não servem: `GET /v4/subscribers?segment_id=X` ignora o parâmetro em
 * silêncio (o total volta com a conta inteira, medido nos 6 segmentos em
 * 24/08/2026) e não há rota que liste quem está num segmento. Mirar segmento
 * é enviar sem poder conferir a audiência — nem antes, nem depois. Membresia
 * de tag é legível, então é ela que vira o alvo. Detalhes:
 * `scripts/lib/mensal/apoiadores-kit-channel.ts`.
 *
 * ## Ordem de execução (importa)
 *
 *   1. `npx tsx scripts/sync-apoio-nivel-kit.ts --push`   (apoia.se → apoio_nivel)
 *   2. `npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push`  (apoio_nivel → tag)
 *   3. `/diaria-mensal-apoiadores` (Passo 2 cria o broadcast pra essa tag)
 *
 * ## Disciplina de escrita
 *
 * - **Dry-run por padrão.** Só `--push` grava.
 * - **Nunca confia no 2xx.** Cada `tagSubscriber`/`untagSubscriber` é
 *   verificado por releitura de `GET /subscribers/{id}/tags` (direção
 *   assinante→tags, a única sem atraso de propagação observado — ver
 *   `kit-client.ts`). O `DELETE` de tag no Kit tem histórico de responder 204
 *   sem remover em rota vizinha, então releitura aqui não é zelo, é o único
 *   jeito de saber.
 * - **Guard de blast radius** (30%, mesmo limiar do sync de nível):
 *   `--force-blast-radius` é a decisão consciente, sempre logada.
 * - A tag é CRIADA se ainda não existir (só com `--push`) — diferente de
 *   `findTagIdByName` no caminho de ENVIO, que nunca cria: aqui a tag vazia é
 *   inofensiva (este script está prestes a populá-la), lá ela seria um filtro
 *   que casa com ninguém ou, pior, um envio sem filtro.
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push --force-blast-radius
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import {
  createTag,
  findTagIdByName,
  listSubscriberTags,
  listTagSubscribersPage,
  tagSubscriber,
  untagSubscriber,
} from "./lib/kit-broadcasts.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./lib/apoio-segments-canonical-kit.ts";
import {
  APOIADORES_MENSAL_NIVEIS,
  diffApoiadoresTagMembership,
  evaluateApoiadoresBlastRadius,
  resolveApoiadoresTagName,
  type ApoiadoresTagDiff,
  type KitApoiadoresChannelConfig,
} from "./lib/mensal/apoiadores-kit-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-mensal-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

/** Membro da tag no Kit — id + e-mail, os dois necessários (id pra mutar,
 *  e-mail pra casar contra o desejado). */
export interface KitTagMember {
  id: number;
  email: string;
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
export function selectDesiredMembers(subs: readonly SelectableKitSubscriber[]): KitTagMember[] {
  const niveis = new Set<string>(APOIADORES_MENSAL_NIVEIS);
  return subs
    .filter((s) => s.state === "active")
    .filter((s) => niveis.has((s.fields?.[KIT_APOIO_NIVEL_FIELD_KEY] ?? "").trim().toLowerCase()))
    .map((s) => ({ id: s.id, email: s.email_address.trim().toLowerCase() }));
}

/** I/O: lê a base do Kit e aplica `selectDesiredMembers`. */
export async function fetchDesiredMembers(config?: KitConfig): Promise<KitTagMember[]> {
  return selectDesiredMembers(await listAllKitSubscribers(config));
}

/** Log do diff, no mesmo formato dos outros syncs de apoio (lista explícita,
 *  nunca só contagem — quem revisa precisa ver QUEM entra e QUEM sai). */
export function logDiff(diff: ApoiadoresTagDiff): void {
  log(`diff: +${diff.toAdd.length} adicionar · -${diff.toRemove.length} remover · ${diff.unchanged.length} já corretos`);
  for (const e of diff.toAdd) log(`  + ${e}`);
  for (const e of diff.toRemove) log(`  - ${e}`);
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

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as { kit_apoiadores?: KitApoiadoresChannelConfig })
    : {};
  const tagNameResolution = resolveApoiadoresTagName(platformConfig.kit_apoiadores);
  if (!tagNameResolution.ok) {
    log(`ERRO: ${tagNameResolution.reason}`);
    process.exit(2);
    return;
  }
  const tagName = tagNameResolution.tagName;

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(1);
    return;
  }
  const kitConfig = kitConfigResult.config;

  log(`lendo assinantes do Kit (níveis alvo: ${APOIADORES_MENSAL_NIVEIS.join(", ")})…`);
  const desired = await fetchDesiredMembers(kitConfig);
  log(`${desired.length} assinante(s) ativo(s) com nível alvo.`);

  let tagId = await findTagIdByName(tagName, kitConfig);
  if (tagId === null) {
    if (!push) {
      log(
        `tag "${tagName}" ainda não existe no Kit — em --push ela SERIA criada e receberia ` +
          `${desired.length} membro(s). Nada aplicado (dry-run).`,
      );
      logDiff(diffApoiadoresTagMembership(desired.map((m) => m.email), []));
      return;
    }
    log(`tag "${tagName}" não existe — criando.`);
    tagId = (await createTag(tagName, kitConfig)).id;
    log(`tag criada: id=${tagId}. (A listagem de tags do Kit leva ~1-2min pra refletir — normal.)`);
  }

  const current = await fetchTagMembers(tagId, kitConfig);
  log(`tag "${tagName}" (id=${tagId}) tem ${current.length} membro(s) hoje.`);

  const diff = diffApoiadoresTagMembership(desired.map((m) => m.email), current.map((m) => m.email));
  logDiff(diff);

  const blast = evaluateApoiadoresBlastRadius(diff.toRemove.length, current.length, forceBlastRadius);
  if (blast.removalCount > 0) {
    log(
      `blast radius: ${blast.removalCount}/${blast.currentCount} remoções (${(blast.ratio * 100).toFixed(1)}%)` +
        (blast.blocked ? " — ACIMA do limiar de 30%." : ""),
    );
  }

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  if (blast.blocked) {
    log(
      "RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação aplicada, nem adições " +
        "nem remoções. Confira se é virada de mês/leitura parcial antes de usar --force-blast-radius.",
    );
    process.exit(1);
    return;
  }

  const byEmail = new Map<string, KitTagMember>();
  for (const m of [...desired, ...current]) byEmail.set(m.email, m);

  let applied = 0;
  let failed = 0;
  for (const email of diff.toAdd) {
    const member = byEmail.get(email);
    if (!member) {
      failed++;
      log(`FALHA em ${email}: sem id de assinante (não deveria acontecer — e-mail veio da própria leitura).`);
      continue;
    }
    try {
      await applyAdd(member, tagId, kitConfig);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA ao adicionar ${email}: ${(e as Error).message}`);
    }
  }
  for (const email of diff.toRemove) {
    const member = byEmail.get(email);
    if (!member) {
      failed++;
      log(`FALHA em ${email}: sem id de assinante (não deveria acontecer — e-mail veio da própria leitura).`);
      continue;
    }
    try {
      await applyRemove(member, tagId, kitConfig);
      applied++;
    } catch (e) {
      failed++;
      log(`FALHA ao remover ${email}: ${(e as Error).message}`);
    }
  }

  log(`push concluído: ${applied} aplicada(s), ${failed} falha(s).`);
  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
