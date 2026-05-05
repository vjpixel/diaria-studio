import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlatformConfig } from "../../scripts/lib/schemas/platform-config.ts";

describe("platform-config schema (#632)", () => {
  it("parse config mínimo (só campos obrigatórios)", () => {
    const result = parsePlatformConfig({});
    assert.equal(result.drive_sync, true);
  });

  it("parse config completo sem erro", () => {
    const result = parsePlatformConfig({
      newsletter: "beehiiv",
      publication_id: "pub_abc123",
      drive_sync: true,
      image_generator: "gemini",
      inbox: { enabled: true, gmailQuery: "label:Diaria.Editor", address: "test@test.com" },
      publishing: {
        newsletter: { platform: "beehiiv", template: "Default" },
        social: {
          linkedin: { method: "chrome_automation", day_offset: 0 },
          facebook: { method: "graph_api", day_offset: 0 },
        },
      },
    });
    assert.equal(result.newsletter, "beehiiv");
    assert.equal(result.image_generator, "gemini");
  });

  it("rejeita image_generator inválido", () => {
    assert.throws(
      () => parsePlatformConfig({ image_generator: "dall-e-3" }),
      /invalid_enum_value|invalid/i,
    );
  });

  it("rejeita inbox.address não-email", () => {
    assert.throws(
      () => parsePlatformConfig({ inbox: { address: "not-an-email" } }),
      /invalid_string|invalid/i,
    );
  });

  it("aceita campos extras (passthrough)", () => {
    const result = parsePlatformConfig({ custom_prop: "custom" });
    assert.equal((result as Record<string, unknown>).custom_prop, "custom");
  });
});
