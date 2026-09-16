import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  waitAndMergeSitePagePr,
  parsePrNumberFromUrl,
  productionDeps,
  type GhRunner,
  type GitRunner,
} from "../scripts/publish-edition-site-page.ts";

/**
 * #8158 (revoga #6598): `publish-edition-site-page.ts` passou a mergear o
 * próprio PR sozinho quando o CI fica verde, em vez de deixá-lo aberto de
 * propósito. Estes testes cobrem o novo `waitAndMergeSitePagePr` e o
 * `parsePrNumberFromUrl` que o alimenta — o gap real encontrado ao
 * implementar (issue não previa): `gh pr create` só imprime a URL, nunca o
 * número do PR, e sem parsear a URL o merge nunca rodaria no caso comum
 * (1ª publicação de cada edição, que sempre CRIA — nunca reusa — o PR).
 */

function statusCheckRollupPayload(entries: unknown[], mergeable = "MERGEABLE"): string {
  return JSON.stringify({ statusCheckRollup: entries, mergeable });
}

const PASSING_CHECK = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const RUNNING_CHECK = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
const FAILING_CHECK = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };

describe("parsePrNumberFromUrl (#8158)", () => {
  it("extrai o número de uma URL real de gh pr create", () => {
    assert.equal(parsePrNumberFromUrl("https://github.com/vjpixel/diaria-studio/pull/8156"), 8156);
  });
  it("tolera barra final / querystring / hash", () => {
    assert.equal(parsePrNumberFromUrl("https://github.com/vjpixel/diaria-studio/pull/42/"), 42);
    assert.equal(parsePrNumberFromUrl("https://github.com/vjpixel/diaria-studio/pull/42?tab=files"), 42);
    assert.equal(parsePrNumberFromUrl("https://github.com/vjpixel/diaria-studio/pull/42#issuecomment-1"), 42);
  });
  it("undefined pra ausente/malformado — nunca lança", () => {
    assert.equal(parsePrNumberFromUrl(undefined), undefined);
    assert.equal(parsePrNumberFromUrl(""), undefined);
    assert.equal(parsePrNumberFromUrl("https://github.com/vjpixel/diaria-studio/issues/42"), undefined);
    assert.equal(parsePrNumberFromUrl("garbage"), undefined);
  });
});

describe("waitAndMergeSitePagePr (#8158)", () => {
  it("CI verde na 1ª checagem: mergeia e devolve merged:true", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") {
        return statusCheckRollupPayload([PASSING_CHECK, PASSING_CHECK]);
      }
      if (args[0] === "pr" && args[1] === "merge") return "Merged\n";
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    let slept = 0;
    const result = waitAndMergeSitePagePr("/repo", 8156, gh, (ms) => { slept += ms; });
    assert.equal(result.merged, true);
    assert.match(result.reason, /CI verde/);
    assert.equal(slept, 0, "não deveria dormir nenhuma vez — verde de primeira");
    assert.ok(
      calls.some((c) => c[0] === "pr" && c[1] === "merge" && c.includes("--squash") && !c.includes("--delete-branch")),
      "deve chamar gh pr merge --squash SEM --delete-branch (fleet review finding 2: evita apagar a branch local do checkout compartilhado fora da janela do lock)",
    );
  });

  it("CI pending → pending → verde: poll até convergir, sem estourar timeout", () => {
    let viewCalls = 0;
    const gh: GhRunner = (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        viewCalls++;
        if (viewCalls < 3) return statusCheckRollupPayload([RUNNING_CHECK]);
        return statusCheckRollupPayload([PASSING_CHECK]);
      }
      if (args[0] === "pr" && args[1] === "merge") return "Merged\n";
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    let sleeps = 0;
    const result = waitAndMergeSitePagePr("/repo", 1, gh, () => { sleeps++; }, 60_000, 10);
    assert.equal(result.merged, true);
    assert.equal(viewCalls, 3);
    assert.equal(sleeps, 2, "dorme entre cada tentativa pendente, não depois da última");
  });

  it("CI vermelho: NÃO mergeia, PR fica aberto — fail-soft (comportamento pré-#8158)", () => {
    const gh: GhRunner = (args) => {
      if (args[0] === "pr" && args[1] === "view") return statusCheckRollupPayload([PASSING_CHECK, FAILING_CHECK]);
      throw new Error(`gh pr merge não deveria ser chamado com CI vermelho: ${args.join(" ")}`);
    };
    const result = waitAndMergeSitePagePr("/repo", 1, gh, () => {});
    assert.equal(result.merged, false);
    assert.match(result.reason, /fail|vermelho/i);
  });

  it("gh pr view falha (erro de rede/CLI): NÃO mergeia, nunca lança", () => {
    const gh: GhRunner = () => {
      throw new Error("network unreachable");
    };
    const result = waitAndMergeSitePagePr("/repo", 1, gh, () => {});
    assert.equal(result.merged, false);
    assert.match(result.reason, /gh pr view falhou/);
  });

  it("timeout: CI fica pending pra sempre → NÃO mergeia, PR fica aberto, respeita maxWaitMs", () => {
    const gh: GhRunner = (args) => {
      if (args[0] === "pr" && args[1] === "view") return statusCheckRollupPayload([RUNNING_CHECK]);
      throw new Error(`gh pr merge não deveria ser chamado em timeout: ${args.join(" ")}`);
    };
    let now = 0;
    const realNow = Date.now;
    // simula o avanço do relógio junto com os sleeps, sem dormir de verdade
    (Date as unknown as { now: () => number }).now = () => now;
    try {
      const result = waitAndMergeSitePagePr("/repo", 1, gh, (ms) => { now += ms; }, 30_000, 10_000);
      assert.equal(result.merged, false);
      assert.match(result.reason, /não convergiu/);
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
  });

  it("gh pr merge falha mesmo com CI verde: NÃO relança, devolve merged:false com o motivo", () => {
    const gh: GhRunner = (args) => {
      if (args[0] === "pr" && args[1] === "view") return statusCheckRollupPayload([PASSING_CHECK]);
      if (args[0] === "pr" && args[1] === "merge") throw new Error("required review thread not resolved");
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const result = waitAndMergeSitePagePr("/repo", 1, gh, () => {});
    assert.equal(result.merged, false);
    assert.match(result.reason, /gh pr merge falhou/);
  });
});

describe("productionDeps.publish — integração fim-a-fim do auto-merge (#8158)", () => {
  it("PR CRIADO (não reusado) tem prNumber parseado da URL e é mergeado quando o CI vem verde — o caso comum que a issue original deixaria sempre sem prNumber", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
      if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
      if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
      if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
      return "";
    };
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/8156\n";
      if (args[0] === "pr" && args[1] === "view") return statusCheckRollupPayload([PASSING_CHECK]);
      if (args[0] === "pr" && args[1] === "merge") return "Merged\n";
      return "";
    };
    const lock = () => ({ ok: true, stdout: "", stderr: "" });
    const deps = productionDeps("/repo", git, gh, lock, () => {});
    const result = deps.publish("meu-slug");
    assert.equal(result.prCreated, true);
    assert.equal(result.prNumber, 8156, "prNumber precisa vir da URL quando o PR é CRIADO, não só quando reusado");
    assert.equal(result.merged, true);
    assert.ok(ghCalls.some((c) => c[0] === "pr" && c[1] === "merge"));
  });

  it("PR REUSADO (não criado — já existe um aberto pra branch) também é mergeado quando o CI vem verde", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
      if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
      if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
      if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
      return "";
    };
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 4321, url: "https://github.com/vjpixel/diaria-studio/pull/4321" }]);
      }
      if (args[0] === "pr" && args[1] === "create") {
        throw new Error("gh pr create não deveria ser chamado — já existe PR aberto pra essa branch");
      }
      if (args[0] === "pr" && args[1] === "view") return statusCheckRollupPayload([PASSING_CHECK]);
      if (args[0] === "pr" && args[1] === "merge") return "Merged\n";
      return "";
    };
    const lock = () => ({ ok: true, stdout: "", stderr: "" });
    const deps = productionDeps("/repo", git, gh, lock, () => {});
    const result = deps.publish("meu-slug");
    assert.equal(result.prCreated, false, "reusa o PR existente, não cria um novo");
    assert.equal(result.prNumber, 4321);
    assert.equal(result.merged, true, "o caminho de reuso também precisa mergear quando o CI vem verde");
    assert.ok(ghCalls.some((c) => c[0] === "pr" && c[1] === "merge" && c.includes("4321")));
  });

  it("sem PR nenhum (gh pr create não devolve URL parseável): merged:false, nunca tenta gh pr view/merge", () => {
    const git: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
      if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
      if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
      if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
      return "";
    };
    const ghCalls: string[][] = [];
    const gh: GhRunner = (args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "\n"; // saída vazia, sem URL
      return "";
    };
    const lock = () => ({ ok: true, stdout: "", stderr: "" });
    const deps = productionDeps("/repo", git, gh, lock, () => {});
    const result = deps.publish("meu-slug");
    assert.equal(result.prNumber, undefined);
    assert.equal(result.merged, false);
    assert.match(result.mergeReason ?? "", /sem prNumber/);
    assert.ok(!ghCalls.some((c) => c[0] === "pr" && (c[1] === "view" || c[1] === "merge")));
  });
});
