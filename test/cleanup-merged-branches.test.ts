/**
 * test/cleanup-merged-branches.test.ts (#4706)
 *
 * Cobre a lógica PURA de scripts/cleanup-merged-branches.ts: parse do
 * `git ls-remote --heads` e seleção das branches com PR mergeada — tudo com
 * um checker `isMerged` injetável, sem precisar de rede nem chamadas reais
 * pro `gh`/`git push`. Mesmo padrão de test/cleanup-merged-worktrees.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLsRemoteHeads,
  selectMergedForDeletion,
  excludeReopenedBranches,
} from "../scripts/cleanup-merged-branches.ts";

// ── parseLsRemoteHeads ──

test("parseLsRemoteHeads — parseia múltiplas linhas sha\\trefs/heads/branch", () => {
  const output = [
    "a1b2c3d4\trefs/heads/overnight/fix-4326",
    "e5f6a7b8\trefs/heads/develop/fix-4669",
  ].join("\n");

  const branches = parseLsRemoteHeads(output);
  assert.deepEqual(branches, ["overnight/fix-4326", "develop/fix-4669"]);
});

test("parseLsRemoteHeads — output vazio retorna array vazio", () => {
  assert.deepEqual(parseLsRemoteHeads(""), []);
});

test("parseLsRemoteHeads — ignora linhas sem tab (malformadas/defensivo)", () => {
  const output = ["sem-tab-aqui", "a1b2\trefs/heads/overnight/ok"].join("\n");
  assert.deepEqual(parseLsRemoteHeads(output), ["overnight/ok"]);
});

test("parseLsRemoteHeads — ignora refs que não são refs/heads/ (ex: tags)", () => {
  const output = [
    "a1b2\trefs/heads/overnight/fix-1",
    "c3d4\trefs/tags/v1.0.0",
  ].join("\n");
  assert.deepEqual(parseLsRemoteHeads(output), ["overnight/fix-1"]);
});

test("parseLsRemoteHeads — ignora linhas em branco", () => {
  const output = ["a1b2\trefs/heads/overnight/fix-1", "", "  ", "c3d4\trefs/heads/develop/fix-2"].join("\n");
  assert.deepEqual(parseLsRemoteHeads(output), ["overnight/fix-1", "develop/fix-2"]);
});

// ── selectMergedForDeletion ──

test("selectMergedForDeletion — só seleciona as que o checker confirma como mergeadas", () => {
  const branches = ["overnight/fix-1", "overnight/fix-2", "develop/fix-3"];
  const merged = new Set(["overnight/fix-1", "develop/fix-3"]);
  const result = selectMergedForDeletion(branches, (b) => merged.has(b));
  assert.deepEqual(result.sort(), ["develop/fix-3", "overnight/fix-1"]);
});

test("selectMergedForDeletion — PR fechado sem merge (checker false) NÃO é selecionado (#4706: não é lixo)", () => {
  // Regressão direta da ressalva da issue: develop/fix-4669 tem PR FECHADO
  // sem merge, preservado de propósito — o checker (gh pr list --state
  // merged) corretamente devolve false pra esse caso, e a branch nunca deve
  // aparecer na lista de deleção.
  const branches = ["develop/fix-4669"];
  const result = selectMergedForDeletion(branches, () => false);
  assert.deepEqual(result, []);
});

test("selectMergedForDeletion — nenhuma mergeada -> array vazio (fail-soft: nunca deleta por engano)", () => {
  const branches = ["overnight/fix-1", "overnight/fix-2"];
  const result = selectMergedForDeletion(branches, () => false);
  assert.deepEqual(result, []);
});

test("selectMergedForDeletion — lista vazia de entrada -> array vazio", () => {
  assert.deepEqual(selectMergedForDeletion([], () => true), []);
});

// ── excludeReopenedBranches (#4744 fleet review) ──

test("excludeReopenedBranches — branch com PR mergeado antigo E PR aberto novo reusando o nome vai pra 'excluded', não deletada", () => {
  // Cenário do achado: overnight/fix-4700 teve um PR mergeado no passado,
  // depois a issue reabriu e uma 2ª tentativa reusou o MESMO nome de branch
  // com um PR ainda ABERTO — checkBranchMergedViaGh sozinho confirmaria
  // "mergeado" (existe HISTORICAMENTE um PR mergeado com esse head), mas
  // deletar a branch agora destruiria o trabalho em andamento do PR aberto.
  const candidates = ["overnight/fix-4700", "overnight/fix-4701"];
  const hasOpenPr = (b: string) => b === "overnight/fix-4700";
  const { safe, excluded } = excludeReopenedBranches(candidates, hasOpenPr);
  assert.deepEqual(safe, ["overnight/fix-4701"]);
  assert.deepEqual(excluded, ["overnight/fix-4700"]);
});

test("excludeReopenedBranches — nenhuma reaberta -> todas seguras, excluded vazio", () => {
  const candidates = ["overnight/fix-1", "develop/fix-2"];
  const { safe, excluded } = excludeReopenedBranches(candidates, () => false);
  assert.deepEqual(safe, candidates);
  assert.deepEqual(excluded, []);
});

test("excludeReopenedBranches — todas reabertas -> safe vazio (fail-soft: nunca deleta por engano)", () => {
  const candidates = ["overnight/fix-1", "develop/fix-2"];
  const { safe, excluded } = excludeReopenedBranches(candidates, () => true);
  assert.deepEqual(safe, []);
  assert.deepEqual(excluded, candidates);
});

test("excludeReopenedBranches — lista vazia de entrada -> ambos vazios", () => {
  const { safe, excluded } = excludeReopenedBranches([], () => true);
  assert.deepEqual(safe, []);
  assert.deepEqual(excluded, []);
});
