/**
 * test/session-leakage-checklist.test.ts (#5547 item 4)
 *
 * Cobre `scripts/lib/session-leakage-checklist.ts` — o checklist de
 * qualidade editorial derivado dos 9 valores conhecidos do #5414 (3 módulos
 * de estado) + o scan de candidatos novos não cobertos nos playbooks.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPersistedStateCompleteness,
  findUncoveredSessionValueMentions,
  buildSessionLeakageReport,
} from "../scripts/lib/session-leakage-checklist.ts";
import { writePreflightState } from "../scripts/lib/preflight-state.ts";
import { writeStage4CaptureState } from "../scripts/lib/stage4-capture-state.ts";
import { writeEiaDispatchState } from "../scripts/lib/eia-dispatch-state.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tmpEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-leakage-"));
  roots.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("checkPersistedStateCompleteness", () => {
  it("todos os 9 valores ok quando os 3 módulos de estado foram escritos por completo", () => {
    const dir = tmpEditionDir();
    writePreflightState(dir, {
      chromeMcp: true,
      gmailMcp: true,
      beehiivMcp: true,
      clariceRest: true,
      cloudflareTokenOk: true,
    });
    writeStage4CaptureState(dir, { whatsappUrl: "https://diar.ia.br/x", metaDescriptionSuggestion: "" });
    writeEiaDispatchState(dir, { bashId: "bash-1", dispatchedAt: "2026-08-14T08:00:00.000Z" });

    const checks = checkPersistedStateCompleteness(dir);
    const failing = checks.filter((c) => !c.ok);
    assert.deepEqual(failing, [], `esperava todos ok, falharam: ${JSON.stringify(failing)}`);
  });

  it("preflight nunca escrito → falha em TODOS os 6 checks de preflight (capturedAt + 5 sinais)", () => {
    const dir = tmpEditionDir();
    const checks = checkPersistedStateCompleteness(dir);
    const preflightChecks = checks.filter((c) => c.key.startsWith("preflight."));
    assert.equal(preflightChecks.length, 6);
    assert.ok(preflightChecks.every((c) => !c.ok));
  });

  it("metaDescriptionSuggestion='' (string vazia) é um valor VÁLIDO — não confundir com null", () => {
    const dir = tmpEditionDir();
    writeStage4CaptureState(dir, { whatsappUrl: "https://x", metaDescriptionSuggestion: "" });
    const checks = checkPersistedStateCompleteness(dir);
    const check = checks.find((c) => c.key === "stage4.metaDescriptionSuggestion")!;
    assert.equal(check.ok, true);
  });

  it("eia.bashId null cross-sessão é OPCIONAL — não falha o checklist mesmo ausente", () => {
    const dir = tmpEditionDir();
    writeEiaDispatchState(dir, { bashId: null, dispatchedAt: "2026-08-14T08:00:00.000Z" });
    const checks = checkPersistedStateCompleteness(dir);
    const bashIdCheck = checks.find((c) => c.key === "eia.bashId")!;
    assert.equal(bashIdCheck.optional, true);
    assert.equal(bashIdCheck.ok, true);
  });

  it("eia.dispatchedAt ausente FALHA (não é opcional — precisa sobreviver a sessão nova)", () => {
    const dir = tmpEditionDir();
    const checks = checkPersistedStateCompleteness(dir);
    const dispatchedCheck = checks.find((c) => c.key === "eia.dispatchedAt")!;
    assert.equal(dispatchedCheck.optional, false);
    assert.equal(dispatchedCheck.ok, false);
  });
});

describe("findUncoveredSessionValueMentions", () => {
  function withAgentsDir(files: Record<string, string>, fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "leakage-agents-"));
    roots.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    fn(dir);
  }

  it("ignora menção marcada com #5414 na mesma linha", () => {
    withAgentsDir(
      {
        "orchestrator-stage-4.md": "Capturar como `{whatsapp_url}` e persistir em disco (#5414).\n",
      },
      (dir) => {
        const found = findUncoveredSessionValueMentions(dir);
        assert.deepEqual(found, []);
      },
    );
  });

  it("ignora menção marcada com #5414 em linha próxima (janela de cobertura)", () => {
    withAgentsDir(
      {
        "orchestrator-stage-4.md": "Capturar como `{x}` e\npersistir em disco (#5414), mesmo motivo.\n",
      },
      (dir) => {
        const found = findUncoveredSessionValueMentions(dir);
        assert.deepEqual(found, []);
      },
    );
  });

  it("acha menção SEM marcador #5414 — candidato novo não coberto", () => {
    withAgentsDir(
      {
        "orchestrator-stage-0-preflight.md": "Armazenar como `edition_iso` (ex: `2026-04-23`).\n",
      },
      (dir) => {
        const found = findUncoveredSessionValueMentions(dir);
        assert.equal(found.length, 1);
        assert.equal(found[0].line, 1);
        assert.match(found[0].text, /edition_iso/);
      },
    );
  });

  it("varre múltiplos arquivos orchestrator-stage-*.md", () => {
    withAgentsDir(
      {
        "orchestrator-stage-1-research.md": "Guardar em sessão o valor X.\n",
        "orchestrator-stage-2.md": "nada relevante aqui.\n",
        "outro-agente.md": "Guardar em sessão isto também (não deve contar, não é orchestrator-stage-*).\n",
      },
      (dir) => {
        const found = findUncoveredSessionValueMentions(dir);
        assert.equal(found.length, 1);
        assert.equal(found[0].file, "orchestrator-stage-1-research.md");
      },
    );
  });

  it("diretório ausente retorna [] sem lançar", () => {
    const found = findUncoveredSessionValueMentions("/does/not/exist/at/all");
    assert.deepEqual(found, []);
  });
});

describe("buildSessionLeakageReport", () => {
  it("clean=true só quando persisted_state passa E não há candidatos não cobertos", () => {
    const editionDir = tmpEditionDir();
    writePreflightState(editionDir, {
      chromeMcp: true,
      gmailMcp: true,
      beehiivMcp: true,
      clariceRest: true,
      cloudflareTokenOk: true,
    });
    writeStage4CaptureState(editionDir, { whatsappUrl: "https://x", metaDescriptionSuggestion: "" });
    writeEiaDispatchState(editionDir, { bashId: null, dispatchedAt: "2026-08-14T08:00:00.000Z" });

    const agentsDir = mkdtempSync(join(tmpdir(), "leakage-agents-clean-"));
    roots.push(agentsDir);
    writeFileSync(join(agentsDir, "orchestrator-stage-4.md"), "nada de especial aqui.\n", "utf8");

    const report = buildSessionLeakageReport(editionDir, "260814", agentsDir);
    assert.equal(report.clean, true);
  });

  it("clean=false quando há candidato não coberto, mesmo com persisted_state completo", () => {
    const editionDir = tmpEditionDir();
    writePreflightState(editionDir, {
      chromeMcp: true,
      gmailMcp: true,
      beehiivMcp: true,
      clariceRest: true,
      cloudflareTokenOk: true,
    });
    writeStage4CaptureState(editionDir, { whatsappUrl: "https://x", metaDescriptionSuggestion: "" });
    writeEiaDispatchState(editionDir, { bashId: null, dispatchedAt: "2026-08-14T08:00:00.000Z" });

    const agentsDir = mkdtempSync(join(tmpdir(), "leakage-agents-dirty-"));
    roots.push(agentsDir);
    writeFileSync(join(agentsDir, "orchestrator-stage-2.md"), "Armazenar como `{y}` sem persistir.\n", "utf8");

    const report = buildSessionLeakageReport(editionDir, "260814", agentsDir);
    assert.equal(report.clean, false);
    assert.equal(report.uncovered_mentions.length, 1);
  });
});
