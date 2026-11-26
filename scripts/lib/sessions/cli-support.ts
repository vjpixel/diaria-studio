/**
 * scripts/lib/sessions/cli-support.ts (#14004)
 *
 * Validação de argumentos do CLI (`requireKind`, `requireSessionId`,
 * `requireClaimIssue`...) e `resolveRepoRoot`. O `main()` fica em
 * `session-registry.ts`.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
// #7836 — mesma constante que `.claude/hooks/inject-session-id.mjs` importa
// pra montar `INJECTABLE_SUBCOMMANDS`. Usada aqui só em `requireSessionId`,
// pra enriquecer a mensagem de erro com a fonte única sem duplicar a lista
// — ver docblock de `session-id-required-subcommands.ts` pro motivo de ser
// um módulo à parte em vez de o hook importar `session-registry.ts` inteiro.
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../session-id-required-subcommands.ts";
import { DEFAULT_ISSUE_REPO, legacyIssueNumber, normalizeRepoSlug, parseIssueRef } from "../issue-repos.ts";
import { ALL_SESSION_KINDS, hasMergeAuthorityKind, type MergeLockRecord, type SessionKind } from "./types.ts";
import { readJsonSafe, sessionsDir } from "./store.ts";
import type { ClaimIssueTarget } from "./claims.ts";

// ─── CLI ────────────────────────────────────────────────────────────────────

/**
 * Exportado só para teste direto (#5293) — o CLI (main(), abaixo) é o único
 * chamador em produção.
 */
export function requireKind(value: string | undefined): SessionKind {
  if (value === undefined || !(ALL_SESSION_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `--kind deve ser "overnight", "develop", "continuo", "interactive" ou "continuo-review", recebido "${value}"`,
    );
  }
  return value as SessionKind;
}

/**
 * Como `requireKind`, mas exige AUTORIDADE DE MERGE — usada nos subcomandos
 * que só fazem sentido pra quem decide merge. Hoje: `grant-merge` (#6296).
 *
 * **#7702: passou a checar `hasMergeAuthorityKind`, não `isCoordinatorKind`.**
 * Enquanto checava coordenadora, este gate aceitava `--kind continuo` e dizia
 * na própria mensagem que continuo podia — mas `grantMergeWindow` logo abaixo
 * recusa com `not-a-coordinator`. O operador passava a validação que o
 * afirmava permitido e falhava adiante, com uma mensagem que contradizia a
 * primeira (achado do pr-test-analyzer nesta PR). O nome da função ficou por
 * retrocompatibilidade de import; o critério é autoridade de merge.
 */
export function requireCoordinatorKind(value: string | undefined): SessionKind {
  const kind = requireKind(value);
  if (!hasMergeAuthorityKind(kind)) {
    throw new Error(
      `--kind "${kind}" não tem autoridade de merge — só overnight/develop podem executar esta operação. ` +
        (kind === "continuo"
          ? "continuo é uma RODADA, mas não decide merge (#7702): quem mergeia no fluxo contínuo é " +
            "`continuo-pr-review.sh`, e nada a impede de conceder janela porque ela nunca teve uma pra dar. " +
            "Uma sessão interativa bloqueada por uma rodada continuo não precisa de concessão — ela já tem " +
            "direito de mergear, só falta `merge-lock-acquire --pr N`."
          : "Uma sessão interativa nunca concede janela de merge (nem a si mesma): peça à coordenadora registrada (#6296)."),
    );
  }
  return kind;
}

export function requireSessionId(values: Record<string, string>): string {
  const sessionId = values["session-id"];
  if (!sessionId) {
    throw new Error(
      "--session-id ausente — normalmente injetado automaticamente por " +
        ".claude/hooks/inject-session-id.mjs a partir do payload do hook PreToolUse " +
        `(subcomandos reconhecidos: ${SESSION_ID_REQUIRED_SUBCOMMANDS.join(", ")} — ver ` +
        "scripts/lib/session-id-required-subcommands.ts, #7836). " +
        "Se você está chamando este script fora do harness do Claude Code, passe --session-id explicitamente.",
    );
  }
  return sessionId;
}

/**
 * Repos cujo merge lock está, agora, na mão de `sessionId` (#10618). Lê os
 * arquivos `.merge-lock*.json` de `data/sessions/`; o nome volta pro repo
 * (o owner nunca tem `--`, então o 1º `--` separa owner e repo). Fail-soft.
 */
export function mergeLocksHeldBy(repoRoot: string, sessionId: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(sessionsDir(repoRoot));
  } catch {
    return out;
  }
  for (const name of names) {
    let repo: string | null = null;
    if (name === ".merge-lock.json") repo = DEFAULT_ISSUE_REPO;
    else {
      const m = /^\.merge-lock--(.+?)--(.+)\.json$/.exec(name);
      if (m) repo = normalizeRepoSlug(`${m[1]}/${m[2]}`);
    }
    if (!repo) continue;
    if (readJsonSafe<MergeLockRecord>(join(sessionsDir(repoRoot), name))?.heldBy === sessionId) out.push(repo);
  }
  return out;
}

/**
 * Aviso (stderr) quando o lock do repo pedido não estava com esta sessão mas
 * ela segura o lock de OUTRO repo — o caso típico é esquecer o `--repo` no
 * release/renew de um merge do diaria-design (#10618).
 */
export function warnLockHeldInOtherRepo(
  repoRoot: string,
  sessionId: string,
  repo: string,
  heldByBefore: string | undefined,
  command: string,
): void {
  if (heldByBefore === sessionId) return;
  const others = mergeLocksHeldBy(repoRoot, sessionId).filter((r) => r !== repo);
  if (others.length === 0) return;
  process.stderr.write(
    `session-registry: AVISO (#10618) — ${command} mirou o lock de ${repo}, que esta sessão não segurava, ` +
      `mas ela segura o lock de: ${others.join(", ")}. Faltou ${others
        .map((r) => (r === DEFAULT_ISSUE_REPO ? "rodar SEM --repo" : `--repo ${r}`))
        .join(" / ")}?\n`,
  );
}

/**
 * `--repo owner/name` (#10618). Ausente → repo default (`vjpixel/diaria-studio`),
 * que é o que todo comando significava antes. Presente e ilegível → erro alto:
 * cair no default em silêncio faria um lock/claim do diaria-design pousar no
 * do diaria-studio.
 */
export function requireRepoFlag(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string> = new Set(),
): string {
  // `--repo` sem valor (vira flag no parseArgs) ou `--repo=` vazio: erro alto,
  // nunca o default em silêncio — quem digitou `--repo` queria OUTRO repo.
  if (flags.has("repo") || values.repo === "") {
    throw new Error("--repo sem valor (esperado owner/name, ex: vjpixel/diaria-design)");
  }
  const raw = values.repo;
  if (raw === undefined) return DEFAULT_ISSUE_REPO;
  const slug = normalizeRepoSlug(raw);
  if (!slug) throw new Error(`--repo inválido: "${raw}" (esperado owner/name, ex: vjpixel/diaria-design)`);
  return slug;
}

/**
 * `--issue` dos subcomandos de claim (#10618). Aceita a forma legada (`123`,
 * `#123` — o repo default) e a canônica `owner/repo#N`. `--repo` só pode
 * concordar com o repo da forma qualificada; divergência é erro alto. Devolve
 * o NÚMERO legado que `claimed_issues` guarda.
 *
 * Para consumidores que só entendem NÚMERO: issue de OUTRO repo é recusada
 * alto — gravar `21` pro `vjpixel/diaria-design#21` reivindicaria o
 * `vjpixel/diaria-studio#21` em silêncio, que é exatamente a colisão que a
 * #10618 existe pra evitar. O CLI de claim usa `requireClaimIssue` (fatia 2),
 * que aceita outro repo da allowlist e grava em `claimed_foreign_issues`.
 */
export function requireLegacyClaimIssue(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string> = new Set(),
): number {
  const repoFlag = requireRepoFlag(values, flags);
  const ref = parseIssueRef(values.issue ?? "", repoFlag);
  if (!ref) throw new Error("--issue deve ser um inteiro ou owner/repo#N");
  if (values.repo !== undefined && ref.repo !== repoFlag) {
    throw new Error(`--issue ${values.issue} e --repo ${values.repo} apontam pra repos diferentes (#10618)`);
  }
  const n = legacyIssueNumber(ref);
  if (n === null) {
    throw new Error(
      `claim de issue de outro repo (${ref.repo}#${ref.number}) ainda não é suportado pelo session-registry — ` +
        "claimed_issues só guarda número do repo default e gravar o número colidiria com " +
        `${DEFAULT_ISSUE_REPO}#${ref.number} (#10618).`,
    );
  }
  return n;
}

/**
 * `--issue` dos subcomandos de claim do CLI (#10618, fatia 2). Mesmo parse de
 * `requireLegacyClaimIssue`, mas aceita issue de OUTRO repo — desde que ele
 * esteja na allowlist `issue_repos` (`allowedRepos`, normalmente
 * `loadIssueRepos(repoRoot)`). Devolve o número legado quando a issue é do
 * repo default (grava em `claimed_issues`, como sempre) e a `IssueRef`
 * quando é de outro repo (grava em `claimed_foreign_issues`). Repo fora da
 * allowlist (typo, fork) é erro alto — nunca vira claim de um repo que as
 * rodadas não listam.
 */
export function requireClaimIssue(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  allowedRepos: readonly string[],
): ClaimIssueTarget {
  const repoFlag = requireRepoFlag(values, flags);
  const ref = parseIssueRef(values.issue ?? "", repoFlag);
  if (!ref) throw new Error("--issue deve ser um inteiro ou owner/repo#N");
  if (values.repo !== undefined && ref.repo !== repoFlag) {
    throw new Error(`--issue ${values.issue} e --repo ${values.repo} apontam pra repos diferentes (#10618)`);
  }
  const legacy = legacyIssueNumber(ref);
  if (legacy !== null) return legacy;
  const allowed = new Set(allowedRepos.map((r) => normalizeRepoSlug(r)).filter((r): r is string => r !== null));
  if (!allowed.has(ref.repo)) {
    throw new Error(
      `claim de ${ref.repo}#${ref.number} recusado — ${ref.repo} não está em platform.config.json → issue_repos ` +
        `(permitidos: ${[...allowed].join(", ")}) (#10618).`,
    );
  }
  return ref;
}

/**
 * #12010 — `--issues A,B,owner/repo#C` do `claim-issue` em lote. Cada item
 * passa pela mesma validação de `requireClaimIssue` (repo na allowlist,
 * coerência com `--repo`). `--issue` e `--issues` juntos são erro: um pedido
 * ambíguo nunca vira claim parcial.
 */
export function requireClaimIssueList(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  allowedRepos: readonly string[],
): ClaimIssueTarget[] {
  if (values.issue !== undefined || flags.has("issue")) {
    throw new Error("use --issue N (uma issue) OU --issues A,B,C (lote), nunca os dois (#12010)");
  }
  const parts = (values.issues ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error("--issues deve listar ao menos uma issue (ex: --issues 101,102) (#12010)");
  return parts.map((part) => requireClaimIssue({ ...values, issue: part }, flags, allowedRepos));
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repositório (#6372) — nunca
 * `process.cwd()` nem `git rev-parse --show-toplevel`, os dois candidatos
 * óbvios que devolvem o WORKTREE atual em vez do checkout principal.
 *
 * `data/` é uma junction/symlink OneDrive que só existe no checkout
 * principal — um `git worktree` vinculado (`.claude/worktrees/agent-*`,
 * onde TODO subagente implementador de overnight/develop/continuo roda,
 * `isolation: "worktree"`) não a herda. Antes deste fix, `main()` resolvia
 * `repoRoot` via `process.cwd()`: uma sessão cujo cwd persistisse dentro de
 * um worktree (`cd` num Bash anterior — o cwd persiste entre chamadas
 * Bash, ver docstring do harness) fazia TODO comando deste CLI
 * (`register`, `claim-issue`, `is-claimed`, `merge-lock-acquire`,
 * `list-active`) criar/ler um `data/sessions/` NOVO e VAZIO dentro do
 * worktree, silenciosamente — exit 0 sempre, sem aviso. Isso desarmava, em
 * silêncio, exatamente os 3 mecanismos que existem pra impedir 2 sessões
 * colidirem na mesma issue/merge.
 *
 * `git rev-parse --path-format=absolute --git-common-dir` aponta pro `.git`
 * REAL compartilhado entre o checkout principal e TODO worktree vinculado
 * do mesmo repositório (mesmo mecanismo de `resolveSharedLockPath` em
 * `scripts/lib/git-sync.ts`, #3430 — verificado empiricamente ali: rodar o
 * comando tanto do checkout principal quanto de dentro de
 * `.claude/worktrees/agent-*` devolve o EXATO mesmo path absoluto). Para o
 * checkout principal, `.git` é um diretório real direto na raiz do repo —
 * `dirname()` desse path é a raiz. `--show-toplevel`, ao contrário, devolve
 * o toplevel do PRÓPRIO worktree (o mesmo bug que `resolveSharedLockPath`
 * já descartou por esse motivo) — não usar.
 *
 * Fail-soft, mas não fail-BLIND (#7699): se o comando git falhar (não é
 * repo git, git indisponível, versão de git anterior a 2.31 sem
 * `--path-format`), o pré-#6372 caía direto pro `cwd` cru — correto no caso
 * comum (processo já rodando na raiz do checkout principal), mas catastrófico
 * quando o `cwd` é um diretório qualquer FORA do repo: `sessionsDir(cwd)`
 * grava `{cwd}/data/sessions/…` ali dentro, silenciosamente, sem nenhum sinal
 * de erro. Foi exatamente isso que produziu a árvore recursiva
 * `data/data/data/…` de 20 níveis no `300` (#7699) — `data/` é uma
 * junction/symlink pro OneDrive que **não é um repo git** (`git rev-parse`
 * falha ali de propósito), então um processo cujo `cwd` ficou preso dentro
 * dela (herdado de um `cd` anterior — o cwd persiste entre chamadas Bash do
 * harness) caía no fallback, devolvia o próprio `.../diaria-studio-data`
 * como "repoRoot", e `sessionsDir` criava um `data/` NOVO ali dentro — cada
 * iteração seguinte repete o mesmo erro sobre o diretório recém-criado,
 * empilhando um nível a cada vez.
 *
 * Por isso o fallback agora VALIDA o candidato antes de aceitá-lo, subindo a
 * árvore de diretórios a partir de `cwd` (`looksLikeRepoRoot`, marcador:
 * `package.json` com `"name": "diaria-studio"` — o mesmo `name` que
 * `npm ci`/`npm test` já dependem de existir na raiz correta) até achar a
 * raiz real OU esgotar a árvore. `cwd` legítimo (processo rodando na raiz do
 * checkout principal, só o `git` que falhou) continua resolvendo igual a
 * antes — o marcador bate já na 1ª iteração. Só quando NENHUM ancestral tem
 * o marcador (cenário do #7699: `cwd` genuinamente fora do repo) é que a
 * função agora RECUSA ALTO em vez de devolver um palpite — melhor um comando
 * que falha com erro claro do que um `data/data/…` silencioso.
 *
 * `cwd` (default `process.cwd()`) existe como parâmetro explícito — não só
 * pra deixar `git rev-parse` correr no diretório certo, mas pra tornar a
 * função testável sem precisar mutar o cwd real do processo de teste
 * (`process.chdir` afetaria QUALQUER outro teste rodando no mesmo processo).
 */
const REPO_ROOT_MARKER_PACKAGE_NAME = "diaria-studio";

/** `true` se `dir` parece a raiz deste repo — `package.json` legível com
 * `"name": "diaria-studio"`. Não usa `.git` como marcador porque o cenário
 * que este guard existe pra pegar é justamente "aqui não tem `.git`" (senão
 * o `git rev-parse` do caminho principal já teria resolvido). */
function looksLikeRepoRoot(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
    return pkg.name === REPO_ROOT_MARKER_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Sobe de `cwd` até a raiz do filesystem procurando `looksLikeRepoRoot`.
 * Devolve o 1º ancestral (incluindo o próprio `cwd`) que bater, ou
 * `undefined` se nenhum bater. */
function findRepoRootAncestor(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // chegou na raiz do filesystem
    dir = parent;
  }
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  try {
    const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true, // #13559
    });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return dirname(res.stdout.trim());
    }
  } catch {
    // git indisponível/timeout — cai pro fallback validado abaixo.
  }
  const ancestor = findRepoRootAncestor(cwd);
  if (ancestor) return ancestor;
  throw new Error(
    `resolveRepoRoot: "git rev-parse" falhou e nenhum ancestral de "${cwd}" parece a raiz do repo ` +
      `(procurado: package.json com "name": "${REPO_ROOT_MARKER_PACKAGE_NAME}"). Recusando devolver "${cwd}" ` +
      "às cegas — é exatamente esse fallback cego que produziu a árvore data/data/data/… do #7699 quando " +
      "o cwd ficou preso dentro da pasta OneDrive sincronizada (que não é um repo git). Rode este comando " +
      "com o cwd dentro do checkout do repo, ou garanta que o git esteja disponível.",
  );
}
