import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseNewsletterBackend } from "../scripts/lib/newsletter-backend.ts";
import { decideKitChannelDispatch } from "../scripts/lib/kit-diaria-channel.ts";

describe("#11225 arquivo Beehiiv nunca reativa envio", () => {
  for (const raw of [undefined, null, "", "beehiiv", " BEEHIIV ", "kit", "typo", 1]) {
    it(`backend ${JSON.stringify(raw)} resolve para Kit e recusa canal paralelo`, () => {
      assert.equal(parseNewsletterBackend(raw), "kit");
      assert.equal(decideKitChannelDispatch({
        config: { enabled: true, audience_tag: "rampa-kit" },
        existing: null,
        defaultAudienceTag: "rampa-kit",
        newsletterBackend: raw as string | undefined,
      }).action, "skip");
    });
  }
  for (const script of ["sync-apoio-nivel-beehiiv", "sync-apoio-segments-beehiiv", "sync-sparkloop-exclusion-segment-beehiiv", "sync-beehiiv-subscribers-kit"]) {
    it(`${script} --push encerra antes de rede`, () => {
      const target = new URL(`../scripts/${script}.ts`, import.meta.url);
      const code = `globalThis.fetch = async () => { throw new Error("REDE PROIBIDA"); }; process.argv = [process.execPath, ${JSON.stringify(target.pathname)}, "--push"]; await import(${JSON.stringify(target.href)});`;
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /#11225/);
      assert.doesNotMatch(result.stderr, /REDE PROIBIDA/);
    });
  }
});
