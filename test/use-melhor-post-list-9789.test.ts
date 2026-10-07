/**
 * Lote "use-melhor-post" (#9789, #9791, #9795) — regressões do 4º post social
 * (item USE MELHOR) levantadas pelo editor no gate do Stage 4 da edição 261007.
 *
 * - #9789: `## um` direto ao ponto, em lista numerada; capa sem o sufixo de
 *   formato do veículo.
 * - #9791: 2 recomendações por card quando couberem; o slide corta entre itens.
 * - #9795: chaves `um_carousel_p{k}` de slides apagados saem de
 *   `06-public-images.json` (gen-carousel-cards + upload) e o Stage 4 acusa.
 *
 * #9794 (social-writer a partir do texto da fonte) é mudança de prompt — o
 * guard aqui só trava que o dispatch e o agent carregam o insumo.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUseMelhorSlides,
  lintUseMelhorPostList,
  lintUseMelhorPostText,
  parseUseMelhorListItems,
  splitUseMelhorParagraphs,
  useMelhorSlideBody,
} from "../scripts/lib/use-melhor-carousel.ts";
import { splitParagraphIntoTwoBlocks } from "../scripts/lib/daily-carousel-card.ts";
import { resolveUseMelhorCoverTitle, stripUseMelhorTitleFormatSuffix } from "../scripts/lib/use-melhor-post.ts";
import {
  pruneStaleUseMelhorPublicImages,
  staleUseMelhorImageKeys,
  useMelhorSlotFromImageKey,
} from "../scripts/lib/use-melhor-slide-files.ts";
import { uploadPublicImages } from "../scripts/upload-images-public.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `## um` real da edição 261007, como o editor aprovou no gate. */
const UM_261007 = [
  "1) Peça **o primeiro rascunho** de e-mails, relatórios e propostas. Revise e ajuste o tom antes de usar.\n" +
    "2) **Resuma documentos longos** pedindo pontos principais, decisões e pendências. Confira com o original antes de decidir.",
  "3) **Prepare reuniões:** peça a pauta, as objeções possíveis e uma resposta para cada uma.\n" +
    "4) **Analise e-mails** perguntando qual é a solicitação e o prazo. Depois, peça um rascunho de resposta.",
  '5) **Aprenda mais rápido** contando o seu nível: "explique IA generativa como se eu fosse de marketing, sem formação técnica".',
  "#InteligenciaArtificial #Produtividade #ChatGPT #Claude #Gemini",
].join("\n\n");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(name = "261007"): string {
  const d = mkdtempSync(join(tmpdir(), "um-9789-"));
  dirs.push(d);
  const dir = join(d, name);
  mkdirSync(dir);
  return dir;
}

describe("#9789 — lista numerada direto ao ponto", () => {
  it("o `## um` aprovado na 261007 passa limpo nos dois lints", () => {
    assert.deepEqual(lintUseMelhorPostText(UM_261007), []);
    assert.deepEqual(lintUseMelhorPostList(UM_261007), []);
  });

  it("parágrafo de introdução no 1º slide é acusado", () => {
    const t = ["Um guia mostra como usar IA no trabalho.", "1) Faça A.\n2) Faça B.", "3) Faça C."].join("\n\n");
    assert.match(lintUseMelhorPostList(t).join(" | "), /1º parágrafo não é item da lista numerada/);
  });

  it("parágrafo fora da lista no meio/fim é acusado com o índice", () => {
    const t = ["1) Faça A.\n2) Faça B.", "Em resumo, vale testar.", "3) Faça C."].join("\n\n");
    assert.match(lintUseMelhorPostList(t).join(" | "), /parágrafo\(s\) 2 fora da lista/);
  });

  it("numeração descontínua é acusada", () => {
    const t = ["1) Faça A.\n2) Faça B.", "4) Faça D."].join("\n\n");
    assert.match(lintUseMelhorPostList(t).join(" | "), /não é contínua/);
  });

  it("aceita marcador `1.` e `1)`", () => {
    assert.deepEqual(
      parseUseMelhorListItems("1. Faça A.\n2) Faça B.")?.map((i) => i.n),
      [1, 2],
    );
    assert.equal(parseUseMelhorListItems("Texto corrido. 1) não conta"), null);
  });

  it("linha sem marcador depois de um item é continuação dele", () => {
    const items = parseUseMelhorListItems("1) Faça A\ncom detalhe.\n2) Faça B.");
    assert.deepEqual(items, [
      { n: 1, text: "1) Faça A com detalhe." },
      { n: 2, text: "2) Faça B." },
    ]);
  });

  it("capa: sufixo de formato do veículo sai do título automático", () => {
    assert.equal(
      stripUseMelhorTitleFormatSuffix("Como usar IA no trabalho: guia prático para profissionais em 2026"),
      "Como usar IA no trabalho",
    );
    assert.equal(stripUseMelhorTitleFormatSuffix("Prompts para planilhas - Tutorial completo"), "Prompts para planilhas");
    assert.equal(stripUseMelhorTitleFormatSuffix("Custom GPTs no trabalho | A complete guide"), "Custom GPTs no trabalho");
    // Sufixo que é ASSUNTO, título sem separador e cabeça curta demais ficam intactos.
    assert.equal(stripUseMelhorTitleFormatSuffix("ChatGPT: o que muda com o GPT-6"), "ChatGPT: o que muda com o GPT-6");
    assert.equal(stripUseMelhorTitleFormatSuffix("Guia do GPT-5 para iniciantes"), "Guia do GPT-5 para iniciantes");
    assert.equal(stripUseMelhorTitleFormatSuffix("Excel: guia prático"), "Excel: guia prático");
  });

  it("resolveUseMelhorCoverTitle aplica a limpeza no título da fonte, nunca no cover_title manual", () => {
    const item = {
      url: "https://x.com/guia",
      title: "Como usar IA no trabalho: guia prático para profissionais em 2026",
      summary: "",
      score: 50,
    };
    assert.equal(resolveUseMelhorCoverTitle(item, { reviewedMd: null, approved: null }), "Como usar IA no trabalho");
    assert.equal(
      resolveUseMelhorCoverTitle({ ...item, cover_title: "IA no trabalho: guia prático para profissionais" }, {
        reviewedMd: null,
        approved: null,
      }),
      "IA no trabalho: guia prático para profissionais",
    );
  });
});

describe("#9791 — 2 recomendações por card", () => {
  it("parágrafo agrupado vira 1 bloco por item no slide (corte entre itens, nunca no meio)", () => {
    const paras = splitUseMelhorParagraphs(UM_261007.split("\n\n#")[0]);
    assert.equal(paras.length, 3);
    const body = useMelhorSlideBody(paras[0]);
    const blocks = body.split("\n\n");
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /^1\) Peça/);
    assert.match(blocks[1], /^2\) \*\*Resuma/);
  });

  it("carrossel da 261007: capa + 3 cards + CTA (5 itens em 3 slides)", () => {
    const slides = buildUseMelhorSlides(UM_261007, "Como usar IA para produtividade");
    assert.deepEqual(
      slides.map((s) => s.slot),
      ["cover", "p1", "p2", "p3", "cta"],
    );
    assert.equal(slides[1].text.kicker, "01 / 03");
  });

  it("texto sem lista segue o caminho antigo (carimbo de edições antigas não muda)", () => {
    const p = "Primeira frase do parágrafo.   Segunda frase,\ncom quebra manual. Terceira frase **em negrito**.";
    assert.equal(useMelhorSlideBody(p), splitParagraphIntoTwoBlocks(p.replace(/\s+/g, " ").trim()));
  });

  it("2 cards vizinhos de 1 item curto que caberiam juntos → aviso de agrupar", () => {
    const t = ["1) Faça A.", "2) Faça B.", "3) Faça C."].join("\n\n");
    assert.match(lintUseMelhorPostList(t).join(" | "), /parágrafos 1\+2 cabem no mesmo card/);
  });

  it("nunca sugere fundir abaixo do mínimo de 2 parágrafos", () => {
    const t = ["1) Faça A.", "2) Faça B."].join("\n\n");
    assert.deepEqual(lintUseMelhorPostList(t), []);
  });

  it("itens longos que não cabem juntos não geram aviso", () => {
    const long = (n: number) =>
      `${n}) ${"Abra a planilha, selecione o intervalo inteiro e peça uma fórmula que some só as linhas marcadas. ".repeat(2).trim()}`;
    const t = [long(1), long(2), long(3)].join("\n\n");
    assert.equal(
      lintUseMelhorPostList(t).some((m) => /cabem no mesmo card/.test(m)),
      false,
    );
  });

  it("mais de 2 itens no mesmo parágrafo é acusado", () => {
    const t = ["1) A.\n2) B.\n3) C.", "4) D."].join("\n\n");
    assert.match(lintUseMelhorPostList(t).join(" | "), /mais de 2 itens/);
  });
});

describe("#9795 — chaves de slides antigos saem de 06-public-images.json", () => {
  const IMAGES = {
    d1_4x5: { url: "https://w/d1" },
    um_carousel_cover: { url: "https://w/c" },
    um_carousel_p1: { url: "https://w/p1" },
    um_carousel_p4: { url: "https://w/p4" },
    um_carousel_p5: { url: "https://w/p5" },
    um_carousel_cta: { url: "https://w/cta" },
  };
  function edition(withFiles: string[]): string {
    const dir = tmp();
    for (const f of withFiles) writeFileSync(join(dir, f), "jpg");
    writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: IMAGES }, null, 2));
    return dir;
  }
  const CURRENT = ["cover", "p1", "cta"].map((s) => `04-um-carousel-${s}-4x5.jpg`);

  it("slot de chave do 4º post", () => {
    assert.equal(useMelhorSlotFromImageKey("um_carousel_p12"), "p12");
    assert.equal(useMelhorSlotFromImageKey("um_carousel_cover"), "cover");
    assert.equal(useMelhorSlotFromImageKey("d1_carousel_p1"), null);
  });

  it("staleUseMelhorImageKeys: só as chaves sem arquivo, nunca os slots atuais", () => {
    const dir = edition(CURRENT);
    assert.deepEqual(staleUseMelhorImageKeys(IMAGES, dir).sort(), ["um_carousel_p4", "um_carousel_p5"]);
    // Slot do carimbo atual com arquivo sumido: preservado (#5085 cuida).
    assert.deepEqual(staleUseMelhorImageKeys(IMAGES, dir, ["cover", "p1", "p4", "cta"]), ["um_carousel_p5"]);
  });

  it("pruneStaleUseMelhorPublicImages reescreve o JSON sem as sobras", () => {
    const dir = edition(CURRENT);
    assert.deepEqual(pruneStaleUseMelhorPublicImages(dir, ["cover", "p1", "cta"]).sort(), ["um_carousel_p4", "um_carousel_p5"]);
    const out = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
    assert.deepEqual(Object.keys(out).sort(), ["d1_4x5", "um_carousel_cover", "um_carousel_cta", "um_carousel_p1"]);
    assert.deepEqual(pruneStaleUseMelhorPublicImages(dir), [], "idempotente");
  });

  it("pruneStaleUseMelhorPublicImages: JSON ausente/ilegível é no-op", () => {
    const dir = tmp();
    assert.deepEqual(pruneStaleUseMelhorPublicImages(dir), []);
    writeFileSync(join(dir, "06-public-images.json"), "{nope");
    assert.deepEqual(pruneStaleUseMelhorPublicImages(dir), []);
    assert.equal(readFileSync(join(dir, "06-public-images.json"), "utf8"), "{nope");
  });

  it("upload-images-public poda as chaves órfãs ao gravar o cache", async () => {
    const dir = edition(CURRENT);
    const res = await uploadPublicImages({
      editionDir: dir,
      destaques: [],
      uploaders: { uploadToCloudflare: async (_p: string, key: string) => `https://w/${key}` },
    });
    assert.equal("um_carousel_p4" in res.images, false);
    assert.equal("um_carousel_p5" in res.images, false);
    assert.ok(res.images.um_carousel_p1, "slide atual preservado");
    assert.ok(res.warnings.some((w) => /um_carousel_p4/.test(w)));
    const disk = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
    assert.equal("um_carousel_p5" in disk, false);
  });

  it("invariante do Stage 4 acusa chave sem arquivo (warning) e cala quando limpo", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "use-melhor-image-key-without-file");
    assert.ok(rule, "regra registrada em STAGE_4_RULES");
    const dir = edition(CURRENT);
    const v = rule!.run(dir) as { rule: string; severity: string; message: string }[];
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /um_carousel_p4, um_carousel_p5/);
    pruneStaleUseMelhorPublicImages(dir);
    assert.deepEqual(rule!.run(dir), []);
    assert.ok(existsSync(join(dir, "06-public-images.json")));
  });
});

describe("#9794 — social-writer recebe o texto da fonte", () => {
  it("dispatch do Stage 2 passa source_text_paths ao social-writer", () => {
    const stage2 = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-2.md"), "utf8");
    assert.match(stage2, /`source_text_paths` \(#9794\)/);
  });

  it("social-writer lê a fonte antes de escrever e faz a fonte prevalecer sobre o summary", () => {
    const agent = readFileSync(resolve(ROOT, ".claude/agents/social-writer.md"), "utf8");
    assert.match(agent, /`source_text_paths` \(opcional, #9794\)/);
    assert.match(agent, /vale o texto da fonte/);
    assert.match(agent, /`newsletter_md_path` \(opcional, #9794\)/);
  });
});
