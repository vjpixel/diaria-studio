#!/usr/bin/env npx tsx
/**
 * scripts/list-expired-one-off-scripts.ts (#7114)
 *
 * "Alarme periódico que lista os vencidos, sem remover nada sozinho — a
 * remoção continua sendo decisão com varredura de consumidor (regra 3 da
 * #7112)."
 *
 * Varre `scripts/*.ts` (nível raiz) por scripts que declaram
 * `@one-off-validity: expira=AAAA-MM-DD ...` (ver
 * `scripts/lib/one-off-script-validity.ts`) cuja data já passou, e lista.
 * Não apaga, não abre issue, não comenta — só imprime (`--json` pra
 * consumo programático). A decisão de remover — com a varredura de
 * consumidor que a regra 3 da #7112 exige — é sempre humana/manual (mesmo
 * espírito de `check-alarm-retirement-candidates.ts`, que também só lista).
 *
 * Uso:
 *   npx tsx scripts/list-expired-one-off-scripts.ts
 *   npx tsx scripts/list-expired-one-off-scripts.ts --json
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { checkOneOffScriptValidity, isExpiredMarker, isOneOffScriptFilename } from "./lib/one-off-script-validity.ts";

const LOG_PREFIX = "[list-expired-one-off-scripts]";
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SCRIPTS_DIR = resolve(ROOT, "scripts");

export interface ExpiredOneOffScript {
  path: string;
  expiresAt: string;
  question: string;
}

/**
 * Pura — dado o conteúdo já lido de cada arquivo (`Record<basename,
 * source>`) e "agora", devolve os que expiraram. Testável sem tocar disco.
 */
export function findExpiredOneOffScripts(
  filesByName: Record<string, string>,
  now: Date = new Date(),
): ExpiredOneOffScript[] {
  const out: ExpiredOneOffScript[] = [];
  for (const [name, source] of Object.entries(filesByName)) {
    if (!isOneOffScriptFilename(name)) continue;
    const result = checkOneOffScriptValidity(name, source);
    if (result.status !== "valid" || result.marker.kind !== "expires") continue;
    if (isExpiredMarker(result.marker, now)) {
      out.push({ path: `scripts/${name}`, expiresAt: result.marker.expiresAt, question: result.marker.question });
    }
  }
  return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

function readScriptsDirNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name);
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = hasFlag(argv, "json");

  const names = readScriptsDirNames(SCRIPTS_DIR).filter(isOneOffScriptFilename);
  const filesByName: Record<string, string> = {};
  for (const name of names) {
    filesByName[name] = readFileSync(resolve(SCRIPTS_DIR, name), "utf8");
  }

  const expired = findExpiredOneOffScripts(filesByName);

  if (json) {
    console.log(JSON.stringify(expired, null, 2));
    return;
  }

  if (expired.length === 0) {
    console.log(`${LOG_PREFIX} nenhum script one-off vencido.`);
    return;
  }

  console.log(`${LOG_PREFIX} ${expired.length} script(s) one-off vencido(s) — revisão manual, nada removido automaticamente:`);
  for (const e of expired) {
    console.log(`  ${e.path} — expirou em ${e.expiresAt} — pergunta: "${e.question}"`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
