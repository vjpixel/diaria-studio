/**
 * test/coordinator-territory.test.ts (#6957)
 *
 * Cobre `scripts/lib/coordinator-territory.ts` — a lógica PURA/testável do
 * protocolo de duas coordenadoras com território disjunto.
 *
 * `pathsOverlap`: mesmo critério de `beaconPathsOverlap` (#6168) — prefixo de
 * diretório OU arquivo igual. Substring não basta.
 *
 * `isTerritoryDisjoint`: dois territórios colidem quando NENHUM path de um
 * bate com qualquer path do outro (prefixo de dir ou arquivo igual).
 * Território sem paths declarados é INDETERMINADO, nunca livre.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerritoryDisjoint, pathsOverlap, type Territory } from "../scripts/lib/coordinator-territory.ts";

const T = (name: string, paths: string[]): Territory => ({ name, paths });

describe("pathsOverlap", () => {
  it("mesmo arquivo é overlap", () => {
    assert.equal(pathsOverlap("scripts/lib/foo.ts", "scripts/lib/foo.ts"), true);
  });

  it("arquivo dentro do diretório do outro é overlap", () => {
    assert.equal(pathsOverlap("scripts/lib/foo.ts", "scripts/lib/"), true);
    assert.equal(pathsOverlap("scripts/lib/", "scripts/lib/foo.ts"), true);
  });

  it("arquivo dentro de subdiretório do outro é overlap", () => {
    assert.equal(pathsOverlap("scripts/lib/foo/bar.ts", "scripts/lib/"), true);
    assert.equal(pathsOverlap("scripts/lib/", "scripts/lib/foo/bar.ts"), true);
  });

  it("subdiretórios com prefixo comum mas nomes diferentes NÃO se sobrepõem", () => {
    assert.equal(pathsOverlap("scripts/lib2/foo.ts", "scripts/lib/"), false);
    assert.equal(pathsOverlap("scripts/lib/foo.ts", "scripts/lib2/"), false);
  });

  it("pastas distintas NÃO se sobrepõem", () => {
    assert.equal(pathsOverlap("hermes/skills/foo/", "scripts/lib/"), false);
    assert.equal(pathsOverlap("scripts/lib/", "hermes/skills/foo/"), false);
  });

  it("trailing slash no diretório: apenas / conta como contenedor", () => {
    // "scripts/lib/" COM trailing slash é diretório — foo.ts dentro dele
    assert.equal(pathsOverlap("scripts/lib/foo.ts", "scripts/lib/"), true);
    assert.equal(pathsOverlap("scripts/lib/", "scripts/lib/foo.ts"), true);
    // "scripts/lib" SEM trailing slash é um ARQUIVO chamado "lib", não diretório
    assert.equal(pathsOverlap("scripts/lib/foo.ts", "scripts/lib"), false);
  });

  it("prefixo de nome mas diretório diferente NÃO é overlap", () => {
    assert.equal(pathsOverlap("scripts/foo.ts", "scripts/foobar.ts"), false);
    assert.equal(pathsOverlap("scripts/foobar.ts", "scripts/foo.ts"), false);
  });

  it("arquivos irmãos no mesmo diretório NÃO se sobrepõem", () => {
    assert.equal(pathsOverlap("scripts/foo.ts", "scripts/bar.ts"), false);
    assert.equal(pathsOverlap("scripts/bar.ts", "scripts/foo.ts"), false);
  });

  it("paths absolutos funcionam igual", () => {
    assert.equal(pathsOverlap("/home/u/repo/scripts/foo.ts", "/home/u/repo/scripts/foo.ts"), true);
    assert.equal(pathsOverlap("/home/u/repo/scripts/foo.ts", "/home/u/repo/scripts/"), true);
    assert.equal(pathsOverlap("/home/u/repo/scripts/foo.ts", "/home/u/repo/scripts/bar.ts"), false);
  });
});

describe("isTerritoryDisjoint", () => {
  it("territórios disjuntos retornam disjoint=true", () => {
    const a = T("esteira-hermes", ["hermes/skills/foo/SKILL.md", "hermes/scripts/bar.sh"]);
    const b = T("infra-repo", ["scripts/lib/session-registry.ts", "test/session-registry.test.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, true);
    assert.equal(result.overlappingPaths.length, 0);
  });

  it("um path que se sobrepõe torna o território colidente", () => {
    const a = T("A", ["scripts/lib/foo.ts", "hermes/bar.sh"]);
    const b = T("B", ["scripts/lib/foo.ts", "data/baz.json"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, false);
    assert.deepEqual(result.overlappingPaths, ["scripts/lib/foo.ts"]);
  });

  it("sobreposição por diretório (file ∈ dir) conta", () => {
    const a = T("A", ["scripts/lib/foo.ts"]);
    const b = T("B", ["scripts/lib/"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, false);
    assert.deepEqual(result.overlappingPaths, ["scripts/lib/"]);
  });

  it("sobreposição por diretório (dir ⊃ file) conta", () => {
    const a = T("A", ["scripts/lib/"]);
    const b = T("B", ["scripts/lib/foo.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, false);
    assert.deepEqual(result.overlappingPaths, ["scripts/lib/foo.ts"]);
  });

  it("múltiplos overlaps são agrupados, deduplicados e sorted", () => {
    // b1 e b2 se sobrepõem a a1; b3 não se sobrepõe.
    const a = T("A", ["scripts/lib/foo.ts", "scripts/lib/foo.ts", "scripts/lib/bar.ts"]);
    const b = T("B", [
      "scripts/lib/foo.ts", // overlap a1 (deduplicado)
      "scripts/lib/foo.ts", // overlap a1 (deduplicado)
      "scripts/lib/bar.ts", // overlap bar
      "hermes/baz.sh",     // no overlap
    ]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, false);
    // deduplicado e em ordem sorted
    assert.deepEqual(result.overlappingPaths, ["scripts/lib/bar.ts", "scripts/lib/foo.ts"]);
  });

  it("território A vazio é INDETERMINADO (nunca disjoint)", () => {
    const result = isTerritoryDisjoint(T("A", []), T("B", ["scripts/foo.ts"]));
    assert.equal(result.disjoint, false);
    assert.equal(result.overlappingPaths.length, 0);
    assert.match(result.reason, /indeterminado/i);
  });

  it("território B vazio é INDETERMINADO (nunca disjoint)", () => {
    const result = isTerritoryDisjoint(T("A", ["scripts/foo.ts"]), T("B", []));
    assert.equal(result.disjoint, false);
    assert.equal(result.overlappingPaths.length, 0);
    assert.match(result.reason, /indeterminado/i);
  });

  it("ambos vazios é INDETERMINADO", () => {
    const result = isTerritoryDisjoint(T("A", []), T("B", []));
    assert.equal(result.disjoint, false);
    assert.equal(result.overlappingPaths.length, 0);
  });

  it("disjunto com diretórios irmãos — lib vs lib2 não colide", () => {
    const a = T("A", ["scripts/lib/foo.ts", "scripts/lib/bar.ts"]);
    const b = T("B", ["scripts/lib2/foo.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, true);
  });

  it("disjunto com paths absolutos", () => {
    const a = T("A", ["/home/u/repo/hermes/skills/foo/SKILL.md"]);
    const b = T("B", ["/home/u/repo/scripts/lib/session-registry.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, true);
  });

  it("overlap por arquivo com mesmo nome em diretórios diferentes NÃO colide", () => {
    const a = T("A", ["scripts/lib/utils.ts"]);
    const b = T("B", ["hermes/lib/utils.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.equal(result.disjoint, true);
  });

  it("resultado é simétrico (basta checar de A→B ou B→A, os hit paths são os de B)", () => {
    const a = T("A", ["scripts/lib/foo.ts", "hermes/x.sh"]);
    const b = T("B", ["scripts/lib/foo.ts", "hermes/x.sh", "data/y.json"]);
    const ab = isTerritoryDisjoint(a, b);
    const ba = isTerritoryDisjoint(b, a);
    assert.equal(ab.disjoint, ba.disjoint);
    assert.equal(ab.overlappingPaths.length, ba.overlappingPaths.length);
    // A checagem percorre a×b (paths de b que batem com a), então
    // overlappingPaths lista sempre os paths do territory B (o segundo arg).
    assert.deepEqual(ab.overlappingPaths, ["hermes/x.sh", "scripts/lib/foo.ts"]);
    assert.deepEqual(ba.overlappingPaths, ["hermes/x.sh", "scripts/lib/foo.ts"]);
  });

  it("motivo inclui nomes dos territórios e contagem de paths", () => {
    const a = T("esteira", ["hermes/a.sh"]);
    const b = T("infra", ["scripts/b.ts"]);
    const result = isTerritoryDisjoint(a, b);
    assert.match(result.reason, /esteira/);
    assert.match(result.reason, /infra/);
    assert.match(result.reason, /1 path\(s\) × 1 path\(s\)/);
  });
});
