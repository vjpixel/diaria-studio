/**
 * #14128 — caracterização dos parsers de argumento dos 4 CLIs do kind
 * `continuo` com parser próprio, travada ANTES da troca por
 * `scripts/lib/cli-args.ts` e mantida depois como prova de paridade.
 *
 * Esses CLIs têm consumidor externo: `hermes/scripts/continuo-pr-review.sh`
 * (skill do Hermes no `300`) chama `--pr "$pr"`, `--head <sha>` e
 * `--candidate "$REJECT_BODY"`. Interface idêntica é o requisito: mesmas
 * flags, mesmo resultado para argv válido e mesmo "uso inválido" (o `main`
 * de cada um sai 2 quando o parser devolve `null`/`{ error }`).
 *
 * Única divergência aceita, só em argv já inválido: `--head` seguido de outra
 * flag antes saía `--head inválido: "--repo"` (lia a flag como valor) e agora
 * sai `--head inválido: ""`; os dois são erro de uso, exit 2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEscalateLabelArgs } from "../scripts/check-continuo-escalate-label.ts";
import { parseRejectDedupeArgs } from "../scripts/check-continuo-reject-comment-dedupe.ts";
import { parseRejectLabelArgs } from "../scripts/check-continuo-reject-label.ts";
import { parseCiFixAttemptedArgs } from "../scripts/mark-continuo-ci-fix-attempted.ts";

const PR_ONLY: [string, (argv: string[]) => { pr: string } | null][] = [
  ["check-continuo-reject-label", parseRejectLabelArgs],
  ["mark-continuo-ci-fix-attempted", parseCiFixAttemptedArgs],
];

for (const [name, parse] of PR_ONLY) {
  describe(`${name} — --pr (#14128)`, () => {
    it("forma do Hermes: --pr N", () => assert.deepEqual(parse(["--pr", "123"]), { pr: "123" }));
    it("sem argumento → uso inválido", () => assert.equal(parse([]), null));
    it("--pr no fim, sem valor → uso inválido", () => assert.equal(parse(["--pr"]), null));
    it("--pr seguido de outra flag → uso inválido (não lê a flag como número)", () =>
      assert.equal(parse(["--pr", "--head"]), null));
    it("--pr não numérico → uso inválido", () => assert.equal(parse(["--pr", "abc"]), null));
    it("--pr negativo → uso inválido", () => assert.equal(parse(["--pr", "-5"]), null));
    it("token solto depois é ignorado", () => assert.deepEqual(parse(["--pr", "12", "extra"]), { pr: "12" }));
    it("flag desconhecida antes não atrapalha", () => assert.deepEqual(parse(["--verbose", "--pr", "7"]), { pr: "7" }));
    it("--pr repetido: o último vence", () => assert.deepEqual(parse(["--pr", "1", "--pr", "2"]), { pr: "2" }));
  });
}

describe("check-continuo-reject-comment-dedupe — --pr/--candidate (#14128)", () => {
  const body = "Gate de merge automático (#6926): rejeitado — checks vermelhos";
  it("forma do Hermes", () =>
    assert.deepEqual(parseRejectDedupeArgs(["--pr", "5", "--candidate", body]), { pr: "5", candidate: body }));
  it("ordem invertida", () =>
    assert.deepEqual(parseRejectDedupeArgs(["--candidate", body, "--pr", "5"]), { pr: "5", candidate: body }));
  it("candidate vazio é aceito (string vazia, não ausente)", () =>
    assert.deepEqual(parseRejectDedupeArgs(["--pr", "5", "--candidate", ""]), { pr: "5", candidate: "" }));
  it("candidate multilinha começando com um só '-' é aceito intacto", () => {
    const c = "- item\n-- linha\n--- fim";
    assert.deepEqual(parseRejectDedupeArgs(["--pr", "5", "--candidate", c]), { pr: "5", candidate: c });
  });
  it("sem --candidate → uso inválido", () => assert.equal(parseRejectDedupeArgs(["--pr", "5"]), null));
  it("--candidate no fim sem valor → uso inválido", () =>
    assert.equal(parseRejectDedupeArgs(["--pr", "5", "--candidate"]), null));
  it("sem --pr → uso inválido", () => assert.equal(parseRejectDedupeArgs(["--candidate", body]), null));
  it("--pr não numérico → uso inválido", () =>
    assert.equal(parseRejectDedupeArgs(["--pr", "x", "--candidate", body]), null));
});

describe("check-continuo-escalate-label — --pr/--head/--repo (#14128)", () => {
  const err = (argv: string[]): string => {
    const r = parseEscalateLabelArgs(argv);
    assert.ok("error" in r, `esperava erro para ${JSON.stringify(argv)}`);
    return r.error;
  };
  it("só --pr", () =>
    assert.deepEqual(parseEscalateLabelArgs(["--pr", "5"]), { pr: "5", head: null, repo: undefined }));
  it("forma do Hermes com --head", () =>
    assert.deepEqual(parseEscalateLabelArgs(["--pr", "5", "--head", "abcdef1"]), {
      pr: "5", head: "abcdef1", repo: undefined,
    }));
  it("--head de 40 hex", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.deepEqual(parseEscalateLabelArgs(["--head", sha, "--pr", "9"]), { pr: "9", head: sha, repo: undefined });
  });
  it("--repo default vira undefined", () =>
    assert.deepEqual(parseEscalateLabelArgs(["--pr", "5", "--repo", "vjpixel/diaria-studio"]), {
      pr: "5", head: null, repo: undefined,
    }));
  it("--repo do design (allowlist)", () =>
    assert.deepEqual(parseEscalateLabelArgs(["--pr", "5", "--repo", "vjpixel/diaria-design"]), {
      pr: "5", head: null, repo: "vjpixel/diaria-design",
    }));
  it("sem --pr", () => assert.equal(err(["--head", "abcdef1"]), "--pr ausente ou não-numérico"));
  it("--pr no fim", () => assert.equal(err(["--pr"]), "--pr ausente ou não-numérico"));
  it("--pr seguido de flag", () => assert.equal(err(["--pr", "--head", "abcdef1"]), "--pr ausente ou não-numérico"));
  it("--head no fim, sem valor", () => assert.equal(err(["--pr", "5", "--head"]), '--head inválido: ""'));
  it("--head que não é SHA", () => assert.equal(err(["--pr", "5", "--head", "xyz"]), '--head inválido: "xyz"'));
  it("--head seguido de outra flag → erro de --head", () =>
    assert.match(err(["--pr", "5", "--head", "--repo", "vjpixel/diaria-design"]), /^--head inválido: /));
  it("--repo no fim, sem valor", () => assert.match(err(["--pr", "5", "--repo"]), /--repo sem valor/));
  it("--repo fora da allowlist", () => assert.match(err(["--pr", "5", "--repo", "outro/repo"]), /fora de/));
});
