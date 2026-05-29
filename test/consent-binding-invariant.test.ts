/**
 * test/consent-binding-invariant.test.ts (#1575)
 *
 * Cobre o invariant `consent-binding` em stage-4: canais com consent=auto
 * devem ter dispatch real (não pending_manual / ausente / vazio).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkConsentBinding } from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "consent-binding-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeConsent(
  dir: string,
  consent: { newsletter?: string; linkedin?: string; facebook?: string },
): void {
  writeFileSync(
    resolve(dir, "_internal", "05-publish-consent.json"),
    JSON.stringify(consent),
  );
}

function writePublished(
  dir: string,
  pub: { status?: string; draft_url?: string; post_id?: string },
): void {
  writeFileSync(
    resolve(dir, "_internal", "05-published.json"),
    JSON.stringify(pub),
  );
}

function writeSocialPublished(
  dir: string,
  posts: Array<{ platform: string; status?: string; url?: string }>,
): void {
  writeFileSync(
    resolve(dir, "_internal", "06-social-published.json"),
    JSON.stringify({ posts }),
  );
}

describe("checkConsentBinding (#1575)", () => {
  it("sem 05-publish-consent.json → no-op (zero violations)", () => {
    const dir = makeEditionDir();
    try {
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json ausente → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      const nl = violations.find((v) => v.rule === "consent-binding-newsletter");
      assert.ok(nl);
      assert.match(nl!.message, /05-published\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json com pending_manual → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      writePublished(dir, { status: "pending_manual" });
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      const nl = violations.find((v) => v.rule === "consent-binding-newsletter");
      assert.ok(nl);
      assert.match(nl!.message, /pending_manual/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=auto + 05-published.json com draft_url → ok", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "manual", facebook: "manual" });
      writePublished(dir, {
        status: "draft",
        draft_url: "https://app.beehiiv.com/posts/abc/edit",
      });
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.newsletter=manual → não exige dispatch (sem violation)", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "manual", facebook: "manual" });
      // Nada em 05-published.json — manual, ok não dispatchar
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.linkedin=auto + 06-social-published.json ausente → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "manual" });
      const violations = checkConsentBinding(dir);
      const li = violations.find((v) => v.rule === "consent-binding-social");
      assert.ok(li);
      assert.match(li!.message, /linkedin/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.facebook=auto + posts[platform=facebook] vazio → violation", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "manual", facebook: "auto" });
      writeSocialPublished(dir, [
        { platform: "linkedin", url: "https://linkedin.com/x" },
      ]);
      const violations = checkConsentBinding(dir);
      const fb = violations.find((v) => v.rule === "consent-binding-facebook");
      assert.ok(fb);
      assert.match(fb!.message, /vazio/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("consent.{linkedin,facebook}=auto + ambos com posts → ok", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "manual", linkedin: "auto", facebook: "auto" });
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: "https://linkedin.com/x" },
        { platform: "facebook", status: "draft", url: "https://facebook.com/x" },
      ]);
      const violations = checkConsentBinding(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Cenário real 260529: consent=tudo auto + dispatch newsletter pulado → violation loud", () => {
    const dir = makeEditionDir();
    try {
      writeConsent(dir, { newsletter: "auto", linkedin: "auto", facebook: "auto" });
      // Newsletter ausente (orchestrator bypassou Chrome MCP)
      // Social com posts
      writeSocialPublished(dir, [
        { platform: "linkedin", status: "scheduled", url: "..." },
        { platform: "facebook", status: "draft", url: "..." },
      ]);
      const violations = checkConsentBinding(dir);
      assert.ok(violations.length > 0);
      assert.ok(violations.some((v) => v.rule === "consent-binding-newsletter"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
