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

  it("#1416: §4b referencia buildCoverUploadJs + classifyUploadResult", () => {
    assert.match(playbook, /buildCoverUploadJs/);
    assert.match(playbook, /classifyUploadResult/);
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
});
