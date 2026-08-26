#!/usr/bin/env node
/**
 * scripts/backfill-kit-attribution.ts (#6318 — Passo 0)
 *
 * Recupera a atribuição da base Kit a partir do snapshot da Beehiiv.
 *
 * O switchover (#6048/#6114) trouxe ~586 assinantes sem UTM nenhum, porque
 * `POST /v4/subscribers` não aceita atribuição e a nativa do Kit é
 * inalcançável por API (medido no #6318). O dado não se perdeu: está em
 * `data/beehiiv-backup/{data}/subscribers.jsonl`, com os 7 campos que a
 * Beehiiv mantinha. Este script cruza por e-mail e grava nos custom fields.
 *
 * Recuperação EXATA, não inferência — é o oposto do Passo 4 (reconstrução
 * por timestamp a partir dos Workers Logs), e por isso os dois gravam
 * `atribuicao_fonte` diferente. Ver `scripts/lib/kit-attribution.ts`.
 *
 * **Dry-run por padrão** (mesma convenção de `sync-apoio-nivel-*.ts`):
 * imprime o plano completo — inclusive quem NÃO vai ser tocado e por quê —
 * e só escreve com `--push`.
 *
 * Uso:
 *   npx tsx scripts/backfill-kit-attribution.ts
 *   npx tsx scripts/backfill-kit-attribution.ts --push
 *   npx tsx scripts/backfill-kit-attribution.ts --push --snapshot 2026-08-26
 *   npx tsx scripts/backfill-kit-attribution.ts --push --limit 20
 *   npx tsx scripts/backfill-kit-attribution.ts --push --force
 *
 * Exit codes: 1 erro fatal; 2 config ausente; 3 snapshot não encontrado.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { montarPlano, type BeehiivSubscriberRecord } from "./lib/kit-attribution.ts";
import { listAllKitSubscribers, updateSubscriberFields } from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Espaçamento entre escritas. Endpoints singulares do Kit dão 429 depois de
 *  algumas dezenas de chamadas sem pausa (achado do #6047). `kitFetch` já
 *  absorve um 429 ISOLADO via backoff, mas não é mecanismo de rate limit —
 *  um laço de centenas de chamadas precisa se auto-espaçar. */
const REQUEST_SPACING_MS = 350;

/** Pura — diretório de snapshot mais recente (nomes são `YYYY-MM-DD`). */
export function escolherSnapshot(dirs: string[], pedido?: string): string | null {
  const validos = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (pedido) return validos.includes(pedido) ? pedido : null;
  return validos.length > 0 ? validos[validos.length - 1] : null;
}

export function lerSnapshot(path: string): Map<string, BeehiivSubscriberRecord> {
  const porEmail = new Map<string, BeehiivSubscriberRecord>();
  for (const linha of readFileSync(path, "utf8").split("\n")) {
    if (!linha.trim()) continue;
    const registro = JSON.parse(linha) as BeehiivSubscriberRecord;
    if (registro?.email) porEmail.set(registro.email.toLowerCase(), registro);
  }
  return porEmail;
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const force = hasFlag(argv, "force");
  const valores = parseCliArgs(argv).values;
  const snapshotPedido = valores.snapshot as string | undefined;
  const log = (m: string) => process.stderr.write(`[backfill-kit-attribution] ${m}\n`);
  // `--limit N` grava só os N primeiros. Serve pro rollout em lote pequeno
  // (conferir na UI do Kit antes de soltar os ~586): como a idempotência é
  // por `atribuicao_fonte`, a rodada seguinte SEM `--limit` continua de onde
  // parou em vez de reprocessar o lote já gravado.
  const limite = valores.limit === undefined ? undefined : Number(valores.limit);
  if (limite !== undefined && (!Number.isInteger(limite) || limite <= 0)) {
    log(`ERRO: --limit precisa ser inteiro positivo, recebido "${valores.limit}".`);
    process.exitCode = 2;
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exitCode = 2;
    return;
  }
  const kitConfig = kitConfigResult.config;

  const baseDir = resolve(rootDir, "data", "beehiiv-backup");
  if (!existsSync(baseDir)) {
    log(`ERRO: ${baseDir} nao existe — rode scripts/backup-beehiiv.ts antes.`);
    process.exitCode = 3;
    return;
  }
  const snapshot = escolherSnapshot(readdirSync(baseDir), snapshotPedido);
  if (!snapshot) {
    log(`ERRO: snapshot ${snapshotPedido ?? "(mais recente)"} nao encontrado em ${baseDir}.`);
    process.exitCode = 3;
    return;
  }
  const snapshotPath = resolve(baseDir, snapshot, "subscribers.jsonl");
  if (!existsSync(snapshotPath)) {
    log(`ERRO: ${snapshotPath} nao existe.`);
    process.exitCode = 3;
    return;
  }

  const beehiiv = lerSnapshot(snapshotPath);
  log(`snapshot ${snapshot}: ${beehiiv.size} assinantes da Beehiiv`);

  // `status: "all"` inclui cancelados de propósito: a atribuição deles é o
  // que permite analisar churn POR CANAL de aquisição depois. O default da
  // API (só `active`) perderia essa metade da série.
  const kitSubs = await listAllKitSubscribers(kitConfig, { status: "all" });
  const kit = kitSubs.map((s) => ({ id: s.id, email_address: s.email_address, fields: s.fields }));
  log(`base Kit: ${kit.length} subscribers (inclui cancelados)`);

  const plano = montarPlano(kit, beehiiv, { force });
  log("");
  log(`  a gravar                              : ${plano.aplicar.length}`);
  log(`  ja tinham atribuicao_fonte (pulados)  : ${plano.jaFeitos}`);
  log(`  sem registro na Beehiiv (nasceram Kit): ${plano.semOrigem.length}`);
  log(`  casaram mas origem tambem vazia       : ${plano.origemVazia.length}`);

  if (plano.semOrigem.length > 0) {
    log("");
    log("  SEM ORIGEM (continuam sem atribuicao — alvo do Passo 4, via Workers Logs):");
    for (const e of plano.semOrigem) log(`    ${e}`);
  }

  if (!push) {
    log("");
    log("[dry-run] nada gravado. Rode com --push para aplicar.");
    return;
  }

  const aGravar = limite === undefined ? plano.aplicar : plano.aplicar.slice(0, limite);
  if (limite !== undefined) {
    log("");
    log(`[--limit ${limite}] gravando ${aGravar.length} de ${plano.aplicar.length}. ` +
      `Os ${plano.aplicar.length - aGravar.length} restantes ficam pra proxima rodada.`);
  }

  let ok = 0;
  const falhas: { email: string; erro: string }[] = [];
  for (const entry of aGravar) {
    try {
      // `updateSubscriberFields` = PATCH /v4/subscribers/{id} via `kitFetch`
      // (retry + 429). NÃO trocar por um PUT hand-rolled: PUT documenta
      // `email_address` como obrigatório e tem semântica de REPLACE, então
      // gravaria errado ou falharia nos 586 — e perderia a camada de retry.
      // Achado P0 do review da PR #6324.
      await updateSubscriberFields(entry.subscriberId, entry.fields, kitConfig);
      ok++;
      if (ok % 50 === 0) log(`  ... ${ok}/${aGravar.length}`);
    } catch (e) {
      falhas.push({ email: entry.email, erro: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  log("");
  log(`gravados: ${ok}/${aGravar.length}`);
  if (falhas.length > 0) {
    log(`FALHAS: ${falhas.length}`);
    for (const f of falhas.slice(0, 20)) log(`  ${f.email}: ${f.erro}`);
    // Idempotente: re-rodar reprocessa só quem nao recebeu `atribuicao_fonte`.
    log("Re-rodar o script reprocessa apenas as falhas (idempotencia por atribuicao_fonte).");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(
      `[backfill-kit-attribution] erro fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exitCode = 1;
  });
}
