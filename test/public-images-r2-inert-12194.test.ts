/**
 * #12194: com `public_images_r2.enabled` ligada e a edição inteira no KV
 * (env ausente, PUT/HEAD falhando), o upload avisa e grava um `warn` no
 * run-log, que `collect-edition-signals.ts` transforma em signal do
 * auto-reporter. Sem rede: uploaders e run-log injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLIC_IMAGES_R2_INERT_LOG_PREFIX,
  publicImagesR2InertMessage,
  summarizePublicImagesR2Coverage,
} from "../scripts/lib/public-images-r2.ts";
import { uploadPublicImages } from "../scripts/upload-images-public.ts";
import { signalsFromPublicImagesR2Inert, signalsFromTestWarnings } from "../scripts/collect-edition-signals.ts";
import type { RunLogEvent } from "../scripts/lib/run-log.ts";

const COVER = "img-261028-04-d1-2x1-0123abcd.jpg";
const D2 = "img-261028-04-d2-2x1-89abcdef.jpg";
const EIA = "img-261028-01-eia-A.jpg";

describe("#12194 summarizePublicImagesR2Coverage", () => {
  it("flag ligada + todas as elegíveis no KV → inert", () => {
    const c = summarizePublicImagesR2Coverage(
      {
        cover: { file_id: COVER, target: "cloudflare" },
        d2: { file_id: D2, target: "cloudflare" },
        eia_a: { file_id: EIA, target: "cloudflare" },
      },
      true,
    );
    assert.equal(c.eligible, 2, "É IA? de convenção fixa não é elegível");
    assert.equal(c.r2, 0);
    assert.deepEqual(c.kvKeys, ["cover", "d2"]);
    assert.equal(c.inert, true);
  });

  it("≥1 elegível no R2 → não inerte (fallback parcial não alarma)", () => {
    const c = summarizePublicImagesR2Coverage(
      { cover: { file_id: COVER, target: "r2" }, d2: { file_id: D2, target: "cloudflare" } },
      true,
    );
    assert.equal(c.r2, 1);
    assert.equal(c.kv, 1);
    assert.equal(c.inert, false);
  });

  it("flag desligada → nunca inerte, mesmo tudo no KV", () => {
    const c = summarizePublicImagesR2Coverage({ cover: { file_id: COVER, target: "cloudflare" } }, false);
    assert.equal(c.eligible, 1);
    assert.equal(c.inert, false);
  });

  it("0 elegíveis (só É IA?, entry legada drive/sem target) → não inerte", () => {
    const c = summarizePublicImagesR2Coverage(
      {
        eia_a: { file_id: EIA, target: "cloudflare" },
        old: { file_id: COVER, target: "drive" },
        notarget: { file_id: D2 },
      },
      true,
    );
    assert.equal(c.eligible, 0);
    assert.equal(c.inert, false);
  });

  it("mensagem começa com o prefixo que o collector casa", () => {
    const c = summarizePublicImagesR2Coverage({ cover: { file_id: COVER, target: "cloudflare" } }, true);
    const msg = publicImagesR2InertMessage(c);
    assert.ok(msg.startsWith(PUBLIC_IMAGES_R2_INERT_LOG_PREFIX), msg);
    assert.match(msg, /0 de 1 /);
    assert.match(msg, /cover/);
  });
});

describe("#12194 uploadPublicImages: alarme da edição toda no KV", () => {
  function setupEdition() {
    const base = mkdtempSync(join(tmpdir(), "r2-inert-"));
    const dir = join(base, "261028");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    for (const f of ["04-d1-2x1.jpg", "01-eia-A.jpg", "01-eia-B.jpg"]) writeFileSync(join(dir, f), `bytes-${f}`, "utf8");
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }), "utf8");
    return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("R2 ligado e falhando em tudo → aviso + warn no run-log com a edição", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const events: RunLogEvent[] = [];
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => `https://kv/img/${key}`,
          uploadToR2: async () => {
            throw new Error("R2 PUT x: HTTP 403");
          },
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
        logRunEvent: (e) => events.push(e),
      });
      assert.equal(res.r2_coverage.inert, true);
      assert.equal(res.r2_coverage.eligible, 1);
      assert.ok(res.warnings.some((w) => w.startsWith(PUBLIC_IMAGES_R2_INERT_LOG_PREFIX)), JSON.stringify(res.warnings));
      assert.equal(events.length, 1);
      assert.equal(events[0].level, "warn");
      assert.equal(events[0].edition, "261028");
      assert.equal(events[0].agent, "upload-images-public");
      assert.ok(events[0].message.startsWith(PUBLIC_IMAGES_R2_INERT_LOG_PREFIX));
    } finally {
      cleanup();
    }
  });

  it("R2 ligado e funcionando → sem alarme", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const events: RunLogEvent[] = [];
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => `https://kv/img/${key}`,
          uploadToR2: async (_p, key) => `https://eia/img/${key}`,
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
        logRunEvent: (e) => events.push(e),
      });
      assert.equal(res.r2_coverage.inert, false);
      assert.equal(res.r2_coverage.r2, 1);
      assert.deepEqual(events, []);
      assert.ok(!res.warnings.some((w) => w.startsWith(PUBLIC_IMAGES_R2_INERT_LOG_PREFIX)));
    } finally {
      cleanup();
    }
  });

  it("flag desligada (sem uploader R2) → tudo no KV sem alarme", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const events: RunLogEvent[] = [];
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: { uploadToCloudflare: async (_p, key) => `https://kv/img/${key}`, uploadToR2: null },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
        logRunEvent: (e) => events.push(e),
      });
      assert.equal(res.r2_coverage.flagEnabled, false);
      assert.equal(res.r2_coverage.inert, false);
      assert.deepEqual(events, []);
    } finally {
      cleanup();
    }
  });
});

describe("#12194 signalsFromPublicImagesR2Inert", () => {
  const warnLine = (edition: string | null, message: string, level = "warn") =>
    JSON.stringify({ timestamp: "2026-11-04T10:00:00Z", edition, stage: null, agent: "upload-images-public", level, message, details: null });
  const msg = `${PUBLIC_IMAGES_R2_INERT_LOG_PREFIX} public_images_r2.enabled = true, mas 0 de 1 imagens elegíveis`;

  it("um warn da edição vira 1 signal medium; dois uploads (social + newsletter) seguem 1 signal", () => {
    const one = signalsFromPublicImagesR2Inert([warnLine("261028", msg)], "261028");
    assert.equal(one.length, 1);
    assert.equal(one[0].kind, "public_images_r2_inert");
    assert.equal(one[0].severity, "medium");
    assert.equal(one[0].related_issue, "#12194");
    const two = signalsFromPublicImagesR2Inert([warnLine("261028", msg), warnLine("261028", msg)], "261028");
    assert.equal(two.length, 1);
    assert.equal(two[0].details.count, 2);
  });

  it("outra edição, sem edição, info ou mensagem sem o prefixo → nada", () => {
    assert.deepEqual(signalsFromPublicImagesR2Inert([warnLine("261027", msg)], "261028"), []);
    assert.deepEqual(signalsFromPublicImagesR2Inert([warnLine(null, msg)], "261028"), []);
    assert.deepEqual(signalsFromPublicImagesR2Inert([warnLine("261028", msg, "info")], "261028"), []);
    assert.deepEqual(signalsFromPublicImagesR2Inert([warnLine("261028", "outra coisa")], "261028"), []);
  });

  it("não duplica como test_warning", () => {
    assert.deepEqual(signalsFromTestWarnings([warnLine("261028", msg)], "261028"), []);
  });
});
