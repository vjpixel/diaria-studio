import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KNOWN_NEWSLETTER_REPLY_ADDRESSES } from "../scripts/lib/newsletter-reply-addresses.ts";

const cfg = JSON.parse(readFileSync("platform.config.json", "utf8"));
const REPLY_TO = "pixel@diar.ia.br";

describe("reply-to das contas Brevo (Clarice News + diar.ia.br)", () => {
  for (const block of ["brevo_monthly", "brevo_diaria", "brevo_apoiadores", "onboarding"]) {
    it(`${block}.reply_to = ${REPLY_TO}`, () => {
      assert.equal(cfg[block].reply_to, REPLY_TO);
    });
  }

  it("todo POST/PUT de /emailCampaigns com sender propaga replyTo", () => {
    const files = [
      "scripts/clarice-schedule-group.ts",
      "scripts/clarice-schedule-ramp.ts",
      "scripts/clarice-schedule-sends.ts",
      "scripts/publish-daily-brevo.ts",
      "scripts/publish-monthly.ts",
      "scripts/publish-monthly-apoiadores-brevo.ts",
      "scripts/onboarding-welcome-run.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const senders = (src.match(/^\s*sender[:,]/gm) ?? []).length;
      const replyTos = (src.match(/replyTo/g) ?? []).length;
      assert.ok(replyTos >= senders, `${f}: ${senders} sender(s) mas só ${replyTos} replyTo`);
    }
  });

  it("reply-to entra na query de replies do Stage 0", () => {
    assert.ok((KNOWN_NEWSLETTER_REPLY_ADDRESSES as readonly string[]).includes(REPLY_TO));
  });
});
