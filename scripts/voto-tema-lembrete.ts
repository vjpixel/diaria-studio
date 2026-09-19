#!/usr/bin/env node
/**
 * scripts/voto-tema-lembrete.ts (#8371)
 *
 * Marca quem AINDA NÃO votou com a tag `voto-tema-pendente` — o Kit não
 * filtra broadcast por lista arbitrária de e-mails, só por tag/segmento
 * (ver `scripts/lib/shared/kit-apoio-tag.ts`), daí o passo de tagueamento
 * antes de qualquer 2º envio. Este script SÓ tagueia; criar/disparar o
 * broadcast de lembrete continua sendo `publish-voto-tema-kit.ts`
 * (`--audience pendentes`), ação manual e sempre rascunho.
 *
 * Uso:
 *   npx tsx scripts/voto-tema-lembrete.ts --ciclo 2610 --dry-run
 *   npx tsx scripts/voto-tema-lembrete.ts --ciclo 2610 --push
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { createTag, findTagIdByName, tagSubscriber } from "./lib/kit-broadcasts.ts";
import { fetchTagMembers } from "./lib/kit-apoio-tag-sync.ts";
import { listWorkerKVKeys } from "./lib/cloudflare-kv-upload.ts";
import { eleitorHash, parseCicloVotacao, voteKeyPrefix } from "../workers/artigos/src/voto-tema-core.ts";
import {
  VOTO_TEMA_TAG_SYNC_COMMAND,
  VotoTemaGuardError,
  emailFromVoteKey,
  readBallotFromKv,
  readPlatformConfig,
  resolveVotoTemaKvConfig,
  resolveVotoTemaTagName,
} from "./lib/voto-tema-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[voto-tema-lembrete]";
export const VOTO_TEMA_PENDENTE_TAG = "voto-tema-pendente";

export interface RunOptions {
  ciclo: string;
  dryRun: boolean;
  log: (msg: string) => void;
}

/**
 * Pura: quem tem tag mas já votou (recebeu voto contado) não deveria ser
 * lembrado — a lista de "quem ainda não votou" é eleitorado − votantes,
 * casado por e-mail normalizado (mesma normalização de `kit-apoio-tag.ts`).
 * @pure
 */
export function selectPendentes(eleitoradoEmails: readonly string[], votantesEmails: readonly string[]): string[] {
  const votou = new Set(votantesEmails.map((e) => e.trim().toLowerCase()));
  return eleitoradoEmails.map((e) => e.trim().toLowerCase()).filter((e) => !votou.has(e));
}

export interface PendentesResolution {
  /** Quem ainda não votou E está no eleitorado congelado da cédula — só
   *  estes podem ser lembrados. */
  pendentes: string[];
  /** Quem está na tag HOJE mas não estava no eleitorado no momento da
   *  abertura (ex: virou Mantenedor depois). Um clique dessa pessoa no link
   *  de voto bateria 403 em `autorizarEleitor`, então ela NÃO é tagueada —
   *  mas o operador precisa saber que ela existe. */
  foraDoEleitorado: string[];
}

/**
 * Filtra os pendentes pelo eleitorado CONGELADO na cédula (`ballot.eleitores`,
 * hashes sha256 gravados na abertura). A membresia da tag é dinâmica; o
 * eleitorado não é. Mandar lembrete pra quem entrou na tag depois da abertura
 * é convidar pra um 403 — daí o filtro, e daí a lista `foraDoEleitorado`
 * devolvida junto (o aviso é do operador, não um erro que derruba a rodada).
 */
export async function selectPendentesElegiveis(
  eleitoradoEmails: readonly string[],
  votantesEmails: readonly string[],
  eleitoresHashes: readonly string[],
): Promise<PendentesResolution> {
  const congelados = new Set(eleitoresHashes);
  const pendentes: string[] = [];
  const foraDoEleitorado: string[] = [];
  for (const email of selectPendentes(eleitoradoEmails, votantesEmails)) {
    (congelados.has(await eleitorHash(email)) ? pendentes : foraDoEleitorado).push(email);
  }
  return { pendentes, foraDoEleitorado };
}

export async function run(options: RunOptions): Promise<void> {
  const { ciclo: rawCiclo, dryRun, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) throw new VotoTemaGuardError(`--ciclo "${rawCiclo}" inválido — precisa ser AAMM.`);

  const platformConfig = readPlatformConfig(ROOT);
  const tagNameResolution = resolveVotoTemaTagName(platformConfig.kit_votacao);
  if (!tagNameResolution.ok) throw new VotoTemaGuardError(tagNameResolution.reason);

  const kvConfig = resolveVotoTemaKvConfig();
  const ballot = await readBallotFromKv(ciclo, kvConfig);
  if (!ballot) throw new VotoTemaGuardError(`ciclo ${ciclo}: nenhuma cédula gravada.`);

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) throw new VotoTemaGuardError(kitConfigResult.reason);
  const kitConfig = kitConfigResult.config;

  const tagId = await findTagIdByName(tagNameResolution.tagName, kitConfig);
  if (tagId === null) {
    throw new VotoTemaGuardError(`tag "${tagNameResolution.tagName}" não existe — rode '${VOTO_TEMA_TAG_SYNC_COMMAND}' antes.`);
  }
  const eleitorado = await fetchTagMembers(tagId, kitConfig);

  const voteKeys = await listWorkerKVKeys(voteKeyPrefix(ciclo), kvConfig);
  const votantesEmails = voteKeys.map((k) => emailFromVoteKey(ciclo, k));
  const { pendentes, foraDoEleitorado } = await selectPendentesElegiveis(
    eleitorado.map((m) => m.email),
    votantesEmails,
    ballot.eleitores,
  );
  log(`eleitorado: ${eleitorado.length} · já votaram: ${votantesEmails.length} · pendentes: ${pendentes.length}`);
  if (foraDoEleitorado.length > 0) {
    log(
      `AVISO: ${foraDoEleitorado.length} membro(s) da tag NÃO estão no eleitorado congelado da cédula do ciclo ` +
        `${ciclo} (entraram na tag depois da abertura): ${foraDoEleitorado.join(", ")}. NÃO recebem lembrete — um ` +
        "clique deles no link de voto daria 403. Para incluí-los, reabra o ciclo com " +
        "'npx tsx scripts/voto-tema-open.ts --ciclo " + ciclo + " --push --force' (recalcula tokens de TODOS, " +
        "invalidando os links já enviados).",
    );
  }

  if (dryRun) {
    log(`[DRY RUN] tag "${VOTO_TEMA_PENDENTE_TAG}" seria aplicada a ${pendentes.length} apoiador(es): ${pendentes.join(", ") || "(nenhum)"}`);
    log("[DRY RUN] nenhuma mutação — rode com --push para gravar.");
    return;
  }

  if (pendentes.length === 0) {
    log("ninguém pendente — nada a tagear.");
    return;
  }

  let pendenteTagId = await findTagIdByName(VOTO_TEMA_PENDENTE_TAG, kitConfig);
  if (pendenteTagId === null) {
    pendenteTagId = (await createTag(VOTO_TEMA_PENDENTE_TAG, kitConfig)).id;
    log(`tag "${VOTO_TEMA_PENDENTE_TAG}" criada (id=${pendenteTagId}).`);
  }

  const pendentesSet = new Set(pendentes);
  let tagged = 0;
  for (const member of eleitorado) {
    if (!pendentesSet.has(member.email)) continue;
    await tagSubscriber(pendenteTagId, member.id, kitConfig);
    tagged++;
  }
  log(`tag "${VOTO_TEMA_PENDENTE_TAG}" aplicada a ${tagged} apoiador(es) que ainda não votaram.`);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const ciclo = getStringArg(argv, "ciclo", { example: "2610" });
  if (!ciclo) {
    process.stderr.write("Uso: npx tsx scripts/voto-tema-lembrete.ts --ciclo AAMM [--dry-run|--push]\n");
    process.exit(2);
  }
  try {
    await run({ ciclo, dryRun: !hasFlag(argv, "push"), log: (m) => process.stderr.write(`${LOG_PREFIX} ${m}\n`) });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
