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
 *   5. `.mv-cache-*.json` (cache MillionVerifier — o resultado pago vive
 *      nos `-verified`/`-rejected`/`-unknown`/`-error`, #4353).
 *
 * Fora desta fatia (itens 4-6 do "O que fazer" da issue, follow-up
 * separado): agendamento armado em `scheduled-tasks.ts`, alarme de cota, e
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

export type GcBucket = "forensic-cache" | "tmp-intermediate" | "embedded-html" | "backup-sibling" | "mv-cache";

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
 *  memory: helios — servidor Linux 24/7, também participa de conflito
 *  OneDrive, ver #7170 —, neo, predator, Zenbook) + o padrão
 *  `-safeBackup-NNNN` que o cliente OneDrive gera em conflito de eTag
 *  (#7170) + `.bak[-data]` de backup manual. Casa `-Neo`, `-Neo-2` …
 *  `-Neo-10` (OneDrive numera conflitos repetidos), `-helios`,
 *  `-predator-safeBackup-0001`, `-fromWindows-260817-0146`, `.db.bak`,
 *  `.db.bak-260728-pre-build`. */
const BACKUP_SIBLING_PATTERNS: readonly RegExp[] = [
  /-safeBackup-\d+(?=\.[^./]+$|$)/i,
  /-(predator|neo|zenbook|helios)(-\d+)?(?=\.[^./]+$)/i,
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
      reason: `cache MillionVerifier, ${f.ageDays}d (>${retentionDays}d) — resultado pago já persistido em outro lugar (#4353)`,
    }));
}
