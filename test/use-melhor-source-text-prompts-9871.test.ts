/**
 * Guard de prompt (#9871): os social agents não têm WebFetch, então o `## um`
 * (4º post, item USE MELHOR) recebe o texto COMPLETO da fonte como
 * `source_text_paths.um` (`_internal/use-melhor-source.txt`, gravado por
 * `select-use-melhor-post.ts` — teste de código em use-melhor-steps-9585.test.ts),
 * e o re-disparo do `writer-destaque` no gate do Stage 4 exige ler os 4
 * arquivos de contexto obrigatórios.
 *
 * Edição 261008: o `## um` saiu do `item.body` cortado em 6000 chars, e os 2
 * `writer-destaque` despachados no gate voltaram com "não li os 4 arquivos de
 * contexto".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("#9871 — source_text_paths.um no 4º post", () => {
  for (const agent of ["social-writer", "social-curto"]) {
    it(`${agent}.md declara a chave um e manda ler o arquivo antes de escrever o ## um`, () => {
      const md = read(`.claude/agents/${agent}.md`);
      assert.match(md, /Chave `um` \(#9871/);
      assert.match(md, /`source_text_paths\.um`[^\n]*`Read`/);
      assert.match(md, /não tem WebFetch/);
    });
  }

  it("orchestrator-stage-2.md passa a chave um a partir de item.source_text_path", () => {
    const md = read(".claude/agents/orchestrator-stage-2.md");
    assert.match(md, /\*\*Chave `um` \(#9871\):\*\*[^\n]*item\.source_text_path/);
  });

  it("orchestrator-stage-4.md §e passa source_text_paths.um no re-disparo do ## um", () => {
    const md = read(".claude/agents/orchestrator-stage-4.md");
    const e = md.split("\n").find((l) => l.startsWith("**e. Dispatchar `social-writer`"));
    assert.ok(e, "§e não encontrado");
    assert.match(e!, /Re-disparo do `## um`[^\n]*"um":/);
  });
});

describe("#9871 — re-disparo do writer-destaque lê os 4 arquivos de contexto", () => {
  it("§4d.1b passo 1 lista os 4 arquivos com paths explícitos", () => {
    const md = read(".claude/agents/orchestrator-stage-4.md");
    const passo1 = md.split("\n").find((l) => l.startsWith("1. **Texto do destaque novo**"));
    assert.ok(passo1, "§4d.1b passo 1 não encontrado");
    for (const f of [
      "context/editorial-rules.md",
      "context/templates/newsletter.md",
      "context/audience-profile.md",
      "data/past-editions.md",
    ]) {
      assert.ok(passo1!.includes(f), `passo 1 não cita ${f}`);
    }
  });

  it("os 4 arquivos citados são os mesmos do Contexto obrigatório do writer-destaque", () => {
    const md = read(".claude/agents/writer-destaque.md");
    const sec = md.split("## Contexto obrigatório")[1]?.split("\n## ")[0] ?? "";
    const files = [...sec.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(files, [
      "context/editorial-rules.md",
      "context/templates/newsletter.md",
      "context/audience-profile.md",
      "data/past-editions.md",
    ]);
  });
});
