/**
 * #13252 (edição 261116): a seleção de boxes pôs `encerramento-social-apoio.md`
 * no slot 1. O bloco "Para encerrar" saiu duas vezes em `02-reviewed.md` e a
 * cópia do slot trouxe `{{OPENING}}` cru. Cobre:
 *   1. a seleção nunca escolhe snippet de encerramento (nome ou marcador de
 *      template no corpo), em ranking, pin ou fallback;
 *   2. o invariante de `{{...}}` desconhecido em `02-reviewed.md`;
 *   3. o invariante de bloco "Nesta edição da diar.ia.br, usei..." duplicado.
 * `data/snippets/` é gitignored: tudo em diretório temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSnippetContent } from "../scripts/box-click-report.ts";
import { isSnippetEligibleForDiaria, resolveBoxesForEdition } from "../scripts/select-boxes-by-clicks.ts";
import { isNonBoxSnippet, findTemplatePlaceholder } from "../scripts/lib/shared/non-box-snippets.ts";
import {
  findUnknownTemplateMarkers,
  findClosingCreditsLines,
  isKnownEspMergeTag,
} from "../scripts/lib/lint-checks/reviewed-md-template-leaks.ts";
import {
  checkReviewedUnknownTemplateMarkers,
  checkReviewedDuplicateClosingBlock,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

// Mesmo formato do `data/snippets/encerramento-social-apoio.md` real (header
// encurtado): parágrafo de apoio com `{{OPENING}}` + parágrafo de créditos.
const APOIO = "Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria) para ganhar recompensas como **artigo especial do mês**.";
const CREDITOS_GEMINI =
  "Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)).";
const CREDITOS_CHATGPT = CREDITOS_GEMINI.replace("Gemini", "ChatGPT");
const ENCERRAMENTO = `<!--\nnome: PARA ENCERRAR\ncategoria: Para Encerrar\n-->\n\n{{OPENING}}${APOIO}\n\n${CREDITOS_GEMINI}\n`;

function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "box-encerramento-13252-"));
  const editionsDir = join(dir, "editions");
  const postsDir = join(dir, "posts");
  const snippetsDir = join(dir, "snippets");
  for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
  return { dir, editionsDir, postsDir, snippetsDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeEdition(editionsDir: string, aammdd: string, md: string): void {
  mkdirSync(join(editionsDir, aammdd), { recursive: true });
  writeFileSync(join(editionsDir, aammdd, "02-reviewed.md"), md);
}

function writePost(postsDir: string, id: string, iso: string, url: string, clicks: number): void {
  writeFileSync(
    join(postsDir, `${id}.json`),
    JSON.stringify({
      id,
      publish_date: Math.floor(new Date(`${iso}T09:00:00Z`).getTime() / 1000),
      stats: { clicks: [{ url, email: { verified_clicks: clicks, unique_verified_clicks: clicks } }] },
    }),
  );
}

const editionWithBox = (title: string, url: string) =>
  `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**${title}**\n\n[Link](${url})\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`;

describe("#13252 seleção de boxes: snippet de encerramento nunca é box", () => {
  it("encerramento-social-apoio.md é recusado por nome e, renomeado, pelo {{OPENING}} no corpo", () => {
    const real = parseSnippetContent("encerramento-social-apoio.md", ENCERRAMENTO);
    assert.equal(real.templatePlaceholderBody, true);
    assert.equal(isSnippetEligibleForDiaria(real), false);
    assert.equal(isNonBoxSnippet("encerramento-social-apoio.md"), true);
    assert.equal(isNonBoxSnippet("encerramento-mensal.md"), true);
    const renamed = parseSnippetContent("apoio-rodape.md", ENCERRAMENTO);
    assert.equal(isSnippetEligibleForDiaria(renamed), false);
  });

  it("marcador de template só casa maiúsculas sem espaço; merge tag de ESP e box comum seguem elegíveis", () => {
    assert.equal(findTemplatePlaceholder("x {{OPENING}} y"), "{{OPENING}}");
    assert.equal(findTemplatePlaceholder("[ok](https://x.com/?e={{ subscriber.email_address }})"), null);
    assert.equal(findTemplatePlaceholder("{{email}}"), null);
    const livros = parseSnippetContent("livros-divulgacao.md", "<!--\nnome: Livros\n-->\n**📚 Curadoria** [Confira](https://livros.diar.ia.br)");
    assert.equal(livros.templatePlaceholderBody, false);
    assert.equal(isSnippetEligibleForDiaria(livros), true);
  });

  it("cenário da 261116: encerramento com a URL do box mais clicado no pool não é escolhido pro slot 1", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = setupFixture();
    try {
      const apoia = "https://apoia.se/diaria";
      writeFileSync(join(snippetsDir, "encerramento-social-apoio.md"), ENCERRAMENTO);
      writeFileSync(join(snippetsDir, "livros.md"), "<!-- nome: Livros -->\n**📚 Livros**\n\n[Link](https://livros.diar.ia.br)");
      // A edição imediatamente anterior usou outra caixa (a anti-repetição não
      // tira o encerramento do páreo); as duas antes dela, um box com o link
      // do apoia.se, que casa com o snippet de encerramento no histórico.
      writeEdition(editionsDir, "261113", editionWithBox("Livros", "https://livros.diar.ia.br"));
      writePost(postsDir, "p1113", "2026-11-13", "https://livros.diar.ia.br", 2);
      writeEdition(editionsDir, "261112", editionWithBox("Apoie", apoia));
      writePost(postsDir, "p1112", "2026-11-12", apoia, 80);
      writeEdition(editionsDir, "261111", editionWithBox("Apoie", apoia));
      writePost(postsDir, "p1111", "2026-11-11", apoia, 70);
      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "261116",
        boxesCfg: { slot0: null, slot1: "x.md", slot2: "y.md", slot3: null },
        autoCfg: { enabled: true, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        snippetsDir,
      });
      assert.ok(selection.every((s) => s.file !== "encerramento-social-apoio.md"), JSON.stringify(selection));
      assert.notEqual(effective.slot1, "encerramento-social-apoio.md");
      assert.notEqual(effective.slot2, "encerramento-social-apoio.md");
    } finally {
      cleanup();
    }
  });

  it("encerramento pinado ou configurado como fallback sai vazio (auto ligada ou desligada)", () => {
    for (const enabled of [true, false]) {
      const { editionsDir, postsDir, snippetsDir, cleanup } = setupFixture();
      try {
        writeFileSync(join(snippetsDir, "encerramento-social-apoio.md"), ENCERRAMENTO);
        const { effective } = resolveBoxesForEdition({
          aammdd: "261116",
          boxesCfg: { slot0: "encerramento-social-apoio.md", slot1: "encerramento-social-apoio.md", slot2: null, slot3: null },
          autoCfg: { enabled, pinnedSlots: new Set([1]), recentWindow: 3, priorWindow: 3, lastN: 20 },
          editionsDir,
          postsDir,
          snippetsDir,
        });
        assert.equal(effective.slot0, null, `enabled=${enabled}`);
        assert.equal(effective.slot1, null, `enabled=${enabled}`);
      } finally {
        cleanup();
      }
    }
  });
});

// Trecho do 02-reviewed.md da 261116 antes da correção manual (backup
// `02-reviewed.md.pre-opening.bak`): cópia do encerramento no slot 1 + o
// PARA ENCERRAR de verdade no fim.
const REVIEWED_261116 = [
  "**DESTAQUE 1 | 🚀**",
  "",
  "[Título](https://d1.com)",
  "",
  "---",
  "",
  `{{OPENING}}${APOIO}`,
  "",
  CREDITOS_GEMINI,
  "",
  "---",
  "",
  "**DESTAQUE 2 | 🚀**",
  "",
  "---",
  "",
  "**PARA ENCERRAR**",
  "",
  APOIO,
  "",
  CREDITOS_CHATGPT,
  "",
].join("\n");

describe("#13252 guards em 02-reviewed.md", () => {
  it("{{OPENING}} é marcador desconhecido; merge tags de ESP e comentário HTML passam", () => {
    assert.deepEqual(findUnknownTemplateMarkers(REVIEWED_261116), [{ marker: "{{OPENING}}", line: 7 }]);
    for (const tag of ["{{ subscriber.email_address }}", "{{poll_token}}", "{{email}}", "{{ contact.EMAIL }}", "{{ unsubscribe }}", "{{email_address_id}}"]) {
      assert.equal(isKnownEspMergeTag(tag), true, tag);
    }
    assert.equal(isKnownEspMergeTag("{{IMAGE_TOOL}}"), false);
    const ok = `[Vote](https://diar.ia.br/vote?t={{poll_token}})\n\n<!-- {{OPENING}} só em comentário -->\n\n${APOIO}\n\n${CREDITOS_CHATGPT}`;
    assert.deepEqual(findUnknownTemplateMarkers(ok), []);
    assert.deepEqual(findClosingCreditsLines(ok), [7]);
  });

  it("parágrafo de créditos duplicado é detectado, com ou sem negrito na marca", () => {
    assert.deepEqual(findClosingCreditsLines(REVIEWED_261116), [9, 21]);
    assert.deepEqual(findClosingCreditsLines(CREDITOS_CHATGPT.replace("**diar.ia.br**", "diar.ia.br")), [1]);
  });

  it("invariantes: erro na edição da 261116, nada na edição corrigida; registrados nos Stages 2 e 4", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewed-13252-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261116);
      const markers = checkReviewedUnknownTemplateMarkers(dir);
      assert.equal(markers.length, 1);
      assert.equal(markers[0]!.severity, "error");
      assert.match(markers[0]!.message, /\{\{OPENING\}\}/);
      const dup = checkReviewedDuplicateClosingBlock(dir);
      assert.equal(dup.length, 1);
      assert.equal(dup[0]!.severity, "error");
      assert.match(dup[0]!.message, /2 vezes/);

      const fixed = REVIEWED_261116.replace(`{{OPENING}}${APOIO}\n\n${CREDITOS_GEMINI}\n\n---\n\n`, "");
      writeFileSync(join(dir, "02-reviewed.md"), fixed);
      assert.deepEqual(checkReviewedUnknownTemplateMarkers(dir), []);
      assert.deepEqual(checkReviewedDuplicateClosingBlock(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const id of ["reviewed-unknown-template-marker", "reviewed-duplicate-closing-block"]) {
      assert.ok(STAGE_2_RULES.some((r) => r.id === id && r.stage === 2), `stage 2: ${id}`);
      assert.ok(STAGE_4_RULES.some((r) => r.id === id && r.stage === 4), `stage 4: ${id}`);
    }
  });
});
