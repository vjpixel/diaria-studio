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
 *      — o resultado vive em `01-approved.json`/`01-categorized.md`).
 *   3. `*-embedded.html` em `_internal/` de edição FECHADA (render
 *      derivado, regenerável).
 *   4. Cópias-irmãs de conflito do OneDrive (`-safeBackup-NNNN`, sufixo de
 *      nome de máquina como `-Neo`/`-predator`/`-Zenbook`, `.bak[-data]`) —
 *      em QUALQUER lugar sob `data/`, não só edições.
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
 */
export const OPT_IN_BUCKETS: readonly GcBucket[] = ["mv-cache"];

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

/** Intermediários do Stage 1 (`tmp-articles-raw.json`, `tmp-categorized.json`,
 *  `tmp-dedup-output.json`, `tmp-kept.json`, `tmp-filtered.json`, …) —
 *  qualquer `tmp-*` diretamente em `_internal/`. */
export function isTmpIntermediateFilename(name: string): boolean {
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
const BACKUP_SIBLING_PATTERNS: readonly RegExp[] = [
  /-safeBackup-\d+(?=\.[^./]+$|$)/i,
  /-(predator|neo|zenbook|helios|300)(-\d+)?(?=\.[^./]+$)/i,
  /-fromWindows-\d{6}-\d{4}(?=\.[^./]+$)/i,
  /\.bak(-\d{6}[-\w]*)?$/i,
];

/** @pure — `true` se `name` (basename, sem diretório) é uma cópia-irmã de
 *  conflito, nunca o arquivo canônico em si (o canônico não tem nenhum
 *  desses sufixos). */
export function isBackupSiblingFilename(name: string): boolean {
  return BACKUP_SIBLING_PATTERNS.some((re) => re.test(name));
}

export interface AgedFile {
  /** path relativo à raiz `data/`, "/"-separated. */
  relPath: string;
  sizeBytes: number;
  /** idade em dias (mtime), calculada pelo caller — mantém esta função pura/testável sem `Date.now()` embutido. */
  ageDays: number;
  /** mtime bruto em ms (epoch) — usado só pra DESEMPATAR ordem dentro do
   *  mesmo dia (`classifyBackupSiblings`). `ageDays` sozinho (arredondado
   *  pra baixo) empataria cópias-irmãs nascidas no mesmo dia — o caso
   *  COMUM pra conflito do OneDrive, já que as cópias nascem no mesmo
   *  evento de sync, não em dias diferentes. */
  mtimeMs: number;
}

/** Retenção default pra cópias-irmãs — folgada o bastante pra sobreviver a
 *  uma máquina fora do ar por 1-2 semanas sem perder o backup mais recente
 *  dela, curta o bastante pra não deixar lixo de meses acumular (medição da
 *  issue: 23 dos 33 `run-log-*.jsonl` eram de jun/jul, muito além disso). */
export const BACKUP_SIBLING_RETENTION_DAYS = 14;

/**
 * Classifica cópias-irmãs candidatas a remoção — agrupadas por DIRETÓRIO
 * (não por "família" de nome canônico, ver nota de desenho abaixo). Dentro
 * de cada diretório, a cópia MAIS RECENTE (por `mtimeMs` real, não
 * `ageDays` arredondado — ver docstring de `AgedFile`) nunca é candidata —
 * mesmo se velha (issue: "sempre preservando o mais recente de cada
 * família") — as demais só entram se `ageDays > retentionDays`.
 *
 * `files` deve conter só arquivos já filtrados por `isBackupSiblingFilename`
 * (esta função não filtra de novo — separação de responsabilidade: achar
 * vs. decidir retenção).
 *
 * **Premissa assumida, registrada e não resolvida (achado de review,
 * confiança média):** agrupar por DIRETÓRIO em vez de por família de nome
 * canônico (ex: extrair o stem antes do 1º sufixo de conflito) assume que
 * um diretório nunca mistura backups de mais de 1 arquivo canônico
 * distinto — verdadeiro em todo caso medido no projeto (`clarice-users.db`
 * sozinho em `clarice-subscribers/`, `run-log.jsonl` sozinho na raiz),
 * mas não é garantido em geral: um diretório com 2 arquivos canônicos
 * diferentes, cada um com suas próprias cópias-irmãs, faria esta função
 * tratá-las como 1 família só — "a mais recente do diretório" preservaria
 * só 1 cópia (de 1 dos 2 canônicos), quando deveria preservar 1 de CADA.
 * Critério pra revisitar: se uma varredura real (`--dry-run --json`)
 * mostrar um diretório com 3+ cópias-irmãs cujos nomes, ao remover o
 * sufixo de conflito, não convergem pro MESMO stem — sinal de mistura —
 * trocar pra agrupamento por família (stem canônico) em vez de diretório.
 */
export function classifyBackupSiblings(
  files: readonly AgedFile[],
  retentionDays: number = BACKUP_SIBLING_RETENTION_DAYS,
): GcCandidate[] {
  const byDir = new Map<string, AgedFile[]>();
  for (const f of files) {
    const norm = f.relPath.replace(/\\/g, "/");
    const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    const list = byDir.get(dir) ?? [];
    list.push(f);
    byDir.set(dir, list);
  }

  const out: GcCandidate[] = [];
  for (const list of byDir.values()) {
    // mtimeMs REAL, não ageDays arredondado (achado de review) — cópias-
    // irmãs do OneDrive nascem no mesmo evento de conflito, então empatar
    // no mesmo DIA é o caso comum, não a exceção; ageDays (Math.floor)
    // faria a ordem depender de readdirSync (arbitrária), não de quem é
    // de fato mais recente.
    const sorted = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs); // mais nova primeiro
    sorted.forEach((f, idx) => {
      if (idx === 0) return; // mais recente do diretório — nunca candidata
      if (f.ageDays <= retentionDays) return;
      out.push({
        relPath: f.relPath,
        bucket: "backup-sibling",
        sizeBytes: f.sizeBytes,
        reason: `cópia-irmã de conflito do OneDrive, ${f.ageDays}d (>${retentionDays}d) e não é a mais recente do diretório`,
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

/** Único diretório onde o bucket `db-backup` atua (escopo da #9725). */
export const DB_BACKUP_DIR = "diaria-subscribers";

export interface DbBackupName {
  /** basename do `.db` canônico (ex: `diaria-subscribers.db`). */
  base: string;
  /** timestamp do backup (`backupFileSuffix`, ex: `2026-09-05T01-24-38-264Z`). */
  stamp: string;
}

/**
 * @pure — reconhece `{base}.db.backup-{stamp}` e seus sidecars SQLite
 * (`-shm`/`-wal`/`-journal`), formato gravado por `backupStoreFile`
 * (`scripts/lib/diaria-subscribers-identity-resolve.ts`). O sidecar
 * pertence ao MESMO conjunto do backup (mesmo `stamp`) e sai junto com ele —
 * nunca fica órfão. `null` = não é backup (inclui o `.db` canônico).
 */
export function parseDbBackupFilename(name: string): DbBackupName | null {
  const m = /^(.+\.db)\.backup-(.+?)(?:-(?:shm|wal|journal))?$/i.exec(name);
  if (!m) return null;
  return { base: m[1], stamp: m[2] };
}

/**
 * Classifica backups do store: agrupa por (diretório, `.db` base), depois
 * por `stamp` (conjunto = backup + sidecars). Preserva os `keep` conjuntos
 * mais recentes — ordenados por `stamp` desc (ISO, ordena lexicalmente;
 * mtime não serve como critério primário porque a cópia via OneDrive entre
 * máquinas reescreve mtime), desempate por mtime — e devolve TODOS os
 * arquivos dos demais conjuntos. Sem limiar de idade: o critério é "os N
 * últimos", mesmo que todos velhos.
 *
 * Arquivos que `parseDbBackupFilename` não reconhece são ignorados (o
 * caller já filtra; defesa em profundidade).
 */
export function classifyDbBackups(files: readonly AgedFile[], keep: number = DB_BACKUP_KEEP_DEFAULT): GcCandidate[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`classifyDbBackups: keep deve ser inteiro ≥ 1, recebido ${keep}`);
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
      for (const f of list) {
        out.push({
          relPath: f.relPath,
          bucket: "db-backup",
          sizeBytes: f.sizeBytes,
          reason: `backup do store (${stamp}) fora dos ${keep} mais recentes do mesmo .db`,
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
