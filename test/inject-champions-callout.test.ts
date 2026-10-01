/**
 * inject-champions-callout.test.ts (#2725)
 *
 * Regressão: injeção do callout do sorteio (#9236: sem os campeões, que
 * migraram pro box do É IA?) em `02-reviewed.md`, gateada
 * pela MESMA lógica "1ª edição do mês" do leaderboard (#1753) — reusada, não
 * duplicada — e com precedência explícita quando já existe um introCallout
 * (ex: patrocínio) na região de intro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertChampionsCallout, parseCliArgs } from "../scripts/inject-champions-callout.ts";
import { extractIntroCallout, extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { formatCoverageLine } from "../scripts/lib/inbox-stats.ts";

const REVIEWED_BASE = `Para esta edição, eu (o editor) enviei 5 artigos e a Diar.ia encontrou outros 20. Selecionamos os 3 mais relevantes para as pessoas que assinam a newsletter.

---

**DESTAQUE 1 | 💰 MERCADO**

**[Título](https://example.com/d1)**

Corpo do destaque.

Por que isso importa:

Importa.

---

**DESTAQUE 2 | 🚀 PRODUTO**

**[Título 2](https://example.com/d2)**

Corpo.
`;

// #9236: o callout de intro carrega só o Sorteio (campeões migraram pro box do É IA?).
const CALLOUT_INNER = `🎉 Sorteio

O sorteio entre quem achou o erro intencional será ao vivo no dia 2 de julho, das 13h30 às 14h, no [Google Meet](https://meet.google.com/nbs-jcut-ojj). Será uma caneca entre quem encontrou o erro intencional e outra entre os Patronos. Apareça para ver quem vai ganhar caneca e bater um papo sobre IA.`;

describe("insertChampionsCallout (#2725)", () => {
  it("injeta o box entre a coverage line e o separador antes de DESTAQUE 1", () => {
    const result = insertChampionsCallout(REVIEWED_BASE, CALLOUT_INNER);
    assert.equal(result.skippedReason, null);
    assert.ok(result.text);
    // O texto final deve ser parseável por extractIntroCallout.
    const cta = extractIntroCallout(result.text!);
    assert.ok(cta);
    assert.match(cta!, /^🎉 Sorteio\n\n/);
    assert.match(cta!, /Apareça para ver quem vai ganhar caneca/);
    // Coverage line + DESTAQUE 1 continuam intactos.
    assert.match(result.text!, /Para esta edição, eu \(o editor\)/);
    assert.match(result.text!, /\*\*DESTAQUE 1 \| 💰 MERCADO\*\*/);
  });

  it("precedência: NÃO sobrescreve um introCallout já existente (patrocínio)", () => {
    const withSponsor = REVIEWED_BASE.replace(
      "---\n\n**DESTAQUE 1",
      "---\n\n**📣 Anúncio patrocinado no topo.**\n\n---\n\n**DESTAQUE 1",
    );
    const result = insertChampionsCallout(withSponsor, CALLOUT_INNER);
    assert.equal(result.text, null);
    assert.match(result.skippedReason!, /callout já presente/);
    // Texto original não deve conter o callout do sorteio.
    assert.ok(!withSponsor.includes("🎉 Sorteio"));
  });

  it("separador ausente (formato inesperado) → skip fail-safe, não corrompe o arquivo", () => {
    const weird = "Texto sem separador nenhum antes do destaque.\n\n**DESTAQUE 1 | X**\n\nCorpo.";
    const result = insertChampionsCallout(weird, CALLOUT_INNER);
    assert.equal(result.text, null);
    assert.match(result.skippedReason!, /separador/);
  });

  it("#4310: devolve o separador '---' consumido pelo regex antes do box injetado", () => {
    const result = insertChampionsCallout(REVIEWED_BASE, CALLOUT_INNER);
    assert.ok(result.text);
    // Estrutura esperada: coverage line, então um '---' isolado FECHANDO a
    // coverage line, então o box de campeões, então outro '---' isolado
    // fechando o box antes de DESTAQUE 1. Sem o fix, o 1º '---' (o que
    // separava a coverage line do box) nunca existia — só sobrava o que já
    // vinha no fim do `block`.
    assert.match(
      result.text!,
      /Selecionamos os 3 mais relevantes para as pessoas que assinam a newsletter\.\n\n---\n\n\*\*🎉 Sorteio/,
      "coverage line deve ser fechada por '---' isolado ANTES do callout",
    );
  });
});

describe("parseCliArgs — default editionDir via #3491 (mesma classe de #3483/#3484)", () => {
  // Na prática o orchestrator (Stage 3, orchestrator-stage-3.md) SEMPRE passa
  // --edition-dir explícito, então este fallback não é exercitado em
  // produção hoje. Corrigido por defesa em profundidade — antes do #3491, sem
  // --edition-dir, o default construía `data/editions/{AAMMDD}` à mão (layout
  // FLAT), mesma classe de bug de #3483/#3484.
  it("resolve edição no layout NESTED via --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "champions-nested-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseCliArgs([
        "--edition", "260517",
        "--editions-dir", dir,
      ]);
      assert.ok(args);
      assert.equal(args!.reviewedPath, join(nestedEditionDir, "02-reviewed.md"));
      assert.equal(
        args!.leaderboardJson,
        join(nestedEditionDir, "_internal", "04-leaderboard-top1.json"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve edição no layout FLAT legado via --editions-dir (compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "champions-flat-"));
    try {
      const flatEditionDir = join(dir, "260421");
      mkdirSync(flatEditionDir, { recursive: true });
      const args = parseCliArgs([
        "--edition", "260421",
        "--editions-dir", dir,
      ]);
      assert.ok(args);
      assert.equal(args!.reviewedPath, join(flatEditionDir, "02-reviewed.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--edition-dir explícito continua tendo precedência sobre --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "champions-precedence-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseCliArgs([
        "--edition", "260517",
        "--editions-dir", dir,
        "--edition-dir", "/custom/override",
      ]);
      assert.ok(args);
      assert.equal(args!.reviewedPath, join("/custom/override", "02-reviewed.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Integração hermética via CLI real (mesmo padrão de fetch-leaderboard-top1.test.ts).
 */
describe("main() CLI (#2725 integração)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "champions-cli-"));
    const editionDir = join(dir, "editions", "260701");
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    const reviewedPath = join(editionDir, "02-reviewed.md");
    writeFileSync(reviewedPath, REVIEWED_BASE);
    const platformConfig = join(dir, "platform.config.json");
    writeFileSync(
      platformConfig,
      JSON.stringify({
        raffle: {
          meet_url: "https://meet.google.com/nbs-jcut-ojj",
          sorteio_do_mes: { mes: "2026-07", dia: 2 },
          hora_inicio: "13:30",
          hora_fim: "14:00",
        },
      }),
    );
    return { dir, editionDir, reviewedPath, platformConfig };
  }

  function runCli(args: string[]) {
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/inject-champions-callout.ts", ...args],
      { stdio: "pipe", encoding: "utf8" },
    );
  }

  const PODIUM_JSON = JSON.stringify({
    podium: [
      { nickname: "jorgemartinsfilho", rank: 1 },
      { nickname: "Bruna Quevedo", rank: 2 },
      { nickname: "perli…@***", rank: 3 },
    ],
  });

  it("1ª edição do mês → injeta o callout SÓ com o Sorteio (#9236 — campeões não entram mais no intro)", () => {
    const { dir, editionDir, reviewedPath, platformConfig } = setup();
    try {
      const leaderboardJson = join(editionDir, "_internal", "04-leaderboard-top1.json");
      writeFileSync(leaderboardJson, PODIUM_JSON);
      const pastEditions = join(dir, "past-editions-raw.json");
      // Nenhuma edição publicada em julho ainda → 260701 é a 1ª.
      writeFileSync(
        pastEditions,
        JSON.stringify([{ published_at: "2026-06-15T09:00:00.000Z" }]),
      );

      runCli([
        "--edition", "260701",
        "--reviewed", reviewedPath,
        "--leaderboard-json", leaderboardJson,
        "--past-editions", pastEditions,
        "--platform-config", platformConfig,
      ]);

      const written = readFileSync(reviewedPath, "utf8");
      // #4583(a): sorteio_do_mes.mes ("2026-07") bate com a edição corrente
      // (260701 → slug "2026-07") — renderiza normalmente com o `dia` (2) do
      // config, mês "julho" resolvido do próprio slug da edição.
      assert.match(written, /\*\*🎉 Sorteio\n\n/);
      assert.match(written, /dia 2 de julho, das 13h30 às 14h/);
      // #9236: nada do pódio no markdown da região de intro.
      assert.doesNotMatch(written, /Os campeões do É IA\?/);
      assert.doesNotMatch(written, /jorgemartinsfilho/);
      assert.doesNotMatch(written, /ranking completo/);
      // #9242: o e-mail mascarado do pódio (`@***`) não chega ao markdown.
      assert.doesNotMatch(written, /@\*\*\*/);
      const cta = extractIntroCallout(written);
      assert.ok(cta);
      assert.match(cta!, /^🎉 Sorteio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#9236: pódio ausente/vazio NÃO impede o sorteio (callout não depende mais do leaderboard)", () => {
    const { dir, editionDir, reviewedPath, platformConfig } = setup();
    try {
      const pastEditions = join(dir, "past-editions-raw.json");
      writeFileSync(pastEditions, JSON.stringify([]));
      runCli([
        "--edition", "260701",
        "--reviewed", reviewedPath,
        "--leaderboard-json", join(editionDir, "_internal", "ausente.json"),
        "--past-editions", pastEditions,
        "--platform-config", platformConfig,
      ]);
      const written = readFileSync(reviewedPath, "utf8");
      assert.match(written, /\*\*🎉 Sorteio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#4583(b) — sorteio_do_mes.mes divergente do mês da edição corrente → aborta (exit 1), nunca renderiza a data velha", () => {
    const { dir, reviewedPath } = setup();
    try {
      const pastEditions = join(dir, "past-editions-raw.json");
      // Nenhuma edição publicada em julho ainda → 260701 é a 1ª.
      writeFileSync(
        pastEditions,
        JSON.stringify([{ published_at: "2026-06-15T09:00:00.000Z" }]),
      );
      // sorteio_do_mes ainda aponta pro mês ANTERIOR (junho) — o editor não
      // atualizou o config pra julho antes desta edição rodar.
      const staleConfig = join(dir, "stale-platform.config.json");
      writeFileSync(
        staleConfig,
        JSON.stringify({
          raffle: {
            meet_url: "https://meet.google.com/nbs-jcut-ojj",
            sorteio_do_mes: { mes: "2026-06", dia: 2 },
            hora_inicio: "13:30",
            hora_fim: "14:00",
          },
        }),
      );

      const before = readFileSync(reviewedPath, "utf8");
      let threw = false;
      try {
        runCli([
          "--edition", "260701",
          "--reviewed", reviewedPath,
          "--past-editions", pastEditions,
          "--platform-config", staleConfig,
        ]);
      } catch (err) {
        threw = true;
        const e = err as { status?: number | null; stderr?: string };
        assert.equal(e.status, 1, "exit code deve ser 1 (fatal), não 0/2");
        assert.match(String(e.stderr), /sorteio_do_mes\.mes/);
        assert.match(String(e.stderr), /"2026-06"/);
        assert.match(String(e.stderr), /"2026-07"/);
      }
      assert.ok(threw, "esperava que o processo abortasse (exit != 0) com sorteio_do_mes.mes divergente");

      // 02-reviewed.md NUNCA é tocado — não renderiza silenciosamente o `dia`
      // herdado do mês anterior.
      const after = readFileSync(reviewedPath, "utf8");
      assert.equal(after, before, "02-reviewed.md não deve mudar quando sorteio_do_mes.mes diverge");
      assert.ok(!after.includes("🎉 Sorteio"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição que NÃO é a 1ª do mês → no-op, 02-reviewed.md inalterado", () => {
    const { dir, reviewedPath, platformConfig } = setup();
    try {
      const pastEditions = join(dir, "past-editions-raw.json");
      // 260701 já publicada antes → 260702 (edição-alvo deste teste) NÃO é a
      // 1ª de julho. (O pódio no box do É IA? ainda aparece nela — janela de 3,
      // #9236 — mas o Sorteio é só da 1ª.)
      writeFileSync(
        pastEditions,
        JSON.stringify([{ published_at: "2026-07-01T09:00:00.000Z" }]),
      );

      const before = readFileSync(reviewedPath, "utf8");
      runCli([
        "--edition", "260702",
        "--reviewed", reviewedPath,
        "--past-editions", pastEditions,
        "--platform-config", platformConfig,
      ]);
      const after = readFileSync(reviewedPath, "utf8");
      assert.equal(after, before, "02-reviewed.md não deve mudar quando não é a 1ª edição do mês");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bloco 'raffle' ausente em platform.config.json → no-op", () => {
    const { dir, reviewedPath } = setup();
    try {
      const pastEditions = join(dir, "past-editions-raw.json");
      writeFileSync(pastEditions, JSON.stringify([]));
      const emptyConfig = join(dir, "empty-platform.config.json");
      writeFileSync(emptyConfig, JSON.stringify({}));

      const before = readFileSync(reviewedPath, "utf8");
      runCli([
        "--edition", "260701",
        "--reviewed", reviewedPath,
        "--past-editions", pastEditions,
        "--platform-config", emptyConfig,
      ]);
      const after = readFileSync(reviewedPath, "utf8");
      assert.equal(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * #4310: reprodução do bug real via round-trip completo (insertChampionsCallout
 * → extractContent → renderHTML) usando a coverage line MULTI-PARÁGRAFO
 * (#3461/#3691), formato padrão desde 260715 — a fixture legada de linha única
 * usada acima (`REVIEWED_BASE`) não exercitava o bug porque
 * `captureUntilCoverageBoundary` só entra em jogo pro formato novo. Sem o
 * fix, o box de campeões é fundido na coverage line (`captureUntilCoverageBoundary`
 * não encontra o '---' que deveria fechá-la) E extraído de novo por
 * `extractIntroCallout` — duplicado no HTML final.
 */
describe("#4310 — box de campeões não duplica com coverage line multi-parágrafo", () => {
  const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

  const MULTI_PARAGRAPH_COVERAGE = formatCoverageLine({
    editorSubmissions: 5,
    diariaDiscovered: 10,
    selected: 2,
  });

  function buildReviewed(): string {
    return `${MULTI_PARAGRAPH_COVERAGE}

---

**DESTAQUE 1 | 💰 MERCADO**

**[Título](https://example.com/d1)**

Corpo do destaque.

Por que isso importa:

Importa.

---

**DESTAQUE 2 | 🚀 PRODUTO**

**[Título 2](https://example.com/d2)**

Corpo.

Por que isso importa:

Importa também.

---

${EIA}
`;
  }

  it("renderiza o callout exatamente 1x (não duplica, coverage line intacta)", () => {
    const reviewed = buildReviewed();
    const result = insertChampionsCallout(reviewed, CALLOUT_INNER);
    assert.equal(result.skippedReason, null);
    assert.ok(result.text);

    const dir = mkdtempSync(join(tmpdir(), "champions-4310-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), result.text!, "utf8");
      writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");

      const content = extractContent(dir);
      // A coverage line não deve ter "engolido" o callout (#4310).
      assert.ok(
        !content.coverageLine?.includes("Apareça para ver"),
        "coverage line não deve conter o callout — separador '---' precisa fechá-la antes do box",
      );
      assert.ok(content.introCallout?.includes("Apareça para ver"));

      const html = renderHTML(content);
      const occurrences = (html.match(/Apareça para ver quem vai ganhar caneca/g) ?? []).length;
      assert.equal(occurrences, 1, "callout deve aparecer exatamente 1x no HTML final, nunca 2x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
