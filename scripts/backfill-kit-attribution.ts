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
 *   npx tsx scripts/backfill-kit-attribution.ts --push --force
 *
 * Exit codes: 1 erro fatal; 2 config ausente; 3 snapshot não encontrado.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import {
  montarPlano,
  type BeehiivSubscriberRecord,
  type KitSubscriberLite,
} from "./lib/kit-attribution.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Espaçamento entre PUTs. Endpoints singulares do Kit dão 429 depois de
 *  algumas dezenas de chamadas sem pausa (achado do #6047). */
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

async function listarBaseKit(apiKey: string): Promise<KitSubscriberLite[]> {
  const todos: KitSubscriberLite[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("https://api.kit.com/v4/subscribers");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("status", "all");
    // Sem `include[]=fields`: o REST v4 já devolve os custom fields por
    // padrão e REJEITA esse include (422, "Valid fields are: attribution,
    // tags, location, canceled_at"). O `include: ["fields"]` do MCP é forma
    // da camada MCP, não da API — não portar de um pro outro.
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, { headers: { "X-Kit-Api-Key": apiKey } });
    if (!res.ok) throw new Error(`Kit list subscribers -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    for (const s of body.subscribers ?? []) {
      todos.push({ id: s.id, email_address: s.email_address, fields: s.fields });
    }
    cursor = body?.pagination?.has_next_page ? body.pagination.end_cursor : undefined;
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  } while (cursor);
  return todos;
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const force = hasFlag(argv, "force");
  const snapshotPedido = parseCliArgs(argv).values.snapshot as string | undefined;
  const log = (m: string) => process.stderr.write(`[backfill-kit-attribution] ${m}\n`);

  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    log("ERRO: KIT_API_KEY ausente no ambiente.");
    process.exitCode = 2;
    return;
  }

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

  const kit = await listarBaseKit(apiKey);
  log(`base Kit: ${kit.length} subscribers`);

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

  let ok = 0;
  const falhas: { email: string; erro: string }[] = [];
  for (const entry of plano.aplicar) {
    try {
      const res = await fetch(`https://api.kit.com/v4/subscribers/${entry.subscriberId}`, {
        method: "PUT",
        headers: { "X-Kit-Api-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: entry.fields }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
      ok++;
      if (ok % 50 === 0) log(`  ... ${ok}/${plano.aplicar.length}`);
    } catch (e) {
      falhas.push({ email: entry.email, erro: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  log("");
  log(`gravados: ${ok}/${plano.aplicar.length}`);
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
