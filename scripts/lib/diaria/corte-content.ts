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

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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

/** sha256 hex de bytes já lidos; `null` = sem arquivo. */
export function sha256Bytes(bytes: Buffer | null): string | null {
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

/**
 * Impressão digital do vídeo e da capa do corte nesta máquina, lida do disco
 * (o timer do 300 confere antes de chamar o filho). Capa vazia conta como
 * ausente, como no `readShortCover` do `publish-shorts`.
 */
export function corteContentFingerprint(dir: string, spec: Pick<CorteSpec, "video">): CorteContentFingerprint {
  const cover = join(dir, SHORT_COVER_FILE);
  return {
    video_sha256: sha256File(resolveCorteVideo(dir, spec.video)),
    cover_sha256: existsSync(cover) && statSync(cover).size > 0 ? sha256File(cover) : null,
  };
}

/**
 * #11912: impressão digital dos bytes que a rodada de fato publica (o vídeo
 * já lido e a capa do `readShortCover`), sem reler o disco: o que o
 * `publish-shorts` confere e grava é exatamente o que sobe.
 */
export function corteContentFingerprintFromBytes(video: Buffer | null, cover: Buffer | null): CorteContentFingerprint {
  return { video_sha256: sha256Bytes(video), cover_sha256: sha256Bytes(cover) };
}
