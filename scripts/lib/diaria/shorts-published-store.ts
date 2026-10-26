/**
 * scripts/lib/diaria/shorts-published-store.ts (#11157)
 *
 * Leitura e gravação do registro do vertical (`_internal/06-shorts-published.json`)
 * com mais de um escritor.
 *
 * Até o #11157 o `publish-shorts.ts` lia o registro uma vez no início e
 * reescrevia o arquivo INTEIRO a cada destino a partir dessa cópia em memória.
 * Com o timer do LinkedIn pessoal no 300 (`shorts-linkedin-profile-timer.ts`,
 * #10982) o arquivo ganhou um 2º escritor em OUTRA máquina, e `data/` é
 * sincronizado pelo OneDrive: um `--mark facebook_profile=URL` no neo,
 * gravado a partir de uma cópia sem `linkedin_profile`, apagava a entrada do
 * timer, e a execução seguinte do timer publicava o mesmo vídeo de novo no
 * perfil do editor. Mesma classe do #11113 (arquivo inteiro escrito por duas
 * máquinas via OneDrive).
 *
 * Duas defesas:
 *
 *   1. Registro por ESCRITOR (padrão do #11113). A rodada do timer
 *      (`--linkedin-timer`) grava só em `SHORTS_TIMER_LEDGER_FILE`, que
 *      nenhuma outra rodada escreve; as demais gravam no registro principal.
 *      Uma máquina com cópia defasada do principal nunca apaga a entrada do
 *      timer, e vice-versa. Os leitores unem os arquivos
 *      (`readShortsRegistry`), inclusive as cópias de conflito do OneDrive
 *      (`06-shorts-published-Neo.json` e afins): uma entrada em qualquer um
 *      deles conta como feita. Entrada só fecha a janela de publicação, nunca
 *      abre, então uma cópia de conflito a mais nunca causa post duplicado.
 *   2. Gravação por upsert sob lock (`persistShortEntry`): relê o arquivo do
 *      próprio escritor do disco, troca só a entrada do destino e grava de
 *      forma atômica, com `withFileLock`. Cobre dois processos na MESMA
 *      máquina (o lock é arquivo local; entre máquinas quem protege é o 1).
 *
 * Registro ilegível continua abortando (nunca vira "nada publicado").
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { withFileLock } from "../file-lock.ts";
import {
  SHORTS_PUBLISHED_FILE,
  parseShortsPublishedFile,
  upsertShortEntry,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "./short-video.ts";

/** Registro escrito SÓ pela rodada do timer do 300 (`--linkedin-timer`). */
export const SHORTS_TIMER_LEDGER_FILE = "_internal/06-shorts-published.linkedin-timer.json";

export type ShortsRegistryWriter = "main" | "linkedin-timer";

/** Caminho do arquivo que `writer` escreve, dentro da pasta da edição. */
export function shortsRegistryPath(editionDir: string, writer: ShortsRegistryWriter): string {
  return join(editionDir, writer === "linkedin-timer" ? SHORTS_TIMER_LEDGER_FILE : SHORTS_PUBLISHED_FILE);
}

/** Qual escritor é esta rodada do `publish-shorts.ts`. */
export function shortsRegistryWriterFor(linkedinTimer: boolean): ShortsRegistryWriter {
  return linkedinTimer ? "linkedin-timer" : "main";
}

const REGISTRY_STEM = basename(SHORTS_PUBLISHED_FILE, ".json"); // "06-shorts-published"

/**
 * Nome é de um arquivo do registro? O principal, o do timer e as cópias de
 * conflito do OneDrive dos dois (`06-shorts-published-Neo.json`,
 * `06-shorts-published.linkedin-timer-Neo-2.json`). Temporários da escrita
 * atômica começam com `.` e ficam de fora.
 */
export function isShortsRegistryFileName(name: string): boolean {
  return name.startsWith(REGISTRY_STEM) && name.endsWith(".json");
}

/** Arquivos do registro presentes na edição: principal primeiro, depois o do timer, depois o resto em ordem. */
export function listShortsRegistryFiles(editionDir: string): string[] {
  const dir = dirname(join(editionDir, SHORTS_PUBLISHED_FILE));
  if (!existsSync(dir)) return [];
  const main = basename(SHORTS_PUBLISHED_FILE);
  const ledger = basename(SHORTS_TIMER_LEDGER_FILE);
  const rank = (n: string) => (n === main ? 0 : n === ledger ? 1 : 2);
  return readdirSync(dir)
    .filter(isShortsRegistryFileName)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((n) => join(dir, n));
}

function entryTime(e: ShortPublishedEntry): number {
  const ms = Date.parse(e.at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Une registros por destino. O mesmo destino em mais de um arquivo fica com a
 * entrada de `at` mais recente (ex.: `--mark linkedin_profile=URL` do editor
 * depois de um `send_unknown` do timer); empate fica com o arquivo que vem
 * antes na lista. Puro.
 */
export function mergeShortsRegistries(aammdd: string, files: readonly ShortsPublishedFile[]): ShortsPublishedFile {
  const byDest = new Map<string, ShortPublishedEntry>();
  for (const f of files) {
    for (const e of f.entries) {
      const prev = byDest.get(e.destination);
      if (!prev || entryTime(e) > entryTime(prev)) byDest.set(e.destination, e);
    }
  }
  return { aammdd, entries: [...byDest.values()] };
}

function readOne(path: string, aammdd: string): ShortsPublishedFile {
  return parseShortsPublishedFile(readFileSync(path, "utf8"), aammdd, path);
}

/**
 * Visão unida do registro da edição (todos os escritores + cópias de
 * conflito). Qualquer arquivo ilegível lança, como o registro único lançava.
 */
export function readShortsRegistry(editionDir: string, aammdd: string): ShortsPublishedFile {
  return mergeShortsRegistries(aammdd, listShortsRegistryFiles(editionDir).map((p) => readOne(p, aammdd)));
}

/** Conteúdo bruto de cada arquivo do registro (pro `decideTimerRun`). */
export function readShortsRegistryRaws(editionDir: string): Array<{ path: string; raw: string }> {
  return listShortsRegistryFiles(editionDir).map((path) => ({ path, raw: readFileSync(path, "utf8") }));
}

/**
 * Grava UMA entrada no arquivo de `writer`: sob lock, relê esse arquivo do
 * disco, troca só a entrada do destino e grava de forma atômica. Nunca
 * reescreve a partir de uma cópia em memória. Devolve a visão unida já com a
 * entrada nova.
 */
export function persistShortEntry(
  editionDir: string,
  aammdd: string,
  writer: ShortsRegistryWriter,
  entry: ShortPublishedEntry,
  lockTimeoutMs = 30_000,
): ShortsPublishedFile {
  const path = shortsRegistryPath(editionDir, writer);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(
    `${path}.lock`,
    () => {
      const current = existsSync(path) ? readOne(path, aammdd) : { aammdd, entries: [] };
      writeFileAtomic(path, JSON.stringify(upsertShortEntry(current, entry), null, 2) + "\n");
    },
    lockTimeoutMs,
  );
  return readShortsRegistry(editionDir, aammdd);
}
