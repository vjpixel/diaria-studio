/**
 * scripts/lib/diaria/video-drive-cleanup.ts (#13627, #13630, #13632)
 *
 * Política PURA das três limpezas que o arquivamento do vídeo
 * (`scripts/archive-video-brutos.ts`; rodada manual desde a #14292, quando a
 * task `Diaria-Video-Bruto-Archive` foi aposentada) faz
 * além do arquivamento dos brutos (`video-bruto-archive.ts`):
 *
 * 1. **Edição renomeada (#13632).** Quando uma edição muda de número (a 261109
 *    virou 261110 em 10/11/2026), a pasta nova guarda um `_origem-brutos.json`
 *    com `"renomeada": {"de": "261109", "para": "261110"}`. A pasta antiga fica
 *    sem edição em `data/editions` e a rotina nunca decidia por ela
 *    ("publicação desconhecida"). Com o registro, a pasta antiga segue a
 *    edição nova (publicação e idade) e os brutos que o registro diz que foram
 *    para a pasta nova são movidos para lá de fato (no Drive, `moveto`, que
 *    preserva o id), para os XMLs da edição nova acharem a mídia.
 *    Só vale o registro gravado NA PASTA DE DESTINO (`para` = nome da pasta
 *    onde o arquivo está): um `_origem-brutos.json` copiado para outra pasta
 *    não desvia nada.
 *
 * 2. **Finais, prévias e editados (#13630).** Saem do Drive quando a edição
 *    foi LIBERADA: o `/diaria-publica` grava
 *    `_internal/05-video-liberada.json` depois de horizontal e vertical
 *    publicados (`scripts/mark-video-liberada.ts`), e a rotina diária recolhe.
 *    A sessão de publicação nunca baixa nada (são GBs por edição): só marca.
 *    Mesmo liberada, a pasta espera enquanto o banco de agendamentos tiver
 *    item da edição ainda não enviado à plataforma (o vertical 2 "guia" sai
 *    D+7 baixando o export de `Final/`; os cortes extras idem). Mesma
 *    disciplina dos brutos: cópia no HD conferida por tamanho + MD5 antes de
 *    apagar. Brutos NÃO mudam: seguem a idade mínima de 4 dias e o
 *    `source.json` das outras edições (#12602).
 *
 * 3. **Duplicatas entre pastas (#13627).** Mesmo conteúdo (md5 + tamanho) em
 *    pastas de edição diferentes, com ou sem renomear. Fica a cópia da pasta
 *    dona (bruto: a edição da data do nome + 1 dia; o resto: a pasta mais
 *    antiga) e as outras vão para a LIXEIRA do Drive (reversível por 30 dias),
 *    nunca delete definitivo. Nunca sai: arquivo de 0 byte (upload
 *    incompleto), arquivo sem MD5 no Drive, arquivo referenciado por `pathurl`
 *    de um XML da raiz da própria pasta (cta_card e título reaproveitados entre
 *    edições), XML da raiz (é a versão vigente da pasta), arquivo com nome que
 *    uma montagem em curso usa, e cópia em pasta que ainda não saiu da rodada
 *    (`decideFolder` não elegível: a edição pode estar em montagem).
 *    Desde o #13748: final, editado ou prévia só sai de pasta com os finais
 *    liberados (`decideFinalsFolder` elegível; o vertical 2 "guia" do D+7 ainda
 *    baixa de `Final/`), registro `_*.json` da raiz nunca entra na regra (o
 *    `_origem-brutos.json` vale só na pasta onde está), e a pasta que fica
 *    segue a renomeação: a cópia da pasta antiga de uma edição renomeada não
 *    vence a da pasta nova.
 */

import { editionsOfFolder, effectiveEditionsOfFolder, isBrutoFile } from "./video-bruto-archive.ts";
import { xmlReferencedNames } from "./video-version-archive.ts";

// ── 1. edição renomeada (#13632) ─────────────────────────────────────────────

/** Registro da origem dos brutos, na raiz da pasta da edição no Drive. */
export const ORIGEM_BRUTOS_FILE = "_origem-brutos.json";

export interface EditionRename {
  de: string;
  para: string;
}

const AAMMDD = /^\d{6}$/;

/** Pura — `renomeada: {de, para}` do `_origem-brutos.json`; qualquer outro formato = `null`. */
export function parseOrigemBrutosRename(raw: unknown): EditionRename | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = (raw as { renomeada?: unknown }).renomeada;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const { de, para } = r as { de?: unknown; para?: unknown };
  if (typeof de !== "string" || typeof para !== "string") return null;
  const d = de.trim();
  const p = para.trim();
  if (!AAMMDD.test(d) || !AAMMDD.test(p) || d === p) return null;
  return { de: d, para: p };
}

/**
 * Pura — mapa `de → para` a partir dos registros lidos (`folder` = pasta onde
 * o `_origem-brutos.json` está). Registro fora da pasta de destino é ignorado
 * (aviso); duas pastas dizendo destinos diferentes para a mesma origem anulam
 * as duas (aviso): sem saber qual vale, a pasta antiga fica como estava.
 */
export function buildRenameMap(records: ReadonlyArray<{ folder: string; raw: unknown }>): { map: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const { folder, raw } of records) {
    const r = parseOrigemBrutosRename(raw);
    if (!r) continue;
    if (r.para !== folder) {
      warnings.push(`${folder}/${ORIGEM_BRUTOS_FILE}: "renomeada" aponta para ${r.para}, mas o registro está em ${folder}; ignorado (#13632)`);
      continue;
    }
    const set = seen.get(r.de) ?? new Set<string>();
    set.add(r.para);
    seen.set(r.de, set);
  }
  const map = new Map<string, string>();
  for (const [de, paras] of seen) {
    if (paras.size === 1) map.set(de, [...paras][0]);
    else warnings.push(`edição ${de} renomeada para destinos diferentes (${[...paras].sort().join(", ")}); nenhum vale (#13632)`);
  }
  return { map, warnings };
}

// ── 2. finais, prévias e editados (#13630) ───────────────────────────────────

/** Marcador da edição liberada para o arquivamento dos finais, gravado pelo `/diaria-publica`. */
export const VIDEO_LIBERADA_FILE = "_internal/05-video-liberada.json";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv)$/i;
const FINAL_DIRS = /^(final|editados?)$/i;

/**
 * Pura — o que sai do Drive na liberação (`relPath` relativo à pasta da
 * edição): tudo dentro de `Final/`, `Editado/` ou `Editados/` (o export que o
 * editor sobe) e todo vídeo de prévia (`* - previa *.mp4`), inclusive os já
 * arquivados em `arquivo/`. Bruto nunca entra aqui (tem regra própria).
 */
export function isFinalOrPreviewFile(relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0 || isBrutoFile(relPath)) return false;
  const name = parts[parts.length - 1];
  if (VIDEO_EXT.test(name) && /previa|prévia/i.test(name)) return true;
  const dirs = parts.slice(0, -1);
  const start = dirs[0]?.toLowerCase() === "arquivo" ? 1 : 0;
  return dirs.length > start && FINAL_DIRS.test(dirs[start]);
}

/** Pura — `{aammdd, liberada_at}` da edição certa. Ausente/ilegível/de outra edição = não liberada. */
export function parseVideoLiberada(raw: unknown, edition: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as { aammdd?: unknown; liberada_at?: unknown };
  return o.aammdd === edition && typeof o.liberada_at === "string" && !Number.isNaN(Date.parse(o.liberada_at));
}

/** Estados do banco de agendamentos em que a peça já saiu do Drive (enviada à plataforma). */
const AGENDAMENTO_ENVIADO = new Set(["agendado", "publicado"]);

/** Pura — itens do banco de agendamentos da edição que ainda podem precisar do export no Drive. */
export function pendingAgendamentosOf(
  itens: ReadonlyArray<{ id: string; edicao: string; estado: string }>,
  edition: string,
): string[] {
  return itens.filter((i) => i.edicao === edition && !AGENDAMENTO_ENVIADO.has(i.estado)).map((i) => `${i.id} (${i.estado})`);
}

export type FinalsDecision =
  | { name: string; eligible: true }
  | { name: string; eligible: false; reason: "nome-fora-do-padrao" | "nao-liberada" | "agendamento-pendente" | "agendamentos-ilegiveis"; detail?: string };

/**
 * Pura — a pasta tem os finais liberados? Todas as edições do nome (depois da
 * renomeação) liberadas e sem item pendente no banco. `pending` = `null`
 * quando o banco não pôde ser lido (nada sai).
 */
export function decideFinalsFolder(input: {
  name: string;
  liberada: Readonly<Record<string, boolean>>;
  pending: Readonly<Record<string, readonly string[]>> | null;
  renamedTo?: Readonly<Record<string, string>>;
}): FinalsDecision {
  const editions = effectiveEditionsOfFolder(input.name, input.renamedTo);
  if (!editions) return { name: input.name, eligible: false, reason: "nome-fora-do-padrao" };
  if (!editions.every((e) => input.liberada[e] === true)) return { name: input.name, eligible: false, reason: "nao-liberada" };
  if (input.pending === null) return { name: input.name, eligible: false, reason: "agendamentos-ilegiveis" };
  const pend = editions.flatMap((e) => input.pending?.[e] ?? []);
  if (pend.length > 0) return { name: input.name, eligible: false, reason: "agendamento-pendente", detail: pend.join(", ") };
  return { name: input.name, eligible: true };
}

// ── 3. duplicatas entre pastas (#13627) ──────────────────────────────────────

export interface FolderFile {
  folder: string;
  /** Relativo à pasta da edição, `/` como separador. */
  path: string;
  size: number;
  md5: string | null;
}

export type DuplicateHoldReason =
  | "referenciado-por-xml-da-pasta"
  | "xmls-da-pasta-ilegiveis"
  | "xml-atual-da-pasta"
  | "pasta-ainda-nao-liberada"
  | "finais-ainda-nao-liberados"
  | "em-uso-pela-montagem"
  | "nome-duplicado-na-pasta";

export interface DuplicateGroup {
  md5: string;
  size: number;
  /** A cópia que fica (pasta dona). */
  keep: FolderFile[];
  remove: FolderFile[];
  held: Array<FolderFile & { reason: DuplicateHoldReason }>;
}

const CAMERA_DATE = /^(?:VID_|PXL_|WIN_)?(\d{4})(\d{2})(\d{2})_/i;

/**
 * Pura — edição dona de um bruto: a data do nome de câmera + 1 dia (a gravação
 * é na véspera da edição, D+1). Fora do padrão = `null`.
 */
export function brutoOwnerEdition(relPath: string): string | null {
  const name = relPath.split("/").pop() ?? "";
  const m = CAMERA_DATE.exec(name);
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const rec = new Date(Date.UTC(y, mo - 1, da));
  if (rec.getUTCFullYear() !== y || rec.getUTCMonth() !== mo - 1 || rec.getUTCDate() !== da) return null;
  const d = new Date(Date.UTC(y, mo - 1, da + 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Pura — XML da raiz da pasta (a versão vigente; as anteriores vão para `arquivo/`). */
export function isRootXml(relPath: string): boolean {
  return !relPath.includes("/") && /\.xml$/i.test(relPath);
}

/**
 * Pura — registro da rotina guardado como `_*.json` na raiz da pasta (ex.:
 * `_origem-brutos.json`, #13632). Fica fora da regra de duplicatas (#13748):
 * o conteúdo igual em duas pastas não é cópia redundante, vale só na pasta
 * onde está.
 */
export function isFolderRecordFile(relPath: string): boolean {
  return !relPath.includes("/") && /^_.*\.json$/i.test(relPath);
}

export interface DuplicatePlanOptions {
  /** Pastas cujas cópias podem sair (a pasta já saiu da rodada: `decideFolder` elegível). */
  removableFolders: ReadonlySet<string>;
  /**
   * #13748: pastas com os finais liberados (`decideFinalsFolder` elegível).
   * Cópia de final, editado ou prévia (`isFinalOrPreviewFile`) só sai de pasta
   * que está aqui E em `removableFolders`. Ausente = nenhuma dessas sai.
   */
  finalsRemovableFolders?: ReadonlySet<string>;
  /**
   * #13748: renomeações `de → para` (#13632). A pasta que fica segue o destino:
   * entre a pasta antiga e a nova de uma edição renomeada, fica a nova.
   */
  renamedTo?: Readonly<Record<string, string>>;
  /**
   * Nomes referenciados pelos XMLs da raiz de cada pasta (`xmlReferencedNames`).
   * `null` ou ausente = não deu para ler: nada sai daquela pasta.
   */
  referencedByFolder: ReadonlyMap<string, ReadonlySet<string> | null>;
  /** Nome de arquivo (minúsculas) que uma montagem em curso usa (`brutoRefKey`). */
  inUseKeys?: ReadonlySet<string>;
}

const nfcLower = (s: string) => s.normalize("NFC").toLowerCase();
const baseName = (p: string) => p.split("/").pop() ?? p;

/**
 * Pura — agrupa por md5 + tamanho entre pastas diferentes e decide o que sai.
 * Tamanho igual com md5 diferente nunca é duplicata (chave inclui o md5).
 * Cópias repetidas DENTRO da mesma pasta não são tratadas aqui.
 */
export function planCrossFolderDuplicates(files: readonly FolderFile[], opts: DuplicatePlanOptions): DuplicateGroup[] {
  const byKey = new Map<string, FolderFile[]>();
  const pathCount = new Map<string, number>();
  for (const f of files) {
    const k = `${f.folder}\u0000${f.path}`;
    pathCount.set(k, (pathCount.get(k) ?? 0) + 1);
  }
  for (const f of files) {
    if (f.size <= 0 || !f.md5 || isFolderRecordFile(f.path)) continue;
    const key = `${f.md5}:${f.size}`;
    const list = byKey.get(key) ?? [];
    list.push(f);
    byKey.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [, list] of [...byKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const folders = [...new Set(list.map((f) => f.folder))].sort();
    if (folders.length < 2) continue;
    const allBruto = list.every((f) => isBrutoFile(f.path));
    // #13748: pasta de edição única renomeada cede para a pasta de destino, quando ela está no grupo.
    const followRename = (folder: string): string => {
      const eds = editionsOfFolder(folder);
      const to = eds && eds.length === 1 ? opts.renamedTo?.[eds[0]] : undefined;
      return to && folders.includes(to) ? to : folder;
    };
    let keeper = followRename(folders[0]);
    if (allBruto) {
      const recorded = list.map((f) => brutoOwnerEdition(f.path)).find((e) => e !== null) ?? null;
      const owner = recorded ? (opts.renamedTo?.[recorded] ?? recorded) : null;
      const ownerFolder = owner ? folders.find((fo) => (editionsOfFolder(fo) ?? []).includes(owner)) : undefined;
      if (ownerFolder) keeper = ownerFolder;
    }
    const g: DuplicateGroup = { md5: list[0].md5 as string, size: list[0].size, keep: [], remove: [], held: [] };
    for (const f of [...list].sort((a, b) => (a.folder === b.folder ? (a.path < b.path ? -1 : 1) : a.folder < b.folder ? -1 : 1))) {
      if (f.folder === keeper) {
        g.keep.push(f);
        continue;
      }
      const hold = (reason: DuplicateHoldReason) => g.held.push({ ...f, reason });
      if ((pathCount.get(`${f.folder}\u0000${f.path}`) ?? 0) > 1) hold("nome-duplicado-na-pasta");
      else if (!opts.removableFolders.has(f.folder)) hold("pasta-ainda-nao-liberada");
      else if (isFinalOrPreviewFile(f.path) && !opts.finalsRemovableFolders?.has(f.folder)) hold("finais-ainda-nao-liberados");
      else if (isRootXml(f.path)) hold("xml-atual-da-pasta");
      else if (opts.inUseKeys?.has(baseName(f.path).toLowerCase())) hold("em-uso-pela-montagem");
      else {
        const refs = opts.referencedByFolder.get(f.folder);
        if (!refs) hold("xmls-da-pasta-ilegiveis");
        else if ([...refs].some((r) => nfcLower(r) === nfcLower(baseName(f.path)))) hold("referenciado-por-xml-da-pasta");
        else g.remove.push(f);
      }
    }
    groups.push(g);
  }
  return groups;
}

/**
 * Pura — nomes referenciados pelos XMLs da raiz de uma pasta. Diferente do
 * `referencedFromXmlTexts` do #13610, um XML sem `pathurl` não anula a pasta
 * (aqui só protege; não decide o que fica na raiz), mas um texto não lido
 * (`null`) anula: sem ler um XML vigente não dá para saber o que ele usa.
 */
export function referencedNamesOfXmls(texts: ReadonlyArray<string | null>): Set<string> | null {
  const out = new Set<string>();
  for (const t of texts) {
    if (t === null) return null;
    for (const n of xmlReferencedNames(t)) out.add(n);
  }
  return out;
}

/** Pura — pastas que têm candidata a sair (para só ler os XMLs dessas). */
export function foldersWithRemovalCandidates(
  files: readonly FolderFile[],
  removableFolders: ReadonlySet<string>,
  extra: Pick<DuplicatePlanOptions, "finalsRemovableFolders" | "renamedTo"> = {},
): string[] {
  const everything = new Map<string, ReadonlySet<string>>();
  for (const f of files) everything.set(f.folder, new Set());
  const groups = planCrossFolderDuplicates(files, { ...extra, removableFolders, referencedByFolder: everything });
  return [...new Set(groups.flatMap((g) => g.remove.map((f) => f.folder)))].sort();
}
