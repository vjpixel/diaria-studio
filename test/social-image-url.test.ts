/**
 * test/social-image-url.test.ts (#1635)
 *
 * Bug 260601: d2/d3 só sobem pro Drive (mode=social); render-social-html
 * fabricava uma key Cloudflare SEM o sufixo md5 → 404 silencioso. resolveSocialImageUrl
 * nunca chuta key: prefere cloudflare_url, senão a url real (Drive serve inline).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSocialImageUrl } from "../scripts/lib/social-image-url.ts";

const CF_URL = "https://poll.diaria.workers.dev/img/img-260601-04-d2-1x1-6d6820cf.jpg";
const DRIVE_URL = "https://drive.google.com/uc?id=ABC123&export=view";

describe("resolveSocialImageUrl (#1635)", () => {
  it("prefere cloudflare_url quando presente (com md5 suffix)", () => {
    const out = resolveSocialImageUrl({ url: DRIVE_URL, cloudflare_url: CF_URL });
    assert.equal(out, CF_URL);
  });

  it("sem cloudflare_url + url Drive → usa a Drive url direto (NÃO fabrica key CF)", () => {
    const out = resolveSocialImageUrl({ url: DRIVE_URL, filename: "04-d2-1x1.jpg" });
    assert.equal(out, DRIVE_URL);
    // o bug: nunca deve retornar uma key Cloudflare montada sem md5
    assert.doesNotMatch(out, /workers\.dev\/img\/img-\d+-04-d2-1x1\.jpg$/);
  });

  it("emite warn quando cai no fallback Drive (nudge pra subir pro CF)", () => {
    let warned = "";
    resolveSocialImageUrl({ url: DRIVE_URL }, (m) => (warned = m));
    assert.match(warned, /cloudflare_url ausente/i);
    assert.match(warned, /#1635/);
  });

  it("não emite warn quando usa cloudflare_url", () => {
    let warned = "";
    resolveSocialImageUrl({ url: DRIVE_URL, cloudflare_url: CF_URL }, (m) => (warned = m));
    assert.equal(warned, "");
  });

  it("url não-Drive (ex: já Cloudflare em url) → usa direto, sem warn", () => {
    let warned = "";
    const out = resolveSocialImageUrl({ url: CF_URL }, (m) => (warned = m));
    assert.equal(out, CF_URL);
    assert.equal(warned, "");
  });

  it("entry ausente → string vazia", () => {
    assert.equal(resolveSocialImageUrl(undefined), "");
  });

  it("entry sem url nem cloudflare_url → string vazia", () => {
    assert.equal(resolveSocialImageUrl({ url: "" }), "");
  });
});
