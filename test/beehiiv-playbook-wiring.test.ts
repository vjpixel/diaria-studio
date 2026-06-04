/**
 * test/beehiiv-playbook-wiring.test.ts (#1433)
 *
 * Grep tests pra garantir que beehiiv-playbook.md referencia os helpers
 * libs corretos. Sem isso, os helpers (criados em PR #1430) ficam
 * órfãos e os bugs originais (#1416/#1419/#1423) ressurgem em runtime
 * via JS inline que pode regredir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK = resolve(ROOT, "context/publishers/beehiiv-playbook.md");

describe("beehiiv-playbook wiring de helpers (#1433)", () => {
  const playbook = readFileSync(PLAYBOOK, "utf8");

  it("#1423: §4a referencia buildSetFieldJs + isFieldVerified", () => {
    assert.match(playbook, /buildSetFieldJs/);
    assert.match(playbook, /isFieldVerified/);
    assert.match(playbook, /beehiiv-set-field/);
  });

  it("#1423: warning explícito contra execCommand direto em title/subtitle", () => {
    // Bug do 260520: title duplicado por execCommand não-atômico.
    // Sem warning, future code review pode permitir regression.
    assert.match(
      playbook,
      /NUNCA chamar.*execCommand|nunca usar execCommand|sempre.*helper.*atômico/i,
      "playbook deve avisar contra execCommand direto",
    );
  });

  it("#1801: §4b usa buildCoverDataTransferJs (DataTransfer) como primário + classifyCoverVerify", () => {
    assert.match(playbook, /buildCoverDataTransferJs/);
    assert.match(playbook, /classifyCoverVerify/);
    assert.match(playbook, /beehiiv-cover-upload/);
  });

  it("#1419: §7 referencia send-count helpers + warn/block decision", () => {
    assert.match(playbook, /loadSendCount/);
    assert.match(playbook, /recordSend/);
    assert.match(playbook, /decideWarnLevel/);
    assert.match(playbook, /beehiiv-send-count/);
  });

  it("#1419: §7 menciona rate limit do Beehiiv como motivação", () => {
    assert.match(playbook, /rate.?limit/i);
  });

  it("#1705: §4b nunca declara capa aplicada sem confirmar + warning explícito de cover não confirmada", () => {
    // O dano real do #1705 foi declarar "capa aplicada" silenciosamente quando
    // o auto-apply (quebrado na UI atual) falhou. O playbook DEVE mandar emitir
    // o warning explícito — este guard impede que a instrução suma num refactor.
    assert.match(playbook, /#1705/, "deve referenciar #1705");
    assert.match(
      playbook,
      /cover\s+N[ÃA]O\s+confirmada/i,
      "playbook deve mandar emitir '⚠️ Cover NÃO confirmada'",
    );
    assert.match(
      playbook,
      /NUNCA.*afirme.*capa aplicada|nunca.*declar.*capa aplicada/i,
      "playbook deve proibir declarar 'capa aplicada' sem sinal confiável",
    );
  });

  it("#1801: §4b apresenta DataTransfer como PRIMÁRIO e 'Upload from URL' só como DEPRECATED", () => {
    // Regressão: o playbook documentava "Upload from URL" (#1416/#1705) como
    // método primário de cover, mas ele NÃO aplica como thumbnail na UI atual
    // (260604: falhou 4×). O DataTransfer (#1500) aplica. Este guard falha se
    // o §4b voltar a apresentar "Upload from URL" como primário.
    const m = playbook.match(/#### 4b\.[\s\S]*?(?=\n#### |\n### |$)/);
    assert.ok(m, "§4b deve existir no playbook");
    const s4b = m![0];
    assert.match(s4b, /DataTransfer/, "§4b deve documentar o método DataTransfer");

    // Guard robusto a rephrasing (review #1814): o PRIMEIRO helper de cover
    // referenciado no §4b deve ser o DataTransfer — não o legado buildCoverUploadJs.
    // Pega revert mesmo que a frase 'Upload from URL' seja renomeada.
    const dtHelperIdx = s4b.indexOf("buildCoverDataTransferJs");
    const legacyHelperIdx = s4b.indexOf("buildCoverUploadJs");
    assert.ok(dtHelperIdx >= 0, "§4b deve referenciar buildCoverDataTransferJs");
    if (legacyHelperIdx >= 0) {
      assert.ok(
        dtHelperIdx < legacyHelperIdx,
        "buildCoverDataTransferJs deve vir ANTES de buildCoverUploadJs (primário primeiro)",
      );
    }

    // Guard adicional pela frase literal, quando presente.
    const dtIdx = s4b.indexOf("DataTransfer");
    const ufuIdx = s4b.indexOf("Upload from URL");
    if (ufuIdx >= 0) {
      assert.ok(
        dtIdx < ufuIdx,
        "DataTransfer deve vir ANTES de 'Upload from URL' (primário primeiro)",
      );
      assert.match(s4b, /DEPRECATED/, "'Upload from URL' só pode aparecer marcado DEPRECATED");
    }
  });

  it("#1764: §5.1 usa clique REAL (⋮ → Use template), não .click() sintético", () => {
    assert.match(playbook, /buildHtmlTemplateMenuLocateJs/);
    assert.match(playbook, /buildUseTemplateItemLocateJs/);
    assert.match(playbook, /resolveClickPoint/);
    assert.match(playbook, /@deprecated|deprecated|N[ÃA]O usar.*sint[ée]tico/i);
  });
});
