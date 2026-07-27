/**
 * publish-weekly-social.test.ts (#4101)
 *
 * Cobre:
 *   - computeWeeklyScheduledAt (pura, baseada em `saturday` — nunca Date.now()).
 *   - resolvePublicImageUrl / resolveLocalImagePath (leitura de disco).
 *   - Integração: semana com 0 edições válidas → o script encerra ANTES de
 *     qualquer publisher ser chamado (nunca lança por falta de credenciais
 *     Facebook/Worker, porque nunca chega a precisar delas).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  computeWeeklyScheduledAt,
  resolvePublicImageUrl,
  resolveLocalImagePath,
  DEFAULT_WEEKLY_TIME,
} from "../scripts/publish-weekly-social.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("computeWeeklyScheduledAt", () => {
  it("usa a data do sábado passada, nunca Date.now()", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260801", timezone: "America/Sao_Paulo" });
    assert.match(iso, /^2026-08-01T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    assert.ok(iso.startsWith(`2026-08-01T${DEFAULT_WEEKLY_TIME}`));
  });

  it("aceita --time override", () => {
    const iso = computeWeeklyScheduledAt({ saturday: "260801", time: "09:15", timezone: "America/Sao_Paulo" });
    assert.ok(iso.startsWith("2026-08-01T09:15"));
  });

  it("rejeita time em formato inválido", () => {
    assert.throws(() => computeWeeklyScheduledAt({ saturday: "260801", time: "9h", timezone: "America/Sao_Paulo" }));
  });

  it("rejeita saturday em formato inválido", () => {
    assert.throws(() => computeWeeklyScheduledAt({ saturday: "2026-08-01", timezone: "America/Sao_Paulo" }));
  });
});

describe("resolvePublicImageUrl / resolveLocalImagePath", () => {
  it("retorna null quando os arquivos não existem", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      assert.equal(resolvePublicImageUrl(root), null);
      assert.equal(resolveLocalImagePath(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lê a URL pública 4x5 com fallback pra 1x1", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({ images: { d1: { url: "https://cdn.example.com/d1-1x1.jpg" } } }),
        "utf8",
      );
      assert.equal(resolvePublicImageUrl(root), "https://cdn.example.com/d1-1x1.jpg");

      writeFileSync(
        resolve(root, "06-public-images.json"),
        JSON.stringify({
          images: {
            d1: { url: "https://cdn.example.com/d1-1x1.jpg" },
            d1_4x5: { url: "https://cdn.example.com/d1-4x5.jpg" },
          },
        }),
        "utf8",
      );
      assert.equal(resolvePublicImageUrl(root), "https://cdn.example.com/d1-4x5.jpg");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefere o arquivo local 4x5, cai pra 1x1", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-weekly-img-"));
    try {
      writeFileSync(resolve(root, "04-d1-1x1.jpg"), "fake-jpg-1x1");
      assert.equal(resolveLocalImagePath(root), resolve(root, "04-d1-1x1.jpg"));

      writeFileSync(resolve(root, "04-d1-4x5.jpg"), "fake-jpg-4x5");
      assert.equal(resolveLocalImagePath(root), resolve(root, "04-d1-4x5.jpg"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("integração: semana com 0 edições — nenhum publisher é chamado", () => {
  it("script encerra sem lançar e sem exigir credenciais Facebook/Worker", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "diaria-weekly-empty-"));
    try {
      const result = spawnSync(
        "npx",
        [
          "tsx",
          resolve(__ROOT, "scripts/publish-weekly-social.ts"),
          "--saturday",
          "260801",
          "--editions-root",
          editionsRoot,
          "--schedule", // mesmo com --schedule, não deve tentar publicar nada
        ],
        {
          cwd: __ROOT,
          encoding: "utf8",
          // Sem env de credenciais — se o script tentasse dispatchar um
          // publisher de verdade, falharia aqui por falta de env vars antes
          // de qualquer fetch de rede.
          env: { ...process.env, FACEBOOK_PAGE_ID: "", FACEBOOK_PAGE_ACCESS_TOKEN: "", DIARIA_LINKEDIN_CRON_TOKEN: "" },
          shell: process.platform === "win32",
        },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        (result.stdout ?? "").includes("NÃO será publicado"),
        `stdout deveria explicar que nada foi publicado: ${result.stdout}`,
      );
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });
});
