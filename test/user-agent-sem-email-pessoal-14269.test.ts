/**
 * user-agent-sem-email-pessoal-14269.test.ts (REFS #14269)
 *
 * Guarda de regressão: nenhum `User-Agent` de requisição externa em `scripts/`
 * leva o e-mail pessoal do editor. Na edição 261127 o `eia-compose.ts` mandava
 * esse e-mail à Wikimedia e o hook de privacidade do app barrou o script
 * quando rodado direto. O contato certo é o do inbox editorial.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS_DIR = join(import.meta.dirname, "..", "scripts");
const PERSONAL_PREFIX = /vjpixel@/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("User-Agent sem e-mail pessoal (#14269)", () => {
  it("nenhuma linha com User-Agent em scripts/ cita o e-mail pessoal", () => {
    const offenders: string[] = [];
    for (const file of walk(SCRIPTS_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/user-agent/i.test(line) && PERSONAL_PREFIX.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `User-Agent com e-mail pessoal em: ${offenders.join(", ")}`);
  });

  it("eia-compose.ts mantém um User-Agent com contato do inbox editorial", () => {
    const src = readFileSync(join(SCRIPTS_DIR, "eia-compose.ts"), "utf8");
    assert.match(src, /"User-Agent": "diar\.ia\.br\/1\.0 \(https:\/\/diar\.ia\.br; diariaeditor@/);
  });
});
