/**
 * test/publish-edition-site-page-8684-fetch-before-worktree.test.ts
 *
 * REGRESSÃO (#8684, 21/09/2026): edição 260922, Stage 6 —
 * `publish-edition-site-page.ts` saiu com `exit 3` porque o CÓDIGO no disco
 * do checkout compartilhado ainda não tinha puxado o commit do #8636 (worktree
 * default) — a sessão de Stage 5/6 (#6171, sempre NOVA) nunca roda
 * `sync-code.ts`. Esse gap é de SESSÃO (coberto por
 * `.claude/skills/diaria-5-publicacao/SKILL.md`, Passo -3 novo, não
 * testável aqui) — mas o diagnóstico revelou um 2º gap, de CÓDIGO, que este
 * arquivo cobre: mesmo com o worktree default (#8636) já rodando, `git
 * worktree add --detach <tmp> origin/master` nasce do ref LOCAL de
 * `origin/master` — que `git worktree add` NUNCA atualiza sozinho. Sem um
 * `git fetch origin master` fresco na MESMA chamada, o worktree pode nascer
 * de um `origin/master` desatualizado (uma sessão longa, entre o sync
 * inicial e este passo, perde qualquer commit mergeado nesse meio-tempo por
 * outras sessões overnight/develop/continuo concorrentes) mesmo já rodando
 * a versão corrigida do script.
 *
 * Cobre 2 cenários:
 * 1. Ref local de `origin/master` está STALE (outra "sessão" avançou o
 *    remoto sem que `rootDir` desse fetch) — com a correção, o worktree
 *    nasce do `origin/master` FRESCO (via o `git fetch origin master`
 *    interno), não do ref cacheado.
 * 2. Falha do `git fetch` (rede indisponível) é fail-soft — a publicação
 *    ainda acontece, só que a partir do ref cacheado (mesmo comportamento
 *    de antes do #8684, nunca pior).
 *
 * Usa git real (mesma disciplina de
 * `test/publish-edition-site-page-8636-worktree-real-git.test.ts` — um
 * `GitRunner` mockado não exercitaria `git fetch`/`git worktree add` de
 * verdade, e foi exatamente esse tipo de gap que deixou passar a regressão
 * original do #8636).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushSitePage, writeSitePageState } from "../scripts/publish-edition-site-page.ts";
import type { GitRunner, GhRunner, LockRunner, SleepFn } from "../scripts/publish-edition-site-page.ts";

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function makeGh(): GhRunner {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") return "[]\n";
    if (args[0] === "pr" && args[1] === "create") {
      return "https://github.com/vjpixel/diaria-studio/pull/1\n";
    }
    return "";
  };
}

const noopLock: LockRunner = () => ({ ok: true, stdout: "ok\n", stderr: "" });
const noopSleep: SleepFn = () => {};

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * Monta `rootDir` (checkout de trabalho) + `originBare` (remoto real, sem
 * rede) — mesmo miolo de `setupRealRepo()` em
 * `test/publish-edition-site-page-8636-worktree-real-git.test.ts`, mas
 * devolve `originBare` pra o cenário 1 poder simular uma 2ª sessão
 * avançando o remoto SEM que `rootDir` refetche.
 */
function setupRealRepo(): { rootDir: string; originBare: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "diaria-8684-root-"));
  const originBare = mkdtempSync(join(tmpdir(), "diaria-8684-origin-"));
  cleanupDirs.push(rootDir, originBare);

  realGit(["init", "-b", "master"], rootDir);
  realGit(["config", "user.email", "test@example.com"], rootDir);
  realGit(["config", "user.name", "Test"], rootDir);

  mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
  writeFileSync(join(rootDir, "workers", "site", "public", "sitemap.xml"), "OLD_SITEMAP\n", "utf8");
  writeFileSync(join(rootDir, "workers", "site", "public", "index.html"), "OLD_HOME\n", "utf8");
  realGit(["add", "-A"], rootDir);
  realGit(["commit", "-m", "init"], rootDir);

  rmSync(originBare, { recursive: true, force: true });
  realGit(["clone", "--bare", rootDir, originBare], rootDir);
  realGit(["remote", "add", "origin", originBare], rootDir);
  realGit(["fetch", "origin"], rootDir);
  realGit(["branch", "--set-upstream-to=origin/master", "master"], rootDir);

  return { rootDir, originBare };
}

describe("#8684 — commitAndPushSitePage refetcha origin/master antes de criar o worktree", () => {
  it("worktree nasce do origin/master FRESCO, não do ref local desatualizado", () => {
    const { rootDir, originBare } = setupRealRepo();

    // Simula uma 2ª sessão (overnight/develop concorrente) avançando
    // `master` no remoto DEPOIS do fetch inicial de `rootDir` — sem que
    // `rootDir` refetche antes de publicar a página. Clone independente,
    // nunca toca `rootDir` diretamente.
    const otherSessionClone = mkdtempSync(join(tmpdir(), "diaria-8684-other-session-"));
    cleanupDirs.push(otherSessionClone);
    realGit(["clone", originBare, otherSessionClone], process.cwd());
    realGit(["config", "user.email", "other@example.com"], otherSessionClone);
    realGit(["config", "user.name", "Other Session"], otherSessionClone);
    writeFileSync(join(otherSessionClone, "marker-b.txt"), "COMMIT_B\n", "utf8");
    realGit(["add", "-A"], otherSessionClone);
    realGit(["commit", "-m", "commit B: outra sessão avançou master"], otherSessionClone);
    realGit(["push", "origin", "master"], otherSessionClone);

    // Confirma a premissa do teste: o ref LOCAL de origin/master em
    // `rootDir` continua no commit A (sem marker-b.txt) — `rootDir` nunca
    // deu fetch depois do push acima.
    const staleOriginMaster = realGit(["rev-parse", "origin/master"], rootDir).trim();
    const realOriginBareHead = realGit(["rev-parse", "master"], otherSessionClone).trim();
    assert.notEqual(
      staleOriginMaster,
      realOriginBareHead,
      "premissa do teste: o ref local de origin/master em rootDir precisa estar desatualizado",
    );

    const worktreeDir = mkdtempSync(join(tmpdir(), "diaria-8684-wt-"));
    cleanupDirs.push(worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });

    const slug = "pagina-fetch-fresco-8684";
    const pageDir = join(rootDir, "workers", "site", "public", "p", slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "NEW_PAGE_CONTENT\n", "utf8");

    const result = commitAndPushSitePage(
      rootDir,
      slug,
      realGit,
      undefined,
      makeGh(),
      noopLock,
      noopSleep,
      worktreeDir,
    );

    assert.equal(result.committed, true, "commit deveria ter acontecido");
    assert.equal(result.pushed, true, "push deveria ter confirmado");

    // A prova do fix: a branch de publicação, criada a partir do worktree,
    // precisa conter `marker-b.txt` — só presente se o worktree nasceu do
    // origin/master FRESCO (pós-fetch interno), não do ref stale que
    // `rootDir` tinha cacheado antes desta chamada.
    const branchName = `site-publish/${slug}`;
    realGit(["fetch", "origin"], rootDir);
    const markerContent = realGit(["show", `origin/${branchName}:marker-b.txt`], rootDir);
    assert.equal(
      markerContent,
      "COMMIT_B\n",
      "worktree deveria ter nascido do origin/master FRESCO (com o commit da 'outra sessão'), " +
        "não do ref local desatualizado — commitAndPushSitePage precisa refetchar antes do worktree add (#8684)",
    );

    // O ref local de origin/master em rootDir também deveria ter avançado
    // (efeito colateral esperado do fetch interno).
    const originMasterAfter = realGit(["rev-parse", "origin/master"], rootDir).trim();
    assert.equal(
      originMasterAfter,
      realOriginBareHead,
      "o fetch interno deveria ter atualizado o ref local de origin/master em rootDir",
    );
  });

  it("falha do 'git fetch' é fail-soft — publica mesmo assim, a partir do ref cacheado", () => {
    const { rootDir } = setupRealRepo();
    const worktreeDir = mkdtempSync(join(tmpdir(), "diaria-8684-wt-failsoft-"));
    cleanupDirs.push(worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });

    const slug = "pagina-fetch-falhou-8684";
    const pageDir = join(rootDir, "workers", "site", "public", "p", slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "PAGE_DESPITE_FETCH_FAILURE\n", "utf8");

    // GitRunner que lança especificamente em `git fetch` (simula rede
    // indisponível) e delega todo o resto pro git real — prova que uma
    // falha de fetch não impede a publicação de acontecer (fail-soft),
    // só deixa de refrescar o ref local antes do worktree add.
    let fetchAttempted = false;
    const flakyFetchGit: GitRunner = (args, cwd) => {
      if (args[0] === "fetch") {
        fetchAttempted = true;
        throw new Error("simulated network failure");
      }
      return realGit(args, cwd);
    };

    const result = commitAndPushSitePage(
      rootDir,
      slug,
      flakyFetchGit,
      undefined,
      makeGh(),
      noopLock,
      noopSleep,
      worktreeDir,
    );

    assert.equal(fetchAttempted, true, "o fetch deveria ter sido tentado");
    assert.equal(result.committed, true, "commit deveria ter acontecido mesmo com fetch falhando");
    assert.equal(result.pushed, true, "push deveria ter confirmado mesmo com fetch falhando");
    // #8689: a falha deixa sinal estruturado, não só stderr.
    assert.equal(result.fetchStale, true, "fetchStale deve sinalizar o worktree possivelmente desatualizado");

    const branchName = `site-publish/${slug}`;
    realGit(["fetch", "origin"], rootDir);
    const pageContent = realGit(["show", `origin/${branchName}:workers/site/public/p/${slug}/index.html`], rootDir);
    assert.equal(pageContent, "PAGE_DESPITE_FETCH_FAILURE\n");
  });
});

describe("#8689 — fetchStale persiste em _internal/site-page-published.json", () => {
  it("writeSitePageState grava fetchStale quando o resultado o traz, e omite quando não", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-8689-state-"));
    cleanupDirs.push(dir);
    writeSitePageState(dir, { code: 0, slug: "s", bytes: 1, published: true, fetchStale: true });
    const state = JSON.parse(readFileSync(join(dir, "_internal", "site-page-published.json"), "utf8"));
    assert.equal(state.fetchStale, true);
    writeSitePageState(dir, { code: 0, slug: "s", bytes: 1, published: true });
    const state2 = JSON.parse(readFileSync(join(dir, "_internal", "site-page-published.json"), "utf8"));
    assert.equal(state2.fetchStale, undefined);
  });
});
