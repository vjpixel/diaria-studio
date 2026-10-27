/**
 * Invariante `public-images-md5-matches-local` (#11252), compartilhado por
 * `invariant-checks/stage-4.ts` (gate) e `stage-5.ts` (pre-dispatch) — módulo
 * próprio pra não criar import cruzado stage-5 → stage-4 (#2154).
 *
 * Hero 2:1 do e-mail com URL pública de OUTRA arte. `carousel-upload-stale`
 * (#6068) cruza o md5 do upload contra o disco só pras chaves do carrossel
 * (4:5 + 4 slides); as chaves que o e-mail usa — `cover` (D1), `d2_2x1`,
 * `d3_2x1` e a cópia com o convite `d1_play` — ficavam sem esse cruzamento.
 * Edição 261027: depois de `swap-destaques.ts --d3-url`, `d3_2x1` seguiu com o
 * md5 da imagem do destaque antigo enquanto `04-d3-2x1.jpg` já era a nova, e o
 * e-mail de teste do Kit saiu com a imagem de outro assunto.
 *
 * Mesma função de md5 (`md5OfFile`) que o uploader usa pra decidir re-upload.
 * Só acusa divergência REAL (entry com URL + md5, arquivo local presente e
 * legível): arquivo ausente, entry sem md5 (pré-#1418) ou leitura falha não
 * viram violação — ausência de chave é assunto do `public-images-populated`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "./invariant-checks/types.ts";
import { md5OfFile } from "./shared/file-md5.ts";
import { readDestaqueCount } from "./invariant-checks/stage-3.ts";
import { D1_HERO_FILE, D1_PLAY_HERO_FILE, D1_PLAY_IMAGE_KEY } from "./diaria/d1-video-hero.ts";

interface Entry {
  url?: string;
  md5?: string;
}

/** Pares chave → arquivo local do hero 2:1 do e-mail, por contagem de destaques. */
export function emailHeroKeyFiles(destaqueCount: 2 | 3): Array<{ key: string; file: string }> {
  return [
    { key: "cover", file: D1_HERO_FILE },
    { key: D1_PLAY_IMAGE_KEY, file: D1_PLAY_HERO_FILE },
    { key: "d2_2x1", file: "04-d2-2x1.jpg" },
    ...(destaqueCount === 3 ? [{ key: "d3_2x1", file: "04-d3-2x1.jpg" }] : []),
  ];
}

export function checkPublicImagesMd5MatchesLocal(editionDir: string): InvariantViolation[] {
  const imagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(imagesPath)) return [];
  let images: Record<string, Entry | undefined> = {};
  try {
    images = (JSON.parse(readFileSync(imagesPath, "utf8")) as { images?: Record<string, Entry> }).images ?? {};
  } catch {
    return []; // JSON inválido já é coberto por public-images-parseable
  }

  const desatualizados: string[] = [];
  for (const { key, file } of emailHeroKeyFiles(readDestaqueCount(editionDir))) {
    const entry = images[key];
    const url = entry?.url;
    if (typeof url !== "string" || url.trim().length === 0 || !entry?.md5) continue;
    const localPath = resolve(editionDir, file);
    if (!existsSync(localPath)) continue;
    let localMd5: string;
    try {
      localMd5 = md5OfFile(localPath);
    } catch {
      continue; // arquivo travado entre o existsSync e a leitura (OneDrive) — não derruba o gate
    }
    if (entry.md5 !== localMd5) desatualizados.push(`${key} (${file})`);
  }
  if (desatualizados.length === 0) return [];
  return [
    {
      rule: "public-images-md5-matches-local",
      message:
        `06-public-images.json aponta pra uma arte DIFERENTE da que está em disco: ${desatualizados.join(", ")} ` +
        `(md5 do upload ≠ md5 do arquivo local). O e-mail sairia com a imagem antiga (ex.: destaque trocado no gate, #11252). ` +
        `Fix: "npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir} --mode newsletter" (re-sobe só o que mudou) ` +
        `e re-renderizar o HTML.`,
      source_issue: "#11252",
      severity: "error",
      file: imagesPath,
    },
  ];
}
