/**
 * scripts/lib/issue-triage-fetch.ts (#7018 item 2)
 *
 * Guard de varredura: encapsula o `gh issue list` da Fase 0 (overnight,
 * develop, continuo — três `SKILL.md` reproduziam essa string de campos à
 * mão) num único ponto, pra que a lista de `--json` correta seja mantida
 * uma vez, na fonte, em vez de reescrita/reconferida em cada skill toda vez
 * que um novo campo entra na classificação (foi exatamente a divergência —
 * varredura sem `body` — que causou o #7018: 4 issues `agendada` dispatchadas
 * como `overnight` porque a chamada real da rodada 260901b não incluía
 * `body` no `--json`, sem nenhum sinal de erro).
 *
 * Mesmo padrão fail-soft de `scripts/check-decision-label-drift.ts` /
 * `scripts/lib/state-changed-tracker.ts` (`fetchOpenIssuesForConvergence`):
 * nunca lança por falha de `gh`/rede — falha de transporte volta como
 * `{ issues: [], error }` pro caller decidir degradar (#738). A ÚNICA coisa
 * que este módulo trata como erro FATAL (mesmo com `gh` tendo respondido
 * 200 e JSON válido) é a AUSÊNCIA da chave `body` no primeiro item — sinal
 * de que o comando saiu sem `body` no `--json`, o próprio bug do #7018 —
 * porque campos vêm uniformes em todos os itens de uma chamada, checar o
 * 1º já garante a chamada inteira.
 *
 * Cada item validado passa por `classifyExecTrackFromListItem`
 * (`scripts/lib/issue-exec-track.ts`, também #7018) — fail-closed por item
 * como 2ª camada, redundante com a checagem acima de propósito (a checagem
 * acima é uma otimização "falha rápido, 1 vez"; a validação por item é a
 * garantia real, chamada pelo array vazio caso a lista de issues seja `[]`
 * e a checagem acima nunca rode).
 *
 * `opts.since` (#7018 item 3) dá ao `/diaria-continuo` o mesmo caminho
 * fail-closed SEM forçá-lo pro full-scan que overnight/develop usam —
 * `continuo` varre incrementalmente por desenho (#5344 Parte B6, evita
 * reclassificar o backlog aberto inteiro a cada tick); antes deste item, a
 * varredura incremental do passo 2 do SKILL.md era montada à mão em prosa
 * (`gh issue list --json number,title,labels,updatedAt --search
 * "updated:>={last_scan_at}"`), sem `body` no `--json` — o mesmo bug do
 * #7018, só que na varredura incremental em vez da varredura completa que o
 * item 2 já fechou para overnight/develop.
 *
 * **Multi-repo (#10618, fatia 2) — OPT-IN.** Sem `opts.repos`, varre SÓ o
 * repo default (`vjpixel/diaria-studio`): overnight, contínuo e zerar-fila
 * recebem exatamente a fila de antes, porque ~15 gates e consumidores ainda
 * leem `number` como número do studio (fatia 3). Com `opts.repos` (o CLI
 * resolve `--repos all`/lista via `resolveTriageRepos`, validada contra
 * `platform.config.json → issue_repos`), varre também os repos pedidos — o
 * default sempre primeiro. Toda chamada leva `-R owner/repo`, inclusive a do
 * default: sem `-R`, o `gh` resolveria pelo cwd e um checkout do
 * diaria-design rotularia as issues dele como do studio. Cada item ganha
 * `repo` e `ref` (`owner/repo#N`); `number` continua o número cru dentro de
 * `repo`. Falha de fetch do repo default continua FATAL (`error`); falha de
 * um repo extra é `repoErrors` — o CLI sai com exit 3 (resultado PARCIAL,
 * nunca 0), imprime a lista do que veio e avisa no stderr.
 *
 * @see scripts/lib/issue-exec-track.ts (classifyExecTrackFromListItem)
 * @see scripts/lib/state-changed-tracker.ts (fetchOpenIssuesForConvergence — mesmo padrão, escopo de campos menor)
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 3
 * @see .claude/skills/diaria-develop/SKILL.md § Fase 0 passo 3
 * @see .claude/skills/diaria-continuo/SKILL.md § Loop invariável, passo 2 (--since)
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ISSUE_REPO, formatIssueRef, isDefaultIssueRepo, loadIssueRepos, normalizeRepoSlug } from "./issue-repos.ts";
import {
  classifyExecTrackFromListItem,
  normalizeGhIssueListLabels,
  type GhIssueListRawItem,
  type ExecTrack,
} from "./issue-exec-track.ts";

/** Issue já normalizada + classificada — pronta pro coordenador consumir
 * sem precisar rechamar `classifyExecTrack` por conta própria. */
export interface TriageIssue {
  /** #10618 — repo da issue (`owner/name`, minúsculas). */
  repo: string;
  /** #10618 — identidade canônica `owner/repo#N` (decisão do editor). */
  ref: string;
  /** Número cru DENTRO de `repo`. Só é "o número do studio" quando
   * `isDefaultIssueRepo(repo)`. */
  number: number;
  title: string;
  labels: string[];
  body: string | null;
  url: string;
  updatedAt: string | null;
  state: string | null;
  execTrack: ExecTrack;
}

export interface FetchOpenIssuesForTriageResult {
  issues: TriageIssue[];
  /** Falha do repo default — fatal, como sempre foi. */
  error?: string;
  /** #10618 — falhas de repos EXTRAS da allowlist. Não derrubam a triagem do
   * studio, mas o caller precisa exibi-las (o CLI imprime no stderr). */
  repoErrors?: Array<{ repo: string; error: string }>;
}

/** Raiz do checkout que contém este módulo — onde mora o `platform.config.json`
 * que define `issue_repos`. Independente do cwd (que pode ser um subdiretório). */
const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Campos exigidos pela classificação completa da Fase 0 — `body` é o campo
 * cuja ausência este módulo existe pra prevenir; os demais (title, url,
 * updatedAt) são consumidos pelo passo 4 do overnight/develop (comparação
 * com `decided_at`, exibição no plano). Vale para os dois modos (full scan
 * e incremental, `opts.since` abaixo) — `body` nunca foi o campo caro da
 * varredura, é o volume de issues retornadas que `since` reduz. */
const TRIAGE_JSON_FIELDS = "number,title,labels,body,url,updatedAt,state";

const TRIAGE_ISSUE_LIMIT = 200;

export interface FetchOpenIssuesForTriageOptions {
  /** Injetável pra teste; default `new Date()`. */
  now?: Date;
  /**
   * ISO 8601 (`plan.json.last_scan_at`) — quando fornecido, restringe a
   * varredura a issues atualizadas desde este instante via `gh issue list
   * --search "updated:>={since}"`, em vez do backlog aberto inteiro (#7018
   * item 3). Existe pra dar ao `/diaria-continuo` (SKILL.md passo 2) um
   * caminho fail-closed SEM forçá-lo pro full-scan caro que motivou a
   * varredura incremental em primeiro lugar (#5344 Parte B6) — overnight e
   * develop nunca passam esta opção, continuam em full-scan.
   *
   * `TRIAGE_JSON_FIELDS` (incluindo `body`) não muda com `since` presente
   * — a garantia fail-closed de `classifyExecTrackFromListItem` abaixo
   * cobre os dois modos igualmente, porque o único campo que este módulo
   * exige (`body`) nunca foi o custo que `since` existe pra evitar (custo é
   * RECLASSIFICAR TODO o backlog a cada tick, não buscar 1 campo a mais por
   * item já retornado).
   */
  since?: string;
  /**
   * #10618 — repos a varrer, OPT-IN. Ausente = só o repo default (a fila de
   * sempre). O repo default é sempre incluído e sempre varrido primeiro,
   * mesmo que omitido aqui. Slug ilegível é erro fatal (`error`), nunca
   * descartado em silêncio. Validar contra a allowlist é papel de quem monta
   * a lista (`resolveTriageRepos`).
   */
  repos?: readonly string[];
}

/** Allowlist de repos da triagem — `platform.config.json → issue_repos` do
 * checkout deste módulo (independe do cwd). */
export function triageAllowedRepos(): string[] {
  return loadIssueRepos(MODULE_REPO_ROOT);
}

/**
 * #10618 (fatia 2) — resolve o valor de `--repos` do CLI:
 *   - ausente/vazio → `undefined` (só o repo default, a fila de sempre);
 *   - `all` → todos de `allowedRepos` (`issue_repos`);
 *   - lista `a,b` → cada slug normalizado e conferido contra `allowedRepos`.
 * Slug ilegível ou fora da allowlist → `{ error }` (o CLI sai com exit 1) —
 * nunca vira uma varredura menor que a pedida sem aviso.
 */
export function resolveTriageRepos(
  spec: string | undefined,
  allowedRepos: readonly string[],
): { repos: string[] | undefined } | { error: string } {
  if (spec === undefined || spec.trim() === "") return { repos: undefined };
  const allowed = allowedRepos.map((r) => normalizeRepoSlug(r)).filter((r): r is string => r !== null);
  if (spec.trim().toLowerCase() === "all") return { repos: [...new Set([DEFAULT_ISSUE_REPO, ...allowed])] };
  const out: string[] = [];
  for (const raw of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const slug = normalizeRepoSlug(raw);
    if (!slug) return { error: `--repos: slug ilegível "${raw}" (esperado owner/name ou all) (#10618)` };
    if (!allowed.includes(slug)) {
      return {
        error: `--repos: ${slug} não está em platform.config.json → issue_repos (permitidos: ${allowed.join(", ")}) (#10618)`,
      };
    }
    if (!out.includes(slug)) out.push(slug);
  }
  return { repos: out.length > 0 ? out : undefined };
}

/**
 * Busca as issues abertas (até `TRIAGE_ISSUE_LIMIT`) via `gh issue list`
 * com o conjunto de campos completo da varredura de classificação da Fase
 * 0, já normalizadas e classificadas via `classifyExecTrackFromListItem`.
 * Nunca lança por falha de `gh`/rede (fail-soft, #738); lança apenas se
 * `gh` responder sem a chave `body` no `--json` — nesse caso o bug é NOSSO
 * (comando errado), não uma falha de transporte, então fail-soft
 * mascararia exatamente a classe de erro que este módulo existe pra pegar.
 *
 * `opts.since` (#7018 item 3) restringe a varredura ao delta desde aquele
 * instante (`--search "updated:>={since}"`) em vez do backlog aberto
 * inteiro — omitido/`undefined` preserva o comportamento original (full
 * scan), o único modo que overnight/develop usam. `opts.repos` (#10618) é
 * opt-in: sem ele, só o repo default (ver docblock do módulo); `since` vale
 * igual em todas as chamadas.
 */
export function fetchOpenIssuesForTriage(
  cwd: string,
  opts?: FetchOpenIssuesForTriageOptions,
): FetchOpenIssuesForTriageResult {
  const repos = [DEFAULT_ISSUE_REPO];
  for (const r of opts?.repos ?? []) {
    const slug = normalizeRepoSlug(r);
    if (!slug) return { issues: [], error: `repo ilegível na lista de varredura: "${r}" (#10618)` };
    if (!repos.includes(slug)) repos.push(slug);
  }
  const issues: TriageIssue[] = [];
  const repoErrors: Array<{ repo: string; error: string }> = [];
  for (const repo of repos) {
    const one = fetchOneRepo(cwd, repo, opts);
    if (one.error) {
      if (isDefaultIssueRepo(repo)) return { issues: [], error: one.error };
      repoErrors.push({ repo, error: one.error });
      continue;
    }
    issues.push(...one.issues);
  }
  return repoErrors.length > 0 ? { issues, repoErrors } : { issues };
}

function fetchOneRepo(
  cwd: string,
  repo: string,
  opts?: FetchOpenIssuesForTriageOptions,
): FetchOpenIssuesForTriageResult {
  const args = ["issue", "list", "--state", "open", "--limit", String(TRIAGE_ISSUE_LIMIT), "--json", TRIAGE_JSON_FIELDS];
  if (opts?.since) {
    args.push("--search", `updated:>=${opts.since}`);
  }
  // #10618: sempre `-R`, inclusive no repo default — sem ele o `gh`
  // resolveria pelo cwd e rotularia como do studio as issues de outro checkout.
  args.push("-R", repo);
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      issues: [],
      error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!result.stdout) {
    return { issues: [], error: "gh issue list retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { issues: [], error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], error: "gh issue list retornou payload que não é um array" };
  }
  const raw = parsed as GhIssueListRawItem[];
  // Mesmo achado do #5713/fila-convergence-gate: `--limit N` bate exatamente
  // em N sem sinalizar truncamento — tratado como fetch incompleto, nunca
  // como sucesso parcial silencioso.
  if (raw.length === TRIAGE_ISSUE_LIMIT) {
    return {
      issues: [],
      error: `gh issue list retornou exatamente ${TRIAGE_ISSUE_LIMIT} issues (o limite) — resultado pode estar truncado; tratando como fetch incompleto`,
    };
  }
  const issues: TriageIssue[] = raw.map((item) => {
    const number = typeof item.number === "number" ? item.number : Number(item.number);
    return {
    repo,
    ref: formatIssueRef({ repo, number }),
    number,
    title: typeof item.title === "string" ? item.title : "",
    labels: normalizeGhIssueListLabels(item.labels),
    body: (item.body ?? null) as string | null,
    url: typeof item.url === "string" ? item.url : "",
    updatedAt: (item.updatedAt ?? null) as string | null,
    state: (item.state ?? null) as string | null,
    // Lança (fail-closed, #7018) se `body` estiver ausente — não capturado
    // aqui de propósito, propaga pro caller do fetch inteiro.
    execTrack: classifyExecTrackFromListItem(item, { now: opts?.now }),
    };
  });
  return { issues };
}
