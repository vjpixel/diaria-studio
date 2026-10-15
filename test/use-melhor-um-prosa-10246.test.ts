/**
 * #10246 — `## um` (4º post, USE MELHOR) em texto corrido quando o item não
 * tem `steps` (não é tutorial). Edição 261015: o item de maior score foi um
 * anúncio de inscrição (Itaú, programa Quant); o writer inventou "passos" a
 * partir de requisitos/prazos, o editor reescreveu o `## um` à mão em 3
 * parágrafos e o lint `use-melhor-um-shape` ficou em warning.
 *
 * Cobre: formato derivado do item (`useMelhorUmFormat`), lint de forma por
 * formato (`lintUseMelhorPostShape`), a invariante do Stage 4 com item sem
 * `steps` (o cenário real da issue), o carrossel com prosa, e o prompt dos
 * dois social agents.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  USE_MELHOR_PROSE_PARAGRAPHS,
  buildUseMelhorSlides,
  findOverflowingUseMelhorSlides,
  lintUseMelhorPostProse,
  lintUseMelhorPostShape,
} from "../scripts/lib/use-melhor-carousel.ts";
import {
  useMelhorUmFormat,
  writeUseMelhorPostState,
  type UseMelhorCandidate,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ON: UseMelhorPostConfigState = { enabled: true, time: "19:00" };

/** Forma do `## um` que o editor escreveu à mão na 261015 (texto corrido, 3 parágrafos). */
const UM_PROSA = [
  "O Itaú abriu inscrições para o **programa Quant**, que forma pessoas em ciência de dados aplicada ao mercado financeiro.",
  "O programa é gratuito e dá preferência a quem já tem base em estatística ou programação. As aulas são online.",
  "Quem quer migrar para dados no setor financeiro ganha uma porta de entrada com mentoria de quem trabalha na área.",
  "#InteligenciaArtificial #Carreira",
].join("\n\n");

/** Lista aprovada na 261007 (item tutorial). */
const UM_LISTA = [
  "1) Peça **o primeiro rascunho** de e-mails e propostas.\n2) **Resuma documentos longos** pedindo os pontos principais.",
  "3) **Prepare reuniões:** peça a pauta e as objeções possíveis.",
  "#InteligenciaArtificial",
].join("\n\n");

const ITEM_SEM_STEPS: UseMelhorCandidate = {
  url: "https://example.com/quant",
  title: "Programa Quant abre inscrições",
  summary: "Inscrições abertas.",
  score: 80,
};
const ITEM_COM_STEPS: UseMelhorCandidate = { ...ITEM_SEM_STEPS, steps: ["Crie a conta", "Envie o formulário"] };

describe("#10246 — formato do `## um` derivado do item", () => {
  it("com steps → lista; sem steps / steps vazio / sem item → prosa", () => {
    assert.equal(useMelhorUmFormat(ITEM_COM_STEPS), "lista");
    assert.equal(useMelhorUmFormat(ITEM_SEM_STEPS), "prosa");
    assert.equal(useMelhorUmFormat({ steps: [] }), "prosa");
    assert.equal(useMelhorUmFormat(null), "prosa");
  });
});

describe("#10246 — lint de forma por formato", () => {
  it("prosa de 3 parágrafos passa limpa num item sem steps (cenário da 261015)", () => {
    assert.deepEqual(lintUseMelhorPostShape(UM_PROSA, "prosa"), []);
  });

  it("a mesma prosa num item COM steps segue acusada (tutorial pede lista)", () => {
    assert.match(lintUseMelhorPostShape(UM_PROSA, "lista").join(" | "), /1º parágrafo não é item da lista numerada/);
  });

  it("item sem steps também aceita lista bem formada (escolha do editor não vira warning)", () => {
    assert.deepEqual(lintUseMelhorPostShape(UM_LISTA, "prosa"), []);
    assert.deepEqual(lintUseMelhorPostShape(UM_LISTA, "lista"), []);
  });

  it("prosa com nº de parágrafos ≠ 3 é acusada", () => {
    const dois = ["Primeiro parágrafo corrido.", "Segundo parágrafo corrido.", "#IA"].join("\n\n");
    assert.match(lintUseMelhorPostProse(dois).join(" | "), new RegExp(`pede ${USE_MELHOR_PROSE_PARAGRAPHS}`));
    assert.match(lintUseMelhorPostShape(dois, "prosa").join(" | "), /2 parágrafos/);
  });

  it("fora da faixa 2–6 só o lint genérico acusa (sem mensagem duplicada)", () => {
    const um = ["Só um parágrafo.", "#IA"].join("\n\n");
    assert.deepEqual(lintUseMelhorPostProse(um), []);
    assert.equal(lintUseMelhorPostShape(um, "prosa").length, 1);
  });

  it("prosa com parágrafo em lista no meio é acusada", () => {
    const misto = ["Texto corrido abrindo.", "1) Um passo.\n2) Outro passo.", "Fechando em prosa.", "#IA"].join("\n\n");
    assert.match(lintUseMelhorPostShape(misto, "prosa").join(" | "), /parágrafo\(s\) 2 em lista numerada/);
  });
});

describe("#10246 — carrossel com texto corrido", () => {
  it("3 parágrafos de prosa viram capa + 3 slides + CTA, sem marcador de lista, e cabem no card", () => {
    const slides = buildUseMelhorSlides(UM_PROSA, ITEM_SEM_STEPS.title);
    assert.deepEqual(
      slides.map((s) => s.slot),
      ["cover", "p1", "p2", "p3", "cta"],
    );
    assert.match(slides[1].text.title, /programa Quant/);
    for (const s of slides.slice(1, 4)) assert.doesNotMatch(s.text.title, /^\d+\)/);
    assert.deepEqual(findOverflowingUseMelhorSlides(UM_PROSA, ITEM_SEM_STEPS.title), []);
  });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function edition(um: string, item: UseMelhorCandidate): string {
  const dir = mkdtempSync(join(tmpdir(), "um-10246-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const d = "Parágrafo curto do destaque.\n\nOutro parágrafo.\n\nMais um.\n\n#IA";
  writeFileSync(
    join(dir, "03-social.md"),
    ["# Social", "", "## d1", "", d, "", "## d2", "", d, "", "## d3", "", d, "", "## um", "", um, ""].join("\n"),
    "utf8",
  );
  writeUseMelhorPostState(dir, { enabled: true, time: "19:00", item, generated_at: "x" });
  return dir;
}

describe("#10246 — invariante `use-melhor-um-shape` do Stage 4", () => {
  const shape = (dir: string) => checkCarouselTextOverflow(dir, ON).filter((v) => v.rule === "use-melhor-um-shape");

  it("item sem steps + `## um` em prosa → sem warning (antes do fix: warning de lista)", () => {
    assert.deepEqual(shape(edition(UM_PROSA, ITEM_SEM_STEPS)), []);
  });

  it("item com steps + `## um` em prosa → warning (tutorial segue pedindo lista)", () => {
    const v = shape(edition(UM_PROSA, ITEM_COM_STEPS));
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
  });
});

describe("#10246 — prompt dos social agents", () => {
  for (const agent of ["social-writer", "social-curto"]) {
    it(`${agent}.md manda texto corrido quando o item não tem steps`, () => {
      const md = readFileSync(resolve(ROOT, `.claude/agents/${agent}.md`), "utf8");
      assert.match(md, /#10246/);
      assert.match(md, /Sem `item\.steps`[^\n]*texto corrido/);
    });
  }
});
