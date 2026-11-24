/**
 * #13894 — o box do Artigo Especial só sai até o fim do mês do artigo. Na
 * edição 261124 o box ainda anunciava o "Artigo Especial de Setembro".
 * `update-artigo-especial-box.ts` agora grava `expires:` no header, e a
 * seleção (`resolveBoxesForEdition`) já pula a caixa vencida (#10174).
 *
 * Tudo em diretório temporário: `data/snippets/` é gitignored (#5227).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderArtigoEspecialBox,
  lastDayOfMonthBrt,
  ArtigoEspecialBoxFormatError,
} from "../scripts/update-artigo-especial-box.ts";
import { parseBoxHeaderField, readSnippetExpiry, upsertBoxHeaderField } from "../scripts/lib/shared/snippet-header.ts";
import { resolveBoxesForEdition, type BoxesDivulgacaoAutoConfig } from "../scripts/select-boxes-by-clicks.ts";

const EXISTING = `<!--
nome: Artigo Especial Agosto
categoria: Artigo Especial
alt: Artigo Especial de agosto
-->

**Artigo Especial de Agosto**

O Artigo Especial desse mês é: **"Velho"**. Gancho velho.

Quem apoia a partir de R$10/mês recebe um Artigo Especial todo mês.

[Ler o Artigo Especial](https://especial.diar.ia.br/2026/velho/)`;

const INPUT = { titulo: "O Jev", gancho: "Conto como medi", mesLabel: "Setembro", expires: "2026-09-30" };

describe("lastDayOfMonthBrt (#13894)", () => {
  it("último dia do mês civil em BRT", () => {
    assert.equal(lastDayOfMonthBrt(new Date("2026-09-15T12:00:00Z")), "2026-09-30");
    assert.equal(lastDayOfMonthBrt(new Date("2028-02-10T12:00:00Z")), "2028-02-29");
    assert.equal(lastDayOfMonthBrt(new Date("2026-12-31T12:00:00Z")), "2026-12-31");
  });

  it("01/10 01:00 UTC ainda é 30/09 em BRT", () => {
    assert.equal(lastDayOfMonthBrt(new Date("2026-10-01T01:00:00Z")), "2026-09-30");
  });
});

describe("upsertBoxHeaderField (#13894)", () => {
  it("insere o campo como 1ª linha do header, sem tocar no resto", () => {
    const out = upsertBoxHeaderField(EXISTING, "expires", "2026-09-30");
    assert.ok(out.startsWith("<!--\nexpires: 2026-09-30\nnome: Artigo Especial Agosto\n"));
    assert.equal(out.replace("expires: 2026-09-30\n", ""), EXISTING);
  });

  it("troca a linha existente (idempotente no 2º reuso)", () => {
    const once = upsertBoxHeaderField(EXISTING, "expires", "2026-09-30");
    const twice = upsertBoxHeaderField(once, "expires", "2026-10-31");
    assert.equal(parseBoxHeaderField(twice, "expires"), "2026-10-31");
    assert.equal((twice.match(/expires:/g) ?? []).length, 1);
  });

  it("sem header, cria um no topo", () => {
    const out = upsertBoxHeaderField("**Box**\n\ntexto", "expires", "2026-09-30");
    assert.equal(parseBoxHeaderField(out, "expires"), "2026-09-30");
    assert.ok(out.endsWith("**Box**\n\ntexto"));
  });

  it("valor com quebra de linha lança", () => {
    assert.throws(() => upsertBoxHeaderField(EXISTING, "expires", "2026\n-09"));
  });
});

describe("renderArtigoEspecialBox grava expires: (#13894)", () => {
  it("arquivo existente: expires no header + título/frase atualizados", () => {
    const out = renderArtigoEspecialBox(EXISTING, INPUT);
    assert.equal(parseBoxHeaderField(out, "expires"), "2026-09-30");
    assert.match(out, /\*\*Artigo Especial de Setembro\*\*/);
  });

  it("bootstrap (arquivo ausente) também leva expires", () => {
    assert.equal(parseBoxHeaderField(renderArtigoEspecialBox(null, INPUT), "expires"), "2026-09-30");
  });

  it("sem expires no input, header intocado (back-compat)", () => {
    const out = renderArtigoEspecialBox(EXISTING, { ...INPUT, expires: undefined });
    assert.equal(parseBoxHeaderField(out, "expires"), null);
  });

  it("expires malformado aborta antes de escrever", () => {
    assert.throws(() => renderArtigoEspecialBox(EXISTING, { ...INPUT, expires: "30/09/2026" }), ArtigoEspecialBoxFormatError);
  });

  it("dentro do mês vale; edição do mês seguinte já está vencida", () => {
    const out = renderArtigoEspecialBox(EXISTING, INPUT);
    assert.equal(readSnippetExpiry(out, "2026-09-30").status, "valid");
    assert.equal(readSnippetExpiry(out, "2026-10-01").status, "expired");
  });
});

function auto(pinned: number[]): BoxesDivulgacaoAutoConfig {
  return { enabled: true, pinnedSlots: new Set(pinned as (1 | 2 | 3)[]), recentWindow: 3, priorWindow: 3, lastN: 20 };
}

describe("seleção pula o box do Artigo Especial vencido (#13894)", () => {
  it("pinado no slot 2: sai na última edição do mês, não na seguinte", () => {
    const dir = mkdtempSync(join(tmpdir(), "artigo-13894-"));
    try {
      const editionsDir = join(dir, "editions");
      const postsDir = join(dir, "posts");
      const snippetsDir = join(dir, "data", "snippets");
      for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
      writeFileSync(join(snippetsDir, "artigo-especial-apoiadores.md"), renderArtigoEspecialBox(EXISTING, INPUT));
      const opts = {
        boxesCfg: { slot0: "", slot1: null, slot2: "artigo-especial-apoiadores.md", slot3: null },
        autoCfg: auto([2]),
        editionsDir,
        postsDir,
        snippetsDir,
      };
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
      try {
        const inside = resolveBoxesForEdition({ ...opts, aammdd: "260930" });
        assert.equal(inside.effective.slot2, "artigo-especial-apoiadores.md");
        const after = resolveBoxesForEdition({ ...opts, aammdd: "261124" });
        assert.equal(after.effective.slot2, null, "box vencido não chega ao stitch");
        const rec2 = after.selection.find((s) => s.slot === 2)!;
        assert.equal(rec2.rejectReason, "expirado");
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
