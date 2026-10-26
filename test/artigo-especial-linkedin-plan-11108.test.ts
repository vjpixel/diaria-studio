/**
 * #11108 — publish-artigo-especial-linkedin.ts:
 *  1. o horário planejado do perfil (D+2 09:30, #6014) tem que chegar ao
 *     dispatch, não cair no horário da página;
 *  2. `--only pagina` não planeja o perfil (D+2 sem slot não pode abortar a
 *     página).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planArtigoEspecialLinkedinSchedule } from "../scripts/publish-artigo-especial-linkedin.ts";
import { artigoEspecialStatePath, readArtigoEspecialState } from "../scripts/lib/artigo-especial-state.ts";

const now = Date.parse("2026-10-21T00:00:00Z");
const ats = { pagina: "2026-10-22T09:00:00-03:00", perfil: "2026-10-23T09:30:00-03:00" };

function emptyState() {
  const dir = mkdtempSync(join(tmpdir(), "ae-plan-11108-"));
  try {
    return readArtigoEspecialState(artigoEspecialStatePath(dir, "2026", "x"), "2026", "x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** linkedin:pessoal ocupado de 06h a 22h em D+2: nenhum slot com 2h de folga. */
const perfilDayFull = Array.from({ length: 17 }, (_, i) => ({
  account: "linkedin:pessoal",
  at: `2026-10-23T${String(i + 6).padStart(2, "0")}:00:00-03:00`,
}));

describe("planArtigoEspecialLinkedinSchedule (#11108)", () => {
  it("página e perfil: perfil recebe o próprio horário (D+2), não o da página", () => {
    const plan = planArtigoEspecialLinkedinSchedule({
      ats, grid: [], state: emptyState(), only: ["pagina", "perfil"], force: false, now,
    });
    assert.match(plan.scheduledAt, /^2026-10-22T/);
    assert.ok(plan.scheduledAtPerfil, "scheduledAtPerfil deve existir quando perfil está no --only");
    assert.match(plan.scheduledAtPerfil!, /^2026-10-23T/);
    assert.notEqual(plan.scheduledAtPerfil, plan.scheduledAt);
  });

  it("--only pagina não planeja o perfil: D+2 sem slot não aborta a página", () => {
    const plan = planArtigoEspecialLinkedinSchedule({
      ats, grid: perfilDayFull, state: emptyState(), only: ["pagina"], force: false, now,
    });
    assert.match(plan.scheduledAt, /^2026-10-22T/);
    assert.equal(plan.scheduledAtPerfil, undefined);
    assert.deepEqual(plan.decisions.map((d) => d.key), ["pagina"]);
  });

  it("--only perfil com D+2 cheio continua abortando (o perfil foi pedido)", () => {
    assert.throws(
      () => planArtigoEspecialLinkedinSchedule({
        ats, grid: perfilDayFull, state: emptyState(), only: ["perfil"], force: false, now,
      }),
      /sem slot seguro para perfil/,
    );
  });

  it("main() repassa scheduledAtPerfil ao runner (guard de fonte)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/publish-artigo-especial-linkedin.ts"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main()"));
    const call = mainBody.slice(
      mainBody.indexOf("runArtigoEspecialLinkedinDispatch({"),
      mainBody.indexOf("});", mainBody.indexOf("runArtigoEspecialLinkedinDispatch({")),
    );
    assert.ok(call.length > 0, "chamada do runner não encontrada em main()");
    assert.match(call, /^\s*scheduledAtPerfil,\s*$/m, "main() precisa passar scheduledAtPerfil ao runner");
  });
});
