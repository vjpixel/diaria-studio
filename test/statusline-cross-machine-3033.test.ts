/**
 * test/statusline-cross-machine-3033.test.ts (#3033)
 *
 * bug(statusline): barra não acompanha edição nested (#3024) + estado de
 * develop vaza entre máquinas via OneDrive.
 *
 * Fator 1 (verificado JÁ CORRIGIDO por #3025 — este teste é a cobertura de
 * regressão que faltava, #633): `scanEditionDocs` (usada por
 * `readCurrentEditionDoc`) escaneia `data/editions/` via `enumerateEditionDirs`
 * (`scripts/lib/find-current-edition.ts`), que cobre AMBOS os layouts — flat
 * legado (`data/editions/{AAMMDD}/`) e nested pós-#3024
 * (`data/editions/{AAMM}/{AAMMDD}/`). Antes do #3025, `readCurrentEditionDoc`
 * fazia um `readdirSync` direto do dir de edições e só casava o layout flat —
 * uma edição nested "em curso" ficava invisível pro scan, e a precedência
 * "edição > develop" (docblock de `overnight-statusline.ts`) não tinha como
 * se aplicar: a statusLine caía no fallback de develop mesmo com uma edição
 * genuinamente em curso. Seção 1 abaixo reproduz o repro EXATO da issue
 * (edição nested em progresso + um `plan.json` de develop concorrente) e
 * confirma que a edição vence.
 *
 * Fator 2 (implementado por este PR): `data/` é um junction do OneDrive
 * sincronizado entre máquinas (CLAUDE.md § Setup). `data/develop/{AAMMDD}/plan.json`
 * de uma sessão na máquina A aparece no disco da máquina B via sync — sem
 * nenhum jeito de saber "esse plan.json é da MINHA sessão", a statusLine da
 * máquina B mostrava o progresso de develop de A como se fosse dela (inclusive
 * travado ali depois da sessão de A terminar, já que rodada encerrada fica
 * visível a 100% por design, #2246 pt3). Fix: `plan.json` agora pode carregar
 * um campo `machine_id` (hostname, `scripts/lib/machine-id.ts`); `isForeignDevelopPlan`
 * + `readTodayDevelopPlan` filtram candidatos cujo `machine_id` diverge do
 * hostname local — fail-open quando o campo está ausente (plan.json legado)
 * ou quando o hostname local não pôde ser determinado. Seção 2 abaixo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readCurrentEditionDoc,
  renderStatusline,
  readTodayDevelopPlan,
  isForeignDevelopPlan,
  type Plan,
  type StageStatusDoc,
} from "../scripts/overnight-statusline.ts";
import { getMachineId } from "../scripts/lib/machine-id.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDoc(
  edition: string,
  stageStatuses: Array<"pending" | "running" | "done" | "failed">,
  generatedAt = "2026-07-07T09:00:00.000Z",
): StageStatusDoc {
  return {
    edition,
    rows: stageStatuses.map((status, idx) => ({ stage: idx, status })),
    generated_at: generatedAt,
  };
}

function writeNestedStageStatus(root: string, aammdd: string, doc: StageStatusDoc): string {
  const aamm = aammdd.slice(0, 4);
  const editionDir = join(root, "data", "editions", aamm, aammdd);
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "stage-status.json"), JSON.stringify(doc, null, 2), "utf8");
  return editionDir;
}

function writeDevelopPlan(root: string, dirName: string, plan: Plan, mtime: Date): string {
  const dir = join(root, "data", "develop", dirName);
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan), "utf8");
  utimesSync(planPath, mtime, mtime);
  return planPath;
}

// ─── 1. Fator 1: edição nested em curso vence develop (repro exato da issue) ──

describe("#3033 Fator 1: edição NESTED em curso tem precedência sobre develop (repro da issue, já corrigido por #3025)", () => {
  it("readCurrentEditionDoc encontra a edição em layout nested (data/editions/{AAMM}/{AAMMDD}/)", () => {
    const root = makeTmpDir("edition-nested-precedence-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      const doc = makeDoc("260707", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
      writeNestedStageStatus(root, "260707", doc);

      const result = readCurrentEditionDoc(root, now);
      assert.ok(result !== null, "edição nested em curso deve ser detectada — Fator 1 da issue #3033");
      assert.equal(result!.edition, "260707");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repro exato da issue: edição nested 260707 EM CURSO + data/develop/260706/ de outra sessão (quase encerrada, 7/8) → statusLine mostra a EDIÇÃO, não develop", () => {
    const root = makeTmpDir("edition-nested-vs-develop-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");

      // Edição 260707 (D+1 de 260706) em curso — Stage 1 (Pesquisa) rodando.
      const editionDoc = makeDoc(
        "260707",
        ["done", "running", "pending", "pending", "pending", "pending", "pending"],
        now.toISOString(),
      );
      writeNestedStageStatus(root, "260707", editionDoc);

      // Sessão /diaria-develop de OUTRA máquina, sincronizada via OneDrive,
      // travada em 7/8 — exatamente o estado relatado no repro da issue.
      const developPlan: Plan = {
        issues: [
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "mergeada" },
          { status: "elegivel" },
        ],
      };
      writeDevelopPlan(root, "260706", developPlan, now);

      // Simula exatamente o que o CLI entrypoint faz.
      const editionDocFound = readCurrentEditionDoc(root, now);
      const developEntry = readTodayDevelopPlan(root, now, "" /* localMachineId desconhecido — não afeta este teste, plan.json sem machine_id */);
      const out = renderStatusline(editionDocFound, null, "260707", editionDocFound, "master", developEntry);

      assert.ok(out.includes("edição 260707"), `deve mostrar a barra da EDIÇÃO 260707, não develop: ${out}`);
      assert.ok(!out.includes("develop 260706"), `NÃO deve mostrar o develop de outra sessão travado em 7/8: ${out}`);
      assert.ok(out.includes("1/7"), `deve refletir o progresso real da edição (Stage 1 rodando): ${out}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição nested ENCERRADA (todos terminais) → readCurrentEditionDoc retorna null, develop assume o display (contrato preservado em nested)", () => {
    const root = makeTmpDir("edition-nested-encerrada-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      const doc = makeDoc("260707", ["done", "done", "done", "done", "done", "done", "done"], now.toISOString());
      writeNestedStageStatus(root, "260707", doc);

      const result = readCurrentEditionDoc(root, now);
      assert.equal(result, null, "edição nested encerrada deve ser tratada como concluída, igual ao layout flat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 2. Fator 2: plan.json de develop de OUTRA máquina não sequestra a barra ──

describe("#3033 Fator 2: isForeignDevelopPlan — filtro por machine_id", () => {
  it("machine_id ausente → fail-open, nunca filtra (plan.json legado pré-#3033)", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }] };
    assert.equal(isForeignDevelopPlan(plan, "maquina-b"), false);
  });

  it("machine_id vazio (string) → fail-open, nunca filtra", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }], machine_id: "" };
    assert.equal(isForeignDevelopPlan(plan, "maquina-b"), false);
  });

  it("machine_id igual ao hostname local → não é estrangeiro (false)", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }], machine_id: "maquina-a" };
    assert.equal(isForeignDevelopPlan(plan, "maquina-a"), false);
  });

  it("machine_id diferente do hostname local → estrangeiro (true)", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }], machine_id: "maquina-a" };
    assert.equal(isForeignDevelopPlan(plan, "maquina-b"), true);
  });

  it("localMachineId vazio (hostname local ilegível) → fail-open, nunca filtra mesmo com machine_id presente", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }], machine_id: "maquina-a" };
    assert.equal(isForeignDevelopPlan(plan, ""), false);
  });

  it("machine_id com espaços em branco é normalizado (trim) antes da comparação", () => {
    const plan: Plan = { issues: [{ status: "elegivel" }], machine_id: "  maquina-a  " };
    assert.equal(isForeignDevelopPlan(plan, "maquina-a"), false);
  });
});

describe("#3033 Fator 2: readTodayDevelopPlan filtra plan.json de outra máquina (integração)", () => {
  it("plan.json com machine_id de OUTRA máquina → pulado, cai pro próximo candidato (ou null)", () => {
    const root = makeTmpDir("develop-foreign-single-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      writeDevelopPlan(
        root,
        "260706",
        { issues: [{ status: "mergeada" }, { status: "elegivel" }], machine_id: "maquina-remota" },
        now,
      );

      const entry = readTodayDevelopPlan(root, now, "maquina-local");
      assert.equal(entry, null, "único candidato é de outra máquina — não deve sequestrar a barra");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan.json local + plan.json estrangeiro mais recente → pula o estrangeiro, retorna o local", () => {
    const root = makeTmpDir("develop-foreign-fallback-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      // Dir mais recente por nome — é da máquina remota, deve ser pulado.
      writeDevelopPlan(
        root,
        "260707",
        { issues: [{ status: "elegivel" }], machine_id: "maquina-remota" },
        now,
      );
      // Dir mais antigo — é a sessão local, ainda ativa (mtime fresco).
      writeDevelopPlan(
        root,
        "260706",
        { issues: [{ status: "elegivel" }, { status: "mergeada" }], machine_id: "maquina-local" },
        now,
      );

      const entry = readTodayDevelopPlan(root, now, "maquina-local");
      assert.ok(entry !== null, "deve cair pro candidato local, não retornar null");
      assert.equal(entry!.id, "260706");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan.json SEM machine_id (legado) → tratado como local, não filtrado (sem regressão pré-#3033)", () => {
    const root = makeTmpDir("develop-legacy-no-tag-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      writeDevelopPlan(root, "260707", { issues: [{ status: "elegivel" }] }, now);

      const entry = readTodayDevelopPlan(root, now, "qualquer-maquina");
      assert.ok(entry !== null, "plan.json legado sem machine_id não deve ser escondido");
      assert.equal(entry!.id, "260707");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readTodayDevelopPlan usa getMachineId() real por default quando localMachineId é omitido", () => {
    const root = makeTmpDir("develop-default-local-id-");
    try {
      const now = new Date("2026-07-07T10:00:00.000Z");
      const localId = getMachineId();
      writeDevelopPlan(root, "260707", { issues: [{ status: "elegivel" }], machine_id: localId }, now);

      // Sem passar o 3º argumento — deve resolver via getMachineId() internamente e casar.
      const entry = readTodayDevelopPlan(root, now);
      // Se getMachineId() retornar "" neste ambiente de CI, o guard é fail-open (não filtra) —
      // então o resultado não deve ser null de qualquer forma.
      assert.ok(entry !== null, "plan.json tageado com o hostname real desta máquina deve ser aceito");
      assert.equal(entry!.id, "260707");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
