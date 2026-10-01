/**
 * test/pool-summary-quality-9358.test.ts (#9358)
 *
 * Regressão (#633): resumos de item do pool chegavam ao gate como teaser/lede
 * da fonte, cortados, curtos, com rodapé do WordPress ou boilerplate do
 * YouTube — e nada na pipeline barrava (o editor reescrevia ~3 por edição).
 * Casos abaixo são textos REAIS do último arquivo da pipeline
 * (`_internal/02-clarice-corrected.md`) das edições citadas na issue.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPoolSummaryQuality,
  detectPoolSummaryDefects,
} from "../scripts/lib/lint-checks/pool-summary-quality.ts";
import { forEachSecondaryItem } from "../scripts/lib/lint-checks/secondary-item-walker.ts";
import { cleanSummary, stripFeedBoilerplate } from "../scripts/lib/clean-summary.ts";
import { checkReviewedPassesAllLints } from "../scripts/lib/invariant-checks/stage-2.ts";

const GOOD =
  "Assinantes dos planos Google AI passam a ter o Colab premium incluído, com prioridade em aceleradores e GPUs Premium.";

function pool(section: string, title: string, desc: string): string {
  return `**${section}**\n\n**[${title}](https://example.com/${encodeURIComponent(title)})**  \n${desc}\n`;
}

describe("detectPoolSummaryDefects (#9358)", () => {
  it("resumo completo, factual e com ponto final não tem defeito", () => {
    assert.deepEqual(detectPoolSummaryDefects(GOOD), []);
    assert.deepEqual(detectPoolSummaryDefects(`${GOOD} (5 min)`), []);
  });

  it("CASO REAL 260824: corte da fonte SEM reticências → no-final-punctuation", () => {
    const d =
      "Arch Capital usa inteligência artificial para prever riscos climáticos com até 36 meses de antecedência e proteger edifícios corporativos e";
    assert.deepEqual(detectPoolSummaryDefects(d), ["no-final-punctuation"]);
  });

  it("CASO REAL 260828: falta ponto antes do sufixo (N min) do USE MELHOR", () => {
    const d =
      "Classificada como principal risco de segurança por especialistas, a técnica pode levar sistemas de IA a agir fora do previsto (5 min)";
    assert.deepEqual(detectPoolSummaryDefects(d), ["no-final-punctuation"]);
  });

  it("CASO REAL 260908: reticências finais (…, ... e [...] do WordPress)", () => {
    const base =
      "A Faculdade Sírio-Libanês tornou-se pioneira entre as instituições de ensino do país ao estabelecer";
    assert.ok(detectPoolSummaryDefects(`${base}…`).includes("trailing-ellipsis"));
    assert.ok(detectPoolSummaryDefects(`${base}...`).includes("trailing-ellipsis"));
    assert.ok(detectPoolSummaryDefects(`${base} [...]`).includes("trailing-ellipsis"));
    assert.ok(detectPoolSummaryDefects(`${base} […] (5 min)`).includes("trailing-ellipsis"));
    // reticência final não acumula com no-final-punctuation
    assert.ok(!detectPoolSummaryDefects(`${base}…`).includes("no-final-punctuation"));
  });

  it("CASO REAL 260807/260819: teaser curto vira too-short", () => {
    assert.deepEqual(detectPoolSummaryDefects("Ter um site bonito é só metade do caminho."), ["too-short"]);
    assert.ok(
      detectPoolSummaryDefects("Um piloto inédito de avaliações de IA em duplo-cego.").includes("too-short"),
    );
    // citação cortada: curta e sem fecho
    assert.deepEqual(detectPoolSummaryDefects('"Não são super tecnologias.'), ["too-short"]);
  });

  it("too-short mede sem o prefixo [TRADUZIR] e sem o sufixo (N min)", () => {
    const d = "O Gemini é a plataforma de inteligência artificial (IA) do Google. (15 min)";
    assert.deepEqual(detectPoolSummaryDefects(d), ["too-short"]);
    assert.deepEqual(detectPoolSummaryDefects(`[TRADUZIR] ${GOOD}`), []);
  });

  it("CASO REAL: espaço antes de pontuação", () => {
    const d = `Ferramenta de geração de imagens da Meta , trouxe em seu lançamento um recurso de edição por texto para os usuários .`;
    assert.ok(detectPoolSummaryDefects(d).includes("space-before-punctuation"));
    // reticências com espaço não contam como "espaço antes de ponto"
    assert.ok(!detectPoolSummaryDefects(`${GOOD.slice(0, -1)} ...`).includes("space-before-punctuation"));
  });

  it("CASO REAL: rodapé do WordPress no lugar do resumo", () => {
    const d =
      "O post Por que você não vai trabalhar menos com IA apareceu primeiro em MIT Technology Review - Brasil.";
    assert.ok(detectPoolSummaryDefects(d).includes("wordpress-footer"));
    assert.ok(
      detectPoolSummaryDefects("The post Foo bar baz appeared first on Some Blog with a long enough tail here.").includes(
        "wordpress-footer",
      ),
    );
  });

  it("CASO REAL 260831: descrição padrão do YouTube", () => {
    const d =
      "Aproveite vídeos e músicas que você ama, envie e compartilhe conteúdo original com amigos, parentes e o mundo no YouTube.";
    assert.deepEqual(detectPoolSummaryDefects(d), ["youtube-boilerplate"]);
  });

  it("CASO REAL 260922: links relacionados do TechTudo (emoji) colados", () => {
    const d =
      "Veja como usar o assistente no celular para organizar tarefas. 📝Como usar o ChatGPT no WhatsApp 🔎 Claude + Gemini.";
    assert.ok(detectPoolSummaryDefects(d).includes("emoji-noise"));
  });

  it("©/®/™ em nome de produto não contam como emoji", () => {
    assert.deepEqual(
      detectPoolSummaryDefects("O Microsoft® Copilot™ ganhou um modo de pesquisa que cita as fontes usadas em cada resposta gerada."),
      [],
    );
  });

  it("descrição vazia não é escopo deste check (secondary-items-have-summary cobre)", () => {
    assert.deepEqual(detectPoolSummaryDefects(""), []);
    assert.deepEqual(detectPoolSummaryDefects("(5 min)"), []);
  });
});

describe("checkPoolSummaryQuality — varredura do MD (#9358)", () => {
  it("flagra itens de RADAR, USE MELHOR, LANÇAMENTOS e VÍDEO; ignora destaques", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\nTítulo\n\nCorpo curto sem ponto",
      "---",
      pool("🛠️ USE MELHOR", "Colab", `${GOOD} (5 min)`),
      pool("🚀 LANÇAMENTOS", "Ember", "Ember-1 chegou."),
      pool("📡 RADAR", "Nvidia", "Chipmaker says new system was designed to prevent AI agents from going rogue amid…"),
      pool(
        "📺 VÍDEO",
        "Cowork",
        "Aproveite vídeos e músicas que você ama, envie e compartilhe conteúdo original com amigos, parentes e o mundo no YouTube.",
      ),
    ].join("\n");
    const r = checkPoolSummaryQuality(md);
    assert.equal(r.ok, false);
    const bySection = new Map(r.errors.map((e) => [e.section.replace(/^\S+\s/, ""), e.defects]));
    assert.deepEqual([...bySection.keys()].sort(), ["LANÇAMENTOS", "RADAR", "VÍDEO"]);
    assert.deepEqual(bySection.get("LANÇAMENTOS"), ["too-short"]);
    assert.ok(bySection.get("RADAR")?.includes("trailing-ellipsis"));
    assert.deepEqual(bySection.get("VÍDEO"), ["youtube-boilerplate"]);
    assert.ok(r.errors.every((e) => e.url.startsWith("https://example.com/")));
  });

  it("pool limpo passa", () => {
    const md = [pool("📡 RADAR", "A", GOOD), pool("🛠️ USE MELHOR", "B", `${GOOD} (10 min)`)].join("\n");
    assert.deepEqual(checkPoolSummaryQuality(md), { ok: true, errors: [] });
  });
});

describe("secondary-item-walker: targetSectionRe é opt-in (#9358)", () => {
  it("default continua SEM VÍDEO (não muda os lints gate-blocking existentes)", () => {
    const md = pool("📺 VÍDEO", "V", GOOD);
    const seen: string[] = [];
    forEachSecondaryItem(md, { onFound: (i) => seen.push(i.section) });
    assert.deepEqual(seen, []);
  });
});

describe("stripFeedBoilerplate / cleanSummary — limpeza mecânica na fonte (#9358)", () => {
  it("remove rodapé do WordPress colado ao excerpt", () => {
    const s =
      "Processo de contratação pode prejudicar a diversidade. O post Criação de vieses e estereótipos é maior com IA apareceu primeiro em MIT Technology Review - Brasil .";
    assert.equal(stripFeedBoilerplate(s), "Processo de contratação pode prejudicar a diversidade.");
  });

  it("rodapé sozinho vira string vazia (descrição ausente é barrada por secondary-items-have-summary)", () => {
    assert.equal(
      cleanSummary(
        "O post A voz é só o começo: o salto dos agentes de IA no atendimento apareceu primeiro em MIT Technology Review - Brasil .",
        "A voz é só o começo: o salto dos agentes de IA no atendimento",
      ),
      "",
    );
  });

  it("tira espaço antes de pontuação, preserva reticências e texto normal", () => {
    assert.equal(
      stripFeedBoilerplate("Lançado com o Galaxy AI , da Samsung . Mas qual é o melhor?"),
      "Lançado com o Galaxy AI, da Samsung. Mas qual é o melhor?",
    );
    assert.equal(stripFeedBoilerplate("Então ... veremos."), "Então ... veremos.");
    assert.equal(stripFeedBoilerplate(GOOD), GOOD);
  });

  it("cleanSummary aplica a limpeza (caminho real do stitch)", () => {
    assert.equal(
      cleanSummary("O Muse Image , novo modelo de IA da Meta , gera imagens .", "Muse Image da Meta"),
      "O Muse Image, novo modelo de IA da Meta, gera imagens.",
    );
  });
});

describe("Stage 2 barra resumo de pool defeituoso (#9358)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("CASO REAL: teaser/corte no pool gera violation error reviewed-pool-summary-quality", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-pool-summary-"));
    writeFileSync(
      join(dir, "02-reviewed.md"),
      pool("📡 RADAR", "Estudo", "Estamos vivendo uma das maiores transformações da história da humanidade"),
    );
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === "reviewed-pool-summary-quality");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#9358");
    assert.match(v[0].message, /pool-summary-quality/);
    assert.match(v[0].message, /sem ponto final/);
  });

  it("[TRADUZIR] remanescente também bloqueia já no Stage 2", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-pool-traduzir-"));
    writeFileSync(join(dir, "02-reviewed.md"), pool("📡 RADAR", "Colab", `[TRADUZIR] Unlock premium Google Colab compute with Google AI for all subscribers now.`));
    const v = checkReviewedPassesAllLints(dir).filter((x) => x.rule === "reviewed-no-untranslated-summary");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
  });

  it("pool limpo não gera essas violations", () => {
    dir = mkdtempSync(join(tmpdir(), "stage2-pool-ok-"));
    writeFileSync(join(dir, "02-reviewed.md"), pool("📡 RADAR", "Colab", GOOD));
    const rules = checkReviewedPassesAllLints(dir).map((x) => x.rule);
    assert.ok(!rules.includes("reviewed-pool-summary-quality"));
    assert.ok(!rules.includes("reviewed-no-untranslated-summary"));
    assert.ok(!rules.includes("reviewed-secondary-items-have-summary"));
  });
});

describe("#9401 — CTA do G1 no resumo do pool", () => {
  // String crua real do source-researcher (G1 Tecnologia, edição 261002) — esse
  // caminho NÃO passa pelo enrich, então o corte precisa acontecer no stitch.
  const REAL_261002 =
    "Robb disse que permitiu apenas que o Muse AI gerenciasse sua conta no Facebook Marketplace, " +
    "plataforma de classificados de produtos do Facebook. 🗒️ Tem alguma sugestão de reportagem? " +
    "Envie para o g1 · 🔎 Lançado no início de setembro, o Muse é um assistente de inteligência " +
    "artificial projetado para executar ações em nome dos usuários.";

  it("stripFeedBoilerplate remove o bloco do CTA e preserva o resto", () => {
    const out = stripFeedBoilerplate(REAL_261002);
    assert.ok(!/sugestão de reportagem|Envie para o g1|🗒|🔎/u.test(out), out);
    assert.ok(out.includes("Lançado no início de setembro"), out);
  });

  it("cleanSummary (caminho do stitch) não deixa o CTA vazar", () => {
    const out = cleanSummary(REAL_261002, "Youtuber deixa Muse AI da Meta gerenciar o Facebook Marketplace");
    assert.ok(!/sugestão de reportagem|Envie para o g1/u.test(out), out);
    assert.ok(out.startsWith("Robb disse"), out);
  });

  it("lint acusa g1-report-cta quando o CTA aparece no resumo", () => {
    assert.ok(detectPoolSummaryDefects(REAL_261002).includes("g1-report-cta"));
    assert.ok(
      !detectPoolSummaryDefects(
        "A Meta lançou o Muse, assistente que executa ações em nome dos usuários.",
      ).includes("g1-report-cta"),
    );
  });
});
