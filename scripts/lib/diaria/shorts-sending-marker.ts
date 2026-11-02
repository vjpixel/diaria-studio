/**
 * scripts/lib/diaria/shorts-sending-marker.ts (#11741, finding P2 da PR #11827)
 *
 * Marcador "envio em curso" do vertical, por destino. O registro do vertical
 * (`_internal/06-shorts-published*.json`) só recebe a entrada de um destino
 * DEPOIS que a plataforma aceitou o post. Se uma chamada de `publish-shorts.ts
 * --publish` for interrompida no app e o processo seguir vivo (hipótese do
 * #11741), a releitura do registro logo depois da interrupção podia sair
 * `nothing-since` com um destino no meio do envio, e um novo "pode publicar"
 * duplicaria o post naquele destino.
 *
 * O `publish-shorts.ts` grava aqui o destino ANTES de qualquer chamada que
 * publique (equivalente do `in_progress` do horizontal, gravado antes dos
 * bytes) e apaga a marca quando o destino termina: registrado, recusado pela
 * plataforma ou já registrado por outro processo. A marca só fica quando o
 * processo morre no meio ou quando a plataforma aceitou e o registro não foi
 * gravado — nos dois casos o destino PODE ter saído.
 *
 * Quem lê é o `video-publish-registry-status.ts`: marca sem entrada no
 * registro gravada depois dela conta como "pode ter saído" e nunca deixa o
 * veredito virar `nothing-since`. O publisher não consulta a marca (uma marca
 * órfã de um crash travaria o destino para sempre); a proteção vem da regra da
 * skill de reler o status antes de qualquer nova chamada.
 *
 * Um arquivo por escritor (mesmo motivo do registro, #11157): os timers do 300
 * e as rodadas do neo nunca escrevem o mesmo arquivo pelo OneDrive.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { withFileLock } from "../file-lock.ts";
import type { ShortPublishedEntry } from "./short-video.ts";
import type { ShortsRegistryWriter } from "./shorts-published-store.ts";

const SENDING_DIR = "_internal";
const SENDING_STEM = "06-shorts-sending";

export interface ShortSendingMark {
  destination: string;
  /** ISO do instante em que o envio começou. */
  started_at: string;
  pid?: number;
}

export interface ShortsSendingFile {
  aammdd: string;
  marks: ShortSendingMark[];
}

/** Caminho do arquivo de marcas de `writer`, dentro da pasta da edição. */
export function shortsSendingPath(editionDir: string, writer: ShortsRegistryWriter): string {
  const name = writer === "main" ? `${SENDING_STEM}.json` : `${SENDING_STEM}.${writer}.json`;
  return join(editionDir, SENDING_DIR, name);
}

/** Arquivo de marcas? Inclui cópias de conflito do OneDrive; temporários (`.`) ficam de fora. */
export function isShortsSendingFileName(name: string): boolean {
  return name.startsWith(SENDING_STEM) && name.endsWith(".json");
}

/** Leitura ESTRITA: marca ilegível nunca vira "nada em curso". */
export function parseShortsSendingFile(raw: string, aammdd: string, where: string): ShortsSendingFile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.marks)) throw new Error(`${where}: sem lista "marks"`);
  if (parsed.aammdd !== aammdd) throw new Error(`${where}: é da edição ${parsed.aammdd}, não de ${aammdd}`);
  for (const [i, m] of parsed.marks.entries()) {
    if (!m || typeof m.destination !== "string" || !m.destination || typeof m.started_at !== "string") {
      throw new Error(`${where}: marca ${i} sem destination/started_at`);
    }
  }
  return { aammdd, marks: parsed.marks };
}

/** Todas as marcas da edição (todos os escritores + cópias de conflito). Lança se algum arquivo for ilegível. */
export function readShortsSending(editionDir: string, aammdd: string): ShortSendingMark[] {
  const dir = join(editionDir, SENDING_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isShortsSendingFileName)
    .sort()
    .flatMap((n) => {
      const path = join(dir, n);
      return parseShortsSendingFile(readFileSync(path, "utf8"), aammdd, path).marks;
    });
}

function updateMarks(
  editionDir: string,
  aammdd: string,
  writer: ShortsRegistryWriter,
  change: (marks: ShortSendingMark[]) => ShortSendingMark[],
  lockTimeoutMs: number,
): void {
  const path = shortsSendingPath(editionDir, writer);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(
    `${path}.lock`,
    () => {
      const current = existsSync(path) ? parseShortsSendingFile(readFileSync(path, "utf8"), aammdd, path).marks : [];
      const next = change(current);
      if (next.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      writeFileAtomic(path, JSON.stringify({ aammdd, marks: next }, null, 2) + "\n");
    },
    lockTimeoutMs,
  );
}

/** Grava a marca de `destination` (substitui uma marca anterior do mesmo destino). */
export function markShortSending(
  editionDir: string,
  aammdd: string,
  writer: ShortsRegistryWriter,
  mark: ShortSendingMark,
  lockTimeoutMs = 30_000,
): void {
  updateMarks(editionDir, aammdd, writer, (marks) => [...marks.filter((m) => m.destination !== mark.destination), mark], lockTimeoutMs);
}

/** Apaga a marca de `destination` (arquivo vazio é removido). */
export function clearShortSending(
  editionDir: string,
  aammdd: string,
  writer: ShortsRegistryWriter,
  destination: string,
  lockTimeoutMs = 30_000,
): void {
  updateMarks(editionDir, aammdd, writer, (marks) => marks.filter((m) => m.destination !== destination), lockTimeoutMs);
}

/**
 * Pure: marcas ainda em aberto — destino sem entrada no registro gravada no
 * instante da marca ou depois. Data ilegível conta como em aberto (nunca esconde).
 */
export function openSendingMarks(marks: readonly ShortSendingMark[], entries: readonly ShortPublishedEntry[]): ShortSendingMark[] {
  return marks.filter((m) => {
    const started = Date.parse(m.started_at);
    const entry = entries.find((e) => e.destination === m.destination);
    if (!entry) return true;
    const at = Date.parse(entry.at);
    if (Number.isNaN(started) || Number.isNaN(at)) return true;
    return at < started;
  });
}
