/**
 * ds-golden-components.test.ts (#2071)
 *
 * Golden-files de componentes do DS de email (newsletter diária).
 * Objetivo: detectar drift de design — se um token canônico mudar ou se um
 * componente for refatorado sem atualizar o golden, o CI fica vermelho
 * apontando qual componente divergiu.
 *
 * Componentes cobertos (histórico de drift):
 *   - kicker               (linha ● + régua; token teal/bege; driftou em #1936)
 *   - whyBox               (box "Por que isso importa"; contorno, paper/rule)
 *   - introCallout single  (1 parágrafo; painel bege; driftou em refactors callout)
 *   - introCallout multi   (multi-parágrafo; 1º = título serif 26px)
 *   - boxDivulgacao1 com img   (entre D1 e D2; o drift mais recorrente — #1807/#2066/#2067)
 *   - boxDivulgacao1 sem img   (degrada pra introCallout; cobertura do branch null)
 *   - É IA? box            (painel bege + kicker; #1936 redesign)
 *   - SORTEIO box          (#2080 — kicker fora do box, corpo no painel bege)
 *
 * Como funciona:
 *   - 1ª execução (ou `NODE_TEST_SNAPSHOTS=1 npm test`): grava os goldens em
 *     `test/__snapshots__/ds-golden-components.snap.json`.
 *   - Execuções subsequentes: compara output do render com o golden.
 *   - Mudança de design intencional = atualizar golden conscientemente:
 *       NODE_TEST_SNAPSHOTS=1 npm test
 *     ou:
 *       npm test -- --test-name-pattern "ds-golden" --update-snapshots
 *
 * O golden armazena SHA-256 curto (16 chars hex) + o HTML canônico completo
 * por componente, pra que o diff no PR aponte exatamente o que mudou.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  renderKicker,
  renderWhyBoxInner,
  renderIntroCallout,
  renderMidCallout,
  renderSorteio,
  renderEIA,
} from "../scripts/lib/newsletter-render-html.ts";
import type { EIA } from "../scripts/lib/newsletter-parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = resolve(
  ROOT,
  "test/__snapshots__/ds-golden-components.snap.json",
);

// ── Fixtures fixas ────────────────────────────────────────────────────────────

const EIA_FIXTURE: EIA = {
  credit: "Foto: Gerado com Gemini.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
  prevResultLine: "Resultado da última edição: 73% acertaram",
  leaderboardPodium: [
    { nickname: "Davyd", rank: 1 },
    { nickname: "Luisao P", rank: 2 },
  ],
};

/**
 * Mapa componente → HTML canônico gerado pelos render helpers.
 * As funções são puras — output estável dado o mesmo input + mesmos tokens do DS.
 */
function generateGoldens(): Record<string, string> {
  return {
    kicker_ia: renderKicker("É IA?"),
    kicker_sorteio: renderKicker("Sorteio"),
    kicker_para_encerrar: renderKicker("Para encerrar"),
    kicker_destaque_lançamento: renderKicker("🚀 LANÇAMENTO"),

    why_box_single: renderWhyBoxInner(
      "A replicação autônoma de modelos LLM representa um salto qualitativo no risco sistêmico.",
    ),
    why_box_multi: renderWhyBoxInner(
      "Primeiro parágrafo sobre por que importa.\n\nSegundo parágrafo com mais contexto.",
    ),

    intro_callout_single: renderIntroCallout(
      "🎉 Sorteio ao vivo hoje às 19h! [Participe aqui](https://livros.diaria.workers.dev).",
    ),
    intro_callout_multi: renderIntroCallout(
      "📣 Escreva melhor com a Clarice.ai\n\nA IA brasileira que revisa seus textos.\n\n[Acesse com desconto](https://clarice.ai/precos-planos?via=diaria).",
    ),

    mid_callout_com_imagem: renderMidCallout(
      "📚 Nossa curadoria de livros sobre IA ganhou página nova. [Confira a nova página](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo-a1b2c3d4.jpg",
    ),
    mid_callout_sem_imagem: renderMidCallout(
      "📚 Nossa curadoria de livros sobre IA. [Confira a nova página](https://livros.diaria.workers.dev).",
      null,
    ),
    mid_callout_multi_para: renderMidCallout(
      "📚 Curadoria de livros sobre IA\n\nPágina nova com filtros por tema. [Confira](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo-a1b2c3d4.jpg",
    ),

    sorteio_single: renderSorteio(
      "Participe do sorteio respondendo corretamente o É IA? de hoje.",
    ),
    sorteio_multi: renderSorteio(
      "Responda o É IA? de hoje para participar.\n\nO resultado sai na próxima edição.",
    ),

    eia_box: renderEIA(EIA_FIXTURE),
  };
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

interface SnapEntry {
  hash: string;
  html: string;
}

interface Snapshot {
  updated_at: string;
  components: Record<string, SnapEntry>;
}

function sha256Short(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function loadSnapshot(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function saveSnapshot(components: Record<string, string>): void {
  const entries: Record<string, SnapEntry> = {};
  for (const [key, html] of Object.entries(components)) {
    entries[key] = { hash: sha256Short(html), html };
  }
  const snap: Snapshot = {
    updated_at: new Date().toISOString(),
    components: entries,
  };
  writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(snap, null, 2) + "\n",
    "utf8",
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ds-golden-components (#2071) — HTML canônico por componente do DS", () => {
  const goldens = generateGoldens();

  it("todos os componentes geram HTML não-vazio", () => {
    for (const [key, html] of Object.entries(goldens)) {
      assert.ok(html.length > 50, `${key}: HTML parece vazio (< 50 chars)`);
    }
  });

  it("kicker: ponto teal &#9679; + label uppercase + régua bege (tokens canônicos)", () => {
    const html = goldens["kicker_ia"];
    assert.ok(html.includes("&#9679;"), "kicker: ponto teal ausente");
    assert.ok(html.includes("#00A0A0"), "kicker: cor teal ausente");
    assert.ok(html.includes("#EBE5D0"), "kicker: régua bege ausente");
    assert.ok(html.includes("É IA?"), "kicker: label ausente");
    assert.ok(html.includes("text-transform:uppercase"), "kicker: uppercase ausente");
  });

  it("whyBox: box contorno — paper #FFFFFF + borda bege #EBE5D0 + label teal (DS #1943)", () => {
    const html = goldens["why_box_single"];
    assert.ok(html.includes("Por que isso importa"), "whyBox: label ausente");
    // #1943: PAPER em email é branco (#FFFFFF), não #FBFAF6
    assert.ok(
      html.includes("#FFFFFF") || html.includes("background:#FFFFFF"),
      "whyBox: fundo paper (#FFFFFF) ausente",
    );
    assert.ok(html.includes("border:1px solid #EBE5D0"), "whyBox: borda bege ausente");
    assert.ok(html.includes("#00A0A0"), "whyBox: cor teal do label ausente");
  });

  it("introCallout: painel bege #EBE5D0 (DS SURFACE — não teal)", () => {
    const html = goldens["intro_callout_single"];
    // O painel deve usar SURFACE (#EBE5D0) como background — não teal
    assert.ok(
      html.includes("background:#EBE5D0") || html.includes(`background:${"\x23"}EBE5D0`),
      "introCallout: painel bege #EBE5D0 ausente",
    );
    assert.ok(!html.includes("background:#00A0A0"), "introCallout: painel NÃO deve ser teal");
  });

  it("introCallout multi-parágrafo: 1º parágrafo = título serif 26px (DS h4)", () => {
    const html = goldens["intro_callout_multi"];
    assert.match(html, /font-size:26px/, "introCallout multi: título 26px ausente");
    assert.match(
      html,
      /Georgia, 'Times New Roman', serif/,
      "introCallout multi: fonte serif ausente",
    );
    // Marcador 📣 removido (o separador 'Divulgação' o substitui)
    assert.ok(!html.includes("📣"), "introCallout multi: marcador 📣 não deve aparecer");
  });

  it("boxDivulgacao1 com imagem: <img> + botão CTA + link do box (DS box com screenshot)", () => {
    const html = goldens["mid_callout_com_imagem"];
    assert.match(html, /<img[^>]+src="[^"]*livros-promo/, "boxDivulgacao1: <img> ausente");
    assert.ok(html.includes("Confira a nova página"), "boxDivulgacao1: label CTA ausente");
    assert.ok(
      html.includes("https://livros.diaria.workers.dev"),
      "boxDivulgacao1: link do destino ausente",
    );
    // #2071: painel bege (não teal)
    assert.ok(!html.includes("background:#00A0A0"), "boxDivulgacao1: painel NÃO deve ser teal");
  });

  it("boxDivulgacao1 sem imagem: degrada pra introCallout (sem <img>)", () => {
    const html = goldens["mid_callout_sem_imagem"];
    assert.ok(!html.includes("<img"), "boxDivulgacao1 sem imagem: <img> não deve aparecer");
    // Ainda renderiza o link/texto
    assert.ok(
      html.includes("livros.diaria.workers.dev"),
      "boxDivulgacao1 sem imagem: link deve estar no texto",
    );
  });

  it("SORTEIO: kicker fora do box + corpo no painel bege (#2080)", () => {
    const html = goldens["sorteio_single"];
    // #2080: kicker fora do box de painel (estrutura: kicker → <table> de painel)
    const kickerIdx = html.indexOf("&#9679;");
    const panelIdx = html.indexOf("background:#EBE5D0");
    assert.ok(kickerIdx !== -1, "SORTEIO: kicker ausente");
    assert.ok(panelIdx !== -1, "SORTEIO: painel bege ausente");
    // Kicker antes do painel na ordem do HTML
    assert.ok(kickerIdx < panelIdx, "SORTEIO: kicker deve aparecer ANTES do painel (fora do box)");
  });

  it("É IA? box: kicker 'É IA?' + painel bege + imagens A/B com {{IMG:01-eia-A.jpg}}", () => {
    const html = goldens["eia_box"];
    assert.ok(html.includes("É IA?"), "É IA?: kicker ausente");
    assert.ok(
      html.includes("{{IMG:01-eia-A.jpg}}"),
      "É IA?: placeholder imagem A ausente",
    );
    assert.ok(
      html.includes("{{IMG:01-eia-B.jpg}}"),
      "É IA?: placeholder imagem B ausente",
    );
    assert.ok(html.includes("background:#EBE5D0"), "É IA?: painel bege ausente");
    // Resultado da última edição (#1630)
    assert.ok(
      html.includes("73% acertaram"),
      "É IA?: linha de resultado ausente",
    );
  });

  it("nenhum componente usa valores ad-hoc do canvas antigo (#1936)", () => {
    const combined = Object.values(goldens).join("\n");
    assert.ok(!combined.includes("Newsreader"), "valor Newsreader não deve aparecer");
    assert.ok(!/\#F4EFE2/i.test(combined), "paper antigo #F4EFE2 não deve aparecer");
    assert.ok(!/\#f0fafa/i.test(combined), "teal-tint ad-hoc #f0fafa não deve aparecer");
    assert.ok(!/\#1a1a1a/i.test(combined), "ink ad-hoc #1a1a1a não deve aparecer");
    assert.ok(!/\#E0D9C4/i.test(combined), "régua bege antiga #E0D9C4 não deve aparecer");
  });

  // ── Snapshot guard ─────────────────────────────────────────────────────────
  it("snapshot hash — mudança intencional de design requer update explícito", () => {
    const snap = loadSnapshot();

    const updating =
      process.env.NODE_TEST_SNAPSHOTS === "1" ||
      process.argv.includes("--update-snapshots");

    if (!snap) {
      // Primeira execução: gravar goldens.
      saveSnapshot(goldens);
      console.log("  [ds-golden] snapshot criado (primeira execução)");
      return;
    }

    const failures: string[] = [];
    for (const [key, html] of Object.entries(goldens)) {
      const entry = snap.components[key];
      if (!entry) {
        if (updating) continue; // novo componente — será adicionado abaixo
        failures.push(`Componente novo sem golden: "${key}" — rode NODE_TEST_SNAPSHOTS=1 npm test`);
        continue;
      }
      const currentHash = sha256Short(html);
      if (currentHash !== entry.hash) {
        if (!updating) {
          failures.push(
            `"${key}" divergiu do golden (${entry.hash} → ${currentHash}).\n` +
              `  DS drift detectado — se a mudança é intencional, atualize:\n` +
              `    NODE_TEST_SNAPSHOTS=1 npm test`,
          );
        }
      }
    }

    if (updating) {
      saveSnapshot(goldens);
      console.log("  [ds-golden] snapshot atualizado");
    } else if (failures.length > 0) {
      assert.fail(failures.join("\n\n"));
    }
  });
});
