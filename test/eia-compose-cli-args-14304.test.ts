/**
 * #14304 — `parseArgsSimple` engolia a flag seguinte. Com a ordem do próprio
 * texto de uso (`--force --sd-prompt-text "..."`), `--sd-prompt-text` virava
 * valor de `--force`, o texto do editor era descartado e a imagem saía da
 * descrição da Wikimedia, sem aviso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEiaComposeArgs } from "../scripts/eia-compose.ts";

const TEXT = "micrografia de cristal líquido em luz polarizada";

describe("parseEiaComposeArgs (#14304)", () => {
  it("--force --sd-prompt-text preserva o texto e o force", () => {
    const { args, force } = parseEiaComposeArgs(["--edition", "261127", "--force", "--sd-prompt-text", TEXT]);
    assert.equal(force, true);
    assert.equal(args["sd-prompt-text"], TEXT);
    assert.equal(args.edition, "261127");
  });

  it("ordem inversa dá o mesmo resultado", () => {
    const a = parseEiaComposeArgs(["--edition", "261127", "--force", "--sd-prompt-text", TEXT]);
    const b = parseEiaComposeArgs(["--sd-prompt-text", TEXT, "--edition", "261127", "--force"]);
    assert.deepEqual(a, b);
  });

  it("--force antes de --edition não engole a edição", () => {
    const { args, force } = parseEiaComposeArgs(["--force", "--edition", "261127"]);
    assert.equal(force, true);
    assert.equal(args.edition, "261127");
  });

  it("--sd-prompt-text sem valor é recusado, nunca cai na descrição da Wikimedia", () => {
    assert.throws(
      () => parseEiaComposeArgs(["--edition", "261127", "--sd-prompt-text", "--force"]),
      /--sd-prompt-text foi passado sem valor/,
    );
  });
});
