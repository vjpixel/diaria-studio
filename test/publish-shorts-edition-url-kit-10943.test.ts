/**
 * #10943 item 3 — o vertical (`/diaria-shorts`) sai ANTES da Etapa 5 no fluxo
 * do dia, então `_internal/05-edition-url.txt` ainda não existe e o link da
 * edição vem do slug do título do D1. Com `publishing.newsletter.backend` =
 * "kit" o Stage 5 grava exatamente `deriveEditionUrl(D1)` (#7420): o link
 * derivado é premissa, não aviso. Com "beehiiv" (ou chave ausente) segue
 * aviso, porque o wizard da Beehiiv pode mudar o slug.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newsletterBackendOf, planShortsPublish } from "../scripts/publish-shorts.ts";
import { deriveEditionUrl } from "../scripts/lib/edition-url.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = {
  rotation_times: ["12:00", "19:00"],
  rotation_start: "2026-10-22",
  rotation_end: "2026-11-04",
  default_time: "12:00",
};

const D1_TITLE = "Você já viu IA mentir. Já viu roubar?";
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1_TITLE}](https://alignment.openai.com/x)

Um modelo gastou o saldo de uma carteira de terceiros.

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: `page-${slug}` };
}

function plan(newsletter: Record<string, unknown> | undefined, editionUrl?: string) {
  return planShortsPublish({
    aammdd: "261022",
    reviewedMd: REVIEWED,
    now: new Date("2026-10-22T03:00:00Z"),
    config: {
      publishing: {
        ...(newsletter ? { newsletter } : {}),
        shorts: { facebook_pages: ["diaria"], instagram: false, schedule: SCHEDULE },
      },
    },
    pages: [page("diaria")],
    instagramReady: false,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl,
  });
}

describe("#10943 item 3: link da edição no vertical antes da Etapa 5", () => {
  it("backend kit: link derivado é premissa (mesma regra do Stage 5), nunca aviso", () => {
    const p = plan({ backend: "kit" });
    assert.equal(p.editionUrl, deriveEditionUrl(D1_TITLE));
    assert.ok(!p.warnings.some((w) => w.includes("derivado do slug")), p.warnings.join("\n"));
    assert.ok(p.premises.some((m) => m.includes(p.editionUrl) && m.includes("#7420")), p.premises.join("\n"));
  });

  it("backend beehiiv: link derivado segue AVISO (slug do wizard pode divergir)", () => {
    const p = plan({ backend: "beehiiv" });
    assert.ok(!p.warnings.some((w) => w.includes("derivado do slug")));
  });

  it("chave ausente cai no default kit (premissa, sem aviso) — #11225", () => {
    const p = plan(undefined);
    assert.ok(!p.warnings.some((w) => w.includes("derivado do slug")), p.warnings.join("\n"));
    assert.ok(p.premises.some((m) => m.includes("#7420")), p.premises.join("\n"));
  });

  it("--edition-url / 05-edition-url.txt vencem o backend", () => {
    const p = plan({ backend: "kit" }, "https://diar.ia.br/p/outro");
    assert.equal(p.editionUrl, "https://diar.ia.br/p/outro");
    assert.ok(p.premises.some((m) => m.includes("https://diar.ia.br/p/outro")));
  });

  it("newsletterBackendOf: default kit, só o literal 'beehiiv' é beehiiv (#11225)", () => {
    assert.equal(newsletterBackendOf({ publishing: { newsletter: { backend: "kit" } } }), "kit");
    assert.equal(newsletterBackendOf({ publishing: { newsletter: { backend: "KIT" } } }), "kit");
    assert.equal(newsletterBackendOf({ publishing: { newsletter: { backend: "beehiiv" } } }), "kit");
    assert.equal(newsletterBackendOf(null), "kit");
    assert.equal(newsletterBackendOf(undefined), "kit");
    assert.equal(newsletterBackendOf({}), "kit");
  });
});
