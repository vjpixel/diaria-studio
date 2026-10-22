/**
 * #10835 — o convite social do PARA ENCERRAR perdia a borda de box em
 * silêncio quando o texto do 02-reviewed.md divergia de `SOCIAL_INVITE`.
 * O match tolerante (prefixo) veio no #10781; aqui fica o aviso no Stage 4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_PREFIX,
  detectSocialInviteDrift,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { checkSocialInviteDrift, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const PREVIOUS =
  `${SOCIAL_INVITE_PREFIX} **diar.ia.br** no [LinkedIn](https://l), [Instagram](https://i), [Threads](https://t), [Facebook](https://f) ou [X](https://x).`;
const EDITED =
  "Para seguir as principais notícias de IA, siga a **diar.ia.br** no [LinkedIn](https://l), [Instagram](https://i) ou [YouTube](https://y).";
const wrap = (last: string) => `**PARA ENCERRAR**\n\nTexto de apoio qualquer.\n\n${last}\n`;

describe("#10835 detectSocialInviteDrift", () => {
  it("convite idêntico à constante → nada a avisar", () => {
    assert.equal(detectSocialInviteDrift(wrap(SOCIAL_INVITE)), null);
  });
  it("versão anterior da constante (sem YouTube) → outdated", () => {
    assert.equal(detectSocialInviteDrift(wrap(PREVIOUS))?.kind, "outdated");
  });
  it("prefixo editado (renderer não reconhece) → unrecognized", () => {
    assert.equal(detectSocialInviteDrift(wrap(EDITED))?.kind, "unrecognized");
  });
  it("redação legada 'Agora que chegou' é aceita sem aviso", () => {
    assert.equal(detectSocialInviteDrift(wrap("Agora que chegou até aqui, siga a gente.")), null);
  });
  it("sem parágrafo com cara de convite → null", () => {
    assert.equal(detectSocialInviteDrift("**PARA ENCERRAR**\n\nObrigado por ler a diar.ia.br.\n"), null);
  });
});

describe("#10835 invariante social-invite-drift (Stage 4)", () => {
  it("registrado no Stage 4", () => {
    assert.ok(STAGE_4_RULES.some((r) => r.id === "social-invite-drift" && r.stage === 4));
  });
  it("warning quando o 02-reviewed.md diverge; nada quando bate", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-invite-drift-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), wrap(EDITED));
      const v = checkSocialInviteDrift(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /SEM a borda de box/);
      writeFileSync(join(dir, "02-reviewed.md"), wrap(SOCIAL_INVITE));
      assert.deepEqual(checkSocialInviteDrift(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sem 02-reviewed.md → nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-invite-drift-"));
    try {
      assert.deepEqual(checkSocialInviteDrift(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
