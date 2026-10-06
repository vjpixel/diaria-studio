/**
 * data-dir-gc-policy.ts (#7278)
 *
 * Política PURA de quais arquivos sob `data/` são candidatos a limpeza —
 * cache/intermediário/backup redundante, NUNCA conteúdo de negócio. Medição
 * completa (~2,7 GB elegíveis de 4,28 GB, ~650 MB/mês de acreção em
 * `editions/`) e o veredito por bucket: corpo da issue #7278.
 *
 * Escopo desta fatia — os buckets "sim, com janela" do corpo da issue que
 * dão pra classificar sem estado externo:
 *   1. `_internal/_forensic/` de edição FECHADA (cache intra-edição do
 *      `url-body-cache.ts`, #959 já proíbe expor a agentes).
 *   2. `tmp-*` em `_internal/` de edição FECHADA (intermediários do Stage 1
 *      — o resultado vive em `01-approved.json`/`01-categorized.md`), exceto
 *      os que ainda são input de replay/medição
 *      (`TMP_PRESERVED_INPUT_FILENAMES`, #9751).
 *   3. `*-embedded.html` em `_internal/` de edição FECHADA (render
 *      derivado, regenerável).
 *   4. Cópias-irmãs de conflito do OneDrive (`-safeBackup-NNNN`, sufixo de
 *      nome de máquina como `-Neo`/`-predator`/`-Zenbook`, `.bak[-data]`) —
 *      em QUALQUER lugar sob `data/`, não só edições. **OPT-IN desde #9732**
 *      (`OPT_IN_BUCKETS`): a cópia de conflito pode ser a ÚNICA cópia do
 *      lado que perdeu uma escrita concorrente; o `--apply` só a remove com
 *      `--include-bucket backup-sibling`, e mesmo assim nunca store
 *      (`*.db*`/`*.sqlite*`) nem arquivo editorial (`isBackupSiblingProtected`).
 *   5. `.mv-cache-*.json` (cache MillionVerifier). **OPT-IN desde #9725**
 *      (`OPT_IN_BUCKETS`): o cache pode guardar resultado pago ainda não
 *      persistido nos CSVs, então o `--apply` só o remove com
 *      `--include-bucket mv-cache`.
 *   6. `diaria-subscribers/*.db.backup-*` (#9725) — retenção dos N
 *      conjuntos mais recentes por `.db` (`classifyDbBackups`, N=3).
 *
 * `beehiiv-backup/` segue no guard (nunca candidato); desde #9725 o
 * dry-run só RELATA os snapshots semanais que uma retenção por N
 * liberaria (`planBeehiivSnapshotReport`) — apagar é decisão do editor.
 *
 * Agendamento: `Diaria-Gc-Data-Dir-Weekly` em `scheduled-tasks.ts` (#9725).
 * Fora desta fatia (follow-up separado da #7278): alarme de cota, e
 * normalização dos 15 diretórios `editions/{AAMMDD}` no layout antigo
 * (mover 3, apagar 12 shells duplicados).
 *
 * ## Guard (#7137 — "guard construído tem que rodar")
 *
 * `isExcludedPath` é a ÚLTIMA palavra, chamada pelo script sobre TODO
 * candidato antes de listar ou remover — nunca confiar cegamente em como o
 * candidato foi construído. Nunca remover: `beehiiv-backup/` (#6465, dado
 * que só existe ali), `04-d*.jpg` (entregáveis publicados), `stripe-*.csv`
 * (export de origem não regenerável sem a Stripe), `snippets/` (conteúdo
 * editorial, #5227). Travado por `test/data-dir-gc-policy.test.ts`.
 */

import { STAGE_INPUT_FILES } from "./replay-stage-input.ts";

// ---------------------------------------------------------------------------
// Guard — prefixos/padrões NUNCA elegíveis, goste o caller ou não
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_PREFIXES = ["beehiiv-backup/", "snippets/"] as const;

/** @pure — normaliza separador e checa contra os 4 padrões excluídos. */
export function isExcludedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (EXCLUDED_DIR_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) return true;
  if (/(^|\/)stripe-[^/]+\.csv$/i.test(p)) return true;
  // 04-d{N}[-carousel-{p1,p2,p3,cta}]-{2x1,1x1,4x5}.jpg — capa + variantes
  // sociais + slides do carrossel diário (#6005 Parte B), todos entregáveis
  // publicados.
  if (/(^|\/)04-d\d+(-carousel-(p1|p2|p3|cta))?-(2x1|1x1|4x5)\.jpg$/i.test(p)) return true;
  return false;
}

export type GcBucket =
  | "forensic-cache"
  | "tmp-intermediate"
  | "embedded-html"
  | "backup-sibling"
  | "mv-cache"
  | "db-backup";

/** Todos os buckets conhecidos — vocabulário aceito por `--include-bucket`. */
export const ALL_GC_BUCKETS: readonly GcBucket[] = [
  "forensic-cache",
  "tmp-intermediate",
  "embedded-html",
  "backup-sibling",
  "mv-cache",
  "db-backup",
];

/**
 * Buckets OPT-IN (#9725): inventariados sempre (dry-run lista), mas fora do
 * default do `--apply` — só removidos com `--include-bucket {nome}`
 * explícito. `mv-cache` entra aqui porque `.mv-cache-*.json` pode guardar
 * resultado MillionVerifier JÁ PAGO que ainda não foi persistido nos CSVs
 * `-verified`/`-rejected`/... (caso de 260728: 13k e-mails recuperados dali)
 * — a premissa "resultado pago já vive em outro lugar" de `classifyMvCache`
 * não é garantida, e o `--apply` agendado (semanal, sem supervisão) não pode
 * apostar nela.
 *
 * `backup-sibling` entra pelo #9732 pela mesma razão: uma cópia de conflito
 * do OneDrive (`diaria-subscribers-Neo.db`, `02-reviewed-Neo.md`) pode ser a
 * ÚNICA cópia do lado que perdeu uma escrita concorrente, a idade derivável
 * do filesystem não é confiável (a renomeação de conflito preserva o mtime
 * do original) e a remoção propaga pelo OneDrive às 3 máquinas. Apagar é
 * irreversível, então o default que erra é o que apaga: a task agendada não
 * o inclui, só uma execução manual com `--include-bucket backup-sibling`.
 */
export const OPT_IN_BUCKETS: readonly GcBucket[] = ["mv-cache", "backup-sibling"];

/**
 * @pure — conjunto de buckets que o `--apply` remove: todos os não-opt-in +
 * os opt-in pedidos em `include`. Nome desconhecido LANÇA (fail-closed: um
 * typo em `--include-bucket mvcache` não pode virar "nada incluído" em
 * silêncio, nem o contrário).
 */
export function resolveEnabledBuckets(include: readonly string[] = []): Set<GcBucket> {
  const enabled = new Set<GcBucket>(ALL_GC_BUCKETS.filter((b) => !OPT_IN_BUCKETS.includes(b)));
  for (const raw of include) {
    const name = raw.trim();
    if (name === "") continue;
    if (!(ALL_GC_BUCKETS as readonly string[]).includes(name)) {
      throw new Error(`--include-bucket: bucket desconhecido "${name}" (válidos: ${ALL_GC_BUCKETS.join(", ")})`);
    }
    enabled.add(name as GcBucket);
  }
  return enabled;
}

export interface GcCandidate {
  /** path relativo à raiz `data/`, sempre "/"-separated. */
  relPath: string;
  bucket: GcBucket;
  sizeBytes: number;
  reason: string;
}

/** Aplica o guard sobre uma lista já classificada — filtra qualquer
 *  candidato cujo path caia em `isExcludedPath`, INDEPENDENTE do bucket que
 *  o caller atribuiu. Chamar isto é o último passo antes de listar/remover
 *  (#7137). */
export function guardCandidates(candidates: readonly GcCandidate[]): GcCandidate[] {
  return candidates.filter((c) => !isExcludedPath(c.relPath));
}

// ---------------------------------------------------------------------------
// Bucket 1-3: edição FECHADA, dentro de `_internal/`
// ---------------------------------------------------------------------------

/** `true` se `relPath` (dentro de `_internal/`) é a raiz do cache forense
 *  intra-edição (`url-body-cache.ts`) — o script remove a árvore inteira. */
export function isForensicCacheDir(relPath: string): boolean {
  return /(^|\/)_internal\/_forensic$/i.test(relPath.replace(/\\/g, "/"));
}

/**
 * `tmp-*` que, apesar do prefixo, ainda são INPUT de outra ferramenta depois
 * que a edição fecha (#9751) — a premissa "resultado já vive em
 * `01-approved.json`" do bucket `tmp-intermediate` é falsa para eles, e o GC
 * semanal os apagaria de toda edição de referência sem aviso:
 *   - todo `_internal/tmp-*` listado em `STAGE_INPUT_FILES`
 *     (`replay-stage-input.ts` — presets de replay dos evals #3442/#3444,
 *     que sempre usam edição FECHADA; hoje `tmp-dates-reviewed.json`).
 *     Derivado do preset, não copiado, para que um arquivo novo no preset
 *     fique protegido sem lembrar deste guard;
 *   - `tmp-allscored.json` — lido por `measure-gate4-highlight-changes.ts`
 *     (medição da #9693).
 * Comparação case-insensitive, como o regex do bucket.
 */
export const TMP_PRESERVED_INPUT_FILENAMES: ReadonlySet<string> = new Set(
  [
    ...Object.values(STAGE_INPUT_FILES)
      .flat()
      .filter((p) => /^_internal\/tmp-[^/]+$/i.test(p))
      .map((p) => p.slice("_internal/".length)),
    "tmp-allscored.json",
  ].map((n) => n.toLowerCase()),
);

/** Intermediários do Stage 1 (`tmp-articles-raw.json`, `tmp-categorized.json`,
 *  `tmp-dedup-output.json`, `tmp-kept.json`, `tmp-filtered.json`, …) —
 *  qualquer `tmp-*` diretamente em `_internal/`, EXCETO os que ainda são
 *  input de replay/medição (`TMP_PRESERVED_INPUT_FILENAMES`, #9751). */
export function isTmpIntermediateFilename(name: string): boolean {
  if (TMP_PRESERVED_INPUT_FILENAMES.has(name.toLowerCase())) return false;
  return /^tmp-[\w.-]+$/i.test(name);
}

/** Render derivado (`newsletter-final-embedded.html`,
 *  `social-preview-embedded.html`, `cloudflare-preview-embedded.html`) —
 *  regenerável do markdown da edição, nunca a fonte. */
export function isEmbeddedHtmlFilename(name: string): boolean {
  return /-embedded\.html$/i.test(name);
}

// ---------------------------------------------------------------------------
// Bucket 4: cópias-irmãs de conflito do OneDrive
// ---------------------------------------------------------------------------

/** Sufixos de nome de máquina realmente usados no projeto (ver CLAUDE.md /
 *  memory: neo, Zenbook, e o servidor Linux 24/7 — renomeado de
 *  `helios`/`predator` para `300` em 08-10/09/2026, #7682; `helios` e
 *  `predator` NÃO são máquinas diferentes, são dois apelidos da MESMA
 *  máquina (Acer Predator Helios 300) usados ao longo do tempo, então os
 *  dois seguem na alternância — arquivos de conflito já gravados em `data/`
 *  antes do rename carregam um ou outro sufixo e ficariam órfãos se
 *  saíssem). `300` entra como 3º apelido da mesma máquina, não uma 4ª —
 *  são 3 máquinas reais (neo, Zenbook, servidor) pros 5 nomes na
 *  alternância (neo, zenbook, predator, helios, 300 — os 3 últimos, o
 *  mesmo servidor). Verificado em 10/09/2026 (#7682 Parte C): nenhum arquivo em
 *  `data/` usa sufixo puramente numérico (`-NNN.ext`) que colidiria com
 *  `-300` sendo lido como esse sufixo em vez de nome de máquina — sem
 *  colisão medida, `300` entra sem âncora extra. + o padrão
 *  `-safeBackup-NNNN` que o cliente OneDrive gera em conflito de eTag
 *  (#7170) + `.bak[-data]` de backup manual. Casa `-Neo`, `-Neo-2` …
 *  `-Neo-10` (OneDrive numera conflitos repetidos), `-helios`, `-300`,
 *  `-predator-safeBackup-0001`, `-fromWindows-260817-0146`, `.db.bak`,
 *  `.db.bak-260728-pre-build`. */
const MACHINE_SUFFIX_RE =
  // #9732: `-do-zenbook`/`-no-zenbook` (`coletar-do-zenbook.ps1`,
  // `aplicar-no-zenbook.ps1`) é PROSA em português, não sufixo de conflito —
  // o OneDrive nunca põe preposição antes do nome da máquina.
  /(?<!-(?:do|no|da|na|de|em|pro|para))-(predator|neo|zenbook|helios|300)(-\d+)?(?=\.[^./]+$)/i;

const BACKUP_SIBLING_PATTERNS: readonly RegExp[] = [
  /-safeBackup-\d+(?=\.[^./]+$|$)/i,
  MACHINE_SUFFIX_RE,
  /-fromWindows-\d{6}-\d{4}(?=\.[^./]+$)/i,
  /\.bak(-\d{6}[-\w]*)?$/i,
];

/** @pure — `true` se `name` (basename, sem diretório) é uma cópia-irmã de
 *  conflito, nunca o arquivo canônico em si (o canônico não tem nenhum
 *  desses sufixos). Casar o NOME é necessário, nunca suficiente: um nome
 *  como `run-Zenbook.log` casa, mas só vira candidato se o arquivo canônico
 *  (`run.log`) existir no mesmo diretório (`classifyBackupSiblings`, #9732). */
export function isBackupSiblingFilename(name: string): boolean {
  return BACKUP_SIBLING_PATTERNS.some((re) => re.test(name));
}

/**
 * @pure — nome do arquivo CANÔNICO de uma cópia-irmã (#9732): remove os
 * sufixos de conflito do fim do nome, repetidamente, até estabilizar
 * (`clarice-users-predator-safeBackup-0001.db` → `clarice-users.db`,
 * `run-log-Neo-2.jsonl` → `run-log.jsonl`, `x.db.bak-260728-pre-build` →
 * `x.db`). `null` se o nome não carrega sufixo de conflito nenhum.
 */
export function backupSiblingCanonicalName(name: string): string | null {
  let cur = name;
  for (;;) {
    const next = cur
      .replace(/\.bak(-\d{6}[-\w]*)?$/i, "")
      .replace(/-safeBackup-\d+(?=\.[^./]+$|$)/i, "")
      .replace(/-fromWindows-\d{6}-\d{4}(?=\.[^./]+$)/i, "")
      .replace(MACHINE_SUFFIX_RE, "");
    if (next === cur) break;
    cur = next;
  }
  return cur === name || cur === "" ? null : cur;
}

/**
 * @pure — cópia-irmã que NUNCA é candidata, nem com o opt-in (#9732):
 *   - store SQLite (`*.db*`, `*.sqlite*` — inclui `-wal`/`-shm`/`.bak`): a
 *     cópia de conflito de um store pode ser o único registro das escritas
 *     de uma máquina (`diaria-subscribers-Neo.db`, `clarice-users-Neo.db`);
 *   - arquivo editorial: `0N-*.md` em qualquer lugar e qualquer `*.md` sob
 *     `editions/` (`02-reviewed-Neo.md` pode ser a revisão do editor).
 * Decide pelo nome da cópia E pelo canônico — uma cópia `x.db.bak` ou
 * `02-reviewed-Neo.md` é protegida pelos dois lados.
 */
export function isBackupSiblingProtected(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = p.slice(p.lastIndexOf("/") + 1);
  const names = [base, backupSiblingCanonicalName(base) ?? base];
  for (const n of names) {
    if (/\.(db|sqlite3?)([.-]|$)/i.test(n)) return true;
    if (/^0\d-.*\.md$/i.test(n)) return true;
    if (/\.md$/i.test(n) && /(^|\/)editions\//i.test(p)) return true;
  }
  return false;
}

export interface AgedFile {
  /** path relativo à raiz `data/`, "/"-separated. */
  relPath: string;
  sizeBytes: number;
  /** idade em dias, calculada pelo caller — mantém esta função pura/testável sem `Date.now()` embutido.
   *  Para cópias-irmãs (#9732) o script passa a idade CONSERVADORA (mais
   *  recente entre mtime/ctime/birthtime), não o mtime cru. */
  ageDays: number;
  /** mtime bruto em ms (epoch) — usado só pra DESEMPATAR ordem dentro do
   *  mesmo dia (`classifyBackupSiblings`). `ageDays` sozinho (arredondado
   *  pra baixo) empataria cópias-irmãs nascidas no mesmo dia — o caso
   *  COMUM pra conflito do OneDrive, já que as cópias nascem no mesmo
   *  evento de sync, não em dias diferentes. */
  mtimeMs: number;
}

/** Retenção default pra cópias-irmãs. **Dobrada de 14 para 28 dias no
 *  #9732:** nenhuma idade derivável do filesystem é confiável aqui — a
 *  renomeação de conflito do OneDrive PRESERVA o mtime do original, então
 *  uma cópia pode nascer com "mais de 14 dias" e ser elegível na 1ª rodada.
 *  O script mitiga pela idade CONSERVADORA (o mais recente entre mtime,
 *  ctime e birthtime — rename e criação atualizam ctime/birthtime, ver
 *  `conservativeTimestampMs` em `gc-data-dir.ts`) e o dobro da janela cobre
 *  o resíduo (plataforma/cliente de sync que reescreva esses campos). */
export const BACKUP_SIBLING_RETENTION_DAYS = 28;

export interface ClassifyBackupSiblingsOptions {
  /**
   * `true` se o arquivo CANÔNICO (path relativo a `data/`, "/"-separated)
   * existe. Cópia cujo canônico não existe NUNCA é candidata (#9732): ou é
   * a única cópia sobrevivente daquele dado, ou o nome casou o padrão por
   * acaso (`run-Zenbook.log` sem `run.log` ao lado). Default `() => false`
   * — sem a informação, nada sai (fail-closed).
   */
  canonicalExists?: (canonicalRelPath: string) => boolean;
}

/**
 * Classifica cópias-irmãs candidatas a remoção — agrupadas por FAMÍLIA
 * (diretório + nome canônico, `backupSiblingCanonicalName`), desde o #9732;
 * antes era só por diretório, e um diretório com cópias de 2 canônicos
 * distintos preservava 1 cópia só, de 1 deles. Dentro de cada família, a
 * cópia MAIS RECENTE (por `mtimeMs` real, não `ageDays` arredondado — ver
 * docstring de `AgedFile`) nunca é candidata, mesmo se velha; as demais só
 * entram se `ageDays > retentionDays`.
 *
 * Nunca candidatas, em nenhuma família (#9732): cópias protegidas
 * (`isBackupSiblingProtected` — store e arquivo editorial), cópias sem nome
 * canônico derivável, e cópias cujo canônico não existe
 * (`opts.canonicalExists`).
 *
 * `files` deve conter só arquivos já filtrados por `isBackupSiblingFilename`
 * (esta função não filtra de novo — separação de responsabilidade: achar
 * vs. decidir retenção). O bucket é OPT-IN no `--apply` (`OPT_IN_BUCKETS`).
 */
export function classifyBackupSiblings(
  files: readonly AgedFile[],
  retentionDays: number = BACKUP_SIBLING_RETENTION_DAYS,
  opts: ClassifyBackupSiblingsOptions = {},
): GcCandidate[] {
  const canonicalExists = opts.canonicalExists ?? (() => false);
  const byFamily = new Map<string, AgedFile[]>();
  for (const f of files) {
    const norm = f.relPath.replace(/\\/g, "/");
    if (isBackupSiblingProtected(norm)) continue;
    const slash = norm.lastIndexOf("/");
    const dir = slash === -1 ? "" : norm.slice(0, slash);
    const canonical = backupSiblingCanonicalName(norm.slice(slash + 1));
    if (canonical === null) continue;
    const canonicalRel = dir === "" ? canonical : `${dir}/${canonical}`;
    if (!canonicalExists(canonicalRel)) continue;
    const list = byFamily.get(canonicalRel) ?? [];
    list.push(f);
    byFamily.set(canonicalRel, list);
  }

  const out: GcCandidate[] = [];
  for (const [canonicalRel, list] of byFamily) {
    // mtimeMs REAL, não ageDays arredondado (achado de review) — cópias-
    // irmãs do OneDrive nascem no mesmo evento de conflito, então empatar
    // no mesmo DIA é o caso comum, não a exceção; ageDays (Math.floor)
    // faria a ordem depender de readdirSync (arbitrária), não de quem é
    // de fato mais recente.
    const sorted = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs); // mais nova primeiro
    sorted.forEach((f, idx) => {
      if (idx === 0) return; // mais recente da família — nunca candidata
      if (f.ageDays <= retentionDays) return;
      out.push({
        relPath: f.relPath,
        bucket: "backup-sibling",
        sizeBytes: f.sizeBytes,
        reason:
          `cópia-irmã de conflito do OneDrive de ${canonicalRel}, ${f.ageDays}d (>${retentionDays}d) e não é a mais ` +
          `recente da família — opt-in no --apply (#9732): pode ser a única cópia de uma escrita concorrente`,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bucket 5: cache MillionVerifier
// ---------------------------------------------------------------------------

export function isMvCacheFilename(name: string): boolean {
  return /^\.mv-cache-.*\.json$/i.test(name);
}

/** Cache descartável — o resultado PAGO vive nos `-verified`/`-rejected`/
 *  `-unknown`/`-error` (#4353), nunca no cache. Retenção generosa (não é
 *  urgente) só pra não competir com uma verificação em andamento. */
export const MV_CACHE_RETENTION_DAYS = 30;

export function classifyMvCache(files: readonly AgedFile[], retentionDays: number = MV_CACHE_RETENTION_DAYS): GcCandidate[] {
  return files
    .filter((f) => f.ageDays > retentionDays)
    .map((f) => ({
      relPath: f.relPath,
      bucket: "mv-cache" as const,
      sizeBytes: f.sizeBytes,
      reason: `cache MillionVerifier, ${f.ageDays}d (>${retentionDays}d) — opt-in no --apply (#9725): pode guardar resultado pago ainda não persistido nos CSVs`,
    }));
}

// ---------------------------------------------------------------------------
// Bucket 6: backups do store `diaria-subscribers` (#9725) — retenção por N
// ---------------------------------------------------------------------------

/** Quantos backups (conjuntos `{db}.backup-{stamp}` + sidecars) do mesmo
 *  `.db` são preservados — os N mais recentes, por `stamp`. Default 3,
 *  configurável via `--db-backup-keep`. */
export const DB_BACKUP_KEEP_DEFAULT = 3;

/** Piso de IDADE (#9730, review P2): nenhum backup com menos de N dias sai,
 *  mesmo fora dos `keep` mais recentes. Esses backups são o ponto de
 *  restauração ANTES de operações irreversíveis (`backupStoreFile`,
 *  resolve-identity/backfill) — uma sessão de manutenção que gere 4+
 *  backups seguidos não pode fazer o GC de sábado apagar o 1º deles, que é
 *  justamente o anterior a tudo. A idade vem do timestamp NO NOME (`stamp`),
 *  nunca do mtime (o OneDrive reescreve mtime ao copiar entre máquinas).
 *  Configurável via `--db-backup-min-age-days`. */
export const DB_BACKUP_MIN_AGE_DAYS_DEFAULT = 14;

/** Único diretório onde o bucket `db-backup` atua (escopo da #9725). */
export const DB_BACKUP_DIR = "diaria-subscribers";

export interface DbBackupName {
  /** basename do `.db` canônico (ex: `diaria-subscribers.db`). */
  base: string;
  /** timestamp do backup (`backupFileSuffix`, ex: `2026-09-05T01-24-38-264Z`). */
  stamp: string;
  /** Sufixo de cópia de conflito do OneDrive (ex: `-Neo`, `-predator-safeBackup-0001`),
   *  presente só quando o arquivo é uma cópia de conflito — ela pertence ao
   *  MESMO conjunto do backup de origem (mesmo `stamp`), nunca a um conjunto
   *  próprio que disputaria o top N (#9730, review P3). */
  conflictSuffix?: string;
}

/** Formato de `backupFileSuffix` (`new Date().toISOString()` com `:`/`.` → `-`). */
const DB_BACKUP_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** Sufixo de cópia de conflito do OneDrive — mesmo vocabulário de
 *  `BACKUP_SIBLING_PATTERNS` (nome de máquina, `-safeBackup-NNNN`,
 *  `-fromWindows-…`), ancorado no FIM do nome do backup. */
const DB_BACKUP_CONFLICT_SUFFIX_RE =
  /(-(?:safeBackup-\d+|(?:predator|neo|zenbook|helios|300)(?:-\d+)?(?:-safeBackup-\d+)?|fromWindows-\d{6}-\d{4}))$/i;

/**
 * @pure — reconhece `{base}.db.backup-{stamp}` e seus sidecars SQLite
 * (`-shm`/`-wal`/`-journal`), formato gravado por `backupStoreFile`
 * (`scripts/lib/diaria-subscribers-identity-resolve.ts`). O sidecar
 * pertence ao MESMO conjunto do backup (mesmo `stamp`) e sai junto com ele —
 * nunca fica órfão. Cópia de conflito do OneDrive (`…Z-Neo`, `…Z-shm-Neo`)
 * também entra no conjunto de origem (`conflictSuffix`). `stamp` precisa
 * estar no formato ISO de `backupFileSuffix` — sem isso a idade não é
 * derivável e o arquivo não é tratado como backup (nunca removido por este
 * bucket). `null` = não é backup (inclui o `.db` canônico).
 */
export function parseDbBackupFilename(name: string): DbBackupName | null {
  const conflict = DB_BACKUP_CONFLICT_SUFFIX_RE.exec(name);
  const core = conflict ? name.slice(0, conflict.index) : name;
  const m = /^(.+\.db)\.backup-(.+?)(?:-(?:shm|wal|journal))?$/i.exec(core);
  if (!m || !DB_BACKUP_STAMP_RE.test(m[2])) return null;
  return conflict ? { base: m[1], stamp: m[2], conflictSuffix: conflict[1] } : { base: m[1], stamp: m[2] };
}

/** @pure — epoch ms do `stamp` (formato de `backupFileSuffix`), ou `null`. */
export function dbBackupStampToMs(stamp: string): number | null {
  const m = DB_BACKUP_STAMP_RE.exec(stamp);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export interface ClassifyDbBackupsOptions {
  /** "agora" em epoch ms — injetado pelo caller pra manter a função pura. */
  nowMs: number;
  /** Piso de idade em dias (pelo `stamp`). Default `DB_BACKUP_MIN_AGE_DAYS_DEFAULT`. */
  minAgeDays?: number;
}

/**
 * Classifica backups do store: agrupa por (diretório, `.db` base), depois
 * por `stamp` (conjunto = backup + sidecars + cópias de conflito do
 * OneDrive). Preserva os `keep` conjuntos mais recentes — ordenados por
 * `stamp` desc (ISO, ordena lexicalmente; mtime não serve como critério
 * primário porque a cópia via OneDrive entre máquinas reescreve mtime),
 * desempate por mtime. Dos demais, só sai o conjunto cujo `stamp` tem
 * idade ≥ `minAgeDays` (#9730): "fora do top N" é necessário, nunca
 * suficiente.
 *
 * Arquivos que `parseDbBackupFilename` não reconhece são ignorados (o
 * caller já filtra; defesa em profundidade).
 */
export function classifyDbBackups(
  files: readonly AgedFile[],
  keep: number = DB_BACKUP_KEEP_DEFAULT,
  opts: ClassifyDbBackupsOptions,
): GcCandidate[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`classifyDbBackups: keep deve ser inteiro ≥ 1, recebido ${keep}`);
  }
  const minAgeDays = opts.minAgeDays ?? DB_BACKUP_MIN_AGE_DAYS_DEFAULT;
  if (!Number.isInteger(minAgeDays) || minAgeDays < 1) {
    throw new Error(`classifyDbBackups: minAgeDays deve ser inteiro ≥ 1, recebido ${minAgeDays}`);
  }
  if (!Number.isFinite(opts.nowMs)) {
    throw new Error(`classifyDbBackups: nowMs inválido (${opts.nowMs})`);
  }
  // (dir|base) → stamp → arquivos do conjunto
  const groups = new Map<string, Map<string, AgedFile[]>>();
  for (const f of files) {
    const norm = f.relPath.replace(/\\/g, "/");
    const slash = norm.lastIndexOf("/");
    const dir = slash === -1 ? "" : norm.slice(0, slash);
    const parsed = parseDbBackupFilename(norm.slice(slash + 1));
    if (!parsed) continue;
    const key = `${dir}|${parsed.base}`;
    const sets = groups.get(key) ?? new Map<string, AgedFile[]>();
    const list = sets.get(parsed.stamp) ?? [];
    list.push(f);
    sets.set(parsed.stamp, list);
    groups.set(key, sets);
  }

  const out: GcCandidate[] = [];
  for (const sets of groups.values()) {
    const ordered = [...sets.entries()].sort(([sa, fa], [sb, fb]) => {
      if (sa !== sb) return sa < sb ? 1 : -1; // stamp desc
      return Math.max(...fb.map((f) => f.mtimeMs)) - Math.max(...fa.map((f) => f.mtimeMs));
    });
    for (const [stamp, list] of ordered.slice(keep)) {
      const stampMs = dbBackupStampToMs(stamp);
      if (stampMs === null) continue; // idade indeterminável — nunca remover
      const ageDays = Math.floor((opts.nowMs - stampMs) / 86_400_000);
      if (ageDays < minAgeDays) continue; // piso de idade (#9730)
      for (const f of list) {
        out.push({
          relPath: f.relPath,
          bucket: "db-backup",
          sizeBytes: f.sizeBytes,
          reason: `backup do store (${stamp}, ${ageDays}d ≥ ${minAgeDays}d) fora dos ${keep} mais recentes do mesmo .db`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `beehiiv-backup/` — SÓ RELATÓRIO, nunca candidato (#9725)
// ---------------------------------------------------------------------------

/** N de snapshots semanais que o RELATÓRIO trata como "manter" — só muda o
 *  que é listado como candidato hipotético; nada é removido. */
export const BEEHIIV_SNAPSHOT_KEEP_REPORT_DEFAULT = 4;

/** @pure — snapshot semanal de `beehiiv-backup/` (`YYYY-MM-DD`). */
export function isBeehiivSnapshotDirName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

export interface SnapshotDirInfo {
  /** path relativo à raiz `data/` (ex: `beehiiv-backup/2026-09-06`). */
  relPath: string;
  sizeBytes: number;
}

export interface BeehiivSnapshotReport {
  keep: number;
  kept: SnapshotDirInfo[];
  /** Candidatos HIPOTÉTICOS — nunca entram em `GcCandidate[]` nem são
   *  removidos por este script (o guard `isExcludedPath` também os barra).
   *  `beehiiv-backup/` é o único backup de dado que some junto com o acesso
   *  à Beehiiv (#6465); apagar é decisão do editor. */
  wouldRemove: SnapshotDirInfo[];
  wouldRemoveBytes: number;
  totalBytes: number;
}

/** @pure — ordena por nome (data ISO) desc e separa os `keep` mais recentes. */
export function planBeehiivSnapshotReport(
  snapshots: readonly SnapshotDirInfo[],
  keep: number = BEEHIIV_SNAPSHOT_KEEP_REPORT_DEFAULT,
): BeehiivSnapshotReport {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`planBeehiivSnapshotReport: keep deve ser inteiro ≥ 1, recebido ${keep}`);
  }
  const ordered = [...snapshots].sort((a, b) => (a.relPath < b.relPath ? 1 : a.relPath > b.relPath ? -1 : 0));
  const wouldRemove = ordered.slice(keep);
  return {
    keep,
    kept: ordered.slice(0, keep),
    wouldRemove,
    wouldRemoveBytes: wouldRemove.reduce((s, x) => s + x.sizeBytes, 0),
    totalBytes: ordered.reduce((s, x) => s + x.sizeBytes, 0),
  };
}
