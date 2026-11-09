/**
 * scripts/lib/diaria/video-bruto-archive.ts (#12548, resolve #12472)
 *
 * Política PURA do arquivamento semanal dos brutos do vídeo: o que sai do
 * Google Drive (cópia guardada no HD do `300`, fora do espelho do bisync) e o
 * que fica. Quem executa é `scripts/archive-video-brutos.ts`, e só com
 * `--apply`.
 *
 * Por que existe: a pasta de vídeo da diária no Drive cresce ~10 GB por
 * edição, quase tudo bruto do celular, e a cota da conta Google (Gmail
 * incluso) acabava em ~2 semanas (#12472).
 *
 * Pasta de edição elegível (nome `AAMMDD` ou `AAMMDD-DD`, este último quando
 * uma gravação cobre duas edições, como `261109-10`):
 *   - vídeo publicado em TODAS as edições que o nome cobre (mesmo sinal do
 *     `prune-video-montage-cache.ts`: `05-youtube-published.json` com
 *     `videoId` ou `05-video-url.txt` com link), OU
 *   - edição mais nova do nome com mais de `unpublishedMaxDays` dias. Premissa
 *     declarada (#12548 pedia "criar marcador se não houver um confiável"):
 *     as primeiras edições com vídeo (261021, 261022) são anteriores ao
 *     `/diaria-publica-video` e nunca terão registro; sem o teto ficariam no
 *     Drive para sempre. Arquivar não é apagar: a cópia fica no HD.
 *   - publicação DESCONHECIDA (sem `data/editions` nesta máquina, ou sem a
 *     pasta da edição nele) só sai pelo teto de idade.
 *
 * O que conta como bruto (premissa declarada, mais estreita que "todo .mp4 da
 * raiz" do texto da issue, para nunca tirar do Drive um export que alguém
 * baixa de lá): arquivo de vídeo cujo nome é de câmera/celular
 * (`20261104_124252.mp4`, `WIN_20261020_21_24_22_Pro.mp4`), o
 * `*bruto_unido*` da montagem, e qualquer vídeo dentro de uma pasta
 * `Brutos/` da edição. Prévia (`*previa*`) nunca. `Final/`, `Editado/`,
 * áudio tratado e os demais derivados ficam.
 */

import { editionAgeDays } from "../edition-video-retention.ts";

/** Sem registro de publicação, a pasta entra na rodada depois de 14 dias (mesmo valor do teto do #12365). */
export const DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS = 14;

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv)$/i;
/** Nome que a câmera/celular dá: `20261104_124252.mp4`, `VID_20261104_124252.mp4`, `PXL_20261104_124252345.mp4` (Pixel cola os ms). */
const CAMERA_NAME = /^(VID_|PXL_)?\d{8}_\d{6,9}(_\d+)?\./i;
/** Webcam do Windows: `WIN_20261020_21_24_22_Pro.mp4`. */
const WIN_CAMERA_NAME = /^WIN_\d{8}_\d{2}_\d{2}_\d{2}/i;

/**
 * Pura — `relPath` é relativo à pasta da edição, com `/` como separador.
 * `true` para bruto (ver regras no topo do arquivo).
 */
export function isBrutoFile(relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const name = parts[parts.length - 1];
  if (!VIDEO_EXT.test(name)) return false;
  if (/previa|prévia/i.test(name)) return false;
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => /^brutos?$/i.test(d))) return true;
  if (dirs.length > 0) return false; // Final/, Editado/ etc. ficam
  return CAMERA_NAME.test(name) || WIN_CAMERA_NAME.test(name) || /bruto[_ -]?unido/i.test(name);
}

/**
 * Pura — edições que o nome da pasta cobre. `261105` → `["261105"]`;
 * `261109-10` → `["261109", "261110"]`. Fora do padrão → `null` (a pasta é
 * ignorada, nunca tocada).
 */
export function editionsOfFolder(name: string): string[] | null {
  const m = /^(\d{4})(\d{2})(?:-(\d{2}))?$/.exec(name);
  if (!m) return null;
  const [, aamm, dd, dd2] = m;
  if (!dd2) return [`${aamm}${dd}`];
  if (Number(dd2) <= Number(dd)) return null;
  return [`${aamm}${dd}`, `${aamm}${dd2}`];
}

export interface ArchiveFolderInput {
  name: string;
  /** Publicação por edição do nome; `null` = desconhecida. */
  published: Record<string, boolean | null>;
}

export type FolderDecision =
  | { name: string; eligible: true; reason: "publicado" | "teto-sem-publicacao"; ageDays: number }
  | {
      name: string;
      eligible: false;
      reason: "nome-fora-do-padrao" | "aguardando-publicacao" | "publicacao-desconhecida";
      ageDays: number | null;
    };

/** Pura — decide se a pasta da edição entra na rodada. */
export function decideFolder(
  input: ArchiveFolderInput,
  today: Date,
  unpublishedMaxDays: number = DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS,
): FolderDecision {
  const editions = editionsOfFolder(input.name);
  if (!editions) return { name: input.name, eligible: false, reason: "nome-fora-do-padrao", ageDays: null };
  const ages = editions.map((e) => editionAgeDays(e, today));
  if (ages.some((a) => a === null)) {
    return { name: input.name, eligible: false, reason: "nome-fora-do-padrao", ageDays: null };
  }
  // A mais nova manda: a gravação que cobre 2 edições só envelhece com a última.
  const ageDays = Math.min(...(ages as number[]));
  const signals = editions.map((e) => input.published[e] ?? null);
  if (signals.every((s) => s === true)) return { name: input.name, eligible: true, reason: "publicado", ageDays };
  if (ageDays > unpublishedMaxDays) return { name: input.name, eligible: true, reason: "teto-sem-publicacao", ageDays };
  return {
    name: input.name,
    eligible: false,
    reason: signals.some((s) => s === null) ? "publicacao-desconhecida" : "aguardando-publicacao",
    ageDays,
  };
}

/** Pura — parse de `md5sum` (`<hex>  <path>`); `null` se não houver hash. */
export function parseMd5sumLine(text: string): string | null {
  const m = /^\\?([0-9a-f]{32})\s/i.exec(text.trim());
  return m ? m[1].toLowerCase() : null;
}

export interface RemoteFile {
  /** Relativo à pasta da edição, `/` como separador. */
  path: string;
  size: number;
  md5: string | null;
}

/**
 * Pura — parse de `rclone lsjson -R --files-only --hash --hash-type md5`.
 * Lança com JSON ilegível: sem a listagem do Drive não há o que conferir, e a
 * pasta tem de falhar alto, não sair como "nada a fazer".
 */
export function parseRcloneLsjson(text: string): RemoteFile[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("rclone lsjson não devolveu uma lista");
  const out: RemoteFile[] = [];
  for (const it of raw as Array<Record<string, unknown>>) {
    if (it?.IsDir === true || typeof it?.Path !== "string" || typeof it?.Size !== "number" || it.Size < 0) continue;
    const hashes = (it.Hashes ?? {}) as Record<string, unknown>;
    const md5 = typeof hashes.md5 === "string" && /^[0-9a-f]{32}$/i.test(hashes.md5) ? hashes.md5.toLowerCase() : null;
    out.push({ path: it.Path, size: it.Size, md5 });
  }
  return out;
}

export type VerifyVerdict = "ok" | "tamanho-diverge" | "md5-diverge" | "sem-md5-no-drive" | "md5-local-indisponivel";

/**
 * Pura — a cópia local confere com o Drive? Só `ok` libera apagar. `local.md5`
 * `null` = o `md5sum` falhou (não é "conteúdo diferente").
 */
export function verifyCopy(remote: RemoteFile, local: { size: number; md5: string | null }): VerifyVerdict {
  if (remote.size !== local.size) return "tamanho-diverge";
  if (!remote.md5) return "sem-md5-no-drive";
  if (!local.md5) return "md5-local-indisponivel";
  if (local.md5 !== remote.md5) return "md5-diverge";
  return "ok";
}

/**
 * Pura — caminhos que aparecem mais de uma vez na listagem. O Drive aceita dois
 * arquivos com o mesmo nome na mesma pasta, e `rclone deletefile` por nome não
 * diz qual apaga: esses nunca são apagados.
 */
export function duplicatePaths(files: readonly RemoteFile[]): Set<string> {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const f of files) (seen.has(f.path) ? dups : seen).add(f.path);
  return dups;
}
