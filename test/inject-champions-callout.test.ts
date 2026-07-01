/**
 * inject-champions-callout.test.ts (#2725)
 *
 * Regressão: injeção do box campeões/sorteio em `02-reviewed.md`, gateada
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
import { insertChampionsCallout } from "../scripts/inject-champions-callout.ts";
import { extractIntroCallout } from "../scripts/lib/newsletter-parse.ts";

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

const CALLOUT_INNER = `🎉 Os campeões do É IA? em junho:

🥇 jorgemartinsfilho

🥈 Bruna Quevedo

🥉 Joshu

**Sorteio**

O sorteio entre quem achou o erro intencional será ao vivo no dia 2 de julho, das 13h30 às 14h, no [Google Meet](https://meet.google.com/nbs-jcut-ojj). Apareça para acompanhar o resultado e bater um papo sobre IA.`;

describe("insertChampionsCallout (#2725)", () => {
  it("injeta o box entre a coverage line e o separador antes de DESTAQUE 1", () => {
    const result = insertChampionsCallout(REVIEWED_BASE, CALLOUT_INNER);
    assert.equal(result.skippedReason, null);
    assert.ok(result.text);
    // O texto final deve ser parseável por extractIntroCallout, preservando
    // o sub-cabeçalho **Sorteio** interno (#2727 greedy).
    const cta = extractIntroCallout(result.text!);
    assert.ok(cta);
    assert.match(cta!, /^🎉 Os campeões do É IA\? em junho:/);
    assert.match(cta!, /\*\*Sorteio\*\*/);
    assert.match(cta!, /Apareça para acompanhar o resultado/);
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
    // Texto original não deve conter o box de campeões.
    assert.ok(!withSponsor.includes("Os campeões do É IA?"));
  });

  it("separador ausente (formato inesperado) → skip fail-safe, não corrompe o arquivo", () => {
    const weird = "Texto sem separador nenhum antes do destaque.\n\n**DESTAQUE 1 | X**\n\nCorpo.";
    const result = insertChampionsCallout(weird, CALLOUT_INNER);
    assert.equal(result.text, null);
    assert.match(result.skippedReason!, /separador/);
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
          day_of_month: 2,
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

  it("1ª edição do mês + pódio completo → injeta o box", () => {
    const { dir, editionDir, reviewedPath, platformConfig } = setup();
    try {
      const leaderboardJson = join(editionDir, "_internal", "04-leaderboard-top1.json");
      writeFileSync(
        leaderboardJson,
        JSON.stringify({
          podium: [
            { nickname: "jorgemartinsfilho", rank: 1 },
            { nickname: "Bruna Quevedo", rank: 2 },
            { nickname: "Joshu", rank: 3 },
          ],
        }),
      );
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
      assert.match(written, /Os campeões do É IA\? em junho/);
      assert.match(written, /🥇 jorgemartinsfilho/);
      const cta = extractIntroCallout(written);
      assert.ok(cta);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição que NÃO é a 1ª do mês → no-op, 02-reviewed.md inalterado", () => {
    const { dir, editionDir, reviewedPath, platformConfig } = setup();
    try {
      const leaderboardJson = join(editionDir, "_internal", "04-leaderboard-top1.json");
      writeFileSync(
        leaderboardJson,
        JSON.stringify({
          podium: [
            { nickname: "A", rank: 1 },
            { nickname: "B", rank: 2 },
            { nickname: "C", rank: 3 },
          ],
        }),
      );
      const pastEditions = join(dir, "past-editions-raw.json");
      // 260701 já publicada antes → 260702 (edição-alvo deste teste) NÃO é a
      // 1ª de julho.
      writeFileSync(
        pastEditions,
        JSON.stringify([{ published_at: "2026-07-01T09:00:00.000Z" }]),
      );

      const before = readFileSync(reviewedPath, "utf8");
      runCli([
        "--edition", "260702",
        "--reviewed", reviewedPath,
        "--leaderboard-json", leaderboardJson,
        "--past-editions", pastEditions,
        "--platform-config", platformConfig,
      ]);
      const after = readFileSync(reviewedPath, "utf8");
      assert.equal(after, before, "02-reviewed.md não deve mudar quando não é a 1ª edição do mês");
      assert.ok(!after.includes("Os campeões do É IA?"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pódio incompleto (< 3 ranks) → no-op", () => {
    const { dir, editionDir, reviewedPath, platformConfig } = setup();
    try {
      const leaderboardJson = join(editionDir, "_internal", "04-leaderboard-top1.json");
      writeFileSync(
        leaderboardJson,
        JSON.stringify({ podium: [{ nickname: "Só um", rank: 1 }] }),
      );
      const pastEditions = join(dir, "past-editions-raw.json");
      writeFileSync(pastEditions, JSON.stringify([]));

      const before = readFileSync(reviewedPath, "utf8");
      runCli([
        "--edition", "260701",
        "--reviewed", reviewedPath,
        "--leaderboard-json", leaderboardJson,
        "--past-editions", pastEditions,
        "--platform-config", platformConfig,
      ]);
      const after = readFileSync(reviewedPath, "utf8");
      assert.equal(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bloco 'raffle' ausente em platform.config.json → no-op", () => {
    const { dir, editionDir, reviewedPath } = setup();
    try {
      const leaderboardJson = join(editionDir, "_internal", "04-leaderboard-top1.json");
      writeFileSync(
        leaderboardJson,
        JSON.stringify({
          podium: [
            { nickname: "A", rank: 1 },
            { nickname: "B", rank: 2 },
            { nickname: "C", rank: 3 },
          ],
        }),
      );
      const pastEditions = join(dir, "past-editions-raw.json");
      writeFileSync(pastEditions, JSON.stringify([]));
      const emptyConfig = join(dir, "empty-platform.config.json");
      writeFileSync(emptyConfig, JSON.stringify({}));

      const before = readFileSync(reviewedPath, "utf8");
      runCli([
        "--edition", "260701",
        "--reviewed", reviewedPath,
        "--leaderboard-json", leaderboardJson,
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
