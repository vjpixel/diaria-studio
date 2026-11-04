/**
 * scripts/lib/diaria/video-box0-record.ts (#12159)
 *
 * Registro do que o e-mail de cada edição de fato levou no slot 0: o box do
 * vídeo (#12073) ou não. Gravado pelo `publish-newsletter-kit.ts` (Stage 5)
 * sempre que o payload vai para o Kit; um re-run (atualização do rascunho)
 * regrava com o payload novo. Lido por `resolveVideoBox0` para contar a cota
 * da semana.
 *
 * Por que existe: sem ele a cota recalculava a decisão das edições anteriores
 * a partir do disco, e `05-video-url.txt` gravado DEPOIS do envio (o
 * `--upload` ou o `video-d1-link-watch`) fazia uma terça que saiu sem box
 * contar como "já teve box", tirando a vaga da quarta.
 *
 * Arquivo próprio, fora de `box-selection.json`: aquele é da seleção dos slots
 * 1-3 (#4626) e tem outro dono.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

export const VIDEO_BOX0_RECORD_FILE = "video-box0.json";

export interface VideoBox0Record {
  /** O e-mail enviado ao Kit levou o box do vídeo no slot 0. */
  shown: boolean;
  recorded_at: string;
}

export function videoBox0RecordPath(editionDir: string): string {
  return resolve(editionDir, "_internal", VIDEO_BOX0_RECORD_FILE);
}

/** O que a edição registrou; `undefined` sem registro (ou registro ilegível), e aí a cota recalcula do disco. */
export function readVideoBox0Shown(editionDir: string): boolean | undefined {
  const path = videoBox0RecordPath(editionDir);
  if (!existsSync(path)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as Partial<VideoBox0Record>;
    return typeof rec.shown === "boolean" ? rec.shown : undefined;
  } catch {
    return undefined;
  }
}

export function writeVideoBox0Record(editionDir: string, shown: boolean, now: Date = new Date()): void {
  const rec: VideoBox0Record = { shown, recorded_at: now.toISOString() };
  const path = videoBox0RecordPath(editionDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(rec, null, 2) + "\n");
}
