/**
 * test/publish-edition-site-page-8636-worktree-real-git.test.ts
 *
 * REGRESSÃO P0 (#8636, reaberta 21/09/2026): todos os testes existentes de
 * `commitAndPushSitePage` (`test/publish-edition-site-page-6202.test.ts`)
 * usam um `GitRunner` MOCKADO — nenhum toca um repositório git de verdade.
 * Foi exatamente esse gap que deixou passar a regressão: o caminho default
 * de `main()` (sem `--skip-publish`/`--worktree-dir`) sempre cria um
 * worktree temporário via `git worktree add --detach <tmp> origin/master`,
 * mas a suposição original — "o worktree é um clone completo de
 * origin/master, então a página já está lá" — é falsa para conteúdo
 * recém-escrito e nunca commitado: `git worktree add` reflete só o que já
 * está COMMITADO no ref, nunca arquivos untracked de outro working tree.
 *
 * Este arquivo roda `git`/`git worktree` REAIS (subprocessos de verdade,
 * `execFileSync`) contra um repositório temporário — sem isso, o gap que
 * causou o bug original nunca teria sido pego (era exatamente a lacuna
 * apontada no fleet review pré-merge do #8664 e na reabertura do #8636).
 * `gh`/lock continuam mockados (não dependem de rede/GitHub real, e não são
 * o que está sob teste aqui).
 *
 * Cobre dois sintomas do MESMO bug:
 *
 * 1. **Crash**: a página nova (`relPageDir`, um slug nunca commitado em
 *    `origin/master`) — staged incondicionalmente — fazia `git add` lançar
 *    `pathspec ... did not match any files` dentro do worktree, antes da
 *    correção.
 * 2. **Silêncio (pior)**: `sitemap.xml`/`index.html` (`optionalPaths`) JÁ
 *    existem em `origin/master` (arquivos rastreados) — sem a correção, o
 *    `git add` não lançava, mas staged o conteúdo VELHO herdado do ref, não
 *    o conteúdo novo que `updateSitemapAndHome` tinha acabado de escrever em
 *    `rootDir`. Sem este teste, essa 2ª forma do bug passaria despercebida
 *    mesmo depois de "corrigir" só o sintoma 1 (o crash).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushSitePage, homePageRelPathFromSitemap } from "../scripts/publish-edition-site-page.ts";
import type { GhRunner, LockRunner, SleepFn } from "../scripts/publish-edition-site-page.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

/** `gh` mockado — não depende de rede/GitHub real; não é o que está sob teste. */
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
 * Monta: `rootDir` (checkout de trabalho, com `origin` apontando pra um
 * bare local `originBare`) — `origin/master` resolve de verdade, satisfazendo
 * o que `git worktree add --detach <tmp> origin/master` precisa.
 */
function setupRealRepo(): { rootDir: string; originBare: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "diaria-8636-root-"));
  const originBare = mkdtempSync(join(tmpdir(), "diaria-8636-origin-"));
  cleanupDirs.push(rootDir, originBare);

  git(["init", "-b", "master"], rootDir);
  git(["config", "user.email", "test@example.com"], rootDir);
  git(["config", "user.name", "Test"], rootDir);

  // Conteúdo inicial: sitemap.xml e index.html JÁ rastreados com conteúdo
  // "velho" — simula o estado de `origin/master` antes desta chamada.
  mkdirSync(join(rootDir, "workers", "site", "public"), { recursive: true });
  writeFileSync(join(rootDir, "workers", "site", "public", "sitemap.xml"), "OLD_SITEMAP\n", "utf8");
  writeFileSync(join(rootDir, "workers", "site", "public", "index.html"), "OLD_HOME\n", "utf8");
  git(["add", "-A"], rootDir);
  git(["commit", "-m", "init"], rootDir);

  // origin = bare clone do rootDir. `fetch` popula refs/remotes/origin/master
  // localmente, sem precisar de rede.
  rmSync(originBare, { recursive: true, force: true });
  git(["clone", "--bare", rootDir, originBare], rootDir);
  git(["remote", "add", "origin", originBare], rootDir);
  git(["fetch", "origin"], rootDir);
  git(["branch", "--set-upstream-to=origin/master", "master"], rootDir);

  return { rootDir, originBare };
}

describe("#8636 (regressão P0, 21/09/2026) — worktree default enxerga conteúdo recém-escrito, com git real", () => {
  it("página GENUINAMENTE NOVA (nunca commitada) é commitada e pushada através do worktree default", () => {
    const { rootDir } = setupRealRepo();
    const worktreeDir = mkdtempSync(join(tmpdir(), "diaria-8636-wt-"));
    cleanupDirs.push(worktreeDir);
    // `commitAndPushSitePage` remove o worktree no `finally` — mas garantir
    // que ele exista como path válido pro `git worktree add` (o diretório
    // temp precisa existir vazio, git recusa criar worktree num path que já
    // tem conteúdo não-git).
    rmSync(worktreeDir, { recursive: true, force: true });

    const slug = "pagina-nunca-commitada-8636";

    // Simula exatamente o que `writePage()` faz: escreve DIRETO em `rootDir`,
    // slug que nunca existiu em nenhum commit de `origin/master`.
    const pageDir = join(rootDir, "workers", "site", "public", "p", slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "NEW_PAGE_CONTENT\n", "utf8");

    // Simula `updateSitemapAndHome()`: sobrescreve os arquivos JÁ rastreados
    // com conteúdo NOVO, sem commitar — exatamente o estado em que
    // `commitAndPushSitePage` encontra `rootDir` quando `main()` chama.
    const sitemapRelPath = "workers/site/public/sitemap.xml";
    writeFileSync(join(rootDir, sitemapRelPath), "NEW_SITEMAP\n", "utf8");
    writeFileSync(
      join(rootDir, homePageRelPathFromSitemap(sitemapRelPath)),
      "NEW_HOME\n",
      "utf8",
    );

    const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir).trim();

    // ESTA É A CHAMADA SOB TESTE: git real, worktreeDir definido — exatamente
    // o caminho default de `main()` sem `--skip-publish`/`--worktree-dir`.
    const result = commitAndPushSitePage(
      rootDir,
      slug,
      git,
      sitemapRelPath,
      makeGh(),
      noopLock,
      noopSleep,
      worktreeDir,
    );

    // 1. O commit/push REALMENTE ACONTECEU (antes da correção, `git add` do
    //    slug novo lançava `pathspec did not match any files` dentro do
    //    worktree, e esta chamada teria lançado em vez de retornar).
    assert.equal(result.committed, true, "commit deveria ter acontecido");
    assert.equal(result.pushed, true, "push deveria ter confirmado");

    // 2. O commit chegou no repo remoto (`originBare`) — não só ficou preso
    //    localmente no worktree descartado. `git branch -r` só funciona num
    //    checkout com remote configurado — usamos `rootDir` (que tem
    //    `origin` apontando pro bare) depois de um fetch fresco pra
    //    confirmar que o bare recebeu o push.
    const branchName = `site-publish/${slug}`;
    git(["fetch", "origin"], rootDir);
    const refsAfterFetch = git(["branch", "-r"], rootDir);
    assert.ok(
      refsAfterFetch.includes(`origin/${branchName}`),
      `branch ${branchName} deveria existir no remoto após o push. branches: ${refsAfterFetch}`,
    );

    // 3. O CONTEÚDO commitado na branch remota é o que foi escrito nesta
    //    chamada (NEW_*), não o herdado de origin/master (OLD_*) — prova o
    //    sintoma "silencioso" do bug (sitemap/home stale) além do crash.
    const pageContent = git(
      ["show", `origin/${branchName}:workers/site/public/p/${slug}/index.html`],
      rootDir,
    );
    assert.equal(pageContent, "NEW_PAGE_CONTENT\n", "página commitada deve ter o conteúdo novo");

    const sitemapContent = git(["show", `origin/${branchName}:${sitemapRelPath}`], rootDir);
    assert.equal(
      sitemapContent,
      "NEW_SITEMAP\n",
      "sitemap.xml commitado deve ter o conteúdo NOVO, não o herdado de origin/master",
    );

    const homeContent = git(
      ["show", `origin/${branchName}:${homePageRelPathFromSitemap(sitemapRelPath)}`],
      rootDir,
    );
    assert.equal(
      homeContent,
      "NEW_HOME\n",
      "index.html (home) commitado deve ter o conteúdo NOVO, não o herdado de origin/master",
    );

    // 4. O checkout compartilhado (`rootDir`) nunca foi tocado — segue no
    //    branch original, sem checkout algum feito nele pelo caminho do
    //    worktree.
    const branchAfter = git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir).trim();
    assert.equal(branchAfter, originalBranch, "rootDir deve permanecer no branch original");

    // 5. O worktree temporário foi descartado (fail-soft cleanup do `finally`).
    assert.equal(existsSync(worktreeDir), false, "worktree temporário deveria ter sido removido");
  });

  it("sem worktreeDir (caminho legado), o mesmo cenário segue funcionando no checkout compartilhado", () => {
    // Guarda contra regressão inversa: a correção do #8636 não pode ter
    // quebrado o caminho legado (sem --worktree-dir), que nunca teve o bug —
    // escreve e commita direto em rootDir, sem cópia nenhuma.
    const { rootDir } = setupRealRepo();
    const slug = "pagina-legado-8636";

    const pageDir = join(rootDir, "workers", "site", "public", "p", slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "LEGACY_PAGE\n", "utf8");

    const result = commitAndPushSitePage(rootDir, slug, git, undefined, makeGh(), noopLock, noopSleep, undefined);

    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);

    const branchName = `site-publish/${slug}`;
    const content = git(["show", `${branchName}:workers/site/public/p/${slug}/index.html`], rootDir);
    assert.equal(content, "LEGACY_PAGE\n");
  });

  it("REGRESSÃO 2 (achado no fleet review pré-merge, 21/09/2026): arquivo PODADO de um path-diretório em pathsToStage não sobrevive no commit final via worktree", () => {
    // `cpSync(src, dest, { recursive: true })` sozinho é ADITIVO — copia o
    // que existe/mudou em `src`, mas nunca remove de `dest` um arquivo que
    // deixou de existir em `src`. Pra um path de ARQUIVO único (sitemap.xml,
    // index.html — sempre reescritos do zero) isso é inofensivo. Mas
    // `relPageDir` (`workers/site/public/p/{slug}`) É um diretório — e uma
    // republicação do MESMO slug que remove um arquivo dentro dele (ex:
    // pruning de um asset stale da página, mesmo mecanismo que
    // `gen-archive-index.ts` faz pro acervo em #8645/#8664, ainda não
    // mergeado) reproduz exatamente o cenário do achado: o worktree nasce
    // com o diretório ainda IGUAL ao HEAD de `origin/master` (2 arquivos), o
    // `rootDir` tem o arquivo removido, e sem a correção (rmSync do dest
    // antes do cpSync pra paths que são diretório) o `git add` nunca veria a
    // remoção — o arquivo podado sobreviveria intacto no commit final.
    const { rootDir } = setupRealRepo();
    const slug = "pagina-existente-com-poda-8636";
    const relPageDir = `workers/site/public/p/${slug}`;

    // 1ª publicação (commitada em origin/master): a página nasce com 2
    // arquivos — o index.html de sempre + um asset extra dentro do mesmo
    // diretório (ex: uma variante de página/imagem inline referenciada).
    const pageDir = join(rootDir, "workers", "site", "public", "p", slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), "OLD_PAGE_CONTENT\n", "utf8");
    writeFileSync(join(pageDir, "stale-asset.html"), "STALE_ASSET_TO_BE_PRUNED\n", "utf8");
    git(["add", "-A"], rootDir);
    git(["commit", "-m", "publica pagina com asset que sera podado depois"], rootDir);
    git(["push", "origin", "master"], rootDir);

    // 2ª publicação (o cenário sob teste): `writePage`/o backfill reescrevem
    // index.html com conteúdo novo e REMOVEM `stale-asset.html` de `rootDir`
    // — simula a poda de um arquivo órfão dentro do path-diretório staged.
    // O worktree que `commitAndPushSitePage` vai criar nasce de
    // `origin/master`, que AINDA tem os 2 arquivos da 1ª publicação — é
    // exatamente a divergência rootDir(podado) vs. worktree(herdado) que
    // causa o bug sem a correção.
    writeFileSync(join(pageDir, "index.html"), "NEW_PAGE_CONTENT\n", "utf8");
    rmSync(join(pageDir, "stale-asset.html"));

    const worktreeDir = mkdtempSync(join(tmpdir(), "diaria-8636-wt-prune-"));
    cleanupDirs.push(worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });

    const result = commitAndPushSitePage(rootDir, slug, git, undefined, makeGh(), noopLock, noopSleep, worktreeDir);

    assert.equal(result.committed, true, "commit deveria ter acontecido (conteúdo novo do index.html)");
    assert.equal(result.pushed, true, "push deveria ter confirmado");

    const branchName = `site-publish/${slug}`;
    git(["fetch", "origin"], rootDir);

    // O conteúdo novo do index.html chegou.
    const pageContent = git(["show", `origin/${branchName}:${relPageDir}/index.html`], rootDir);
    assert.equal(pageContent, "NEW_PAGE_CONTENT\n", "index.html commitado deve ter o conteúdo novo");

    // A prova do fix: `stale-asset.html` NÃO deve existir no commit final —
    // nem via `git show` (que lançaria "path does not exist" se de fato
    // ausente) nem na árvore completa via `git ls-tree -r`.
    assert.throws(
      () => git(["show", `origin/${branchName}:${relPageDir}/stale-asset.html`], rootDir),
      /does not exist|exists on disk, but not in/,
      "stale-asset.html deveria ter sido PODADO do commit final, não sobrevivido herdado do worktree",
    );

    const fullTree = git(["ls-tree", "-r", `origin/${branchName}`], rootDir);
    assert.ok(
      !fullTree.includes("stale-asset.html"),
      `árvore completa do commit não deveria conter stale-asset.html. árvore:\n${fullTree}`,
    );
  });
});
