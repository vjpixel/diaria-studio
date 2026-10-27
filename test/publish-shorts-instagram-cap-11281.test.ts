/**
 * test/publish-shorts-instagram-cap-11281.test.ts
 *
 * #11281: em 27/10/2026 o plano mandou o Reels da @diar.ia.br (vertical REAL
 * de 49,9 s) pela API, porque o teto da conta estava em 55 s, e o rupload
 * recusou com `400 ProcessingFailedError`. O #10916 já tinha um sintético de
 * 40 s recusado nessa conta. Com o teto em 30 s (maior valor sem recusa
 * registrada), o vertical de ~50 s vai direto pro passo guiado no plano.
 *
 * Trava três coisas contra o platform.config.json REAL:
 *   1. o teto da @diar.ia.br fica abaixo de toda duração já recusada nela;
 *   2. o plano com esse teto manda o caso real (49,9 s, autora null) pro guiado;
 *   3. a nota do config cita o mesmo valor que o mapa (coerência valor × nota).
 * Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstagramApiMaxSeconds } from "../scripts/lib/diaria/short-video.ts";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
const shorts = config.publishing.shorts;

/** Durações (s) que a API já recusou na @diar.ia.br (#10916 em 22/10, #11281 em 27/10). */
const REJECTED_ON_DIARIA = [40, 49.9];

const SCHEDULE = {
  rotation_times: ["12:00", "19:00"],
  rotation_start: "2026-10-22",
  rotation_end: "2026-11-04",
  default_time: "12:00",
};

function planDiaria(duration: number) {
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
    video: { path: "v.mp4", exists: true, sizeBytes: 5_000_000 },
    videoDurationSeconds: duration,
    editionUrl: "https://diar.ia.br/p/x",
  });
}

describe("#11281 teto do Reels da @diar.ia.br", () => {
  it("o teto configurado fica abaixo de toda duração já recusada na conta", () => {
    const cap = loadInstagramApiMaxSeconds(config, null);
    assert.equal(typeof cap, "number", "a @diar.ia.br precisa de teto numérico (null mandaria tudo pra API)");
    for (const d of REJECTED_ON_DIARIA) assert.ok((cap as number) < d, `teto ${cap} s não pode aceitar ${d} s, já recusado`);
  });

  it("regressão: o vertical real de 49,9 s (autora null) vira passo guiado no plano, não API", () => {
    const ig = planDiaria(49.9).items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "guided");
    assert.match((ig as { detail: string }).detail, /na conta da diar\.ia\.br/);
  });

  it("vertical curto, dentro do teto, segue pela API (fila do Worker)", () => {
    const cap = loadInstagramApiMaxSeconds(config, null) as number;
    assert.equal(planDiaria(cap).items.find((i) => i.destination === "instagram")!.action, "enqueue");
  });

  it("a nota do config cita o mesmo teto da @diar.ia.br que o mapa", () => {
    const cap = shorts.instagram_api_max_seconds_by_account.diaria;
    assert.match(shorts.instagram_api_max_seconds_note, new RegExp(`@diar\\.ia\\.br: teto configurado ${cap} s`));
    assert.match(shorts.instagram_api_max_seconds_note, /#11281/);
  });
});
