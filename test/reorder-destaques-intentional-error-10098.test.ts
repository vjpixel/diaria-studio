/**
 * #10098 — reorder-destaques precisa remapear o "destaque N" citado em prosa no
 * erro intencional (`description`/`reveal` do `_internal/intentional-error.json`
 * e a linha "Nessa edição, …" do bloco ERRO INTENCIONAL em `02-reviewed.md`),
 * coerente com o `location` que já era atualizado. Caso real: edição 261013,
 * `--new-order 3,1,2`, erro "Bradesko" no D3 que virou D1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  remapDestaqueWordRefsInText,
  remapErroIntencionalNarrativeInMd,
  updateIntentionalErrorProseJson,
} from "../scripts/reorder-destaques.ts";

describe("remapDestaqueWordRefsInText (#10098)", () => {
  it("3,1,2: destaque 3 → 1, 1 → 2, 2 → 3 numa passada só (sem encadear)", () => {
    assert.equal(
      remapDestaqueWordRefsInText("destaque 3, Destaque 1 e DESTAQUE 2", [3, 1, 2]),
      "destaque 1, Destaque 2 e DESTAQUE 3",
    );
  });

  it("N fora do newOrder (destaque eliminado) fica intacto", () => {
    assert.equal(remapDestaqueWordRefsInText("no destaque 3", [2, 1]), "no destaque 3");
  });

  it("texto sem menção a destaque não muda", () => {
    assert.equal(remapDestaqueWordRefsInText("no RADAR, item 3", [3, 1, 2]), "no RADAR, item 3");
  });
});

describe("updateIntentionalErrorProseJson (#10098)", () => {
  it("remapeia description e reveal; mantém os demais campos", () => {
    const { record, changed } = updateIntentionalErrorProseJson(
      {
        description: "Nome do banco grafado errado (Bradesko) no destaque 3",
        reveal: "Na última edição, escrevi Bradesko no destaque 3, o correto é Bradesco.",
        location: "DESTAQUE 1, parágrafo 3",
        correct_value: "Bradesco",
      },
      [3, 1, 2],
    );
    assert.equal(changed, true);
    assert.equal(record.description, "Nome do banco grafado errado (Bradesko) no destaque 1");
    assert.equal(record.reveal, "Na última edição, escrevi Bradesko no destaque 1, o correto é Bradesco.");
    assert.equal(record.location, "DESTAQUE 1, parágrafo 3");
    assert.equal(record.correct_value, "Bradesco");
  });

  it("sem menção a destaque → changed=false e o mesmo objeto", () => {
    const input = { description: "erro no RADAR", location: "RADAR, item 2" };
    const { record, changed } = updateIntentionalErrorProseJson(input, [3, 1, 2]);
    assert.equal(changed, false);
    assert.equal(record, input);
  });
});

describe("remapErroIntencionalNarrativeInMd (#10098)", () => {
  it("remapeia só a linha 'Nessa edição' — 'Na última edição' fala da edição anterior", () => {
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, escrevi 1990 no destaque 1, o correto é 1998.",
      "",
      "Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 3.",
      "",
      "---",
      "",
      "**🎁 SORTEIO**",
      "",
      "Texto citando o destaque 3 fora do bloco.",
      "",
    ].join("\n");
    const out = remapErroIntencionalNarrativeInMd(md, [3, 1, 2]);
    assert.match(out, /Na última edição, escrevi 1990 no destaque 1, o correto é 1998\./);
    assert.match(out, /Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 1\./);
    assert.match(out, /Texto citando o destaque 3 fora do bloco\./);
  });
});

describe("reorder-destaques CLI (#10098): --new-order 3,1,2 mantém narrativa, description e location coerentes", () => {
  it("erro no D3 → as três referências apontam para o destaque 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-10098-"));
    try {
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ highlights: [{}, {}, {}] }, null, 2),
      );
      writeFileSync(
        join(internalDir, "intentional-error.json"),
        JSON.stringify(
          {
            description: "Nome do banco grafado errado (Bradesko) no destaque 3",
            location: "DESTAQUE 3, parágrafo 3",
            category: "ortografico",
            correct_value: "Bradesco",
            wrong_value: "Bradesko",
          },
          null,
          2,
        ),
      );
      const body = "A".repeat(300);
      const md = `Intro qualquer da edição...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título Um](https://x.com)**

${body}

---

**DESTAQUE 2 | 💼 MERCADO**

**[Título Dois](https://y.com)**

${body}

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Título Gemini](https://z.com)**

${body} Bradesko.

---

**📰 OUTRAS NOTÍCIAS**

[N1](https://n.com)

---

**ERRO INTENCIONAL**

Na última edição, troquei um número no destaque 2.

Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 3.

---
`;
      writeFileSync(join(dir, "02-reviewed.md"), md);

      const projectRoot = join(import.meta.dirname, "..");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(projectRoot, "scripts", "reorder-destaques.ts"),
          "--edition",
          "999999",
          "--edition-dir",
          dir,
          "--new-order",
          "3,1,2",
        ],
        { cwd: projectRoot, encoding: "utf8" },
      );
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);

      const record = JSON.parse(readFileSync(join(internalDir, "intentional-error.json"), "utf8"));
      assert.equal(record.location, "DESTAQUE 1, parágrafo 3");
      assert.equal(record.description, "Nome do banco grafado errado (Bradesko) no destaque 1");

      const updated = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(updated, /Nessa edição, escrevi o nome de um banco brasileiro errado no destaque 1\./);
      // "Na última edição" é da edição anterior — intacta.
      assert.match(updated, /Na última edição, troquei um número no destaque 2\./);
      // O destaque com o erro de fato está agora na posição 1.
      const d1 = updated.slice(updated.indexOf("**DESTAQUE 1"), updated.indexOf("**DESTAQUE 2"));
      assert.match(d1, /Título Gemini/);
      assert.match(d1, /Bradesko/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
