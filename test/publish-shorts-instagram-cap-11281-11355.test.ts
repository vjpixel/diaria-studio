/**
 * test/publish-shorts-instagram-cap-11281-11355.test.ts
 *
 * #11281: em 27/10/2026 o plano mandou o Reels da @diar.ia.br (vertical REAL
 * de 49,9 s, 120 MB) pela API e o rupload recusou com `400
 * ProcessingFailedError`. O #11281 leu isso como teto de duração e baixou a
 * conta pra 30 s, mandando todo vertical de 31 a 55 s pro passo guiado.
 *
 * #11355: a medição do mesmo dia mostrou que a recusa foi o TAMANHO. O mesmo
 * vídeo cortado em 30 s com 72,6 MB passou, reencodado em 49,9 s com 10 MB
 * passou, e 57 s recusou mesmo com 11,5 MB. O teto de duração da @diar.ia.br
 * volta a 55 s e o plano ganha um teto de bytes (`INSTAGRAM_REELS_API_MAX_BYTES`):
 * acima dele o Instagram vira passo guiado, como acima do teto de duração.
 * A compressão automática antes da API ficou de fora por decisão do editor.
 *
 * Trava contra o platform.config.json REAL:
 *   1. o teto da @diar.ia.br fica abaixo de toda duração já recusada em
 *      arquivo pequeno, e em 55 s;
 *   2. 50 s com 120 MB → guiado (pelo tamanho); 50 s com 20 MB → API;
 *      57 s → guiado (pela duração);
 *   3. o teto de bytes fica entre o maior arquivo aceito e o menor recusado;
 *   4. a nota do config cita o mesmo valor que o mapa.
 * Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTAGRAM_REELS_API_MAX_BYTES, instagramReelsApiSizeFit, loadInstagramApiMaxSeconds } from "../scripts/lib/diaria/short-video.ts";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
const shorts = config.publishing.shorts;

/** Durações (s) que a API recusou na @diar.ia.br com arquivo pequeno (#10916 em 23/10, #11355 em 27/10). */
const DURATION_REJECTED_ON_DIARIA = [57, 58, 90];
/** Tamanhos (bytes) medidos na @diar.ia.br em 27/10 (#11355). */
const LARGEST_ACCEPTED_BYTES = 72_600_000;
const SMALLEST_REJECTED_BYTES = 120_200_000;

const SCHEDULE = {
  rotation_times: ["12:00", "19:00"],
  rotation_start: "2026-10-22",
  rotation_end: "2026-11-04",
  default_time: "12:00",
};

function planDiaria(duration: number, sizeBytes: number) {
  const pages: ResolvedFacebookPage[] = [{ slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null }];
  return planShortsPublish({
    aammdd: "261027",
    reviewedMd: "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n",
    now: new Date("2026-10-27T09:00:00Z"),
    config: {
      publishing: {
        shorts: {
          schedule: SCHEDULE,
          facebook_pages: ["diaria"],
          instagram: true,
          instagram_author_page: null,
          instagram_collaborators: ["vjpixel"],
          instagram_api_max_seconds_by_account: shorts.instagram_api_max_seconds_by_account,
        },
      },
    },
    pages,
    instagramReady: true,
    instagramQueue: { ready: true, account: "diaria" },
    published: { aammdd: "261027", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes },
    videoDurationSeconds: duration,
    editionUrl: "https://diar.ia.br/p/x",
  });
}

const ig = (plan: ReturnType<typeof planDiaria>) => plan.items.find((i) => i.destination === "instagram")!;

describe("#11355 teto do Reels da @diar.ia.br: 55 s e tamanho do arquivo", () => {
  it("o teto de duração da @diar.ia.br é 55 s e fica abaixo de toda duração já recusada", () => {
    const cap = loadInstagramApiMaxSeconds(config, null);
    assert.equal(cap, 55);
    for (const d of DURATION_REJECTED_ON_DIARIA) assert.ok((cap as number) < d, `teto ${cap} s não pode aceitar ${d} s, já recusado`);
  });

  it("o teto de bytes fica entre o maior arquivo aceito (72,6 MB) e o menor recusado (120 MB)", () => {
    assert.ok(INSTAGRAM_REELS_API_MAX_BYTES < LARGEST_ACCEPTED_BYTES);
    assert.ok(INSTAGRAM_REELS_API_MAX_BYTES < SMALLEST_REJECTED_BYTES);
    assert.equal(instagramReelsApiSizeFit(SMALLEST_REJECTED_BYTES).fits, false);
    assert.equal(instagramReelsApiSizeFit(20_000_000).fits, true);
    assert.equal(instagramReelsApiSizeFit(null).fits, true, "tamanho desconhecido não trava o destino");
  });

  it("regressão #11281: 50 s com 120 MB vira passo guiado pelo TAMANHO, sem tentar a API", () => {
    const plan = planDiaria(50, 120_000_000);
    const item = ig(plan);
    assert.equal(item.action, "guided");
    assert.equal(item.mode, "guided");
    assert.match((item as { detail: string }).detail, /120\.0 MB/);
    assert.match((item as { detail: string }).detail, /#11355/);
    assert.ok(plan.premises.some((p) => /teto de tamanho da API, #11355/.test(p)), plan.premises.join("\n"));
  });

  it("50 s com 20 MB segue pela API (fila do Worker)", () => {
    assert.equal(ig(planDiaria(50, 20_000_000)).action, "enqueue");
  });

  it("no limite: 55 s e exatamente o teto de bytes ainda vão pela API", () => {
    assert.equal(ig(planDiaria(55, INSTAGRAM_REELS_API_MAX_BYTES)).action, "enqueue");
  });

  it("57 s vira passo guiado pela DURAÇÃO, mesmo com arquivo pequeno", () => {
    const plan = planDiaria(57, 11_500_000);
    const item = ig(plan);
    assert.equal(item.action, "guided");
    assert.match((item as { detail: string }).detail, /57\.0 s/);
    assert.match((item as { detail: string }).detail, /na conta da diar\.ia\.br/);
    assert.ok(plan.premises.some((p) => /teto de duração da API, #10893/.test(p)), plan.premises.join("\n"));
  });

  it("a nota do config cita o mesmo teto da @diar.ia.br que o mapa", () => {
    const cap = shorts.instagram_api_max_seconds_by_account.diaria;
    assert.match(shorts.instagram_api_max_seconds_note, new RegExp(`@diar\\.ia\\.br: teto configurado ${cap} s`));
    assert.match(shorts.instagram_api_max_seconds_note, /#11355/);
  });
});
