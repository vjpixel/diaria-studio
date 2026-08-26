/**
 * test/kit-diaria-config-6313.test.ts (#6313, #6321)
 *
 * Regressão de CONFIG, não de lógica: garante que `platform.config.json`
 * não volte a afirmar `kit_diaria.enabled: true` enquanto
 * `publishing.newsletter.backend` for `"kit"` — a combinação que sugeria
 * (a quem lesse só a config) um envio duplicado da edição, mesmo com o
 * guard em código (`decideKitChannelDispatch`/`scheduleKitDiaria`) impedindo
 * o dano de fato. Ver #6313/#6321 para o achado completo.
 *
 * Isto não substitui o guard em código (já coberto em
 * `test/kit-diaria-channel-6126.test.ts` e
 * `test/schedule-kit-diaria-6048.test.ts`) — é a segunda camada de defesa
 * que a issue pediu: a config em si não deve mais sugerir o mundo errado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPlatformConfig(): {
  kit_diaria?: { enabled?: boolean };
  publishing?: { newsletter?: { backend?: string } };
} {
  return JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
}

describe("#6313/#6321 platform.config.json — kit_diaria.enabled não pode ser true junto com backend kit", () => {
  it("backend === \"kit\" ⇒ kit_diaria.enabled não é true (config não sugere envio em dobro)", () => {
    const cfg = readPlatformConfig();
    if (cfg.publishing?.newsletter?.backend === "kit") {
      assert.notEqual(
        cfg.kit_diaria?.enabled,
        true,
        "kit_diaria.enabled=true com backend=\"kit\" é a combinação perigosa que #6313/#6321 corrigiram — " +
          "se o switchover for revertido, reverter kit_diaria.enabled junto ou documentar a exceção aqui.",
      );
    }
  });
});
