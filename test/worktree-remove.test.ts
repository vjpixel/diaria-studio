/**
 * test/worktree-remove.test.ts (#8209)
 *
 * Regressão (#633) pra `scripts/lib/worktree-remove.ts`: remoção segura de
 * casca de worktree com junction/symlink `node_modules`/`data` sem seguir
 * pro alvo apontado. **CUIDADO EXTREMO (instrução explícita do dispatch):**
 * este teste NUNCA cria nem toca `node_modules`/`data` reais do repo — todo
 * "alvo" de symlink é um diretório DESCARTÁVEL sob `mkdtemp`, e cada teste
 * confirma explicitamente que o CONTEÚDO do alvo sobrevive intacto. Se
 * qualquer asserção de sobrevivência do alvo falhar, o teste deve estourar
 * ruidosamente (`assert`, nunca um catch silencioso).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSymlinkOrJunction,
  findLinksUnder,
  removeLinkSafely,
  removeWorktreeDirSafely,
  isHuskDirectory,
  findWorktreeHusks,
} from "../scripts/lib/worktree-remove.ts";

function mktmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("isSymlinkOrJunction: true pro symlink, false pro diretório real e pro caminho inexistente", () => {
  const base = mktmp("diaria-wtrm-symlink-");
  const target = join(base, "real-target");
  mkdirSync(target);
  const link = join(base, "link");
  symlinkSync(target, link, "dir");

  assert.equal(isSymlinkOrJunction(link), true);
  assert.equal(isSymlinkOrJunction(target), false);
  assert.equal(isSymlinkOrJunction(join(base, "nao-existe")), false);

  rmSync(base, { recursive: true, force: true });
});

test("findLinksUnder: acha node_modules e data na raiz E nested (workers/*/node_modules), nunca desce pro alvo", () => {
  const base = mktmp("diaria-wtrm-find-");
  const worktree = join(base, "worktree");
  const targetNodeModules = join(base, "SHARED-node-modules-descartavel");
  const targetData = join(base, "SHARED-data-descartavel");
  const targetNestedNodeModules = join(base, "SHARED-nested-nm-descartavel");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(targetNodeModules, { recursive: true });
  writeFileSync(join(targetNodeModules, "canary.txt"), "não pode sumir");
  mkdirSync(targetData, { recursive: true });
  writeFileSync(join(targetData, "canary.txt"), "não pode sumir");
  mkdirSync(targetNestedNodeModules, { recursive: true });
  writeFileSync(join(targetNestedNodeModules, "canary.txt"), "não pode sumir");

  symlinkSync(targetNodeModules, join(worktree, "node_modules"), "dir");
  symlinkSync(targetData, join(worktree, "data"), "dir");
  mkdirSync(join(worktree, "workers", "pkg-a"), { recursive: true });
  symlinkSync(targetNestedNodeModules, join(worktree, "workers", "pkg-a", "node_modules"), "dir");
  // arquivo real qualquer, não deve aparecer na lista de links.
  writeFileSync(join(worktree, "README.md"), "conteúdo real");

  const links = findLinksUnder(worktree).sort();
  assert.deepEqual(
    links.sort(),
    [
      join(worktree, "data"),
      join(worktree, "node_modules"),
      join(worktree, "workers", "pkg-a", "node_modules"),
    ].sort(),
  );

  rmSync(base, { recursive: true, force: true });
});

test("removeLinkSafely: remove o link, alvo real sobrevive intacto", () => {
  const base = mktmp("diaria-wtrm-removelink-");
  const target = join(base, "alvo-descartavel");
  mkdirSync(target);
  writeFileSync(join(target, "canary.txt"), "conteúdo do alvo");
  const link = join(base, "node_modules");
  symlinkSync(target, link, "dir");

  const result = removeLinkSafely(link);
  assert.equal(result.removed, true, result.error);
  assert.equal(existsSync(link), false, "o link deveria ter sumido");
  // ALVO sobrevive — é o ponto central do teste.
  assert.equal(existsSync(target), true, "ALVO NÃO PODE SUMIR");
  assert.equal(readFileSync(join(target, "canary.txt"), "utf8"), "conteúdo do alvo", "conteúdo do alvo intacto");

  rmSync(base, { recursive: true, force: true });
});

test("removeLinkSafely: recusa remover um diretório real (não-link) — guard de segurança", () => {
  const base = mktmp("diaria-wtrm-refuse-");
  const realDir = join(base, "real-dir-nao-e-link");
  mkdirSync(realDir);
  writeFileSync(join(realDir, "canary.txt"), "não pode sumir");

  const result = removeLinkSafely(realDir);
  assert.equal(result.removed, false);
  assert.equal(existsSync(realDir), true, "diretório real preservado — removeLinkSafely nunca apaga não-link");

  rmSync(base, { recursive: true, force: true });
});

test("removeWorktreeDirSafely: remove a casca inteira (links + diretórios vazios), ALVOS dos links sobrevivem intactos", () => {
  const base = mktmp("diaria-wtrm-fulldir-");
  const husk = join(base, "casca-worktree");
  const targetNodeModules = join(base, "SHARED-nm-target");
  const targetData = join(base, "SHARED-data-target");
  mkdirSync(husk, { recursive: true });
  mkdirSync(targetNodeModules, { recursive: true });
  writeFileSync(join(targetNodeModules, "canary.txt"), "node_modules do checkout principal");
  mkdirSync(targetData, { recursive: true });
  writeFileSync(join(targetData, "canary.txt"), "data do OneDrive");

  symlinkSync(targetNodeModules, join(husk, "node_modules"), "dir");
  symlinkSync(targetData, join(husk, "data"), "dir");
  mkdirSync(join(husk, "workers")); // diretório vazio remanescente

  const result = removeWorktreeDirSafely(husk);

  assert.equal(result.dirRemoved, true, `erros: ${result.errors.join("; ")}`);
  assert.equal(existsSync(husk), false, "a casca deveria ter sido removida por completo");
  assert.equal(result.removedLinks.length, 2);

  // OS DOIS ALVOS sobrevivem intactos — é a garantia central da issue #8209
  // (nunca apagar node_modules do checkout principal nem data/ do OneDrive).
  assert.equal(existsSync(targetNodeModules), true, "node_modules ALVO NÃO PODE SUMIR");
  assert.equal(existsSync(targetData), true, "data ALVO NÃO PODE SUMIR");
  assert.equal(
    readFileSync(join(targetNodeModules, "canary.txt"), "utf8"),
    "node_modules do checkout principal",
    "conteúdo do node_modules alvo intacto",
  );
  assert.equal(
    readFileSync(join(targetData, "canary.txt"), "utf8"),
    "data do OneDrive",
    "conteúdo do data alvo intacto",
  );

  rmSync(base, { recursive: true, force: true });
});

test("removeWorktreeDirSafely: diretório inexistente é no-op (dirRemoved=true, sem erro)", () => {
  const base = mktmp("diaria-wtrm-noop-");
  const result = removeWorktreeDirSafely(join(base, "nao-existe"));
  assert.equal(result.dirRemoved, true);
  assert.deepEqual(result.errors, []);
  rmSync(base, { recursive: true, force: true });
});

test("isHuskDirectory: true pra diretório sem .git com só links+diretórios vazios", () => {
  const base = mktmp("diaria-wtrm-ishusk-");
  const husk = join(base, "casca");
  const target = join(base, "alvo-descartavel");
  mkdirSync(target);
  mkdirSync(husk, { recursive: true });
  symlinkSync(target, join(husk, "node_modules"), "dir");
  mkdirSync(join(husk, "workers", "vazio"), { recursive: true });

  assert.equal(isHuskDirectory(husk), true);

  rmSync(base, { recursive: true, force: true });
});

test("isHuskDirectory: false quando tem .git (worktree de verdade, não casca)", () => {
  const base = mktmp("diaria-wtrm-hasgit-");
  const wt = join(base, "worktree-real");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), "gitdir: /algum/lugar/.git/worktrees/worktree-real\n");

  assert.equal(isHuskDirectory(wt), false);

  rmSync(base, { recursive: true, force: true });
});

test("isHuskDirectory: false quando tem QUALQUER arquivo real (caso review-fix-6048 da issue — cópia do repo sem git)", () => {
  const base = mktmp("diaria-wtrm-hasfile-");
  const dir = join(base, "copia-sem-git");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");

  assert.equal(isHuskDirectory(dir), false, "diretório com arquivo real NUNCA é husk — só reporta, nunca apaga");

  rmSync(base, { recursive: true, force: true });
});

test("findWorktreeHusks: acha só as cascas, exclui worktrees ativos (excludePaths) e diretórios com conteúdo real", () => {
  const base = mktmp("diaria-wtrm-findhusks-");
  const huskA = join(base, "casca-a");
  const huskB = join(base, "casca-b");
  const activeWorktree = join(base, "worktree-ativo");
  const realCopy = join(base, "copia-com-arquivo");
  const target = join(base, "SHARED-target");
  mkdirSync(target);
  // arquivo real dentro do alvo — simula um node_modules/checkout de verdade
  // (não uma casca vazia); sem isso o próprio alvo qualificaria como husk.
  writeFileSync(join(target, "canary.txt"), "conteúdo real do alvo");

  mkdirSync(huskA, { recursive: true });
  symlinkSync(target, join(huskA, "node_modules"), "dir");

  mkdirSync(huskB, { recursive: true }); // vazia mesmo, sem link — ainda é husk (só dirs)

  mkdirSync(activeWorktree, { recursive: true });
  symlinkSync(target, join(activeWorktree, "node_modules"), "dir"); // pareceria husk...

  mkdirSync(realCopy, { recursive: true });
  writeFileSync(join(realCopy, "file.txt"), "conteúdo real");

  const husks = findWorktreeHusks(base, new Set([activeWorktree])).sort();
  assert.deepEqual(husks, [huskA, huskB].sort());

  rmSync(base, { recursive: true, force: true });
});
