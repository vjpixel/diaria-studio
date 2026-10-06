/**
 * #9761 — marcador de onda LIBERADA (`{grupo}-released.json` em `segments/`).
 *
 * Quando o import de uma onda falha, a seleção dela volta à fila (rollback do
 * `clarice-envio-run` ou `clarice-unblock-orphaned-selections`). O manifest e
 * os CSVs das células continuam no disco — sem este marcador, nada impediria
 * alguém de RETOMAR a onda à mão (import + schedule) depois que os contatos já
 * foram devolvidos à fila, abrindo a porta pra envio duplo. Com ele:
 *   - `clarice-import-waves` e `clarice-schedule-group` recusam o grupo;
 *   - o detector de órfãos não reporta a onda de novo a cada rodada.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

export interface WaveReleasedMarker {
  group: string;
  releasedAt: string;
  count: number;
  reason: string;
}

export function waveReleasedMarkerPath(segmentsDir: string, group: string): string {
  return resolve(segmentsDir, `${group}-released.json`);
}

export function isWaveReleased(segmentsDir: string, group: string): boolean {
  return existsSync(waveReleasedMarkerPath(segmentsDir, group));
}

export function readWaveReleasedMarker(segmentsDir: string, group: string): WaveReleasedMarker | null {
  try {
    return JSON.parse(readFileSync(waveReleasedMarkerPath(segmentsDir, group), "utf8")) as WaveReleasedMarker;
  } catch {
    return null;
  }
}

export function writeWaveReleasedMarker(segmentsDir: string, marker: WaveReleasedMarker): void {
  writeFileAtomic(waveReleasedMarkerPath(segmentsDir, marker.group), JSON.stringify(marker, null, 2));
}

/** Mensagem única de recusa (import-waves / schedule-group). */
export function waveReleasedRefusal(segmentsDir: string, group: string): string {
  const m = readWaveReleasedMarker(segmentsDir, group);
  const when = m ? ` em ${m.releasedAt} (${m.count} contato(s), ${m.reason})` : "";
  return (
    `❌ onda '${group}' foi LIBERADA${when} — os contatos dela já voltaram à fila e podem estar em outra onda. ` +
    `Retomá-la agora arrisca envio duplo (#9761). Monte uma onda nova; se as listas dela existirem na Brevo, apague-as.`
  );
}
