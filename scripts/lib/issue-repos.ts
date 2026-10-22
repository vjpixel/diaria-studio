/**
 * Identidade de issue multi-repo (#10618).
 *
 * Decisão do editor (20/10/2026, registrada na própria #10618): a identidade
 * de uma issue é `owner/repo#N` — plan.json, claims, marcadores, relatórios.
 * Isso é o ESTADO-ALVO: a 1ª fatia (PR #10668) entregou o modelo, o merge
 * lock e o guard por repo e o escopo dos hooks; a 2ª fatia, os claims do
 * `session-registry` (`claimed_foreign_issues`), o fetch de triagem
 * (`issue-triage-fetch.ts`), os gates que leem `plan.json`
 * (`plan-issue-ref.ts`) e o `route-issue.ts --issue owner/repo#N`. A fila de
 * triagem multi-repo era opt-in na fatia 2; desde a fatia 4 as rodadas
 * (overnight, contínuo, develop) chamam `fetch-open-issues-for-triage.ts
 * --repos all` por padrão — o diaria-design entra na fila sem flag extra —
 * e os gates de fim de rodada avaliam cada repo à parte. O número
 * sozinho colide entre repos (o #21 existe tanto no `vjpixel/diaria-studio`
 * quanto no `vjpixel/diaria-design`).
 *
 * **Compatibilidade com dado legado (invariante deste módulo):** todo número
 * "pelado" já gravado (`claimed_issues: [123]`, `--issue 123`, `#123` num
 * plan.json antigo) continua significando `vjpixel/diaria-studio#123` — é o
 * que ele sempre significou. `parseIssueRef(123)` devolve exatamente isso, e
 * `legacyIssueNumber` faz o caminho inverso: só devolve um número quando a
 * ref é do repo default, porque é o único caso em que um consumidor legado
 * (que só entende número) interpreta certo.
 *
 * **Lista de repos num lugar só:** `platform.config.json → issue_repos`. O 1º
 * item é o repo default (o `diaria-studio`, onde as rodadas rodam). Nenhum
 * script deve hardcodar a lista — use `readIssueRepos`/`loadIssueRepos`
 * (lida pelos hooks via `loadAllowedForeignRepos` e, desde a fatia 2, pelo
 * `session-registry` CLI de claim, pelo fetch de triagem e pelo
 * `route-issue.ts`).
 *
 * Os hooks (`.claude/hooks/*.mjs`) são self-contained e não importam `.ts`
 * (ver docblock de `pr-create-review.mjs`); a parte deles — descobrir de qual
 * repo é o PR de um `gh pr create`/`gh pr merge` — vive em
 * `.claude/hooks/lib/gh-target-repo.mjs`. As duas cópias da constante do repo
 * default, de `normalizeRepoSlug` e do nome do arquivo de lock são travadas
 * por paridade em `test/issue-repos-10618.test.ts`. Duas ressalvas do lado dos
 * hooks: o repo de um `gh pr` sem `-R`/URL vem do `origin` do cwd, o que é
 * HEURÍSTICA (o `gh` também respeita `gh repo set-default` e `upstream`); e o
 * `resolveMainRepoRoot` dos hooks de merge só acha o registro de sessões a
 * partir do cwd ou do checkout de onde o hook foi carregado — fora disso
 * devolve `null` e o guard bloqueia na dúvida. Paridade em
 * `test/issue-repos-10618.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raiz do checkout que contém este módulo — onde mora o `platform.config.json`
 * com `issue_repos` (#10901). Os gates de PR que autorizam merge
 * (`check-pr-checks-gate.ts`, `check-pr-retido-gate.ts`,
 * `check-pr-review-authenticity.ts`) resolvem a allowlist por aqui, não pelo
 * cwd: rodados de um subdiretório, de um worktree sem o config ou do checkout
 * do diaria-design, o cwd recusava `--repo vjpixel/diaria-design` como "fora
 * da allowlist". Mesma regra de `SAFE_EDIT_CONFIG_ROOT` (`gh-pr-safe-edit.ts`).
 */
export const ISSUE_REPOS_CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Repo onde as rodadas rodam e cujo número "pelado" é o significado legado. */
export const DEFAULT_ISSUE_REPO = "vjpixel/diaria-studio";

export interface IssueRef {
  /** `owner/name`, sempre em minúsculas (GitHub trata owner/repo sem caixa). */
  repo: string;
  number: number;
}

const REPO_SLUG_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/**
 * Normaliza `OWNER/REPO` (aceita também `github.com/OWNER/REPO`, com
 * `https://` e sufixo `.git`; outro host não). Owner com `--` interno é
 * recusado. `null` quando não é um slug reconhecível — nunca adivinha.
 */
export function normalizeRepoSlug(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^(?:www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = REPO_SLUG_RE.exec(s);
  if (!m || m[1].includes("--")) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/** `true` quando `repo` é o repo default (o significado de um número pelado). */
export function isDefaultIssueRepo(repo: string | null | undefined): boolean {
  return normalizeRepoSlug(repo ?? "") === DEFAULT_ISSUE_REPO;
}

/**
 * Lê uma identidade de issue. Formas aceitas:
 *   - `123` (number) / `"123"` / `"#123"` → repo default (legado);
 *   - `"owner/repo#123"`;
 *   - `"https://github.com/owner/repo/issues/123"` (também `/pull/123`).
 *
 * `defaultRepo` só vale pras formas sem repo. `null` em qualquer entrada que
 * não seja inequívoca (número não-inteiro, ≤0, slug inválido) — o caller
 * decide como falhar; este parser nunca chuta.
 */
export function parseIssueRef(
  input: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): IssueRef | null {
  const fallbackRepo = normalizeRepoSlug(defaultRepo);
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input <= 0 || !fallbackRepo) return null;
    return { repo: fallbackRepo, number: input };
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s === "") return null;

  const bare = /^#?(\d+)$/.exec(s);
  if (bare) return parseIssueRef(Number(bare[1]), defaultRepo);

  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (url) {
    const repo = normalizeRepoSlug(url[1]);
    const n = Number(url[2]);
    return repo && Number.isSafeInteger(n) && n > 0 ? { repo, number: n } : null;
  }

  const qualified = /^([^#\s]+)#(\d+)$/.exec(s);
  if (qualified) {
    const repo = normalizeRepoSlug(qualified[1]);
    const n = Number(qualified[2]);
    return repo && Number.isSafeInteger(n) && n > 0 ? { repo, number: n } : null;
  }
  return null;
}

/** Forma canônica: `owner/repo#N`, sempre qualificada (decisão do editor). */
export function formatIssueRef(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Atalho: parse + format. `null` quando a entrada não é uma identidade válida. */
export function canonicalIssueKey(
  input: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): string | null {
  const ref = parseIssueRef(input, defaultRepo);
  return ref ? formatIssueRef(ref) : null;
}

/** `true` quando as duas entradas apontam pra MESMA issue (mesmo repo e número). */
export function sameIssue(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): boolean {
  const ka = canonicalIssueKey(a, defaultRepo);
  return ka !== null && ka === canonicalIssueKey(b, defaultRepo);
}

/**
 * Caminho inverso do legado: o número a gravar num campo que só entende
 * número (`claimed_issues: number[]`, `--issue N`) — e só quando a ref é do
 * repo default. Ref de outro repo devolve `null`: gravar o número dela num
 * campo legado faria `#21` do diaria-design virar `#21` do diaria-studio.
 */
export function legacyIssueNumber(ref: IssueRef): number | null {
  return isDefaultIssueRepo(ref.repo) ? ref.number : null;
}

/**
 * Nome do arquivo do merge lock POR REPO (decisão do editor: a linearidade do
 * squash só importa dentro de um mesmo repo, então dois repos nunca se
 * serializam). O repo default mantém o nome histórico `.merge-lock.json` —
 * sessões já rodando, hooks e o painel continuam lendo o mesmo arquivo. Os
 * outros ganham sufixo; o ponto inicial mantém o arquivo fora das varreduras
 * de registro (cada varredura filtra `startsWith(".")` explicitamente).
 *
 * Espelhado em `.claude/hooks/lib/gh-target-repo.mjs` (`mergeLockFileName`),
 * paridade travada por teste.
 */
export function mergeLockFileName(repo: string | null | undefined = DEFAULT_ISSUE_REPO): string {
  const slug = normalizeRepoSlug(repo ?? "") ?? DEFAULT_ISSUE_REPO;
  if (slug === DEFAULT_ISSUE_REPO) return ".merge-lock.json";
  return `.merge-lock--${slug.replace("/", "--")}.json`;
}

/**
 * Lista de repos cujas issues as rodadas listam/agem (`platform.config.json →
 * issue_repos`). Sempre começa pelo repo default, mesmo que o config o omita
 * ou o coloque em outra posição; duplicatas e slugs inválidos são descartados.
 * Config ausente/ilegível → só o default (comportamento pré-#10618).
 *
 * `onInvalid` (#10618, fatia 2) é chamado pra cada item descartado por não
 * ser slug reconhecível e quando `issue_repos` existe mas não é array — quem
 * lê o config de verdade (`loadIssueRepos`) avisa no stderr em vez de
 * encolher a allowlist em silêncio.
 */
export function readIssueRepos(
  config?: { issue_repos?: unknown } | null,
  onInvalid?: (detail: string) => void,
): string[] {
  const out = [DEFAULT_ISSUE_REPO];
  const raw = config?.issue_repos;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const slug = typeof item === "string" ? normalizeRepoSlug(item) : null;
      if (!slug) {
        onInvalid?.(`item ilegível em issue_repos: ${JSON.stringify(item)}`);
        continue;
      }
      if (!out.includes(slug)) out.push(slug);
    }
  } else if (raw !== undefined) {
    onInvalid?.(`issue_repos não é um array (${JSON.stringify(raw)})`);
  }
  return out;
}

/** Aviso padrão de `loadIssueRepos` — stderr, prefixado. */
function warnIssueRepos(detail: string): void {
  console.error(`[issue-repos] AVISO (#10618): ${detail} — usando só o que foi legível (o repo default sempre entra).`);
}

/**
 * `readIssueRepos` lendo `platform.config.json` de `repoRoot`. Fail-soft: cai
 * em só o repo default, mas AVISA (`warn`, default stderr) quando o config
 * existe e está ilegível ou tem slug inválido (#10618, fatia 2) — a allowlist
 * encolhida em silêncio faria uma claim/route de outro repo ser recusada sem
 * pista da causa. Arquivo AUSENTE não avisa: é o clone sem config (testes,
 * sessão cloud), e o resultado — só o default — é o comportamento de sempre.
 */
export function loadIssueRepos(repoRoot: string, warn: (detail: string) => void = warnIssueRepos): string[] {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, "platform.config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`platform.config.json ilegível em ${repoRoot}: ${(e as Error).message}`);
    }
    return readIssueRepos(null);
  }
  let config: { issue_repos?: unknown };
  try {
    config = JSON.parse(text) as { issue_repos?: unknown };
  } catch (e) {
    warn(`platform.config.json com JSON inválido em ${repoRoot}: ${(e as Error).message}`);
    return readIssueRepos(null);
  }
  return readIssueRepos(config, warn);
}

/**
 * `--repo owner/name` dos gates de PR que autorizam merge (#10618, fatia 4):
 * o PR de uma issue do diaria-design mora no diaria-design, e um gate que
 * consultasse `gh pr view N` sem `-R` daria o veredito do PR #N do studio.
 * Ausente → `undefined` (o diaria-studio, chamada de sempre). Presente sem
 * valor, ilegível ou fora da allowlist `issue_repos` → `{ error }` (o gate
 * sai com erro de uso, nunca cai no default em silêncio). O repo default
 * explícito também devolve `undefined`.
 */
export function resolveRepoFlag(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  repoRoot: string,
): { repo: string | undefined } | { error: string } {
  if (flags.has("repo") || values.repo === "") return { error: "--repo sem valor (esperado owner/name)" };
  if (values.repo === undefined) return { repo: undefined };
  const slug = normalizeRepoSlug(values.repo);
  if (!slug) return { error: `--repo inválido: "${values.repo}" (esperado owner/name)` };
  if (slug === DEFAULT_ISSUE_REPO) return { repo: undefined };
  if (!loadIssueRepos(repoRoot).includes(slug)) {
    return { error: `--repo ${slug} está fora de platform.config.json → issue_repos` };
  }
  return { repo: slug };
}

/**
 * Repo do PR dos gates de merge (#10618, fatia 4, review J): `--repo` como em
 * `resolveRepoFlag`, mais `--issue {ref}` opcional — a identidade da issue
 * que o PR fecha (`N` ou `owner/repo#N`). Com `--issue`, o repo do PR é
 * DERIVADO dela (o PR mora no repo da issue, decisão da #10618), de modo que
 * o coordenador que passa a ref da issue não consegue esquecer o `--repo` e
 * ler o PR #N do studio. `--repo` e `--issue` juntos têm de concordar;
 * divergência, `--issue` ilegível ou repo fora da allowlist → `{ error }`.
 */
export function resolvePrTargetRepo(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  repoRoot: string,
): { repo: string | undefined } | { error: string } {
  const fromRepo = resolveRepoFlag(values, flags, repoRoot);
  if ("error" in fromRepo) return fromRepo;
  if (flags.has("issue") || values.issue === "") return { error: "--issue sem valor (esperado N ou owner/repo#N)" };
  if (values.issue === undefined) return fromRepo;
  const ref = parseIssueRef(values.issue);
  if (!ref) return { error: `--issue inválido: "${values.issue}" (esperado N ou owner/repo#N)` };
  const issueRepo = isDefaultIssueRepo(ref.repo) ? undefined : ref.repo;
  if (issueRepo && !loadIssueRepos(repoRoot).includes(issueRepo)) {
    return { error: `--issue ${formatIssueRef(ref)}: repo fora de platform.config.json → issue_repos` };
  }
  if (values.repo !== undefined && fromRepo.repo !== issueRepo) {
    return {
      error: `--repo ${fromRepo.repo ?? DEFAULT_ISSUE_REPO} diverge do repo da --issue ${formatIssueRef(ref)} (o PR mora no repo da issue)`,
    };
  }
  return { repo: issueRepo };
}

/** Rótulo de PR pra mensagem: `PR #N` no studio, `owner/repo PR #N` nos outros. */
export function prLabelInRepo(prNumber: number, repo: string | undefined): string {
  return repo ? `${repo} PR #${prNumber}` : `PR #${prNumber}`;
}
