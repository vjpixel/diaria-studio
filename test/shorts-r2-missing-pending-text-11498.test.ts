/**
 * #11498: depois da #11484 (#11478), X (Buffer) e Threads pessoal sem os
 * secrets do R2 na máquina ficam PENDENTES — o `-short.mp4` fica no disco e
 * outra máquina com os secrets publica. O texto (aviso ao editor, docstrings,
 * SKILL, notas do config) ainda dizia "fica manual", o que manda o editor
 * postar à mão justo o que a outra máquina vai publicar: post duplicado.
 *
 * Trava a mensagem de `publicVideoUnavailableReason` e varre os pontos que
 * a issue listou para o texto antigo não voltar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicVideoUnavailableReason } from "../scripts/publish-shorts.ts";

const ROOT = join(import.meta.dirname, "..");

test("#11498: aviso sem R2 diz pendente e cita --mark, nunca 'fica manual'", () => {
  const reason = publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]);
  assert.match(reason, /fica pendente/);
  assert.match(reason, /máquina com os secrets do R2/);
  assert.match(reason, /--mark/);
  assert.doesNotMatch(reason, /fica manual/);
});

const FILES = [
  "scripts/publish-shorts.ts",
  "scripts/shorts-instagram-timer.ts",
  "platform.config.json",
  ".claude/skills/diaria-publica-video/SKILL.md",
];

// Frases do texto antigo (#11477) sobre X/Threads sem R2.
const STALE = [
  /X e Threads ficam manuais/,
  /ficam pulados com aviso \(manuais\)/,
  /secrets do R2 ficam pulados com aviso, manuais/,
  /o X é pulado com aviso e fica\s*\*?\s*manual/,
  /sem os secrets do R2 na máquina, é pulado com aviso e fica manual/,
  /#10772\/#11265\) — fica manual/,
  /e fica manual \(subir à mão o vertical do Drive/,
];

for (const rel of FILES) {
  test(`#11498: ${rel} não diz mais que X/Threads sem R2 ficam manuais`, () => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const re of STALE) assert.doesNotMatch(text, re, `${rel} ainda casa ${re}`);
  });
}

test("#11498: a SKILL cita a delegação ao timer do Threads no 300 (#11410)", () => {
  const skill = readFileSync(join(ROOT, ".claude/skills/diaria-publica-video/SKILL.md"), "utf8");
  const line = skill.split("\n").find((l) => l.startsWith("| `threads_profile`"));
  assert.ok(line, "linha threads_profile da tabela");
  assert.match(line, /threads_profile_via_timer/);
  assert.match(line, /#11410/);
  assert.match(line, /pendente/);
});
