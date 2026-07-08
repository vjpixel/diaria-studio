/**
 * test/statusline-cross-machine-3119.test.ts (#3119)
 *
 * bug(statusline): barra de 'edição em curso' sequestrada por sessão de OUTRA
 * máquina — `data/editions/{AAMMDD}/_internal/stage-status.json` sincroniza
 * via OneDrive junction `data/` (ver CLAUDE.md § Setup) entre as máquinas do
 * editor. Antes deste fix, `readCurrentEditionDoc` (o ponto que decide a fonte
 * de prioridade MÁXIMA da statusLine, ver docblock de `overnight-statusline.ts`)
 * não tinha como saber se um `stage-status.json` "em curso" no disco era da
 * PRÓPRIA sessão desta máquina ou de uma rodada concorrente em outra — uma
 * edição rodando em outra máquina sequestrava a barra local.
 *
 * Fix: espelha exatamente o padrão do #3033 (`Plan.machine_id` +
 * `isForeignDevelopPlan`, ver `test/statusline-cross-machine-3033.test.ts`),
 * aplicado a `StageStatusDoc`:
 *   - `StageStatusDoc.machine_id?: string` (`update-stage-status.ts`)
 *   - `makeInitialDoc()` grava `getMachineId()`; `applyUpdate` preserva o campo
 *     (via spread de `doc`, mesmo tratamento do `run_started_at`).
 *   - `isForeignStageStatusDoc(doc, localMachineId)` — réplica de
 *     `isForeignDevelopPlan`, mesmo fail-open (machine_id ausente/vazio ou
 *     localMachineId vazio → nunca filtra).
 *   - `readCurrentEditionDoc` pula candidatos estrangeiros e cai pro próximo
 *     (mesmo comportamento de `readTodayDevelopPlan`) — se nenhum candidato
 *     local restar, retorna `null` e a statusLine cai pro fallback
 *     (develop > overnight > idle).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readCurrentEditionDoc,
  renderEditionBar,
  renderStatusline,
  isForeignStageStatusDoc,
} from "../scripts/overnight-statusline.ts";
import { makeInitialDoc, applyUpdate, type StageStatusDoc } from "../scripts/update-stage-status.ts";
import { getMachineId } from "../scripts/lib/machine-id.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDoc(
  edition: string,
  stageStatuses: Array<"pending" | "running" | "done" | "failed">,
  extra: Partial<StageStatusDoc> = {},
): StageStatusDoc {
  return {
    edition,
    rows: stageStatuses.map((status, idx) => ({ stage: idx, status })),
    generated_at: "2026-07-08T09:00:00.000Z",
    ...extra,
  };
}

function writeStageStatus(root: string, aammdd: string, doc: StageStatusDoc): string {
  const editionDir = join(root, "data", "editions", aammdd);
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "stage-status.json"), JSON.stringify(doc, null, 2), "utf8");
  return editionDir;
}

// ─── 1. isForeignStageStatusDoc — filtro por machine_id (unit, espelha #3033) ──

describe("#3119 isForeignStageStatusDoc — filtro por machine_id (réplica de isForeignDevelopPlan)", () => {
  it("machine_id ausente → fail-open, nunca filtra (doc legado pré-#3119)", () => {
    const doc = makeDoc("260708", ["running"]);
    assert.equal(isForeignStageStatusDoc(doc, "maquina-b"), false);
  });

  it("machine_id vazio (string) → fail-open, nunca filtra", () => {
    const doc = makeDoc("260708", ["running"], { machine_id: "" });
    assert.equal(isForeignStageStatusDoc(doc, "maquina-b"), false);
  });

  it("machine_id igual ao hostname local → não é estrangeiro (false)", () => {
    const doc = makeDoc("260708", ["running"], { machine_id: "maquina-a" });
    assert.equal(isForeignStageStatusDoc(doc, "maquina-a"), false);
  });

  it("machine_id diferente do hostname local → estrangeiro (true)", () => {
    const doc = makeDoc("260708", ["running"], { machine_id: "maquina-a" });
    assert.equal(isForeignStageStatusDoc(doc, "maquina-b"), true);
  });

  it("localMachineId vazio (hostname local ilegível) → fail-open, nunca filtra mesmo com machine_id presente", () => {
    const doc = makeDoc("260708", ["running"], { machine_id: "maquina-a" });
    assert.equal(isForeignStageStatusDoc(doc, ""), false);
  });

  it("machine_id com espaços em branco é normalizado (trim) antes da comparação", () => {
    const doc = makeDoc("260708", ["running"], { machine_id: "  maquina-a  " });
    assert.equal(isForeignStageStatusDoc(doc, "maquina-a"), false);
  });
});

// ─── 2. readCurrentEditionDoc filtra stage-status.json de outra máquina (integração) ──

describe("#3119 readCurrentEditionDoc filtra stage-status.json de outra máquina", () => {
  it("doc com machine_id de OUTRA máquina → NÃO sequestra a barra, cai pro fallback (null)", () => {
    const root = makeTmpDir("edition-foreign-single-");
    try {
      const now = new Date("2026-07-08T10:00:00.000Z");
      const doc = makeDoc(
        "260708",
        ["done", "running", "pending", "pending", "pending", "pending", "pending"],
        { machine_id: "maquina-remota" },
      );
      writeStageStatus(root, "260708", doc);

      const result = readCurrentEditionDoc(root, now, "maquina-local");
      assert.equal(result, null, "único candidato é de outra máquina — não deve sequestrar a barra");

      // A statusLine deve cair pro fallback (sem edição), nunca mostrar a barra estrangeira.
      const out = renderStatusline(result, null, "260708", result, "master");
      assert.ok(!out.includes("edição 260708"), `NÃO deve mostrar a edição de outra máquina: ${out}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("doc com machine_id da MÁQUINA LOCAL → mostra a barra normalmente", () => {
    const root = makeTmpDir("edition-local-");
    try {
      const now = new Date("2026-07-08T10:00:00.000Z");
      const doc = makeDoc(
        "260708",
        ["done", "running", "pending", "pending", "pending", "pending", "pending"],
        { machine_id: "maquina-local" },
      );
      writeStageStatus(root, "260708", doc);

      const result = readCurrentEditionDoc(root, now, "maquina-local");
      assert.ok(result !== null, "doc da própria máquina deve ser detectado normalmente");
      assert.equal(result!.edition, "260708");

      const bar = renderEditionBar(result);
      assert.ok(bar.includes("edição 260708"), `deve mostrar a barra da edição local: ${bar}`);
      assert.ok(bar.includes("1/7"), `deve refletir o progresso real (Stage 1 rodando): ${bar}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("doc SEM machine_id (legado, pré-#3119) → tratado como local, fail-open, mostra normalmente", () => {
    const root = makeTmpDir("edition-legacy-no-tag-");
    try {
      const now = new Date("2026-07-08T10:00:00.000Z");
      const doc = makeDoc("260708", ["done", "running", "pending", "pending", "pending", "pending", "pending"]);
      writeStageStatus(root, "260708", doc);

      const result = readCurrentEditionDoc(root, now, "qualquer-maquina");
      assert.ok(result !== null, "doc legado sem machine_id não deve ser escondido (fail-open)");
      assert.equal(result!.edition, "260708");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("doc estrangeiro (mais recente) + doc local (mais antigo) → pula o estrangeiro, retorna o local", () => {
    const root = makeTmpDir("edition-foreign-fallback-");
    try {
      const now = new Date("2026-07-08T10:00:00.000Z");
      // AAMMDD mais recente por ordenação lexicográfica — é da máquina remota, deve ser pulado.
      writeStageStatus(
        root,
        "260708",
        makeDoc("260708", ["running", "pending", "pending", "pending", "pending", "pending", "pending"], {
          machine_id: "maquina-remota",
        }),
      );
      // AAMMDD mais antigo — é a sessão local, ainda em curso.
      writeStageStatus(
        root,
        "260707",
        makeDoc("260707", ["done", "done", "running", "pending", "pending", "pending", "pending"], {
          machine_id: "maquina-local",
        }),
      );

      const result = readCurrentEditionDoc(root, now, "maquina-local");
      assert.ok(result !== null, "deve cair pro candidato local, não retornar null");
      assert.equal(result!.edition, "260707");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readCurrentEditionDoc usa getMachineId() real por default quando localMachineId é omitido", () => {
    const root = makeTmpDir("edition-default-local-id-");
    try {
      const now = new Date("2026-07-08T10:00:00.000Z");
      const localId = getMachineId();
      const doc = makeDoc("260708", ["running", "pending", "pending", "pending", "pending", "pending", "pending"], {
        machine_id: localId,
      });
      writeStageStatus(root, "260708", doc);

      // Sem passar o 3º argumento — deve resolver via getMachineId() internamente e casar.
      const result = readCurrentEditionDoc(root, now);
      // Se getMachineId() retornar "" neste ambiente de CI, o guard é fail-open (não filtra) —
      // então o resultado não deve ser null de qualquer forma.
      assert.ok(result !== null, "doc tageado com o hostname real desta máquina deve ser aceito");
      assert.equal(result!.edition, "260708");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 3. makeInitialDoc grava machine_id; applyUpdate preserva (integração update-stage-status) ──

describe("#3119 makeInitialDoc grava machine_id; applyUpdate preserva em updates subsequentes", () => {
  it("makeInitialDoc() grava getMachineId() no campo machine_id", () => {
    const doc = makeInitialDoc("260708");
    assert.equal(doc.machine_id, getMachineId());
  });

  it("applyUpdate preserva machine_id através de transições de stage (mesmo tratamento de run_started_at)", () => {
    let doc = makeInitialDoc("260708");
    const originalMachineId = doc.machine_id;
    doc = applyUpdate(doc, { stage: 1, status: "running" }, "2026-07-08T10:00:00.000Z");
    assert.equal(doc.machine_id, originalMachineId, "machine_id deve sobreviver ao primeiro update");
    doc = applyUpdate(doc, { stage: 1, status: "done" }, "2026-07-08T10:05:00.000Z");
    assert.equal(doc.machine_id, originalMachineId, "machine_id deve sobreviver a updates subsequentes");
  });
});
