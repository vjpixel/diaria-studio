/**
 * #9796 — `reorder-destaques.ts --new-order 3,1,2` renomeava os headers
 * `## d{N}` de 03-social.md mas deixava os blocos na ordem física antiga
 * (edição 261007: `## d2`, `## d3`, `## d1` em `# Social` e em `# Curto`).
 * Agora os blocos são movidos para d1, d2, d3 em cada seção de topo, com
 * seções não-destaque (`## um`) fixas na própria posição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reorderSocialMd, sortDestaqueSectionsPhysically } from "../scripts/reorder-destaques.ts";

// Formato real de 03-social.md (Social + Curto, `## um` depois dos destaques,
// hashtags com `#` sem espaço que não são headers).
const SOCIAL = `# Social

## d1

Texto social D1.

#InteligenciaArtificial #A

## d2

Texto social D2.

#InteligenciaArtificial #B

## d3

Texto social D3.

#InteligenciaArtificial #C

## um

Texto use melhor.

# Curto

## d1

Curto D1. #A

## d2

Curto D2. #B

## d3

Curto D3. #C

## um

Curto use melhor.
`;

function headers(md: string): string[] {
  return md.split("\n").filter((l) => /^#{1,2}\s/.test(l));
}

describe("reorderSocialMd move fisicamente as seções (#9796)", () => {
  it("--new-order 3,1,2: ordem física d1, d2, d3 em # Social e em # Curto", () => {
    const out = reorderSocialMd(SOCIAL, [3, 1, 2]);
    assert.deepEqual(headers(out), [
      "# Social", "## d1", "## d2", "## d3", "## um",
      "# Curto", "## d1", "## d2", "## d3", "## um",
    ]);
    // conteúdo acompanha o novo rótulo: novo d1 = antigo d3, etc.
    const exp = SOCIAL
      .replace("## d1\n\nTexto social D1.\n\n#InteligenciaArtificial #A\n\n## d2\n\nTexto social D2.\n\n#InteligenciaArtificial #B\n\n## d3\n\nTexto social D3.\n\n#InteligenciaArtificial #C",
        "## d1\n\nTexto social D3.\n\n#InteligenciaArtificial #C\n\n## d2\n\nTexto social D1.\n\n#InteligenciaArtificial #A\n\n## d3\n\nTexto social D2.\n\n#InteligenciaArtificial #B")
      .replace("## d1\n\nCurto D1. #A\n\n## d2\n\nCurto D2. #B\n\n## d3\n\nCurto D3. #C",
        "## d1\n\nCurto D3. #C\n\n## d2\n\nCurto D1. #A\n\n## d3\n\nCurto D2. #B");
    assert.equal(out, exp);
  });

  it("preserva bytes: mesmo multiset de linhas, nada perdido nem duplicado", () => {
    const out = reorderSocialMd(SOCIAL, [2, 3, 1]);
    assert.deepEqual(out.split("\n").sort(), SOCIAL.split("\n").sort());
  });

  it("identidade [1,2,3] devolve o arquivo idêntico", () => {
    assert.equal(reorderSocialMd(SOCIAL, [1, 2, 3]), SOCIAL);
  });

  it("última seção do arquivo sem \\n final movida pro meio não cola no header seguinte", () => {
    const md = "# Curto\n\n## d1\n\nA\n\n## d2\n\nB";
    assert.equal(reorderSocialMd(md, [2, 1]), "# Curto\n\n## d1\n\nB\n\n## d2\n\nA\n");
  });

  it("CRLF preservado", () => {
    const md = "# Social\r\n\r\n## d1\r\n\r\nA\r\n\r\n## d2\r\n\r\nB\r\n\r\n## d3\r\n\r\nC\r\n";
    assert.equal(
      reorderSocialMd(md, [3, 1, 2]),
      "# Social\r\n\r\n## d1\r\n\r\nC\r\n\r\n## d2\r\n\r\nA\r\n\r\n## d3\r\n\r\nB\r\n",
    );
  });

  it("sortDestaqueSectionsPhysically conserta arquivo já fora de ordem (estado real 261007)", () => {
    const md = "# Social\n\n## d2\n\nB\n\n## d3\n\nC\n\n## d1\n\nA\n\n## um\n\nU\n";
    assert.equal(
      sortDestaqueSectionsPhysically(md),
      "# Social\n\n## d1\n\nA\n\n## d2\n\nB\n\n## d3\n\nC\n\n## um\n\nU\n",
    );
  });

  it("seção não-destaque intercalada fica na posição dela", () => {
    const md = "## d2\nB\n## um\nU\n## d1\nA\n";
    assert.equal(sortDestaqueSectionsPhysically(md), "## d1\nA\n## um\nU\n## d2\nB\n");
  });
});
