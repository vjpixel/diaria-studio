/**
 * #11578 — o convite social copiado dos templates tem de virar a fileira de
 * ícones. O template mensal trazia um `]` sobrando no fim da linha: desde o
 * #11483 `parseSocialInviteIcons` devolve `null` com texto depois do último
 * link, e o digest saía com "[YouTube](…)]" em texto corrido, sem ícones.
 * O writer-monthly copia o bloco do template para `draft.md`, então a linha
 * do template é o que chega ao render.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOCIAL_INVITE,
  SOCIAL_INVITE_PREFIX,
  CURADORIA_PILLS,
  parseSocialInviteIcons,
} from "../scripts/lib/shared/encerramento-snippet.ts";
import { renderEncerramento } from "../scripts/lib/mensal/monthly-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Linhas do convite (começam pelo prefixo, ignorando crase/indentação). */
function inviteLines(relPath: string): string[] {
  return readFileSync(join(ROOT, relPath), "utf8")
    .split("\n")
    .map((l) => l.trim().replace(/^`|`$/g, ""))
    .filter((l) => l.startsWith(SOCIAL_INVITE_PREFIX));
}

const FILES = [
  "context/templates/newsletter.md",
  "context/templates/newsletter-monthly.md",
  ".claude/agents/writer-monthly.md",
];

describe("#11578 — convite social dos templates vira fileira de ícones", () => {
  for (const file of FILES) {
    it(`${file}: convite é o SOCIAL_INVITE e o parser reconhece`, () => {
      const lines = inviteLines(file);
      assert.ok(lines.length > 0, `${file} não tem a linha do convite`);
      for (const line of lines) {
        assert.equal(line, SOCIAL_INVITE, `${file}: convite diverge do SOCIAL_INVITE`);
        assert.notEqual(parseSocialInviteIcons(line), null, `${file}: parser não reconhece o convite`);
      }
    });
  }

  it("render mensal do convite copiado do template mostra os 6 ícones e nenhum ']' solto", () => {
    const [line] = inviteLines("context/templates/newsletter-monthly.md");
    const html = renderEncerramento(`Texto de apoio.\n\n${CURADORIA_PILLS}\n\n${line}`);
    assert.equal((html.match(/<img src="https:\/\/diar\.ia\.br\/icons\/social\//g) ?? []).length, 6);
    assert.doesNotMatch(html, /\]/);
  });

  it("controle: com o ']' sobrando o convite cai no texto corrido (o defeito)", () => {
    assert.equal(parseSocialInviteIcons(`${SOCIAL_INVITE}]`), null);
  });
});
