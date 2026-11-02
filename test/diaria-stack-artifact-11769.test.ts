/**
 * #11769 — a prévia final do /diaria-stack vai sempre para um Artifact.
 * Trava no texto da skill: ordem (Passo 5 antes das confirmações), recuperação
 * da URL em sessão nova, fallback e fronteira de segurança.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(".claude/skills/diaria-stack/SKILL.md", "utf8");
const passo = (n: number) => {
  const a = skill.indexOf(`## Passo ${n} `);
  const b = skill.indexOf("\n## ", a + 1);
  return skill.slice(a, b);
};

describe("diaria-stack: prévia em Artifact (#11769)", () => {
  it("Passo 5 vem antes dos passos de confirmação 6 e 7", () => {
    const i5 = skill.indexOf("## Passo 5");
    assert.ok(i5 > 0 && i5 < skill.indexOf("## Passo 6") && skill.indexOf("## Passo 6") < skill.indexOf("## Passo 7"));
    assert.match(passo(5), /Artifact\(file_path:/);
  });

  it("recupera a URL gravada ANTES de criar (rerrodada / sessão nova)", () => {
    const p = passo(5);
    const read = p.indexOf("circle-stack-artifact.txt");
    assert.ok(read > 0);
    assert.ok(read < p.indexOf("criar um novo"), "ler o .txt antes de criar");
    assert.match(p, /sobrescrever o `\.txt`/);
  });

  it("declara conteúdo, caminho do HTML e aviso de publicação imediata", () => {
    const p = passo(5);
    for (const t of ["circle-stack-preview.html", "payload.titulo", "titleOriginal", "NA HORA"]) {
      assert.ok(p.includes(t), t);
    }
  });

  it("tem fallback warning-only que não pula a confirmação", () => {
    assert.match(passo(5), /Fallback:[\s\S]*warning-only[\s\S]*nunca é pulada/);
  });

  it("guard de execução reconhece o Artifact como rede", () => {
    assert.match(skill, /Passo 5 publica um Artifact, que é\s+rede/);
    assert.doesNotMatch(skill, /Passos 1 a 5 só leem/);
  });
});
