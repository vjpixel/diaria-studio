/**
 * scripts/lib/diaria/video-version-archive.ts (#13610)
 *
 * Política PURA da pasta `arquivo/` de cada edição na pasta de vídeo
 * (`diaria-studio-video/{AAMMDD}/`): o que é a versão vigente de cada arquivo
 * lógico (fica na raiz) e o que é versão anterior (vai para `{AAMMDD}/arquivo/`,
 * movido, nunca apagado). Quem executa é `video-version-archive-io.ts` (Drive
 * pela API, ou o disco no Neo), chamado pelo `video-montagem.ts` depois de
 * `build`/`srt`/`preview`/`upload` e pela migração `scripts/archive-video-versions.ts`.
 *
 * Família (o "mesmo arquivo lógico"):
 * - XML de sequência: o nome com o `_V{n}` normalizado. Cada variante é uma
 *   família: `horizontal_V{n}`, `_Vertical_V{n}`, `_Vertical_V{n}-guia`,
 *   `-trechos`, `-automacao`, slug de corte, `_Youtube_V{n}` (nome antigo) e
 *   os sufixos com espaço feitos à mão (`_V12 leve`, `_V13 local`). Fica a de
 *   maior `n` da RAIZ.
 * - SRT da montagem (`{seq} - legendas.srt`, `- legendas do export.srt`, e o
 *   sidecar `.srt.no-plan.json`): acompanha o XML da SUA versão. Fica só o da
 *   versão do XML vigente da família; sem XML da família na raiz, fica o de
 *   maior `n`.
 * - Asset com hash no nome (`{AAMMDD}_audio_tratado-{chave}.wav`,
 *   `_titulo_vertical[-variante]-{hash}.png`, `_cta_card_{orientação}-{hash}`,
 *   `_capa_inicio-…`, `_tela_{id}-{hash}.png`, `_trecho_{id}-{hash}.mov`):
 *   família = o nome sem o hash. Fica todo membro referenciado por um XML
 *   VIGENTE (os `pathurl`, comparados pelo nome do arquivo); sem nenhum
 *   referenciado, o mais novo (data de modificação). Sem data em algum membro,
 *   nada sai (não dá para saber o mais novo).
 * - Prévia (`{AAMMDD} - previa *.mp4`): família = o nome inteiro (só nome
 *   repetido na raiz vira arquivamento; a sobrescrita do `preview` arquiva a
 *   anterior antes, ver `isOverwriteArchivedName`).
 *
 * Fica fora, sempre: subpastas (`Final/`, `Editado/`, `Editados/`, `Projeto/`,
 * `trechos/`, `legendas-vertical*\/`, `arquivo/`), bruto (`isBrutoFile`: nome
 * de câmera, `bruto_unido`), docs e arquivos sem versão nem hash reconhecível
 * no nome (roteiro, decupagem, `.docx`, `.pdf`, `_origem-brutos.json`).
 *
 * `_superadas/` (a 261110/261111 têm um, feito à mão antes desta regra) é
 * absorvido: o conteúdo vai para `arquivo/` (`LEGACY_ARCHIVE_DIRS`).
 *
 * A numeração do `build` conta o `arquivo/` (`maxArchivedXmlVersion`): arquivar
 * o V8 nunca faz o próximo build voltar a um V já importado no Premiere (#13414).
 */

import { isBrutoFile } from "./video-bruto-archive.ts";

/** Nome da subpasta (premissa da issue: minúsculo, como o editor escreveu). */
export const ARCHIVE_DIR_NAME = "arquivo";

/** Pastas de "superadas" feitas à mão antes do #13610: o conteúdo vai para `arquivo/`. */
export const LEGACY_ARCHIVE_DIRS: readonly string[] = ["_superadas"];

export type FamilyKind = "xml" | "srt" | "asset" | "preview";

export interface FileFamily {
  kind: FamilyKind;
  /** Chave da família (o nome sem a versão/hash). */
  key: string;
  /** `_V{n}` do XML/SRT; null em asset e prévia. */
  version: number | null;
  /** SRT: a família do XML a que ele pertence. */
  xmlKey?: string;
}

/** `_V{n}` no fim do nome (sem extensão), com o sufixo de variante: `-guia`, `-trechos`, slug de corte, ` leve`. */
const XML_VERSION_RE = /_V(\d+)((?:[- ][A-Za-z0-9]+)*)$/;
const SRT_RE = /^(.+?) - legendas( do export)?\.srt(\.no-plan\.json)?$/i;
const AUDIO_TRATADO_RE = /^(\d{6}_audio_tratado)-([^./\\]+)\.wav$/i;
/** `{AAMMDD}_{coisa}-{hash hex ≥ 8}.{ext}`: título, CTA, capa, tela, trecho. Nome de câmera tem 8 dígitos antes do `_`, não casa. */
const HASHED_ASSET_RE = /^(\d{6}_[^/\\]+?)-([0-9a-f]{8,})\.([A-Za-z0-9]+)$/;
const PREVIEW_RE = /^\d{6} - pr[eé]via .+\.mp4$/i;

const nfc = (s: string) => s.normalize("NFC");

/** Família do XML de sequência (`Diaria comentada_Vertical_V10-guia.xml` → `xml:Diaria comentada_Vertical_V#-guia`, 10). */
export function xmlFamilyOf(name: string): FileFamily | null {
  const n = nfc(name);
  if (!/\.xml$/i.test(n)) return null;
  const stem = n.slice(0, -4);
  const m = XML_VERSION_RE.exec(stem);
  if (!m) return null;
  return { kind: "xml", key: `xml:${stem.slice(0, m.index)}_V#${m[2]}`, version: Number(m[1]) };
}

/** Pura — a família de um arquivo SOLTO na raiz da pasta da edição; `null` = fica (fora da regra). */
export function familyOf(name: string): FileFamily | null {
  const n = nfc(name);
  if (n.includes("/") || n.includes("\\")) return null;
  if (isBrutoFile(n)) return null;
  const xml = xmlFamilyOf(n);
  if (xml) return xml;
  const srt = SRT_RE.exec(n);
  if (srt) {
    const of = xmlFamilyOf(`${srt[1]}.xml`);
    if (!of) return null;
    const sub = `${srt[2] ? "export" : "montagem"}${srt[3] ? ":no-plan" : ""}`;
    return { kind: "srt", key: `srt:${of.key}:${sub}`, version: of.version, xmlKey: of.key };
  }
  if (PREVIEW_RE.test(n)) return { kind: "preview", key: `preview:${n}`, version: null };
  if (/bruto[_ -]?unido/i.test(n)) return null;
  const audio = AUDIO_TRATADO_RE.exec(n);
  if (audio) return { kind: "asset", key: `asset:${audio[1]}.wav`, version: null };
  const asset = HASHED_ASSET_RE.exec(n);
  if (asset) return { kind: "asset", key: `asset:${asset[1]}.${asset[3].toLowerCase()}`, version: null };
  return null;
}

/**
 * Prévia: o `preview` regrava o mesmo nome. A anterior vai para `arquivo/`
 * ANTES de a nova ocupar o nome (a sobrescrita vira arquivamento).
 */
export function isOverwriteArchivedName(name: string): boolean {
  return familyOf(name)?.kind === "preview";
}

/** Um item da raiz da pasta da edição. `modifiedMs` null = sem data conhecida. */
export interface ArchiveEntry {
  name: string;
  id?: string;
  isFolder?: boolean;
  modifiedMs: number | null;
}

export interface ArchiveDecision {
  name: string;
  id?: string;
  family: string;
  reason: string;
}

export interface EditionArchivePlan {
  move: ArchiveDecision[];
  keep: ArchiveDecision[];
  /** Arquivos fora da regra (sem família) e subpastas: nunca tocados. */
  untouched: string[];
  /** Pastas `_superadas/` a absorver em `arquivo/`. */
  absorb: ArchiveEntry[];
  /** XMLs vigentes (fica na raiz) cujas referências decidem os assets. */
  vigenteXmls: string[];
}

const newestFirst = (a: ArchiveEntry, b: ArchiveEntry) => (b.modifiedMs ?? -Infinity) - (a.modifiedMs ?? -Infinity);

/** Ordem do vencedor de um grupo: maior versão, depois o modificado por último. */
function pickTop<T extends { e: ArchiveEntry; f: FileFamily }>(members: T[]): T {
  return [...members].sort((a, b) => (b.f.version ?? 0) - (a.f.version ?? 0) || newestFirst(a.e, b.e))[0];
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/** Pura — os XMLs que ficam na raiz (o de maior `_V{n}` de cada família). */
export function vigenteXmlNames(root: readonly ArchiveEntry[]): string[] {
  const xmls = root.filter((e) => !e.isFolder).flatMap((e) => {
    const f = xmlFamilyOf(e.name);
    return f ? [{ e, f }] : [];
  });
  return [...groupBy(xmls, (x) => x.f.key).values()].map((g) => pickTop(g).e.name).sort();
}

/**
 * Pura — os XMLs da raiz cujas referências protegem assets (#13610, A): o
 * vigente de cada família (TODAS as cópias do nome, quando o Drive tem nome
 * repetido) e todo `.xml` fora de família (sem `_V{n}`, `(1)`, acento,
 * `_v9` minúsculo), que nunca sai da raiz. Só o XML de versão anterior, que
 * vai para `arquivo/`, não protege.
 */
export function xmlsThatStay(root: readonly ArchiveEntry[]): ArchiveEntry[] {
  const vig = new Set(vigenteXmlNames(root));
  return root.filter((e) => !e.isFolder && /\.xml$/i.test(e.name) && (xmlFamilyOf(e.name) === null || vig.has(e.name)));
}

/** Pura — entidades XML (`&amp;`, `&apos;`, `&quot;`, `&lt;`, `&gt;`, `&#39;`, `&#x27;`). */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (m, ent: string) => {
    const e = ent.toLowerCase();
    if (e === "amp") return "&";
    if (e === "apos") return "'";
    if (e === "quot") return '"';
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * Pura — os nomes de arquivo que um XML (xmeml) referencia por `pathurl`
 * (`file://localhost/…/261118/261118_audio_tratado-x.wav` → `261118_audio_tratado-x.wav`).
 * Entidades XML e percent-encoding (`%XX`) decodificados; `\` vale como separador.
 */
export function xmlReferencedNames(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<pathurl>([^<]+)<\/pathurl>/g)) {
    let p = decodeXmlEntities(m[1].trim());
    try {
      p = decodeURIComponent(p);
    } catch {
      /* percent-encoding inválido: usa o texto cru */
    }
    const name = p.replace(/\\/g, "/").split("/").pop();
    if (name) out.add(nfc(name));
  }
  return [...out];
}

/**
 * Pura — o conjunto de nomes referenciados pelos XMLs que ficam. `null` (nenhum
 * asset sai) quando algum texto não foi lido (`null` na lista) ou foi lido sem
 * nenhum `<pathurl>`: um XML que não referencia nada não é prova de que nada é usado.
 */
export function referencedFromXmlTexts(texts: ReadonlyArray<string | null>): Set<string> | null {
  const out = new Set<string>();
  for (const t of texts) {
    if (t === null) return null;
    const refs = xmlReferencedNames(t);
    if (!refs.length) return null;
    for (const r of refs) out.add(r);
  }
  return out;
}

export interface PlanOptions {
  /**
   * #13610 B: os XMLs que o `plan.json` diz vigentes (o build acabou de gravar).
   * Algum fora da listagem da raiz (a busca do Drive atrasa) = nenhum asset sai nesta rodada.
   */
  expectedXmls?: readonly string[];
}

/**
 * Pura — o plano de uma pasta de edição. `referenced` = nomes que os XMLs que
 * ficam na raiz referenciam (`referencedFromXmlTexts` sobre o texto de cada um
 * de `xmlsThatStay`: os vigentes por família, os fora de família e as cópias de
 * nome repetido). `null` = nenhum asset sai (não dá para saber o que os XMLs
 * usam), seja porque alguma leitura falhou, seja porque algum XML que fica não
 * tem nenhum `<pathurl>`; XML/SRT/prévia seguem a regra nos dois casos.
 */
export function planEditionArchive(root: readonly ArchiveEntry[], referenced: ReadonlySet<string> | null, opts: PlanOptions = {}): EditionArchivePlan {
  const move: ArchiveDecision[] = [];
  const keep: ArchiveDecision[] = [];
  const untouched: string[] = [];
  const absorb: ArchiveEntry[] = [];
  const classified: Array<{ e: ArchiveEntry; f: FileFamily }> = [];
  for (const e of root) {
    if (e.isFolder) {
      if (LEGACY_ARCHIVE_DIRS.includes(e.name)) absorb.push(e);
      else untouched.push(`${e.name}/`);
      continue;
    }
    const f = familyOf(e.name);
    if (f) classified.push({ e, f });
    else untouched.push(e.name);
  }
  const dec = (x: { e: ArchiveEntry; f: FileFamily }, reason: string): ArchiveDecision => ({ name: x.e.name, ...(x.e.id ? { id: x.e.id } : {}), family: x.f.key, reason });

  // XML: maior versão da raiz por família.
  const vigenteVersion = new Map<string, number>();
  for (const [key, g] of groupBy(classified.filter((x) => x.f.kind === "xml"), (x) => x.f.key)) {
    const top = pickTop(g);
    vigenteVersion.set(key, top.f.version ?? 0);
    for (const x of g) {
      if (x === top) keep.push(dec(x, "XML vigente da família"));
      else move.push(dec(x, x.e.name === top.e.name ? `nome repetido na raiz; fica o modificado por último` : `versão anterior (vigente: ${top.e.name})`));
    }
  }

  // SRT: acompanha o XML da sua versão.
  for (const g of groupBy(classified.filter((x) => x.f.kind === "srt"), (x) => x.f.key).values()) {
    const xmlKey = g[0].f.xmlKey!;
    const v = vigenteVersion.get(xmlKey);
    if (v === undefined) {
      const top = pickTop(g);
      for (const x of g) {
        if (x === top) keep.push(dec(x, "SRT sem XML da família na raiz: fica o de maior versão"));
        else move.push(dec(x, `SRT de versão anterior (fica ${top.e.name})`));
      }
      continue;
    }
    const same = g.filter((x) => x.f.version === v);
    const winner = same.length ? same.sort((a, b) => newestFirst(a.e, b.e))[0] : null;
    for (const x of g) {
      if (x === winner) keep.push(dec(x, `SRT da versão vigente (V${v})`));
      else if (x.f.version === v) move.push(dec(x, "nome repetido na raiz; fica o modificado por último"));
      else move.push(dec(x, `SRT do V${x.f.version}; o XML vigente é o V${v}`));
    }
  }

  // Prévia: nome inteiro; só repetição de nome na raiz.
  for (const g of groupBy(classified.filter((x) => x.f.kind === "preview"), (x) => x.f.key).values()) {
    const [top, ...rest] = [...g].sort((a, b) => newestFirst(a.e, b.e));
    keep.push(dec(top, "prévia vigente"));
    for (const x of rest) move.push(dec(x, "nome repetido na raiz; fica o modificado por último"));
  }

  // Asset com hash: o referenciado pelo XML vigente fica; sem referência, o mais novo.
  // #13610 B: listagem possivelmente atrasada (XML do plan.json ausente, ou asset mais novo que todo XML da raiz) = nenhum asset sai.
  const rootNames = new Set(root.filter((e) => !e.isFolder).map((e) => e.name));
  const missingExpected = (opts.expectedXmls ?? []).filter((n) => !rootNames.has(n));
  const xmlTimes = root.filter((e) => !e.isFolder && /\.xml$/i.test(e.name)).map((e) => e.modifiedMs);
  const newestXml = xmlTimes.length && xmlTimes.every((t) => t !== null) ? Math.max(...(xmlTimes as number[])) : null;
  const assets = classified.filter((x) => x.f.kind === "asset");
  const newerAsset = newestXml !== null ? assets.find((x) => x.e.modifiedMs !== null && x.e.modifiedMs > newestXml) : undefined;
  const assetHold =
    referenced === null ? "referências dos XMLs que ficam não lidas: asset fica"
    : missingExpected.length ? `XML do plan.json fora da listagem (${missingExpected.join(", ")}): asset fica nesta rodada`
    : newerAsset ? `${newerAsset.e.name} é mais novo que todo XML da raiz (listagem atrasada?): asset fica nesta rodada`
    : null;
  for (const g of groupBy(assets, (x) => x.f.key).values()) {
    if (assetHold !== null || referenced === null) {
      for (const x of g) keep.push(dec(x, assetHold ?? "referências não lidas: asset fica"));
      continue;
    }
    const refd = g.filter((x) => referenced.has(nfc(x.e.name)));
    if (refd.length) {
      for (const x of g) {
        if (refd.includes(x)) keep.push(dec(x, "referenciado por XML vigente"));
        else move.push(dec(x, "nenhum XML vigente referencia"));
      }
      continue;
    }
    if (g.length === 1) {
      keep.push(dec(g[0], "único da família"));
      continue;
    }
    if (g.some((x) => x.e.modifiedMs === null)) {
      for (const x of g) keep.push(dec(x, "sem data de modificação em algum membro: nada sai"));
      continue;
    }
    const [top, ...rest] = [...g].sort((a, b) => newestFirst(a.e, b.e));
    keep.push(dec(top, "mais novo da família (nenhum XML vigente referencia a família)"));
    for (const x of rest) move.push(dec(x, `versão anterior (fica ${top.e.name})`));
  }

  // Asset referenciado por XML vigente nunca sai, mesmo que outra regra o tenha posto em `move` (defesa).
  const safeMove = referenced === null ? move.filter((m) => familyOf(m.name)?.kind !== "asset") : move.filter((m) => !referenced.has(nfc(m.name)) || familyOf(m.name)?.kind !== "asset");
  return { move: safeMove, keep, untouched: untouched.sort(), absorb, vigenteXmls: vigenteXmlNames(root) };
}

/**
 * Pura — o nome no `arquivo/`: o mesmo, ou com ` (arquivado {stamp})` antes da
 * extensão quando já existe um igual lá (o Drive aceitaria dois, o disco
 * sobrescreveria). `stamp` é do chamador (data/hora), e o contador garante unicidade.
 */
export function archiveTargetName(name: string, taken: ReadonlySet<string>, stamp: string, opts: { caseInsensitive?: boolean } = {}): string {
  // #13610 H: no NTFS do Neo `X.xml` e `x.xml` são o mesmo arquivo.
  const lower = opts.caseInsensitive ? new Set([...taken].map((t) => t.toLowerCase())) : null;
  const has = (n: string) => (lower ? lower.has(n.toLowerCase()) : taken.has(n));
  if (!has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  // `.srt.no-plan.json`: o sufixo vai antes do `.srt`.
  const noPlan = /\.srt\.no-plan\.json$/i.exec(name);
  const [s, x] = noPlan ? [name.slice(0, noPlan.index), name.slice(noPlan.index)] : [stem, ext];
  for (let i = 1; ; i++) {
    const cand = `${s} (arquivado ${stamp}${i > 1 ? ` ${i}` : ""})${x}`;
    if (!has(cand)) return cand;
  }
}

/**
 * Pura — a maior `_V{n}` de uma família de XML entre nomes (a raiz mais o
 * `arquivo/`), para a numeração do `build` contar o que foi arquivado (#13610,
 * #13414). `familyKey` de `xmlFamilyOf`. Null = nenhum.
 */
export function maxXmlVersionIn(names: readonly string[], familyKey: string): number | null {
  let max: number | null = null;
  for (const n of names) {
    const f = xmlFamilyOf(n);
    if (f && f.key === familyKey && f.version !== null && (max === null || f.version > max)) max = f.version;
  }
  return max;
}

/** Pura — tira o ` (arquivado …)` que a colisão no `arquivo/` acrescenta (`X_V8 (arquivado 20261118-120000).xml` → `X_V8.xml`). */
export function stripArchivedSuffix(name: string): string {
  return name.replace(/ \(arquivado [^)]*\)(?=(\.srt\.no-plan\.json|\.[A-Za-z0-9]+)?$)/i, "");
}

/** Pura — a versão do `<sequence id>` versionado (`seq-{chave}-v{n}-{hash}`) do plan.json. */
export function versionOfSequenceId(id: string): { version: number; hash: string } | null {
  const m = /^seq-[a-z0-9-]+?-v(\d+)-([0-9a-f]{8})$/.exec(id);
  return m ? { version: Number(m[1]), hash: m[2] } : null;
}

/** Pura — carimbo do nome de colisão: `20261118-1530` (UTC, só dígitos e hífen). */
export function archiveStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

/** Pura — pasta de edição da pasta de vídeo (`AAMMDD` ou `AAMMDD-DD`). */
export function isEditionFolderName(name: string): boolean {
  return /^\d{6}(?:-\d{2})?$/.test(name);
}
