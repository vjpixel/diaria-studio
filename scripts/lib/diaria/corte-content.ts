/**
 * scripts/lib/diaria/corte-content.ts (#11912)
 *
 * Impressão digital do conteúdo de um corte avulso: sha256 do vídeo
 * (`corte.json` → `video`) e da capa (`SHORT_COVER_FILE` na pasta do corte).
 * O "pode publicar" grava essa impressão; o timer do 300 e o `publish-shorts`
 * chamado por ele recusam publicar quando o arquivo mudou depois.
 *
 * sha256 e não tamanho+mtime: `data/` sincroniza pelo OneDrive entre as
 * máquinas (o corte é preparado no Neo e publicado pelo 300), e a cópia
 * sincronizada não preserva o mtime de forma confiável, o que daria falso
 * "mudou"; um re-export com o mesmo tamanho daria falso "igual". O custo é ler
 * o vertical (dezenas de MB) uma vez por execução que publica, em blocos.
 */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveCorteVideo, type CorteContentFingerprint, type CorteSpec } from "./short-corte.ts";
import { SHORT_COVER_FILE } from "./short-cover.ts";

/** sha256 hex do arquivo, lido em blocos de 4 MB; `null` quando não existe. */
export function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Impressão digital do vídeo e da capa do corte nesta máquina. */
export function corteContentFingerprint(dir: string, spec: Pick<CorteSpec, "video">): CorteContentFingerprint {
  return {
    video_sha256: sha256File(resolveCorteVideo(dir, spec.video)),
    cover_sha256: sha256File(join(dir, SHORT_COVER_FILE)),
  };
}
