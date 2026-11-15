/**
 * test/clarice-group-campaigns-writers-13135.test.ts (#13135)
 *
 * 1. Regressão: `clarice-envio-guard.ts` regravava o array inteiro de
 *    `group-campaigns.json` sem trava nem merge. Uma entrada gravada por outra
 *    invocação enquanto o guard fazia os PUTs de suspensão (ex.: a rodada
 *    `novos` da tarde) sumia do disco. O guard agora usa o mesmo writer
 *    mesclado do `clarice-schedule-group.ts` (#13098).
 * 2. Guard de conjunto: lista os arquivos de `scripts/` que citam o registro
 *    e escrevem arquivo. Um writer novo que não esteja no inventário reprova,
 *    para ninguém voltar a gravar `group-campaigns.json` por fora do merge.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runEnvioGuard, type EnvioGuardDeps } from "../scripts/clarice-envio-guard.ts";
import type { StepResult, ExecFn } from "../scripts/clarice-envio-run.ts";

const ROOT = resolve(import.meta.dirname, "..");
const NOW = new Date("2026-08-12T08:00:00.000Z"); // 05:00 BRT
const CYCLE = "2607-08";

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

describe("clarice-envio-guard: escrita mesclada do group-campaigns.json (#13135)", () => {
  let savedApiKey: string | undefined;
  before(() => {
    savedApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key";
  });
  after(() => {
    if (savedApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = savedApiKey;
  });

  it("entrada gravada por outra invocação durante a suspensão sobrevive à escrita do guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-guard-13135-"));
    const dir = resolve(root, "data", "clarice-subscribers", CYCLE, "segments");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "group-campaigns.json");
    const onda = { key: "d12-qua12", campaignId: 999, listId: 500, subject: "x", status: "scheduled", scheduledAt: "2026-08-12T09:00:00.000Z" };
    const outra = { key: "novos-2608121800", campaignId: 1234, listId: 777, subject: "y", status: "sent" };
    writeFileSync(path, JSON.stringify([onda]), "utf8");

    const exec: ExecFn = (script) => {
      if (script === "scripts/clarice-plan-wave.ts") {
        return jsonResult({ state: { waves: [{ key: "d12-qua12", listId: 500, subject: "x", status: "scheduled", scheduledAt: onda.scheduledAt, volume: 100 }] } });
      }
      if (script === "scripts/clarice-envio-risk.ts") {
        return jsonResult({ brake: { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.3 } });
      }
      throw new Error(`exec inesperado: ${script}`);
    };
    const deps: EnvioGuardDeps = {
      rootDir: root,
      now: () => NOW,
      exec,
      isEnabled: () => true,
      execMode: () => "local",
      sleep: async () => {},
      setCampaignStatus: async () => {
        // Outra invocação grava a entrada dela enquanto o PUT está em curso.
        const onDisk = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify([...onDisk, outra]), "utf8");
      },
    };
    try {
      const r = await runEnvioGuard(deps);
      assert.equal(r.code, 0, r.reportMarkdown);
      const final = JSON.parse(readFileSync(path, "utf8")) as Array<{ key: string; status: string }>;
      assert.deepEqual(final.map((e) => e.key), ["d12-qua12", "novos-2608121800"], "a entrada da outra invocação continua no registro");
      assert.equal(final[0].status, "draft", "a suspensão do guard é aplicada");
      assert.equal(final[1].status, "sent", "a entrada alheia fica como a outra invocação gravou");
      assert.equal(existsSync(`${path}.lock`), false, "a trava é liberada");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Guard de conjunto: quem escreve group-campaigns.json
// ---------------------------------------------------------------------------

/** Arquivos de `scripts/` que citam o registro E chamam uma primitiva de escrita.
 * Cada um precisa estar aqui, com o motivo de ser seguro. */
const KNOWN_FILES: Record<string, string> = {
  "scripts/lib/clarice-group-campaigns-store.ts": "o próprio writer mesclado (#13098/#13135)",
  "scripts/clarice-schedule-group.ts": "grava por writeGroupCampaignsMerged; a restauração do send-now reescreve sob withGroupCampaignsLock",
  "scripts/clarice-envio-guard.ts": "grava por writeGroupCampaignsMerged (#13135); writeFileAtomic é do relatório",
  "scripts/clarice-schedule-sends.ts": "grava sends/cells/campaigns-summary.json; group-campaigns chega por writeFn injetado pelo schedule-group",
  "scripts/lib/clarice-novos-state.ts": "grava o estado do novos; só cita o registro em comentário",
  "scripts/lib/clarice-novos-run-status.ts": "grava o run-status do novos; só LÊ o registro",
};

/** Arquivos que gravam o registro de fato — precisam importar o writer mesclado. */
const MERGED_WRITERS = ["scripts/clarice-schedule-group.ts", "scripts/clarice-envio-guard.ts"];

const WRITE_PRIMITIVE = /\b(writeFileAtomic|writeFileSync|appendFileSync|renameSync|writeFile|copyFileSync)\s*\(/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("inventário de writers do group-campaigns.json (#13135)", () => {
  const candidates = listSourceFiles(resolve(ROOT, "scripts"))
    .filter((p) => {
      const src = readFileSync(p, "utf8");
      return src.includes("group-campaigns") && WRITE_PRIMITIVE.test(src);
    })
    .map((p) => relative(ROOT, p).replaceAll("\\", "/"))
    .sort();

  it("todo arquivo que cita o registro e escreve arquivo está no inventário", () => {
    const unknown = candidates.filter((f) => !(f in KNOWN_FILES));
    assert.deepEqual(
      unknown,
      [],
      `writer novo de group-campaigns.json? Grave pelo writeGroupCampaignsMerged (scripts/lib/clarice-group-campaigns-store.ts) ` +
        `e acrescente o arquivo a KNOWN_FILES com o motivo: ${unknown.join(", ")}`,
    );
  });

  it("o inventário não tem entrada velha", () => {
    const stale = Object.keys(KNOWN_FILES).filter((f) => !candidates.includes(f));
    assert.deepEqual(stale, [], `entrada sem escrita ou sem citação do registro; remover de KNOWN_FILES: ${stale.join(", ")}`);
  });

  for (const f of MERGED_WRITERS) {
    it(`${f} importa o writer mesclado`, () => {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      assert.match(src, /from "\.\/lib\/clarice-group-campaigns-store\.ts"/);
      assert.match(src, /writeGroupCampaignsMerged/);
    });
  }

  it("clarice-envio-guard: writeCampaignEntries grava só pelo writer mesclado", () => {
    const src = readFileSync(resolve(ROOT, "scripts/clarice-envio-guard.ts"), "utf8");
    const start = src.indexOf("function writeCampaignEntries(");
    assert.ok(start >= 0, "writeCampaignEntries existe");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /writeGroupCampaignsMerged\(/);
    assert.doesNotMatch(body, /writeFileAtomic\(|writeFileSync\(/);
  });

  it("clarice-schedule-group: toda escrita crua do registro roda sob withGroupCampaignsLock", () => {
    const lines = readFileSync(resolve(ROOT, "scripts/clarice-schedule-group.ts"), "utf8").split("\n");
    const raw = lines.flatMap((l, i) => (/\bwriteFileAtomic\s*\(/.test(l) ? [i] : []));
    for (const i of raw) {
      const window = lines.slice(Math.max(0, i - 6), i).join("\n");
      assert.match(window, /withGroupCampaignsLock\(/, `writeFileAtomic fora da trava na linha ${i + 1}`);
    }
  });
});
