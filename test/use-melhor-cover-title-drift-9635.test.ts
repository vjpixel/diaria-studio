/**
 * test/use-melhor-cover-title-drift-9635.test.ts (#9635)
 *
 * Desde o #9630 o carimbo do carrossel do 4º post (USE MELHOR) guarda o
 * `cover_title` usado no Stage 3, e editar o título do item no gate 4 não
 * derruba mais o carrossel — mas a capa sai com o título ANTERIOR (ex.: em
 * inglês) sem aviso nenhum. Este arquivo trava o aviso não bloqueante: linha
 * ⚠️ no status do gate 4 e `coverTitleWarning` no plano do Stage 5, com o
 * carrossel seguindo válido.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  describeUseMelhorPostStatus,
  writeUseMelhorPostState,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { planUseMelhorDispatch, freshUseMelhorCarouselSlots } from "../scripts/lib/use-melhor-dispatch.ts";
import { readUseMelhorCarouselStamp, useMelhorCoverTitleDrift } from "../scripts/lib/use-melhor-carousel.ts";
import { gatherUseMelhorStatusInput } from "../scripts/lib/use-melhor-status.ts";
import { genCarouselCards } from "../scripts/gen-carousel-cards.ts";

const ON: UseMelhorPostConfigState = { enabled: true, time: "08:00" };
const CONFIG_ON = { publishing: { social: { use_melhor_time: "08:00" } } };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-9635-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

const URL = "https://www.jotform.com/ai/what-is-a-custom-gpt/";
const SOURCE_TITLE = "What is a custom GPT? From GPT Builder to plug-ins in 2026";
const ITEM = { url: URL, title: SOURCE_TITLE, summary: "", score: 45 };
const APPROVED = { use_melhor: [ITEM] };
const reviewedWith = (t: string) => `**USE MELHOR**\n\n**[${t}](${URL})**\nDescrição. (5 min)\n`;
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo.`;
const UM_TEXT = [P("GPT personalizado em três passos."), P("Abra o editor."), "#IA"].join("\n\n");
const D = [P("Primeiro."), P("Segundo."), P("Terceiro."), "#IA"].join("\n\n");
const SOCIAL = ["# Social", "", "## d1", "", D, "", "## d2", "", D, "", "## d3", "", D, "", "## um", "", UM_TEXT, "", "# Curto", "", "## d1", "", "x", "", "## um", "", "curto", ""].join("\n");

async function stage3(dir: string, title: string): Promise<void> {
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED));
  writeFileSync(join(dir, "02-reviewed.md"), reviewedWith(title));
  writeUseMelhorPostState(dir, { enabled: true, time: "08:00", item: ITEM, generated_at: "x" });
  writeFileSync(join(dir, "03-social.md"), SOCIAL);
  await genCarouselCards(dir, {
    render: (async (_t: string, outPaths: Record<string, string>) => {
      for (const p of Object.values(outPaths)) writeFileSync(p, "x");
      return outPaths;
    }) as never,
    useMelhorConfig: ON,
    renderUseMelhor: async (d, slides) => {
      for (const s of slides) writeFileSync(join(d, `04-um-carousel-${s.slot}-4x5.jpg`), "x");
      return [];
    },
  });
}

describe("#9635 — aviso quando a capa do 4º post usa título diferente do item na edição", () => {
  it("REGRESSÃO: título traduzido no gate 4 depois do Stage 3 → ⚠️ no status do gate, carrossel segue valendo", async () => {
    const dir = tmpEdition();
    await stage3(dir, SOURCE_TITLE);
    assert.equal(readUseMelhorCarouselStamp(dir)?.cover_title, SOURCE_TITLE);
    writeFileSync(join(dir, "02-reviewed.md"), reviewedWith("O que é um GPT personalizado"));

    const input = gatherUseMelhorStatusInput(dir, ON);
    assert.equal(input.carouselStale, false);
    assert.match(input.coverTitleDrift ?? "", /título anterior \("What is a custom GPT\?/);
    assert.match(input.coverTitleDrift ?? "", /"O que é um GPT personalizado"/);
    assert.match(input.coverTitleDrift ?? "", /gen-carousel-cards\.ts --edition-dir .* --force/);
    assert.match(input.coverTitleDrift ?? "", /upload-images-public\.ts/);

    const status = describeUseMelhorPostStatus(input);
    assert.equal(status.level, "warn");
    assert.ok(status.lines.some((l) => l.includes("⚠️ capa do carrossel com o título anterior")), status.lines.join("\n"));
    assert.ok(status.lines.some((l) => /carrossel: \d+ slides/.test(l)), "carrossel continua listado como válido");
  });

  it("REGRESSÃO: Stage 5 — plano pronto, slots mantidos, coverTitleWarning presente, imageWarning ausente", async () => {
    const dir = tmpEdition();
    await stage3(dir, SOURCE_TITLE);
    writeFileSync(join(dir, "02-reviewed.md"), reviewedWith("O que é um GPT personalizado"));
    const plan = planUseMelhorDispatch(dir, CONFIG_ON);
    assert.equal(plan.status, "ready", JSON.stringify(plan));
    if (plan.status !== "ready") return;
    assert.deepEqual(plan.slots, readUseMelhorCarouselStamp(dir)?.slots);
    assert.equal(plan.imageWarning, undefined);
    assert.match(plan.coverTitleWarning ?? "", /título anterior/);
    assert.ok(freshUseMelhorCarouselSlots(dir).length > 0, "upload ainda sobe os slides");
  });

  it("título igual ao gravado → sem aviso (status ok, plano sem coverTitleWarning)", async () => {
    const dir = tmpEdition();
    await stage3(dir, "O que é um GPT personalizado");
    const input = gatherUseMelhorStatusInput(dir, ON);
    assert.equal(input.coverTitleDrift, null);
    assert.equal(describeUseMelhorPostStatus(input).level, "ok");
    const plan = planUseMelhorDispatch(dir, CONFIG_ON);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    assert.equal(plan.coverTitleWarning, undefined);
  });

  it("re-rodar o Stage 3 com --force após a edição → carimbo atualizado e aviso some", async () => {
    const dir = tmpEdition();
    await stage3(dir, SOURCE_TITLE);
    writeFileSync(join(dir, "02-reviewed.md"), reviewedWith("O que é um GPT personalizado"));
    await genCarouselCards(dir, {
      force: true,
      render: (async (_t: string, o: Record<string, string>) => o) as never,
      useMelhorConfig: ON,
      renderUseMelhor: async (d, slides) => {
        for (const s of slides) writeFileSync(join(d, `04-um-carousel-${s.slot}-4x5.jpg`), "y");
        return [];
      },
    });
    assert.equal(readUseMelhorCarouselStamp(dir)?.cover_title, "O que é um GPT personalizado");
    assert.equal(gatherUseMelhorStatusInput(dir, ON).coverTitleDrift, null);
  });

  it("useMelhorCoverTitleDrift: carimbo antigo sem cover_title, título nulo e espaços nas pontas não avisam", () => {
    const stamp = { hash: "h", slots: ["cover", "p1", "cta"] };
    assert.equal(useMelhorCoverTitleDrift(null, "x"), null);
    assert.equal(useMelhorCoverTitleDrift(stamp, "Novo"), null);
    assert.equal(useMelhorCoverTitleDrift({ ...stamp, cover_title: "A" }, null), null);
    assert.equal(useMelhorCoverTitleDrift({ ...stamp, cover_title: " A " }, "A"), null);
    assert.deepEqual(useMelhorCoverTitleDrift({ ...stamp, cover_title: "A" }, "B"), { stamped: "A", current: "B" });
  });
});
