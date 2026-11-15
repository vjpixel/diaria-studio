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
 * #11265: o timer do Instagram no 300 (`shorts-instagram-timer.ts`) virou o
 * 3º escritor, com o mesmo tratamento do timer do LinkedIn. #11410: o timer
 * do Threads pessoal (`shorts-threads-profile-timer.ts`) é o 4º.
 *
 * Duas defesas:
 *
 *   1. Registro por ESCRITOR (padrão do #11113). São três arquivos: cada
 *      rodada de timer grava só no próprio (`--linkedin-timer` em
 *      `SHORTS_TIMER_LEDGER_FILE`, `--instagram-timer` em
 *      `SHORTS_INSTAGRAM_TIMER_LEDGER_FILE`), que nenhuma outra rodada
 *      escreve; as demais gravam no registro principal. Uma máquina com
 *      cópia defasada de um arquivo nunca apaga a entrada de outro escritor. Os leitores unem os arquivos
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
  type InstagramBackend,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "./short-video.ts";
import { isCorteDir } from "./short-corte.ts";

/** Registro escrito SÓ pela rodada do timer do LinkedIn no 300 (`--linkedin-timer`). */
export const SHORTS_TIMER_LEDGER_FILE = "_internal/06-shorts-published.linkedin-timer.json";

/**
 * #11265: registro escrito SÓ pela rodada do timer do Instagram no 300
 * (`--instagram-timer`, `scripts/shorts-instagram-timer.ts`). Mesmo padrão do
 * registro do timer do LinkedIn: um escritor por arquivo entre máquinas.
 */
export const SHORTS_INSTAGRAM_TIMER_LEDGER_FILE = "_internal/06-shorts-published.instagram-timer.json";

/**
 * #11410: registro escrito SÓ pela rodada do timer do Threads pessoal no 300
 * (`--threads-timer`, `scripts/shorts-threads-profile-timer.ts`). Mesmo padrão
 * dos outros dois timers.
 */
export const SHORTS_THREADS_TIMER_LEDGER_FILE = "_internal/06-shorts-published.threads-timer.json";

export type ShortsRegistryWriter = "main" | "linkedin-timer" | "instagram-timer" | "threads-timer";

const LEDGER_FILE_OF: Record<ShortsRegistryWriter, string> = {
  main: SHORTS_PUBLISHED_FILE,
  "linkedin-timer": SHORTS_TIMER_LEDGER_FILE,
  "instagram-timer": SHORTS_INSTAGRAM_TIMER_LEDGER_FILE,
  "threads-timer": SHORTS_THREADS_TIMER_LEDGER_FILE,
};

/** Caminho do arquivo que `writer` escreve, dentro da pasta da edição. */
export function shortsRegistryPath(editionDir: string, writer: ShortsRegistryWriter): string {
  return join(editionDir, LEDGER_FILE_OF[writer]);
}

/**
 * Qual escritor é esta rodada do `publish-shorts.ts`. Duas flags de timer
 * juntas não são um escritor (#11368, #11410): o CLI recusa antes, e aqui
 * lança em vez de escolher um por ordem.
 */
export function shortsRegistryWriterFor(linkedinTimer: boolean, instagramTimer = false, threadsTimer = false): ShortsRegistryWriter {
  if (linkedinTimer && instagramTimer) throw new Error("--instagram-timer não combina com --linkedin-timer (cada timer grava o próprio registro)");
  if (threadsTimer && (linkedinTimer || instagramTimer)) throw new Error("--threads-timer não combina com outro timer (cada timer grava o próprio registro)");
  return linkedinTimer ? "linkedin-timer" : instagramTimer ? "instagram-timer" : threadsTimer ? "threads-timer" : "main";
}

/**
 * #11159: único destino que o registro do timer aceita. O arquivo do timer só
 * fica com um escritor por destino se nenhuma outra entrada cair nele: um
 * `--linkedin-timer` sem `--only` no neo gravaria ali as páginas do Facebook e
 * o Instagram, e uma gravação do timer no 300 a partir da cópia sem elas
 * (último a escrever vence no OneDrive) apagaria essas entradas — o próximo
 * `--publish` republicaria os Reels.
 */
export const SHORTS_TIMER_LEDGER_DESTINATION = "linkedin_profile";

/** #11265: único destino que o registro do timer do Instagram aceita. */
export const SHORTS_INSTAGRAM_TIMER_LEDGER_DESTINATION = "instagram";

/** #11410: único destino que o registro do timer do Threads pessoal aceita. */
export const SHORTS_THREADS_TIMER_LEDGER_DESTINATION = "threads_profile";

/** Destino único de cada registro de timer (`null` = `main`, aceita todos). */
const LEDGER_DESTINATION_OF: Record<ShortsRegistryWriter, string | null> = {
  main: null,
  "linkedin-timer": SHORTS_TIMER_LEDGER_DESTINATION,
  "instagram-timer": SHORTS_INSTAGRAM_TIMER_LEDGER_DESTINATION,
  "threads-timer": SHORTS_THREADS_TIMER_LEDGER_DESTINATION,
};

/**
 * Pure (#11159): o escopo de uma rodada `--linkedin-timer`. Devolve a mensagem
 * de erro, ou `null` quando a rodada pode seguir. A rodada do timer só pode
 * tocar o `linkedin_profile`: `--only linkedin_profile` (exatamente), ou um
 * `--mark linkedin_profile=URL`; `--confirm-instagram` nunca.
 */
export function linkedinTimerScopeError(input: {
  linkedinTimer: boolean;
  only: readonly string[] | null;
  markDestination?: string | null;
  confirmInstagram?: boolean;
}): string | null {
  if (!input.linkedinTimer) return null;
  const dest = SHORTS_TIMER_LEDGER_DESTINATION;
  if (input.confirmInstagram) return `--linkedin-timer não combina com --confirm-instagram (a rodada do timer só grava ${dest})`;
  if (input.markDestination != null) {
    return input.markDestination === dest ? null : `--linkedin-timer com --mark só aceita ${dest} (recebeu ${input.markDestination})`;
  }
  const only = input.only ? [...new Set(input.only)] : [];
  if (only.length === 1 && only[0] === dest) return null;
  return `--linkedin-timer exige --only ${dest} (recebeu ${only.length ? `--only ${only.join(",")}` : "sem --only"}): o registro do timer só pode ter o ${dest}`;
}

/**
 * Pure (#11265): o escopo de uma rodada `--instagram-timer`, mesmo contrato do
 * `linkedinTimerScopeError`. Só `--only instagram` (exatamente) ou `--mark
 * instagram=URL`; nunca junto do `--linkedin-timer` nem do
 * `--confirm-instagram` (o timer confere a conta pela API antes de publicar,
 * sem a flag), e só com `instagram_backend: "timer-300"` (com `worker-r2` o
 * dono do Instagram é a rodada normal: o timer duplicaria o Reels).
 */
export function instagramTimerScopeError(input: {
  instagramTimer: boolean;
  /**
   * `publishing.shorts.instagram_backend`; `"unreadable"` = o config não carregou
   * (#11368: recusa, em vez de pular a regra como o antigo campo opcional).
   */
  backend: InstagramBackend | "unreadable";
  linkedinTimer?: boolean;
  only: readonly string[] | null;
  markDestination?: string | null;
  confirmInstagram?: boolean;
}): string | null {
  if (!input.instagramTimer) return null;
  const dest = SHORTS_INSTAGRAM_TIMER_LEDGER_DESTINATION;
  if (input.backend === "unreadable") {
    return "--instagram-timer: platform.config.json não carregou, não dá pra conferir publishing.shorts.instagram_backend (o timer só age com timer-300)";
  }
  if (input.backend !== "timer-300") {
    return `--instagram-timer só vale com publishing.shorts.instagram_backend = "timer-300" (está "${input.backend}")`;
  }
  if (input.linkedinTimer) return "--instagram-timer não combina com --linkedin-timer (cada timer grava o próprio registro)";
  if (input.confirmInstagram) return `--instagram-timer não combina com --confirm-instagram (a rodada do timer confere a conta sozinha antes de publicar)`;
  if (input.markDestination != null) {
    return input.markDestination === dest ? null : `--instagram-timer com --mark só aceita ${dest} (recebeu ${input.markDestination})`;
  }
  const only = input.only ? [...new Set(input.only)] : [];
  if (only.length === 1 && only[0] === dest) return null;
  return `--instagram-timer exige --only ${dest} (recebeu ${only.length ? `--only ${only.join(",")}` : "sem --only"}): o registro do timer só pode ter o ${dest}`;
}

/**
 * Pure (#11410): o escopo de uma rodada `--threads-timer`, mesmo contrato do
 * `instagramTimerScopeError`. Só `--only threads_profile` (exatamente) ou
 * `--mark threads_profile=URL`; nunca junto de outro timer nem do
 * `--confirm-instagram`, e só com `publishing.shorts.threads_profile_via_timer`
 * ligado (desligado, o dono do destino é a rodada normal do
 * `/diaria-publica-video`: o timer duplicaria o post).
 */
export function threadsTimerScopeError(input: {
  threadsTimer: boolean;
  /** `publishing.shorts.threads_profile_via_timer`; `"unreadable"` = o config não carregou (recusa). */
  viaTimer: boolean | "unreadable";
  otherTimer?: boolean;
  only: readonly string[] | null;
  markDestination?: string | null;
  confirmInstagram?: boolean;
}): string | null {
  if (!input.threadsTimer) return null;
  const dest = SHORTS_THREADS_TIMER_LEDGER_DESTINATION;
  if (input.viaTimer === "unreadable") {
    return "--threads-timer: platform.config.json não carregou, não dá pra conferir publishing.shorts.threads_profile_via_timer (o timer só age com ele ligado)";
  }
  if (!input.viaTimer) return "--threads-timer só vale com publishing.shorts.threads_profile_via_timer = true (está false)";
  if (input.otherTimer) return "--threads-timer não combina com outro timer (cada timer grava o próprio registro)";
  if (input.confirmInstagram) return `--threads-timer não combina com --confirm-instagram (a rodada do timer só grava ${dest})`;
  if (input.markDestination != null) {
    return input.markDestination === dest ? null : `--threads-timer com --mark só aceita ${dest} (recebeu ${input.markDestination})`;
  }
  const only = input.only ? [...new Set(input.only)] : [];
  if (only.length === 1 && only[0] === dest) return null;
  return `--threads-timer exige --only ${dest} (recebeu ${only.length ? `--only ${only.join(",")}` : "sem --only"}): o registro do timer só pode ter o ${dest}`;
}

const REGISTRY_STEM = basename(SHORTS_PUBLISHED_FILE, ".json"); // "06-shorts-published"

/**
 * Nome é de um arquivo do registro? O principal, os dos timers e as
 * cópias de conflito do OneDrive dos três (`06-shorts-published-Neo.json`,
 * `06-shorts-published.linkedin-timer-Neo-2.json`). Temporários da escrita
 * atômica começam com `.` e ficam de fora.
 */
export function isShortsRegistryFileName(name: string): boolean {
  return name.startsWith(REGISTRY_STEM) && name.endsWith(".json");
}

/** Arquivos do registro presentes na edição: principal primeiro, depois os dos timers, depois o resto em ordem. */
export function listShortsRegistryFiles(editionDir: string): string[] {
  const dir = dirname(join(editionDir, SHORTS_PUBLISHED_FILE));
  if (!existsSync(dir)) return [];
  const main = basename(SHORTS_PUBLISHED_FILE);
  const ledgers = new Set([basename(SHORTS_TIMER_LEDGER_FILE), basename(SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), basename(SHORTS_THREADS_TIMER_LEDGER_FILE)]);
  const rank = (n: string) => (n === main ? 0 : ledgers.has(n) ? 1 : 2);
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

/** #12998/#12999: no corte avulso o `aammdd` do arquivo não é comparado (a data do corte muda num reagendamento). */
function readOne(path: string, aammdd: string, corte: boolean): ShortsPublishedFile {
  return parseShortsPublishedFile(readFileSync(path, "utf8"), aammdd, path, { corte });
}

/**
 * Visão unida do registro da edição (todos os escritores + cópias de
 * conflito). Qualquer arquivo ilegível lança, como o registro único lançava.
 */
export function readShortsRegistry(editionDir: string, aammdd: string): ShortsPublishedFile {
  const corte = isCorteDir(editionDir);
  // #12279: o post trocado pelo --replace-scheduled não conta mais como feito, em nenhum
  // arquivo (cópias de conflito do OneDrive incluídas): o par destino/ID antigo some da visão.
  const replaced = readShortReplacements(editionDir);
  const gone = (e: ShortPublishedEntry) => replaced.some((r) => r.destination === e.destination && r.id === e.id);
  const files = listShortsRegistryFiles(editionDir).map((p) => readOne(p, aammdd, corte));
  return mergeShortsRegistries(aammdd, replaced.length ? files.map((f) => ({ ...f, entries: f.entries.filter((e) => !gone(e)) })) : files);
}

/**
 * #12279: histórico das substituições de post agendado (`--replace-scheduled`).
 * Cada linha é um par destino/ID que a plataforma confirmou cancelado (ou que
 * a skill confirmou apagado na Buffer, `--mark ... --replaces`): o registro
 * deixa de contar esse ID como feito, mesmo numa cópia de conflito antiga.
 * Nome fora do padrão `06-shorts-published*`: não é lido como registro.
 */
export const SHORTS_REPLACED_FILE = "_internal/06-shorts-replaced.json";

export interface ShortReplacementRecord {
  destination: string;
  /** ID do post antigo na plataforma (o do registro). */
  id: string;
  /** Horário do post antigo, preservado no novo envio. */
  scheduled_at: string | null;
  replaced_at: string;
  /** Hash dos bytes do vídeo novo (o do plano aprovado). */
  new_video_sha256: string | null;
}

/** Lê o histórico de substituições; ausente = vazio. Ilegível lança (nunca ressuscita um ID apagado às cegas). */
export function readShortReplacements(editionDir: string): ShortReplacementRecord[] {
  const path = join(editionDir, SHORTS_REPLACED_FILE);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: JSON inválido (${(e as Error).message}) — confira à mão: ele lista os posts já substituídos (#12279)`);
  }
  const list = (parsed as { replaced?: unknown })?.replaced;
  if (!Array.isArray(list) || list.some((r) => !r || typeof r.destination !== "string" || !r.destination || typeof r.id !== "string" || !r.id)) {
    throw new Error(`${path}: formato inesperado (esperado {"replaced": [{destination, id, ...}]}) — confira à mão (#12279)`);
  }
  return list as ShortReplacementRecord[];
}

/**
 * #12279: grava a substituição de um post, sob lock, SÓ depois de a plataforma
 * confirmar o cancelamento (ou a skill confirmar a exclusão na Buffer).
 * Idempotente pelo par destino/ID. Não toca o registro dos destinos.
 */
export function recordShortReplacement(editionDir: string, record: ShortReplacementRecord, lockTimeoutMs = 30_000): void {
  const path = join(editionDir, SHORTS_REPLACED_FILE);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(
    `${path}.lock`,
    () => {
      const cur = readShortReplacements(editionDir);
      if (cur.some((r) => r.destination === record.destination && r.id === record.id)) return;
      writeFileAtomic(path, JSON.stringify({ replaced: [...cur, record] }, null, 2) + "\n");
    },
    lockTimeoutMs,
  );
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
  // #11159/#11265/#11410: defesa em profundidade além do guard da CLI — nenhum
  // caminho grava outro destino no arquivo de um timer.
  const only = LEDGER_DESTINATION_OF[writer];
  if (only !== null && entry.destination !== only) {
    throw new Error(
      `registro do timer só aceita ${only} (recebeu ${entry.destination}): grave os outros destinos numa rodada sem --${writer}`,
    );
  }
  const path = shortsRegistryPath(editionDir, writer);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(
    `${path}.lock`,
    () => {
      // #12998: no corte, o arquivo gravado na data anterior é regravado com a data atual.
      const current = existsSync(path) ? readOne(path, aammdd, isCorteDir(editionDir)) : { aammdd, entries: [] };
      writeFileAtomic(path, JSON.stringify(upsertShortEntry(current, entry), null, 2) + "\n");
    },
    lockTimeoutMs,
  );
  return readShortsRegistry(editionDir, aammdd);
}
