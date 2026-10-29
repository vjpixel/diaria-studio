#!/usr/bin/env tsx
/**
 * add-destaque-source.ts (#11531)
 *
 * Acrescenta uma fonte ADICIONAL da mesma história ao destaque N, para o
 * fact-checker conferir claims que vêm dela e não da fonte do link do título.
 * Substitui a edição manual de `_internal/fact-check-sources/d{N}.txt` (o
 * contorno usado na edição 261029, quando o D1 citava um fato do Poder360 e
 * a fonte primária era a CNN).
 *
 * Grava `_internal/fact-check-sources/d{N}-extra-{k}.txt` + entrada
 * `origin: "editor"` em `extras.json` (ver `scripts/lib/fact-check-extra-sources.ts`).
 * Depois disso, redespachar o fact-checker e rodar o `--check-blocking` de novo.
 *
 * Uso:
 *   npx tsx scripts/add-destaque-source.ts --edition-dir data/editions/2610/261029/ --destaque 1 --url https://...
 *
 * Saída (stdout, JSON): a entrada gravada.
 *
 * Exit codes:
 *   0 — fonte baixada e registrada
 *   1 — erro de uso (args, approved ausente, destaque inexistente, URL = primária)
 *   2 — download falhou (entrada registrada com status blocked/error; re-rodar ou usar outra URL)
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { highlightSourceUrls } from "./run-fact-checker.ts";
import { addEditorExtraSource } from "./lib/fact-check-extra-sources.ts";

async function main(): Promise<number | void> {
  const { values: args } = parseArgs(process.argv.slice(2));
  const destaque = Number(args.destaque);
  if (!args["edition-dir"] || !args.url || !Number.isInteger(destaque) || destaque < 1 || destaque > 3) {
    console.error("Uso: add-destaque-source.ts --edition-dir data/editions/AAMM/AAMMDD/ --destaque 1|2|3 --url <URL>");
    return 1;
  }
  if (!/^https?:\/\//i.test(args.url)) {
    console.error(`add-destaque-source: URL inválida: ${args.url}`);
    return 1;
  }
  const internalDir = join(resolve(process.cwd(), args["edition-dir"]), "_internal");
  const approvedPath = join(internalDir, "01-approved.json");
  if (!existsSync(approvedPath)) {
    console.error(`add-destaque-source: 01-approved.json não encontrado em ${approvedPath}`);
    return 1;
  }
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as unknown;
  let entry;
  try {
    entry = await addEditorExtraSource(highlightSourceUrls(approved), internalDir, destaque, args.url);
  } catch (e) {
    console.error(`add-destaque-source: ${(e as Error).message}`);
    return 1;
  }
  console.log(JSON.stringify(entry, null, 2));
  if (entry.status !== "ok") {
    console.error(`add-destaque-source: download falhou (${entry.erro}) — fonte registrada, mas sem texto.`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`add-destaque-source: ${(e as Error).message}`) });
}
