/**
 * test/approved-urls-swapped-link-9899.test.ts (#9899)
 *
 * Regressão: `restrictToRenderedUrls` (#9867) mantinha só as URLs aprovadas
 * que também apareciam no `02-reviewed.md`. Quando o editor/writer trocava o
 * link pela fonte oficial (261008 D2: approved `felloai.com/nano-banana-2-1`,
 * renderizado `deepmind.google/models/model-cards/nano-banana-2-1/`), a
 * aprovada saía e a renderizada nunca entrava — a matéria ficava sem URL em
 * "Links usados" e voltava como item novo na pesquisa do dia seguinte.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictToRenderedUrls } from "../scripts/lib/approved-urls.ts";
import { extractUrlsFromApproved } from "../scripts/refresh-past-editions.ts";
import { extractUrlsFromApproved as extractPendingUrls } from "../scripts/merge-local-pending.ts";

const D1 = "https://www.anthropic.com/claude-haiku-5-5";
const FELLO = "https://felloai.com/nano-banana-2-1";
const DEEPMIND = "https://deepmind.google/models/model-cards/nano-banana-2-1/";
const POOL_NEVER = "https://example.com/candidato-do-pool";
const YT_SHORT = "https://youtu.be/q9xLh2gc9u0";
const YT_LONG = "https://www.youtube.com/watch?v=q9xLh2gc9u0";

const APPROVED = {
  highlights: [{ url: D1 }, { url: FELLO }],
  radar: [{ url: POOL_NEVER }, { url: YT_SHORT }],
};

/** D2 trocado pela fonte oficial; vídeo trocado de youtu.be pra youtube.com; boxes/rodapé/redes presentes. */
const REVIEWED = [
  "Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor desta newsletter.",
  "Se este trabalho faz diferença, [considere apoiar](https://apoia.se/diaria).",
  "",
  "---",
  "",
  `**[Haiku 5.5 supera o Sonnet 5](${D1})**  `,
  "Texto.",
  "",
  "---",
  "",
  "[Saiba mais](https://diar.ia.br/evento/agente-ia?utm_source=newsletter)",
  "",
  `**[Nano Banana 2.1 bate o Pro](${DEEPMIND})**  `,
  "Texto.",
  "",
  `**[Vídeo](${YT_LONG})**`,
  "",
  "Onça no [Parque](https://pt.wikipedia.org/wiki/Parque) — crédito.",
  "**[Ler a Retrospectiva](https://retrospectiva.diar.ia.br/2609)**",
  "- [Cursos](https://cursos.diar.ia.br?utm_source=newsletter)",
  "siga no [X](https://x.com/diaria) e [Threads](https://www.threads.net/@diaria)",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeEdition(yymmdd: string): { root: string; approvedPath: string } {
  const root = mkdtempSync(join(tmpdir(), "diaria-9899-"));
  dirs.push(root);
  const editionDir = join(root, "data/editions", yymmdd.slice(0, 4), yymmdd);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  const approvedPath = join(editionDir, "_internal", "01-approved.json");
  writeFileSync(approvedPath, JSON.stringify(APPROVED));
  writeFileSync(join(editionDir, "02-reviewed.md"), REVIEWED);
  return { root, approvedPath };
}

describe("#9899 — link trocado pela fonte oficial continua em Links usados", () => {
  it("REGRESSÃO 261008: a URL renderizada do D2 entra; a do pool nunca renderizada não", () => {
    const urls = restrictToRenderedUrls([D1, FELLO, POOL_NEVER, YT_SHORT], REVIEWED);
    assert.ok(urls.includes(DEEPMIND), `D2 renderizado precisa entrar: ${JSON.stringify(urls)}`);
    assert.ok(urls.includes(YT_LONG), "vídeo com URL trocada (youtu.be → youtube.com) precisa entrar");
    assert.ok(urls.includes(D1));
    assert.ok(!urls.includes(POOL_NEVER), "candidato do pool que nunca renderizou continua fora (#9867)");
    assert.ok(!urls.includes(FELLO), "aprovada não renderizada continua fora");
  });

  it("box, rodapé, redes e crédito de imagem não viram link usado", () => {
    const urls = restrictToRenderedUrls([D1], REVIEWED);
    for (const u of urls) {
      assert.ok(
        !/linkedin|apoia\.se|diar\.ia\.br|wikipedia|x\.com|threads\.net/.test(u),
        `não-editorial vazou: ${u}`,
      );
    }
  });

  it("aprovada que renderizou com utm não é duplicada; ordem do approved vem primeiro", () => {
    const md = `**[A](${D1}?utm_source=diaria)**\n\n**[B](${DEEPMIND})**`;
    assert.deepEqual(restrictToRenderedUrls([D1, FELLO], md), [D1, DEEPMIND]);
  });

  it("refresh-past-editions e merge-local-pending aplicam a mesma regra", () => {
    const { root, approvedPath } = writeEdition("261008");
    for (const urls of [extractUrlsFromApproved("261008", root), extractPendingUrls(approvedPath)]) {
      assert.ok(urls.includes(DEEPMIND), JSON.stringify(urls));
      assert.ok(!urls.includes(POOL_NEVER));
    }
  });
});
