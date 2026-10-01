// #9218: duas caixas com URL COMPLETA idêntica (utm_content incluído) geram warn.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateSnippetUrls,
  formatDuplicateSnippetUrlWarnings,
  parseSnippetContent,
} from "../scripts/box-click-report.ts";

const box = (url: string): string => `<!-- nome: X -->\n**📣 Workshop: [Inscreva-se](${url})**`;
const U = "https://diar.ia.br/evento/agente-ia?utm_source=diaria&utm_content=box1";

describe("#9218 findDuplicateSnippetUrls", () => {
  it("original + cópia com a mesma URL completa -> 1 duplicata com os 2 arquivos", () => {
    const dups = findDuplicateSnippetUrls([
      parseSnippetContent("workshop-agente-ia-outubro.md", box(U)),
      parseSnippetContent("workshop-agente-ia-outubro-copia.md", box(U)),
      parseSnippetContent("outra.md", box("https://x.com/outra")),
    ]);
    assert.equal(dups.length, 1);
    assert.deepEqual(dups[0].files, ["workshop-agente-ia-outubro-copia.md", "workshop-agente-ia-outubro.md"]);
    const lines = formatDuplicateSnippetUrlWarnings(dups);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /#9218/);
    assert.match(lines[0], /_arquivo/);
  });

  it("mesma base-URL com utm_content diferente NÃO é duplicata", () => {
    const dups = findDuplicateSnippetUrls([
      parseSnippetContent("a.md", box(U)),
      parseSnippetContent("b.md", box(U.replace("box1", "box2"))),
    ]);
    assert.deepEqual(dups, []);
  });

  it("URL repetida dentro do MESMO arquivo não conta", () => {
    const dups = findDuplicateSnippetUrls([parseSnippetContent("a.md", `${box(U)}\n\n[de novo](${U})`)]);
    assert.deepEqual(dups, []);
  });
});
