#!/usr/bin/env node
/**
 * scripts/voto-tema-open.ts (#8371)
 *
 * Abre um ciclo de votação de tema: lê a cédula proposta pelo editor
 * (`data/artigo-especial/votacao/{aamm}/ballot.json`), resolve o eleitorado
 * (tag Kit `apoio-voto-tema`, Mantenedor/Patrono), calcula um token opaco
 * por eleitor (o MESMO formato de token do "É IA?" — `computePollToken`),
 * grava a tabela reversa `polltoken:{token} -> email` no KV, patcha o custom
 * field `voto_token` no Kit e por fim grava a cédula final
 * (`tema:ballot:{aamm}`, com `eleitores[]` já como hash sha256 — nunca
 * e-mail cru) no KV.
 *
 * Ordem de escrita (importa, mesmo racional de `inject-poll-token-brevo.ts`):
 * grava o KV ANTES de patchar o Kit — pior caso de falha no meio é uma
 * entrada KV órfã (sem custo), nunca um custom field publicado sem a entrada
 * reversa correspondente (que faria o link de voto dar 403 pro leitor).
 *
 * ⚠️ Assume que o custom field `voto_token` JÁ EXISTE no Kit (criado
 * manualmente uma vez, mesmo passo do "Teste decisivo" descrito no corpo da
 * #8371) — este script não cria custom field, só o preenche.
 *
 * `--dry-run` (default): mostra o que seria feito, não grava nada.
 * `--push`: grava de verdade — KV + Kit.
 *
 * Uso:
 *   npx tsx scripts/voto-tema-open.ts --ciclo 2610 --dry-run
 *   npx tsx scripts/voto-tema-open.ts --ciclo 2610 --push
 *   npx tsx scripts/voto-tema-open.ts --ciclo 2610 --push --force   # reabre/recalcula tokens
 *
 * Env: POLL_SECRET, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_TOKEN, KIT_API_KEY
 * (todas só exigidas fora de --dry-run).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { findTagIdByName } from "./lib/kit-broadcasts.ts";
import { fetchTagMembers } from "./lib/kit-apoio-tag-sync.ts";
import { updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { computePollToken, pollTokenKvKey } from "./lib/shared/poll-token.ts";
import { putTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { ballotKey, parseCicloVotacao, validarCedula, eleitorHash, type BallotTema, type CandidatoTema } from "../workers/artigos/src/voto-tema-core.ts";
import {
  VOTO_TEMA_TAG_SYNC_COMMAND,
  VotoTemaGuardError,
  readBallotFromKv,
  readPlatformConfig,
  resolveVotoTemaKvConfig,
  resolveVotoTemaTagName,
  writeBallotToKv,
} from "./lib/voto-tema-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[voto-tema-open]";
const KIT_VOTO_TOKEN_FIELD = "voto_token";

/**
 * Mensagem do erro que sobe quando a cédula falha ao ser gravada DEPOIS que os
 * custom fields já foram patchados no Kit e as entradas reversas `polltoken:*`
 * já foram gravadas no KV. Mesmo padrão de `persistSuffix` em
 * `publish-artigo-especial-kit.ts`: quem lê o stack trace precisa saber o que
 * JÁ ACONTECEU (e portanto não deve ser refeito à mão) vs o que falta.
 * @pure
 */
export function ballotWriteFailureMessage(
  ciclo: string,
  patched: number,
  total: number,
  reason: string,
): string {
  return (
    `a cédula do ciclo ${ciclo} NÃO foi gravada no KV (${reason}). JÁ ACONTECERAM, e não precisam ser refeitos ` +
    `à mão: ${patched}/${total} custom field(s) "${KIT_VOTO_TOKEN_FIELD}" patchados no Kit e as entradas ` +
    `reversas polltoken:* correspondentes gravadas no KV. FALTA só a cédula (${ballotKey(ciclo)}) — reexecutar ` +
    "este script com --push --force é seguro e idempotente (recalcula os mesmos tokens para os mesmos " +
    "e-mails); NÃO repatche o Kit manualmente."
  );
}

export function ballotInputPath(dataDir: string, ciclo: string): string {
  return resolve(dataDir, "artigo-especial", "votacao", ciclo, "ballot.json");
}

interface BallotInput {
  titulo: string;
  opcoes: CandidatoTema[];
}

export function readBallotInput(path: string): BallotInput {
  if (!existsSync(path)) {
    throw new VotoTemaGuardError(
      `${path} ausente — escreva a cédula lá (título + opcoes[{n,titulo,descricao,proponente?}]) antes de abrir a votação.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as BallotInput;
}

export interface RunOptions {
  ciclo: string;
  dataDir: string;
  dryRun: boolean;
  force: boolean;
  log: (msg: string) => void;
}

export async function run(options: RunOptions): Promise<void> {
  const { ciclo: rawCiclo, dataDir, dryRun, force, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) {
    throw new VotoTemaGuardError(
      `--ciclo "${rawCiclo}" inválido — precisa ser AAMM (4 dígitos, mês de publicação do artigo). Nunca AAMMDD nem YYMM-MM.`,
    );
  }

  const platformConfig = readPlatformConfig(ROOT);
  const tagNameResolution = resolveVotoTemaTagName(platformConfig.kit_votacao);
  if (!tagNameResolution.ok) throw new VotoTemaGuardError(tagNameResolution.reason);
  const tagName = tagNameResolution.tagName;

  const inputPath = ballotInputPath(dataDir, ciclo);
  const input = readBallotInput(inputPath);
  const validation = validarCedula(input);
  if (!validation.ok) throw new VotoTemaGuardError(`cédula inválida (${inputPath}): ${validation.reason}`);

  const kvConfig = resolveVotoTemaKvConfig();

  if (!dryRun) {
    const already = await readBallotFromKv(ciclo, kvConfig).catch(() => null);
    if (already && !force) {
      throw new VotoTemaGuardError(
        `já existe uma cédula gravada para o ciclo ${ciclo} — recusando sobrescrever. Use --force se for ` +
          "intencional (recalcula tokens de TODOS os eleitores, invalidando links já enviados).",
      );
    }
  }

  if (dryRun) {
    log(`[DRY RUN] ciclo: ${ciclo}`);
    log(`[DRY RUN] título: ${input.titulo}`);
    for (const o of input.opcoes) log(`[DRY RUN]   opção ${o.n}: ${o.titulo}`);
    log(`[DRY RUN] tag de audiência: "${tagName}" (Mantenedor/Patrono, R$25+)`);
    log("[DRY RUN] nenhuma escrita em KV/Kit — rode com --push para gravar de verdade.");
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) throw new VotoTemaGuardError(kitConfigResult.reason);
  const kitConfig: KitConfig = kitConfigResult.config;

  const pollSecret = process.env.POLL_SECRET;
  if (!pollSecret) throw new VotoTemaGuardError("POLL_SECRET ausente — necessário pra calcular o token de voto.");

  const tagId = await findTagIdByName(tagName, kitConfig);
  if (tagId === null) {
    throw new VotoTemaGuardError(
      `tag "${tagName}" não existe no Kit — rode '${VOTO_TEMA_TAG_SYNC_COMMAND}' antes. Recusando: sem ` +
        "audiência resolvida não há eleitorado.",
    );
  }
  const members = await fetchTagMembers(tagId, kitConfig);
  if (members.length === 0) {
    throw new VotoTemaGuardError(
      `tag "${tagName}" (id=${tagId}) está VAZIA — 0 membros. Rode '${VOTO_TEMA_TAG_SYNC_COMMAND}' e confira ` +
        "se há apoiador Mantenedor/Patrono com apoio_nivel gravado no Kit.",
    );
  }
  log(`eleitorado: ${members.length} apoiador(es) (tag "${tagName}", id=${tagId}).`);

  const eleitoresHashes: string[] = [];
  let patched = 0;
  const failures: { email: string; error: string }[] = [];
  for (const member of members) {
    const token = await computePollToken(pollSecret, member.email);
    eleitoresHashes.push(await eleitorHash(member.email));
    try {
      // KV primeiro (ver docstring do módulo) — pior caso de falha aqui é
      // entrada órfã, nunca um custom field publicado sem entrada reversa.
      await putTextToWorkerKV(pollTokenKvKey(token), member.email, kvConfig);
      await updateSubscriberFields(member.id, { [KIT_VOTO_TOKEN_FIELD]: token }, kitConfig);
      patched++;
    } catch (e) {
      failures.push({ email: member.email, error: (e as Error).message });
      log(`AVISO: falha ao preparar token para ${member.email}: ${(e as Error).message}`);
    }
  }

  const ballot: BallotTema = {
    titulo: input.titulo,
    opcoes: input.opcoes,
    eleitores: eleitoresHashes,
    aberta_em: new Date().toISOString(),
  };
  try {
    await writeBallotToKv(ciclo, ballot, kvConfig);
  } catch (e) {
    throw new Error(ballotWriteFailureMessage(ciclo, patched, members.length, (e as Error).message));
  }

  log(
    `cédula gravada (ciclo ${ciclo}): ${patched}/${members.length} eleitor(es) com token pronto` +
      (failures.length ? `, ${failures.length} falha(s) — reveja antes de enviar.` : "."),
  );
  log(
    "Próximo passo: npx tsx scripts/publish-voto-tema-kit.ts --ciclo " +
      `${ciclo} --dry-run (rascunho — NUNCA envie sem test-send + conferência de audiência).`,
  );

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} eleitor(es) sem token pronto: ${failures.map((f) => f.email).join(", ")}. A cédula ` +
        "foi gravada mesmo assim (quem já tem token pode votar); rode de novo com --force pra tentar recalcular tudo.",
    );
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const ciclo = getStringArg(argv, "ciclo", { example: "2610" });
  if (!ciclo) {
    process.stderr.write("Uso: npx tsx scripts/voto-tema-open.ts --ciclo AAMM [--dry-run|--push] [--force]\n");
    process.exit(2);
  }
  try {
    await run({
      ciclo,
      dataDir: resolve(ROOT, "data"),
      dryRun: !hasFlag(argv, "push"),
      force: hasFlag(argv, "force"),
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
