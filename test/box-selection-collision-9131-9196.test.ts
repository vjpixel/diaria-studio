/**
 * test/box-selection-collision-9131-9196.test.ts
 *
 * #9131 — seleção de caixas:
 *   1. colisão de base-URL entre caixas DA DIÁRIA (`matchSnippetForBox`
 *      desempata por URL completa / `utm_content`);
 *   2. anti-repetição entre edições também por EVENTO (não só por arquivo);
 *   3. `box-click-report` deixa de creditar à versão Clarice os cliques do box
 *      da diária (mesmo desempate do item 1).
 * #9196 — CLI `select-boxes-by-clicks.ts --edition` deriva o nº de destaques
 *   da edição (`_internal/01-approved-capped.json`), igual ao stitch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectBoxesForSlots,
  resolveBoxesForEdition,
  readEditionDestaqueCount,
  resolveCliDestaqueCount,
  type RankedBox,
} from "../scripts/select-boxes-by-clicks.ts";
import {
  matchSnippetForBox,
  parseSnippetContent,
  toFullUrlKey,
  type SnippetInfo,
} from "../scripts/box-click-report.ts";

const CLARICE_IMERSAO = `<!--
nome: Imersão Agente de IA (17/10) · a Clarice News
-->

[Quero criar meu agente!](https://diar.ia.br/evento/agente-ia?utm_source=clarice&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-imersao1010)`;

const DIARIA_IMERSAO = `<!--
nome: Imersão Agente de IA (17/10) · diária
-->

[Quero criar meu agente!](https://diar.ia.br/evento/agente-ia?utm_source=diaria&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-imersao1010)`;

const WORKSHOP = `<!--
nome: Workshop Agente de IA (17/10)
-->

**Workshop** [inscreva-se](https://diar.ia.br/evento/agente-ia?utm_source=diaria&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-workshop-outubro)`;

const WORKSHOP_URL =
  "https://diar.ia.br/evento/agente-ia?utm_source=diaria&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-workshop-outubro";
const DIARIA_URL =
  "https://diar.ia.br/evento/agente-ia?utm_source=diaria&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-imersao1010";

// Ordem alfabética, como `loadSnippets` (readdir) devolve.
const snippets: SnippetInfo[] = [
  parseSnippetContent("clarice-imersao1010.md", CLARICE_IMERSAO),
  parseSnippetContent("diaria-imersao1010.md", DIARIA_IMERSAO),
  parseSnippetContent("workshop-agente-ia-outubro.md", WORKSHOP),
];

describe("#9131 item 1 — matchSnippetForBox desempata caixas com a mesma base-URL", () => {
  it("box do workshop é creditado ao workshop, não à 1ª caixa alfabética com a mesma base-URL", () => {
    const m = matchSnippetForBox(`**Workshop** [inscreva-se](${WORKSHOP_URL})`, snippets);
    assert.equal(m?.snippet.file, "workshop-agente-ia-outubro.md");
    assert.equal(m?.url, WORKSHOP_URL);
  });

  it("URL completa idêntica mesmo com parâmetros em outra ordem / trailing slash", () => {
    const reordered =
      "https://diar.ia.br/evento/agente-ia/?utm_content=caixa-workshop-outubro&utm_campaign=agente-ia&utm_medium=email&utm_source=diaria";
    assert.equal(toFullUrlKey(reordered), toFullUrlKey(WORKSHOP_URL));
    assert.equal(matchSnippetForBox(`[x](${reordered})`, snippets)?.snippet.file, "workshop-agente-ia-outubro.md");
  });

  it("sem URL idêntica, desempata pelo utm_content", () => {
    const withExtra = `${WORKSHOP_URL}&ref=editor`;
    assert.equal(matchSnippetForBox(`[x](${withExtra})`, snippets)?.snippet.file, "workshop-agente-ia-outubro.md");
  });

  it("sem desempate possível (URL nua) mantém o 1º candidato — comportamento pré-#9131", () => {
    assert.equal(
      matchSnippetForBox("[x](https://diar.ia.br/evento/agente-ia)", snippets)?.snippet.file,
      "clarice-imersao1010.md",
    );
  });

  it("fixture literal sem fullUrls continua casando por base-URL", () => {
    const literal: SnippetInfo[] = [{ file: "a.md", nome: "A", urls: ["https://x.com/a"], seasonal: null }];
    assert.equal(matchSnippetForBox("[x](https://x.com/a?utm_content=z)", literal)?.snippet.file, "a.md");
  });
});

describe("#9131 item 3 — box-click-report credita o box da diária à versão da diária", () => {
  it("box com utm_source=diaria não é creditado a clarice-imersao1010.md (1ª alfabética)", () => {
    const m = matchSnippetForBox(`[Quero criar meu agente!](${DIARIA_URL})`, snippets);
    assert.equal(m?.snippet.file, "diaria-imersao1010.md");
  });
});

describe("#9131 item 2 — anti-repetição entre edições por evento", () => {
  const r = (file: string, score: number): RankedBox => ({
    file,
    nome: file,
    editionsAppeared: 1,
    avgUniqueVerifiedClicks: score,
    trend: null,
    score,
  });

  it("selectBoxesForSlots pula candidato cujo evento saiu na edição anterior (excludeEventKeys)", () => {
    const picks = selectBoxesForSlots({
      ranked: [r("workshop.md", 50), r("livros.md", 5)],
      slotsToFill: [1],
      excludeFiles: new Set(["imersao.md"]),
      eventKeysByFile: new Map([
        ["imersao.md", ["agente-ia"]],
        ["workshop.md", ["agente-ia"]],
        ["livros.md", []],
      ]),
      excludeEventKeys: new Set(["agente-ia"]),
    });
    assert.equal(picks[0].file, "livros.md");
  });

  it("resolveBoxesForEdition: ontem saiu a imersão, hoje o workshop do mesmo evento não é escolhido", () => {
    const dir = mkdtempSync(join(tmpdir(), "box-9131-"));
    try {
      const editionsDir = join(dir, "editions");
      const postsDir = join(dir, "posts");
      const snippetsDir = join(dir, "snippets");
      for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
      writeFileSync(join(snippetsDir, "diaria-imersao1010.md"), DIARIA_IMERSAO);
      writeFileSync(join(snippetsDir, "workshop-agente-ia-outubro.md"), WORKSHOP);
      writeFileSync(join(snippetsDir, "livros.md"), "<!-- nome: Livros -->\n**Livros**\n\n[Link](https://livros.diar.ia.br)");

      const md = (box: string) =>
        `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n${box}\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`;
      const edition = (aammdd: string, box: string, iso: string, url: string, clicks: number) => {
        mkdirSync(join(editionsDir, aammdd), { recursive: true });
        writeFileSync(join(editionsDir, aammdd, "02-reviewed.md"), md(box));
        writeFileSync(
          join(postsDir, `p${aammdd}.json`),
          JSON.stringify({
            id: `p${aammdd}`,
            publish_date: Math.floor(new Date(`${iso}T09:00:00Z`).getTime() / 1000),
            stats: { clicks: [{ url, email: { verified_clicks: clicks, unique_verified_clicks: clicks } }] },
          }),
        );
      };
      edition("260927", "**Livros**\n\n[Link](https://livros.diar.ia.br)", "2026-09-27", "https://livros.diar.ia.br", 5);
      edition("260928", `**Workshop** [inscreva-se](${WORKSHOP_URL})`, "2026-09-28", "https://diar.ia.br/evento/agente-ia", 50);
      edition("260929", `[Quero criar meu agente!](${DIARIA_URL})`, "2026-09-29", "https://diar.ia.br/evento/agente-ia", 10);

      const { effective } = resolveBoxesForEdition({
        aammdd: "260930",
        boxesCfg: { slot0: null, slot1: null, slot2: null, slot3: null },
        autoCfg: { enabled: true, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        snippetsDir,
        kitBroadcastsDir: join(dir, "kit"),
      });
      assert.notEqual(effective.slot1, "workshop-agente-ia-outubro.md");
      assert.notEqual(effective.slot2, "workshop-agente-ia-outubro.md");
      assert.equal(effective.slot1, "livros.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9196 CLI deriva o nº de destaques da edição", () => {
  const withEditions = (fn: (editionsDir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "box-9196-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const writeCapped = (editionsDir: string, aammdd: string, content: string) => {
    mkdirSync(join(editionsDir, aammdd, "_internal"), { recursive: true });
    writeFileSync(join(editionsDir, aammdd, "_internal", "01-approved-capped.json"), content);
  };

  it("lê highlights.length de _internal/01-approved-capped.json", () => {
    withEditions((editionsDir) => {
      writeCapped(editionsDir, "260930", JSON.stringify({ highlights: [{}, {}] }));
      assert.equal(readEditionDestaqueCount("260930", editionsDir), 2);
    });
  });

  it("fail-soft: edição ausente, arquivo ausente, JSON corrompido ou sem highlights -> undefined", () => {
    withEditions((editionsDir) => {
      assert.equal(readEditionDestaqueCount("260930", editionsDir), undefined);
      mkdirSync(join(editionsDir, "260929"), { recursive: true });
      assert.equal(readEditionDestaqueCount("260929", editionsDir), undefined);
      writeCapped(editionsDir, "260928", "{not json");
      assert.equal(readEditionDestaqueCount("260928", editionsDir), undefined);
      writeCapped(editionsDir, "260927", JSON.stringify({}));
      assert.equal(readEditionDestaqueCount("260927", editionsDir), undefined);
    });
  });

  it("--destaques N explícito vence o valor da edição", () => {
    withEditions((editionsDir) => {
      writeCapped(editionsDir, "260930", JSON.stringify({ highlights: [{}, {}] }));
      assert.equal(resolveCliDestaqueCount(["--edition", "260930"], "260930", editionsDir), 2);
      assert.equal(resolveCliDestaqueCount(["--edition", "260930", "--destaques", "3"], "260930", editionsDir), 3);
    });
  });

  it("regressão: edição de 2 destaques -> slot 2 inativo na inspeção, igual ao stitch", () => {
    withEditions((dir) => {
      const editionsDir = join(dir, "editions");
      const snippetsDir = join(dir, "snippets");
      mkdirSync(snippetsDir, { recursive: true });
      writeFileSync(join(snippetsDir, "livros.md"), "<!-- nome: Livros -->\n[Link](https://livros.diar.ia.br)");
      writeCapped(editionsDir, "260930", JSON.stringify({ highlights: [{}, {}] }));
      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "260930",
        boxesCfg: { slot0: null, slot1: "livros.md", slot2: "livros.md", slot3: null },
        autoCfg: { enabled: false, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        snippetsDir,
        destaqueCount: resolveCliDestaqueCount(["--edition", "260930"], "260930", editionsDir),
      });
      assert.equal(effective.slot2, null);
      assert.equal(selection.find((s) => s.slot === 2)?.file, null);
    });
  });
});
