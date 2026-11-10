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
 *   - #12602: com o horizontal publicado, a pasta ainda espera a edição mais
 *     nova do nome ter `publishedMinDays` (4) dias. O Short da vertical nativa
 *     e os cortes (#11900) saem nos dias úteis SEGUINTES, exportados do
 *     Premiere a partir dos mesmos brutos, e o sinal de publicado só vê o
 *     horizontal. Premissa declarada: 4 dias corridos cobrem até 2 cortes de
 *     qualquer dia da semana (edição de sexta: cortes na segunda, +3, e na
 *     terça, +4); com a rodada só aos sábados, a pasta de quarta a sexta fica
 *     uma semana a mais no Drive.
 *
 * Bruto de OUTRA edição guardado na pasta (o lote gravado para duas edições na
 * mesma sessão, que entra na montagem por `transcribe --source` sem mover o
 * original, #12559) nunca sai enquanto a montagem dessa edição o usar: quem
 * executa lê o `source.json` de cada edição ainda não arquivável e segura no
 * Drive todo bruto com o mesmo nome de arquivo (`brutoRefKey`, só o nome: o
 * caminho gravado é o do Neo, `G:/…`, ou o do cache do modo API). Nome de
 * câmera tem data e hora, então casar só pelo nome erra para o lado de
 * guardar. A montagem da edição seguinte que ainda nem começou (sem
 * `source.json`) fica coberta pelos 4 dias acima.
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
/** #12602: idade mínima da edição mais nova da pasta para sair por "publicado" (Short e cortes saem nos dias seguintes). */
export const DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS = 4;

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
      reason: "nome-fora-do-padrao" | "aguardando-publicacao" | "publicacao-desconhecida" | "publicado-recente";
      ageDays: number | null;
    };

/** Pura — decide se a pasta da edição entra na rodada. */
export function decideFolder(
  input: ArchiveFolderInput,
  today: Date,
  unpublishedMaxDays: number = DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS,
  publishedMinDays: number = DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS,
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
  const allPublished = signals.every((s) => s === true);
  if (allPublished && ageDays >= publishedMinDays) return { name: input.name, eligible: true, reason: "publicado", ageDays };
  if (ageDays > unpublishedMaxDays) return { name: input.name, eligible: true, reason: "teto-sem-publicacao", ageDays };
  if (allPublished) return { name: input.name, eligible: false, reason: "publicado-recente", ageDays };
  return {
    name: input.name,
    eligible: false,
    reason: signals.some((s) => s === null) ? "publicacao-desconhecida" : "aguardando-publicacao",
    ageDays,
  };
}

/**
 * Pura — chave de casamento de um bruto entre a listagem do Drive e o
 * `source.json` da montagem: o nome do arquivo, sem o caminho (`/` ou `\`),
 * em minúsculas.
 */
export function brutoRefKey(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * Pura — os caminhos de bruto que um `source.json` da montagem usa: `path`
 * (bruto único) e `files[].path` (bruto em vários arquivos, #12559). `null` =
 * formato que não dá para ler (quem chama trata como "não sei o que ele usa").
 */
export function montageSourceRefs(source: unknown): string[] | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const o = source as { path?: unknown; files?: unknown };
  const out: string[] = [];
  if (typeof o.path === "string" && o.path.trim() !== "") out.push(o.path);
  if (o.files !== undefined) {
    if (!Array.isArray(o.files)) return null;
    for (const f of o.files) {
      const p = (f as { path?: unknown } | null)?.path;
      if (typeof p !== "string" || p.trim() === "") return null;
      out.push(p);
    }
  }
  return out.length > 0 ? out : null;
}

/** Pura — edições em uso que referenciam este bruto (`refs` indexado por `brutoRefKey`). */
export function referencingEditions(relPath: string, refs: ReadonlyMap<string, readonly string[]>): string[] {
  return [...(refs.get(brutoRefKey(relPath)) ?? [])];
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
 * #12570: registro do MD5 já conferido de uma cópia do arquivo, gravado ao lado
 * dela (`{arquivo}.md5.json`) quando o Drive recusa apagar o original (arquivo
 * de outro dono). Sem ele, toda rodada de sábado recalcularia o MD5 de GBs só
 * para ouvir a mesma recusa.
 */
export interface VerifiedRecord {
  size: number;
  mtimeMs: number;
  md5: string;
}

/** Sufixo do registro de MD5 conferido, ao lado da cópia no arquivo. */
export const VERIFIED_RECORD_SUFFIX = ".md5.json";

/** Pura — lê o registro; qualquer formato estranho = `null` (recalcula). */
export function parseVerifiedRecord(raw: unknown): VerifiedRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) return null;
  if (typeof o.mtimeMs !== "number" || !Number.isFinite(o.mtimeMs)) return null;
  if (typeof o.md5 !== "string" || !/^[0-9a-f]{32}$/i.test(o.md5)) return null;
  return { size: o.size, mtimeMs: o.mtimeMs, md5: o.md5.toLowerCase() };
}

/**
 * Pura — o registro ainda vale para a cópia de hoje? Só com o mesmo tamanho e
 * o mesmo mtime da cópia (ninguém mexeu nela) e o mesmo MD5 que o Drive mostra
 * agora (a dona não trocou o arquivo). Qualquer divergência recalcula.
 */
export function verifiedRecordTrusted(
  record: VerifiedRecord | null,
  local: { size: number; mtimeMs: number } | null,
  remote: RemoteFile,
): boolean {
  if (!record || !local || !remote.md5) return false;
  return record.size === local.size && record.mtimeMs === local.mtimeMs && record.md5 === remote.md5 && record.size === remote.size;
}

/**
 * Pura (#12573) — o lock de uma execução anterior pode ser retomado? Só quando
 * o PID gravado não existe mais (`alive` falso). PID ilegível = lock corrompido,
 * também retomável. PID vivo = outra execução em curso, nunca retomável.
 */
export function runLockIsStale(holderPid: number | null, alive: (pid: number) => boolean): boolean {
  if (holderPid === null || !Number.isInteger(holderPid) || holderPid <= 0) return true;
  return !alive(holderPid);
}

/** Pura — PID gravado no lock (`{ pid, startedAt }`); `null` se ilegível. */
export function parseRunLock(text: string): number | null {
  try {
    const o = JSON.parse(text) as { pid?: unknown };
    return typeof o?.pid === "number" && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : null;
  } catch {
    return null;
  }
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
