/**
 * #13431 — splice das seções sociais reescritas no Stage 4 passa pelo mesmo
 * strip de comentários HTML do merge do Stage 2. Antes, o splice à mão do
 * swap de D2/D3 deixava `<!-- char_count -->` no 03-social.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSplice, spliceSocialMd } from "../scripts/splice-social-sections.ts";
import { buildRestoreSteps, buildSwapDestaqueSteps } from "../scripts/swap-destaque.ts";
import { buildSwapNextSteps } from "../scripts/swap-destaques.ts";

const SOCIAL_MD = `# Social

> **Texto único (#3991)** — banner.

## d1

Legenda do D1.

## d1-cards

Card 1 do D1.

## d2

Legenda velha do D2.

## d2-cards

Card velho do D2.

## d3

Legenda do D3.

## d3-cards

Card do D3.

# Curto

## d1

Curto do D1.

## d2

Curto velho do D2.

## d3

Curto do D3.
`;

const SOCIAL_TMP = `## d2

Legenda nova do D2, com a história que entrou.
<!-- char_count: 312 -->

## d2-cards

Card novo do D2.
<!-- char_count: 120 -->
`;

const CURTO_TMP = `## d2

Curto novo do D2. <!-- char_count: 98 -->
`;

function makeEdition(socialMd = SOCIAL_MD): string {
  const dir = mkdtempSync(join(tmpdir(), "splice-social-13431-"));
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "03-social.md"), socialMd);
  writeFileSync(join(dir, "_internal/03-social.tmp.md"), SOCIAL_TMP);
  writeFileSync(join(dir, "_internal/03-curto.tmp.md"), CURTO_TMP);
  return dir;
}

describe("splice-social-sections (#13431)", () => {
  it("troca d2 e d2-cards de # Social e d2 de # Curto sem deixar comentário char_count", () => {
    const dir = makeEdition();
    try {
      const r = runSplice({ editionDir: dir, destaques: ["d2"] });
      const md = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(!md.includes("<!--"), "nenhum comentário HTML no artefato");
      assert.ok(!md.includes("char_count"));
      assert.match(md, /## d2\n\nLegenda nova do D2, com a história que entrou\.\n\n## d2-cards\n\nCard novo do D2\.\n\n## d3\n/);
      assert.match(md, /# Curto\n\n## d1\n\nCurto do D1\.\n\n## d2\n\nCurto novo do D2\.\n\n## d3\n/);
      // Demais destaques intactos.
      assert.match(md, /## d1\n\nLegenda do D1\.\n\n## d1-cards\n\nCard 1 do D1\./);
      assert.match(md, /## d3-cards\n\nCard do D3\.\n\n# Curto/);
      assert.ok(md.endsWith("Curto do D3.\n"));
      assert.ok(!md.includes("velh"), "texto antigo do D2 saiu");
      assert.deepEqual(r.spliced, ["social:d2", "social:d2-cards", "curto:d2"]);
      // tmps consumidos, como no merge do Stage 2.
      assert.ok(!existsSync(join(dir, "_internal/03-social.tmp.md")));
      assert.ok(!existsSync(join(dir, "_internal/03-curto.tmp.md")));
      assert.ok(r.next_steps.some((s) => s.includes("refresh-social-hash.ts")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splice de d3 (último bloco antes de # Curto e no fim do arquivo) preserva separação", () => {
    const out = spliceSocialMd(SOCIAL_MD, "d3", {
      social: "Nova D3",
      cards: "Novo card D3",
      curto: "Novo curto D3",
    }).md;
    assert.match(out, /## d3\n\nNova D3\n\n## d3-cards\n\nNovo card D3\n\n# Curto\n/);
    assert.ok(out.endsWith("## d3\n\nNovo curto D3\n"));
  });

  it("aborta sem gravar quando o tmp tem comentário mal-formado", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "_internal/03-social.tmp.md"), "## d2\n\nTexto <!-- sem fechar\n");
      assert.throws(() => runSplice({ editionDir: dir, destaques: ["d2"] }), /mal-formados/);
      assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), SOCIAL_MD);
      assert.ok(existsSync(join(dir, "_internal/03-social.tmp.md")), "tmp preservado na falha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa integrar só a legenda quando o 03-social.md tem ## d{N}-cards (#12094)", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "_internal/03-social.tmp.md"), "## d2\n\nSó a legenda.\n");
      assert.throws(() => runSplice({ editionDir: dir, destaques: ["d2"] }), /d2-cards/);
      assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), SOCIAL_MD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("insere ## d{N}-cards depois do ## d{N} em edição anterior ao #12094", () => {
    const legacy = "# Social\n\n## d1\n\nA\n\n## d2\n\nB\n\n# Curto\n\n## d2\n\nC\n";
    const out = spliceSocialMd(legacy, "d2", { social: "B2", cards: "Cards B2" }).md;
    assert.equal(out, "# Social\n\n## d1\n\nA\n\n## d2\n\nB2\n\n## d2-cards\n\nCards B2\n\n# Curto\n\n## d2\n\nC\n");
  });

  it("preserva CRLF do arquivo original", () => {
    const dir = makeEdition(SOCIAL_MD.replace(/\n/g, "\r\n"));
    try {
      runSplice({ editionDir: dir, destaques: ["d2"], keepTmp: true });
      const md = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(md.includes("Legenda nova do D2"));
      assert.ok(!/[^\r]\n/.test(md), "todo \\n segue precedido de \\r");
      assert.ok(existsSync(join(dir, "_internal/03-social.tmp.md")), "--keep-tmp mantém o tmp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejeita --destaque fora de d1..d3", () => {
    const dir = makeEdition();
    try {
      assert.throws(() => runSplice({ editionDir: dir, destaques: ["d4"] }), /inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next_steps do swap apontam o splice para o script, antes do refresh-social-hash", () => {
    const lists = [
      buildSwapDestaqueSteps("/ed/261118", 2, "Z"),
      buildRestoreSteps("/ed/261118", 2, true),
      buildSwapNextSteps("/ed/261118", [
        { position: 1, url: "https://a.com/x", title: "X" },
        { position: 3, url: "https://a.com/z", title: "Z" },
      ]),
    ];
    for (const steps of lists) {
      const iSplice = steps.findIndex((s) => s.includes("splice-social-sections.ts --edition-dir /ed/261118 --destaque"));
      const iHash = steps.findIndex((s) => s.includes("refresh-social-hash.ts"));
      assert.ok(iSplice >= 0, "splice via script");
      assert.ok(iHash >= iSplice, "hash depois do splice");
    }
    assert.ok(lists[2].some((s) => s.includes("--destaque d1,d3")));
  });
});
