/**
 * #11751 — `kit-refresh-social-edition-url.ts` grava `03-social.md` e
 * `_internal/05-edition-url.txt` em duas escritas separadas. Uma queda entre
 * elas deixava o par incoerente e a conferência de frescor do Stage 5
 * (`stage5-freshness.ts`, #11698) parava com `diverged`.
 *
 * Arquivos reais num diretório temporário (deps de produção), só a API do Kit
 * e o `newsletter-kit-published.json` injetados; a queda é simulada fazendo a
 * escrita seguinte lançar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";
import { checkStage5Freshness } from "../scripts/lib/stage5-freshness.ts";
import {
  EDITION_URL_TRANSITION_REL,
  readEditionUrlTransition,
} from "../scripts/lib/edition-url-transition.ts";
import {
  kitRefreshSocialEditionUrl,
  productionDeps,
  type KitRefreshSocialEditionUrlDeps,
} from "../scripts/kit-refresh-social-edition-url.ts";

const STUB = "https://diariabr.kit.com/posts/";
const RESOLVED = "https://diariabr.kit.com/posts/titulo-da-edicao";
const APPROVED_SOCIAL = "## d1\nPost aprovado. Mais em {edition_url}\n\n## d2\nOutro {edition_url} #IA\n";

class SimulatedCrash extends Error {}

/** Edição depois do gate 4 e do §5c-2 da Etapa 5 (stub do Kit embutido). */
function editionAfterStage5(): string {
  const dir = mkdtempSync(join(tmpdir(), "eut-11751-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "# D1\nTexto aprovado\n", "utf8");
  writeFileSync(join(dir, "03-social.md"), APPROVED_SOCIAL, "utf8");
  writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
  writeFileSync(join(dir, "_internal/05-edition-url.txt"), STUB, "utf8");
  writeFileSync(join(dir, "03-social.md"), APPROVED_SOCIAL.replaceAll("{edition_url}", STUB), "utf8");
  return dir;
}

function deps(overrides: Partial<KitRefreshSocialEditionUrlDeps> = {}): KitRefreshSocialEditionUrlDeps {
  return {
    ...productionDeps(),
    readPublished: () => ({ broadcast_id: 42 }),
    getBroadcastPublicUrl: async () => RESOLVED,
    ...overrides,
  };
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

describe("#11751 — queda entre as duas escritas do kit-refresh", () => {
  it("cenário da issue: 03-social.md já com a URL nova, 05-edition-url.txt ainda com a antiga → Stage 5 não acusa diverged", async () => {
    const dir = editionAfterStage5();
    assert.equal(checkStage5Freshness(dir).ok, true, "pré-condição: estado da Etapa 5 confere");

    const crashing = deps({
      writeEditionUrlFile: () => {
        throw new SimulatedCrash("queda entre as escritas");
      },
    });
    await assert.rejects(kitRefreshSocialEditionUrl(dir, crashing), SimulatedCrash);

    assert.match(read(dir, "03-social.md"), /titulo-da-edicao/);
    assert.equal(read(dir, "_internal/05-edition-url.txt"), STUB);
    assert.deepEqual(readEditionUrlTransition(dir), { from: STUB, to: RESOLVED });

    const r = checkStage5Freshness(dir);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it("controle: o mesmo estado sem o marcador segue bloqueando (diverged) — o marcador é o que destrava", async () => {
    const dir = editionAfterStage5();
    const crashing = deps({
      writeTransition: () => {},
      writeEditionUrlFile: () => {
        throw new SimulatedCrash("queda entre as escritas");
      },
    });
    await assert.rejects(kitRefreshSocialEditionUrl(dir, crashing), SimulatedCrash);
    const r = checkStage5Freshness(dir);
    assert.deepEqual(r.problems.map((p) => [p.file, p.kind]), [["03-social.md", "diverged"]]);
  });

  it("re-rodar o kit-refresh depois da queda converge: grava a URL, apaga o marcador e o Stage 5 confere", async () => {
    const dir = editionAfterStage5();
    await assert.rejects(
      kitRefreshSocialEditionUrl(
        dir,
        deps({
          writeEditionUrlFile: () => {
            throw new SimulatedCrash("queda");
          },
        }),
      ),
      SimulatedCrash,
    );
    const r = await kitRefreshSocialEditionUrl(dir, deps());
    assert.equal(r.ok && r.resolved, true);
    assert.equal(read(dir, "_internal/05-edition-url.txt"), RESOLVED);
    assert.equal(existsSync(join(dir, EDITION_URL_TRANSITION_REL)), false);
    assert.equal((read(dir, "03-social.md").match(/titulo-da-edicao/g) ?? []).length, 2, "sem slug duplicado");
    assert.equal(checkStage5Freshness(dir).ok, true);
  });

  it("caminho feliz: nenhuma sobra de marcador, Stage 5 confere", async () => {
    const dir = editionAfterStage5();
    const r = await kitRefreshSocialEditionUrl(dir, deps());
    assert.equal(r.ok && r.resolved, true);
    assert.equal(existsSync(join(dir, EDITION_URL_TRANSITION_REL)), false);
    assert.equal(checkStage5Freshness(dir).ok, true);
  });

  it("queda depois da URL e antes de apagar o marcador: Stage 5 confere e a próxima chamada (already_resolved) limpa", async () => {
    const dir = editionAfterStage5();
    await assert.rejects(
      kitRefreshSocialEditionUrl(
        dir,
        deps({
          clearTransition: () => {
            throw new SimulatedCrash("queda");
          },
        }),
      ),
      SimulatedCrash,
    );
    assert.equal(existsSync(join(dir, EDITION_URL_TRANSITION_REL)), true);
    assert.equal(checkStage5Freshness(dir).ok, true);
    const r = await kitRefreshSocialEditionUrl(dir, deps());
    assert.equal(r.ok && !r.resolved && r.reason, "already_resolved");
    assert.equal(existsSync(join(dir, EDITION_URL_TRANSITION_REL)), false);
  });

  it("marcador ilegível ou com URL não-https é ignorado (falha fechada)", () => {
    const dir = editionAfterStage5();
    writeFileSync(join(dir, "03-social.md"), APPROVED_SOCIAL.replaceAll("{edition_url}", RESOLVED), "utf8");
    for (const raw of ["{nao-json", JSON.stringify({ from: STUB, to: "diariabr.kit.com/posts/x" })]) {
      writeFileSync(join(dir, EDITION_URL_TRANSITION_REL), raw, "utf8");
      assert.equal(readEditionUrlTransition(dir), null);
      assert.deepEqual(checkStage5Freshness(dir).problems.map((p) => p.kind), ["diverged"]);
    }
  });

  it("marcador não afrouxa edição real: texto editado além da URL continua diverged", async () => {
    const dir = editionAfterStage5();
    await assert.rejects(
      kitRefreshSocialEditionUrl(
        dir,
        deps({
          writeEditionUrlFile: () => {
            throw new SimulatedCrash("queda");
          },
        }),
      ),
      SimulatedCrash,
    );
    writeFileSync(join(dir, "03-social.md"), read(dir, "03-social.md").replace("aprovado", "EDITADO"), "utf8");
    assert.deepEqual(checkStage5Freshness(dir).problems.map((p) => p.kind), ["diverged"]);
  });
});
