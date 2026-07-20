/**
 * studio-waves.ts (#3562, extensão da fatia read-only já mergeada em #3574)
 *
 * PREVIEW read-only da "análise de cluster de conflito" que
 * `.claude/skills/diaria-develop/SKILL.md` §"Paralelização segura no
 * desenvolvimento" descreve em prosa: mapear o conjunto de arquivos que cada
 * issue toca, agrupar issues cujos conjuntos se intersectam em clusters
 * (que precisam serializar entre si), e propor a onda paralela máxima seguros
 * = 1 representante por cluster que se toca + todos os singletons.
 *
 * **Isto continua sendo só visualização.** Nada NESTE arquivo dispara
 * worktree, subagente implementador, PR ou merge — só compõe a proposta de
 * onda (clusters + teto de concorrência). A execução de fato (#3702) mora em
 * `studio-wave-fire.ts`/`POST /api/waves/fire`, gateada por
 * `STUDIO_WAVE_FIRE_ENABLED` e nunca validada ao vivo — o botão "disparar
 * onda" da UI (`public/triagem.js`) segue deliberadamente desabilitado até
 * essa validação acontecer (ver doc-comment de `studio-wave-fire.ts`). O
 * objetivo desta fatia continua sendo dar ao editor a MESMA visão que o
 * coordenador do `/diaria-develop` monta manualmente no Gate de Onda.
 *
 * Heurística de extração de arquivo (não é o mesmo grep-com-julgamento que o
 * coordenador faz lendo a issue inteira — aqui é regex puro sobre
 * título+corpo): caminhos em code-span (`` `scripts/foo.ts` ``) e caminhos
 * "nus" prefixados por um diretório-raiz conhecido do repo (`scripts/`,
 * `context/`, `test/`, `seed/`, `docs/`, `workers/`, `.claude/`). Sub-conta
 * (falso-negativo) é mais seguro que sobre-conta aqui: uma issue sem arquivo
 * detectado vira singleton (nunca bloqueia falsamente uma onda por um
 * "conflito" fantasma).
 */

// ─── extração de arquivos citados (pura) ───────────────────────────────

const CODE_SPAN_PATH_RE = /`([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)+)`/g;
const BARE_PATH_RE =
  /\b((?:scripts|context|test|seed|docs|workers|\.claude)\/[a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)*)\b/g;

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:)\]]+$/, "");
}

/** Extrai caminhos de arquivo citados em texto livre (título+corpo de issue).
 * Pura — nenhum I/O, nenhuma chamada a `gh`/git. Dedup via Set; ordem final
 * alfabética (determinístico pra teste e pra render estável). */
export function extractFilePaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const re of [CODE_SPAN_PATH_RE, BARE_PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const path = stripTrailingPunctuation(m[1]);
      if (path.includes("/")) found.add(path);
    }
  }
  return [...found].sort();
}

// ─── classificação overnight/develop (pura, best-effort) ──────────────

export type DispatchTrack = "elegivel" | "bloqueada" | "ambigua";

/** Labels reais que a fila de `/diaria-develop` trata como bloqueio externo
 * (ver SKILL.md §"Categorias de bloqueio"): `external-blocker` (A/B/E
 * conforme corpo), `on-hold`/`kit-migration` (B), `not-this-week` (D),
 * `beehiiv` (E — plataforma plan-gated). */
const BLOCKING_LABELS = new Set([
  "external-blocker",
  "on-hold",
  "kit-migration",
  "not-this-week",
  "beehiiv",
]);

/** Marcadores textuais de decisão-produto/editorial em aberto (cat. C do
 * develop) quando NENHUMA label de bloqueio está presente — sinal mais fraco
 * que uma label real, por isso vira "ambígua" e não "bloqueada". */
const AMBIGUITY_RE = /decidir entre|trade-?off|escolher entre|qual (?:abordagem|opç[aã]o)/i;

/**
 * Classificação best-effort — NÃO é o mesmo julgamento que o coordenador do
 * `/diaria-develop` faz lendo a issue inteira (Fase 0, "Categoria inferida
 * por labels reais + corpo"). É uma aproximação determinística boa o
 * suficiente pra triagem visual; a fonte de verdade continua sendo a sessão
 * `/diaria-develop`/`/diaria-overnight` em si.
 */
export function classifyDispatchTrack(labels: string[], text: string | null | undefined): DispatchTrack {
  if (labels.some((l) => BLOCKING_LABELS.has(l))) return "bloqueada";
  if (AMBIGUITY_RE.test(text ?? "")) return "ambigua";
  return "elegivel";
}

// ─── cluster de conflito (pura) ────────────────────────────────────────

export interface WaveItem {
  id: number;
  files: string[];
}

export interface ConflictCluster {
  /** Membros do cluster, na ordem em que apareceram no input (permite que o
   * caller controle prioridade de representante via ordenação prévia). */
  ids: number[];
  /** União de todos os arquivos tocados pelos membros. */
  files: string[];
}

/**
 * Agrupa itens (issues) cujos conjuntos de arquivos se intersectam em
 * clusters via union-find. Itens sem nenhum arquivo detectado formam
 * clusters unitários (nunca colidem com nada). A ORDEM dos clusters
 * retornados e a ordem de `ids` dentro de cada cluster preservam a ordem de
 * aparição no array de entrada — se o caller passar itens pré-ordenados por
 * prioridade, o primeiro `id` de cada cluster já é o de maior prioridade.
 */
export function buildConflictClusters(items: WaveItem[]): ConflictCluster[] {
  const parent = new Map<number, number>();
  for (const it of items) parent.set(it.id, it.id);

  function find(x: number): number {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as number;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const idsByFile = new Map<string, number[]>();
  for (const it of items) {
    for (const f of it.files) {
      const arr = idsByFile.get(f) ?? [];
      arr.push(it.id);
      idsByFile.set(f, arr);
    }
  }
  for (const ids of idsByFile.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const groups = new Map<number, WaveItem[]>();
  for (const it of items) {
    const root = find(it.id);
    const arr = groups.get(root) ?? [];
    arr.push(it);
    groups.set(root, arr);
  }

  return [...groups.values()].map((members) => ({
    ids: members.map((m) => m.id),
    files: [...new Set(members.flatMap((m) => m.files))].sort(),
  }));
}

// ─── composição da onda (pura) ─────────────────────────────────────────

export interface WaveProposal {
  /** Ids que rodariam em paralelo AGORA (1 por cluster que se toca + todos
   * os singletons), respeitado o teto de concorrência. */
  wave: number[];
  /** Ids adiados — porque colidem (mesmo cluster de um id já na onda) OU
   * porque a onda excedeu o teto de concorrência. */
  deferred: number[];
  clusters: ConflictCluster[];
  /** `true` quando a onda candidata (1 por cluster + singletons) excedeu
   * `maxConcurrency` e precisou ser cortada. */
  overCapacity: boolean;
  maxConcurrency: number;
}

/**
 * Propõe a onda paralela máxima segura a partir dos clusters já calculados
 * (regra do SKILL.md: "Onda paralela máxima = 1 unidade por cluster que se
 * toca + todos os singletons independentes"). Teto de concorrência default
 * 6 (mesmo valor do `/diaria-develop`, #2754).
 */
export function composeWave(clusters: ConflictCluster[], opts: { maxConcurrency?: number } = {}): WaveProposal {
  const maxConcurrency = opts.maxConcurrency ?? 6;
  const candidateWave: number[] = [];
  const clusterDeferred: number[] = [];
  for (const c of clusters) {
    const [first, ...rest] = c.ids;
    candidateWave.push(first);
    clusterDeferred.push(...rest);
  }

  const overCapacity = candidateWave.length > maxConcurrency;
  const wave = overCapacity ? candidateWave.slice(0, maxConcurrency) : candidateWave;
  const capacityDeferred = overCapacity ? candidateWave.slice(maxConcurrency) : [];

  return {
    wave,
    deferred: [...capacityDeferred, ...clusterDeferred],
    clusters,
    overCapacity,
    maxConcurrency,
  };
}

// ─── pipeline combinado (pura) ─────────────────────────────────────────

export interface WaveCandidateIssue {
  number: number;
  files: string[];
  priority: string | null;
  dispatchTrack: DispatchTrack;
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function priorityRank(p: string | null): number {
  return p && p in PRIORITY_RANK ? PRIORITY_RANK[p] : 9;
}

export interface WaveProposalResult extends WaveProposal {
  /** Ids de issues `elegivel` consideradas nesta proposta (ordenadas por
   * prioridade, depois número) — issues `bloqueada`/`ambigua` nunca entram
   * na onda, mesmo espírito do Fase 1 do `/diaria-develop` ("só issues
   * desbloqueada+validada entram na análise de cluster"). */
  consideredIds: number[];
}

/**
 * Pipeline completo: filtra só issues `elegivel`, ordena por prioridade
 * (P0 primeiro, depois número — desempate estável), agrupa em clusters de
 * conflito e propõe a onda. Única função que `server.ts` precisa chamar.
 */
export function buildWaveProposal(
  issues: WaveCandidateIssue[],
  opts: { maxConcurrency?: number } = {},
): WaveProposalResult {
  const eligible = issues
    .filter((i) => i.dispatchTrack === "elegivel")
    .slice()
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      return pr !== 0 ? pr : a.number - b.number;
    });

  const clusters = buildConflictClusters(eligible.map((i) => ({ id: i.number, files: i.files })));
  const proposal = composeWave(clusters, opts);

  return { ...proposal, consideredIds: eligible.map((i) => i.number) };
}
