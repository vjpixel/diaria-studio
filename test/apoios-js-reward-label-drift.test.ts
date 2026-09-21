/**
 * test/apoios-js-reward-label-drift.test.ts
 *
 * `scripts/studio-ui/public/apoios.js` (painel de Apoios do Studio) hardcoda
 * os 4 limiares de nível de recompensa como labels de exibição
 * (`REWARD_GROUP_LABEL`, ex: "Patrono (R$50+)") porque é servido cru — sem
 * build step — e não pode `import` `scripts/lib/reward-tier-thresholds.ts`,
 * a fonte canônica extraída em #8155. Terceira cópia dos mesmos 4 valores
 * (as outras duas: `scripts/studio-ui/studio-apoios.ts::computeRewardGroup`
 * e `scripts/lib/shared/artigo-especial-gate-cta.ts`, ambas já derivadas do módulo
 * canônico) — achada no self-review dessa mesma PR.
 *
 * Este guard não elimina a duplicação (não dá, é JS estático), só garante
 * que ela não passe despercebida: falha se REWARD_TIER_*_MIN mudar e as
 * strings literais de apoios.js não acompanharem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REWARD_TIER_AMIGO_MIN,
  REWARD_TIER_APOIADOR_MIN,
  REWARD_TIER_MANTENEDOR_MIN,
  REWARD_TIER_PATRONO_MIN,
} from "../scripts/lib/reward-tier-thresholds.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apoiosJs = readFileSync(resolve(ROOT, "scripts", "studio-ui", "public", "apoios.js"), "utf8");

describe("apoios.js REWARD_GROUP_LABEL vs REWARD_TIER_*_MIN (guard de drift)", () => {
  it("Patrono cita o piso atual sem teto (nível mais alto)", () => {
    assert.ok(
      apoiosJs.includes(`patrono: "Patrono (R$${REWARD_TIER_PATRONO_MIN}+)"`),
      `label de Patrono deveria citar R$${REWARD_TIER_PATRONO_MIN}+ (REWARD_TIER_PATRONO_MIN atual)`,
    );
  });

  it("Mantenedor cita o intervalo [MANTENEDOR_MIN, PATRONO_MIN - 1]", () => {
    const faixa = `R$${REWARD_TIER_MANTENEDOR_MIN}–${REWARD_TIER_PATRONO_MIN - 1}`;
    assert.ok(
      apoiosJs.includes(`mantenedor: "Mantenedor (${faixa})"`),
      `label de Mantenedor deveria citar ${faixa} (REWARD_TIER_MANTENEDOR_MIN/PATRONO_MIN atuais)`,
    );
  });

  it("Apoiador cita o intervalo [APOIADOR_MIN, MANTENEDOR_MIN - 1]", () => {
    const faixa = `R$${REWARD_TIER_APOIADOR_MIN}–${REWARD_TIER_MANTENEDOR_MIN - 1}`;
    assert.ok(
      apoiosJs.includes(`apoiador: "Apoiador (${faixa})"`),
      `label de Apoiador deveria citar ${faixa} (REWARD_TIER_APOIADOR_MIN/MANTENEDOR_MIN atuais)`,
    );
  });

  it("Amigo cita o intervalo [AMIGO_MIN, APOIADOR_MIN - 1]", () => {
    const faixa = `R$${REWARD_TIER_AMIGO_MIN}–${REWARD_TIER_APOIADOR_MIN - 1}`;
    assert.ok(
      apoiosJs.includes(`amigo: "Amigo (${faixa})"`),
      `label de Amigo deveria citar ${faixa} (REWARD_TIER_AMIGO_MIN/APOIADOR_MIN atuais)`,
    );
  });
});
