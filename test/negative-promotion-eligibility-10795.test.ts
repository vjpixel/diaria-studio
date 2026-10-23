/**
 * test/negative-promotion-eligibility-10795.test.ts (#10795)
 *
 * Decisão do editor no briefing overnight 261023: duas restrições à promoção
 * de destaque negativo para o top-3/D1, sobre o `scorer-select` atual —
 * (1) processo/acusação não é dano já ocorrido; (2) entidade+tema que já foi
 * destaque nos últimos 14 dias não é promovido. O `scorer-select` não recebe
 * os destaques passados, então a regra 2 é TS (`negative-promotion-eligibility.ts`,
 * plugado no `demote-same-fact-highlights.ts`). Os casos reais: 261016 (8
 * estados processam a OpenAI, negativo que desceu de D1) e 261022 (Muse da
 * Meta, tema repetido em outubro).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  applyNegativePromotionEligibility,
  findRecentThemeMatch,
  isAllegationHeadline,
  withinThemeWindow,
} from "../scripts/lib/negative-promotion-eligibility.ts";
import { demoteGenericStudyHighlights } from "../scripts/lib/generic-study-penalty.ts";
import { resolveDestaques } from "../scripts/apply-gate-edits.ts";
import type { PublishedDestaque } from "../scripts/lib/same-fact-demotion.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type H = {
  rank: number;
  score: number;
  url: string;
  article: { url: string; title: string; summary: string; negative_impact?: boolean };
  negative_promotion_excluded?: string;
};
let seq = 0;
function hl(title: string, score: number, negative = false, summary = ""): H {
  seq += 1;
  const url = `https://ex${seq}.com/a`;
  return { rank: 0, score, url, article: { url, title, summary, ...(negative ? { negative_impact: true } : {}) } };
}
const ranked = (...hs: H[]) => hs.map((h, i) => ({ ...h, rank: i + 1 }));
const titles = (hs: H[]) => hs.map((h) => h.article.title);
const past = (aammdd: string, title: string, text = ""): PublishedDestaque => ({
  aammdd,
  n: 1,
  title,
  url: `https://old.example/${aammdd}`,
  text,
});

describe("isAllegationHeadline (#10795 regra 1)", () => {
  it("reconhece processo/acusação judicial", () => {
    for (const t of [
      "Oito estados processam a OpenAI por danos a adolescentes",
      "Coligação aciona o TSE contra vídeo feito com IA",
      "OAB-SP move processo contra a Enter",
      "Empresa é acusada de treinar IA com dados de clientes",
      "Authors sue Anthropic over pirated books",
      "Nova ação judicial contra a Meta por chatbot",
    ]) {
      assert.equal(isAllegationHeadline(t), true, t);
    }
  });
  it("não confunde 'processo' no sentido de procedimento nem dano concreto", () => {
    for (const t of [
      "IA acelera o processo de contratação no varejo",
      "Óculos da Meta gravaram sem comando, admite empresa",
      "Modelo gastou cripto de terceiros, diz relatório da OpenAI",
      "Processador novo da Nvidia",
    ]) {
      assert.equal(isAllegationHeadline(t), false, t);
    }
  });
});

describe("applyNegativePromotionEligibility — processo/acusação", () => {
  it("negativo de processo promovido sai do top-3; negativo de dano concreto ocupa D3", () => {
    const merit = [hl("Claude acha proteínas novas", 92), hl("Nubank lança nota fiscal com IA", 88), hl("Mistral voz", 85)];
    const processo = hl("Oito estados processam a OpenAI", 80, true);
    const concreto = hl("Óculos da Meta gravaram sem comando", 70, true);
    // scorer-select promoveu o processo para D1 (padrão de incidente).
    const input = ranked(processo, merit[0], merit[1], merit[2], concreto);
    const r = applyNegativePromotionEligibility(input, []);
    assert.deepEqual(titles(r.highlights.slice(0, 3)), [
      "Claude acha proteínas novas",
      "Nubank lança nota fiscal com IA",
      "Óculos da Meta gravaram sem comando",
    ]);
    const moved = r.highlights.find((h) => h.article.title === processo.article.title)!;
    assert.equal(moved.rank, 4, "vai para o pool, nunca descartado");
    assert.equal(moved.negative_promotion_excluded, "acusacao");
    assert.equal(r.highlights.length, input.length);
    assert.deepEqual(r.highlights.map((h) => h.rank), [1, 2, 3, 4, 5, 6].slice(0, input.length));
    assert.equal(r.actions[0].action, "removido-do-top3");
    assert.equal(r.no_eligible_negative, false);
  });

  it("processo no trio por mérito fica, mas desce de D1 se há item de score maior", () => {
    const processo = hl("Coligação aciona o TSE contra deepfake", 86, true);
    const a = hl("Gemini ganha painel para PMEs", 90);
    const b = hl("Nubank nota fiscal", 81);
    const r = applyNegativePromotionEligibility(ranked(processo, a, b, hl("Reserva", 60)), []);
    assert.deepEqual(titles(r.highlights.slice(0, 3)), [a.article.title, processo.article.title, b.article.title]);
    assert.equal(r.actions[0].action, "desceu-no-trio");
    assert.equal(r.highlights[1].negative_promotion_excluded, undefined, "continua no trio, sem marca de exclusão");
  });

  it("processo no trio por mérito e já na posição de mérito: nada muda", () => {
    const processo = hl("Oito estados processam a OpenAI", 95, true);
    const input = ranked(processo, hl("X", 90), hl("Y", 80), hl("Z", 70));
    const r = applyNegativePromotionEligibility(input, []);
    assert.equal(r.actions.length, 0);
    assert.deepEqual(r.highlights, input);
  });

  it("sem negativo elegível: sinaliza, não inventa tag, não muta a entrada", () => {
    const input = ranked(hl("A", 90), hl("B", 88), hl("Estados processam a OpenAI", 70, true), hl("C", 75));
    const before = JSON.stringify(input);
    const r = applyNegativePromotionEligibility(input, []);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(titles(r.highlights.slice(0, 3)), ["A", "B", "C"]);
    assert.equal(r.no_eligible_negative, true);
    assert.ok(!r.highlights.slice(0, 3).some((h) => h.article.negative_impact), "nenhum tag inventado");
  });

  it("sem substituto elegível: mantém e registra", () => {
    // único reserva já foi rebaixado por MESMO FATO (#9100): não sobe de volta.
    const reserva = { ...hl("D", 70), same_fact_demoted: { matched_edition: "261020" } };
    const r = applyNegativePromotionEligibility(ranked(hl("A", 90), hl("B", 88), hl("Empresa é acusada de fraude com IA", 60, true), reserva), []);
    assert.equal(r.actions[0].action, "mantido-sem-substituto");
    assert.equal(r.highlights[2].article.title, "Empresa é acusada de fraude com IA");
  });

  it("não-negativo de processo não é afetado (a regra é sobre promoção de negativo)", () => {
    const input = ranked(hl("Autores processam a Anthropic", 70), hl("A", 90), hl("B", 88), hl("C", 80));
    assert.equal(applyNegativePromotionEligibility(input, []).actions.length, 0);
  });
});

describe("applyNegativePromotionEligibility — entidade+tema em 14 dias", () => {
  const merit = () => [hl("Claude acha proteínas", 92), hl("Nubank nota", 88), hl("Mistral voz", 85)];

  it("caso Muse (261022): tema repetido dentro da janela sai do top-3", () => {
    const muse = hl("Muse da Meta vaza links privados de usuários", 72, true);
    const concreto = hl("Óculos gravaram sem comando", 66, true);
    const m = merit();
    const window = withinThemeWindow([past("261015", "Muse da Meta expõe links privados")], "261022");
    const r = applyNegativePromotionEligibility(ranked(muse, ...m, concreto), window);
    assert.ok(!r.highlights.slice(0, 3).some((h) => h.article.title === muse.article.title));
    assert.ok(r.highlights.slice(0, 3).some((h) => h.article.title === concreto.article.title));
    const a = r.actions[0];
    assert.equal(a.why.kind, "tema-recente");
    assert.ok(a.why.kind === "tema-recente" && a.why.match.shared_entities.includes("meta"));
  });

  it("janela é de 14 dias: 261008 entra, 261007 (15 dias) fica fora", () => {
    const pastItems = [past("261007", "Muse da Meta expõe links privados")];
    assert.deepEqual(withinThemeWindow(pastItems, "261022"), []);
    const inWindow = withinThemeWindow([past("261008", "Muse da Meta expõe links privados")], "261022");
    assert.equal(inWindow.length, 1);
    // edição corrente e futura nunca são "passadas"
    assert.deepEqual(withinThemeWindow([past("261022", "x"), past("261023", "y")], "261022"), []);
  });

  it("só a entidade não basta: mesma empresa, outro tema, fica", () => {
    const neg = hl("Muse da Meta vaza links privados", 72, true);
    const window = withinThemeWindow([past("261015", "Meta lança Muse para criadores de vídeo")], "261022");
    assert.equal(findRecentThemeMatch(neg, window), null);
  });

  it("mesmo fato do #9100 (mesma URL) também conta na janela de 14 dias", () => {
    const neg = hl("Título reescrito", 72, true);
    const window: PublishedDestaque[] = [{ aammdd: "261012", n: 2, title: "Outro título", url: neg.url, text: "" }];
    const m = findRecentThemeMatch(neg, window);
    assert.equal(m?.evidence, "same-fact");
  });
});

describe("passos seguintes não re-promovem o excluído", () => {
  it("penalidade de estudo genérico (#9462) não puxa o excluído de volta ao top-3", () => {
    const study = hl("Pesquisa mostra que 40% das empresas usam IA", 90);
    const excluded = { ...hl("Oito estados processam a OpenAI", 80, true), negative_promotion_excluded: "acusacao" };
    const neg = hl("Óculos gravaram sem comando", 70, true);
    const r = demoteGenericStudyHighlights(ranked(hl("A", 92), study, neg, excluded, hl("B", 60)));
    assert.ok(!r.highlights.slice(0, 3).some((h) => h.article.title === excluded.article.title));
  });

  it("preenchimento automático do gate (resolveDestaques) pula o excluído", () => {
    const excluded = { ...hl("Estados processam a OpenAI", 80, true), negative_promotion_excluded: "acusacao" };
    const a = hl("A", 90);
    const b = hl("B", 85);
    const c = hl("C", 70);
    const hs = ranked(a, b, excluded, c);
    const urls = resolveDestaques(
      { destaques: [], lancamento: [], radar: hs.map((h) => h.url), use_melhor: [], video: [] },
      hs,
    );
    assert.deepEqual(urls, [a.url, b.url, c.url]);
  });
});

describe("CLI demote-same-fact-highlights aplica a política (#10795)", () => {
  it("tira o negativo de tema recente do top-3, grava log e é idempotente no resume", () => {
    const root = mkdtempSync(join(tmpdir(), "neg-10795-cli-"));
    try {
      const editionsDir = join(root, "editions");
      const mk = (aammdd: string, md: string) => {
        const dir = join(editionsDir, aammdd.slice(0, 4), aammdd);
        mkdirSync(join(dir, "_internal"), { recursive: true });
        if (md) writeFileSync(join(dir, "02-reviewed.md"), md);
        writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [] }));
      };
      // 7 dias antes: fora da janela de 3 edições do #9100, dentro dos 14 dias.
      mk(
        "261015",
        "**DESTAQUE 1 | 🔒 SEGURANÇA**\n\n**[Muse da Meta expõe links privados](https://old.example/muse)**  \n\nO Muse da Meta expôs links.\n\nPor que isso importa:\n\nPorque sim.\n\n---\n",
      );
      for (const d of ["261019", "261020", "261021"]) mk(d, "");
      mk("261022", "");
      const muse = hl("Muse da Meta vaza links privados de usuários", 72, true);
      const others = [hl("Claude acha proteínas", 92), hl("Nubank nota", 88), hl("Mistral voz", 85)];
      const concreto = hl("Óculos gravaram sem comando", 66, true);
      const hs = ranked(muse, ...others, concreto);
      const catPath = join(editionsDir, "2610", "261022", "_internal", "01-categorized.json");
      writeFileSync(catPath, JSON.stringify({ highlights: hs, radar: hs.map((h) => h.article), lancamento: [], use_melhor: [], video: [] }));
      const logPath = join(root, "log.json");
      const run = () =>
        spawnSync(
          process.execPath,
          ["--import", "tsx", resolve(ROOT, "scripts/demote-same-fact-highlights.ts"), "--categorized", catPath, "--current-edition", "261022", "--editions-dir", editionsDir, "--out-log", logPath],
          { encoding: "utf8" },
        );
      const res = run();
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout.trim().split("\n").pop()!);
      assert.equal(out.negative_promotion, 1);
      assert.ok(out.notes.some((n: string) => n.includes("#10795") && n.includes("Muse")));
      const cat = JSON.parse(readFileSync(catPath, "utf8"));
      const top3 = cat.highlights.filter((h: H) => h.rank <= 3).map((h: H) => h.article.title);
      assert.ok(!top3.includes(muse.article.title));
      assert.ok(top3.includes(concreto.article.title));
      assert.equal(cat.highlights.length, hs.length, "nada descartado");
      const log = JSON.parse(readFileSync(logPath, "utf8"));
      assert.equal(log.negative_promotion.length, 1);
      assert.equal(log.negative_promotion[0].why.kind, "tema-recente");

      const res2 = run();
      assert.equal(res2.status, 0, res2.stderr);
      assert.equal(JSON.parse(res2.stdout.trim().split("\n").pop()!).negative_promotion, 0, "idempotente");
      assert.equal(JSON.parse(readFileSync(logPath, "utf8")).negative_promotion.length, 1, "resume não apaga o log");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prompts e regra editorial carregam as duas regras (#10795)", () => {
  it("scorer-select, scorer e editorial-rules", () => {
    for (const rel of [".claude/agents/scorer-select.md", ".claude/agents/scorer.md", "context/editorial-rules.md"]) {
      const txt = readFileSync(resolve(ROOT, rel), "utf8");
      assert.match(txt, /[Pp]rocesso\/acusação[^\n]*não é dano já ocorrido/, `${rel}: regra de processo/acusação`);
      assert.match(txt, /[Ee]ntidade\+tema que já foi destaque nos últimos 14 dias/, `${rel}: regra de 14 dias`);
      assert.match(txt, /negative-promotion-eligibility\.ts/, `${rel}: aponta o enforcement em TS`);
    }
    const select = readFileSync(resolve(ROOT, ".claude/agents/scorer-select.md"), "utf8");
    const idx = select.indexOf("Incidente com dano já ocorrido sobe para D1");
    const line = select.slice(idx, select.indexOf("\n", idx));
    assert.match(line, /Processo\/acusação e entidade\+tema/);
  });
});
