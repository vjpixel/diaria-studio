/**
 * test/worker-robots-host-branching-7733.test.ts (#7733)
 *
 * Teste de regressão pro defeito descrito em #7733:
 * `test/worker-robots-txt-guard-4777.test.ts` gerava um `it()` por host,
 * mas a asserção era chaveada só pelo DIRETÓRIO do Worker — `host` entrava
 * só no nome do teste. `ROBOTS_ROUTE_DISPATCH_RE` (via
 * `anyTsFileHasRobotsRouteDispatch`) casava `=== "/robots.txt"` em qualquer
 * lugar de `src/`, então um Worker multi-host onde só UM host de fato
 * servisse (ou redirecionasse pra) `/robots.txt` passava para TODOS os
 * hosts — inclusive um host que não servisse nem redirecionasse.
 *
 * Este arquivo testa `classifyHostRobotsHandling`/`analyzeHostBranching`
 * (`scripts/lib/worker-public-hosts.ts`) diretamente, com fixtures de
 * Worker sintéticas em diretório temporário — não depende do estado real
 * de `workers/` (esse já é coberto por `worker-robots-txt-guard-4777.test.ts`
 * rodando contra o repo).
 *
 * Três casos, o critério de sucesso nomeado pela issue:
 *   1. Host que redireciona-tudo pra outro host que serve → "ok-redirect".
 *   2. Host que genuinamente NÃO serve nem redireciona → "missing" (é o
 *      caso que o guard antigo deixava passar; aqui tem que ser pego).
 *   3. Host com ramificação por `url.host` que o guard não reconhece
 *      (redirect condicionado por path, ou alvo não resolvível) →
 *      "cannot-verify", NUNCA "ok" — regra inegociável da issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverWorkerPublicHosts,
  classifyHostRobotsHandling,
  analyzeHostBranching,
} from "../scripts/lib/worker-public-hosts.ts";

function withFixtureWorkersDir(build: (workersDir: string) => void, run: (workersDir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "worker-robots-host-branching-"));
  try {
    build(dir);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeWrangler(workersDir: string, workerDir: string, routes: Array<{ host: string }>) {
  const dir = join(workersDir, workerDir);
  mkdirSync(dir, { recursive: true });
  const routesToml = routes
    .map((r) => `[[routes]]\npattern = "${r.host}"\ncustom_domain = true\n`)
    .join("\n");
  writeFileSync(join(dir, "wrangler.toml"), `name = "${workerDir}"\n\n${routesToml}`, "utf8");
}

function writeSrc(workersDir: string, workerDir: string, fileName: string, content: string) {
  const srcDir = join(workersDir, workerDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, fileName), content, "utf8");
}

describe("classifyHostRobotsHandling — host-aware (#7733)", () => {
  it("host que redireciona-tudo pra outro host que serve robots.txt → ok-redirect, e o host canônico → ok-direct", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "good-multi", [
          { host: "good-multi.example.com" },
          { host: "legacy-good.example.com" },
        ]);
        writeSrc(
          workersDir,
          "good-multi",
          "index.ts",
          `
export const CANONICAL_HOST = "https://good-multi.example.com";
export const LEGACY_HOST = "legacy-good.example.com";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host === LEGACY_HOST) {
      return Response.redirect(\`\${CANONICAL_HOST}\${url.pathname}\`, 301);
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\\nAllow: /\\n");
    }
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        const hosts = discoverWorkerPublicHosts(workersDir);
        const siblingHosts = hosts.map((h) => h.host);
        assert.deepEqual(siblingHosts.sort(), ["good-multi.example.com", "legacy-good.example.com"]);

        const canonical = classifyHostRobotsHandling(workersDir, "good-multi", "good-multi.example.com", siblingHosts);
        assert.deepEqual(canonical, { kind: "ok-direct" });

        const legacy = classifyHostRobotsHandling(workersDir, "good-multi", "legacy-good.example.com", siblingHosts);
        assert.deepEqual(legacy, { kind: "ok-redirect", targetHost: "good-multi.example.com" });
      },
    );
  });

  it("os 3 hosts reais de workers/retrospectiva continuam passando (não-regressão)", () => {
    // Cobertura de integração real contra o repo já vive em
    // worker-robots-txt-guard-4777.test.ts; aqui só reforça a expectativa
    // ESPECÍFICA por host (o que o defeito original escondia).
    const ROOT = join(new URL("..", import.meta.url).pathname);
    const workersDir = join(ROOT, "workers");

    const canonical = classifyHostRobotsHandling(workersDir, "retrospectiva", "retrospectiva.diar.ia.br");
    assert.equal(canonical.kind, "ok-direct");

    const legacyAnual = classifyHostRobotsHandling(workersDir, "retrospectiva", "anual.diar.ia.br");
    assert.equal(legacyAnual.kind, "ok-redirect");
    if (legacyAnual.kind === "ok-redirect") assert.equal(legacyAnual.targetHost, "retrospectiva.diar.ia.br");

    const legacyMensal = classifyHostRobotsHandling(workersDir, "retrospectiva", "artigo.diar.ia.br");
    assert.equal(legacyMensal.kind, "ok-redirect");
    if (legacyMensal.kind === "ok-redirect") assert.equal(legacyMensal.targetHost, "retrospectiva.diar.ia.br");
  });

  it("caso nomeado pela issue: um Worker multi-host novo onde NENHUM host serve nem redireciona é PEGO (missing)", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "broken-multi", [
          { host: "broken-a.example.com" },
          { host: "broken-b.example.com" },
        ]);
        // Worker novo, custom_domain declarado pros dois hosts, mas ninguém
        // implementou robots.txt ainda — nasce servindo o default bloqueante
        // da Cloudflare pros dois (#4546/#4777). Nenhum host aparece em
        // condição `url.host === ...` (não há redirect nenhum), então os
        // dois classificam "no-branch"; sem `public/robots.txt` nem
        // dispatch de rota em src/, o veredito é "missing" pros dois.
        writeSrc(
          workersDir,
          "broken-multi",
          "index.ts",
          `
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        const siblingHosts = ["broken-a.example.com", "broken-b.example.com"];
        for (const host of siblingHosts) {
          const verdict = classifyHostRobotsHandling(workersDir, "broken-multi", host, siblingHosts);
          assert.deepEqual(verdict, { kind: "missing" });
        }
      },
    );
  });

  it("caso nomeado pela issue (variante): host A serve, host B (irmão do mesmo Worker) não serve nem redireciona é PEGO", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "half-broken", [
          { host: "half-broken-served.example.com" },
          { host: "half-broken-legacy.example.com" },
        ]);
        // O host legado redireciona-tudo, mas pro host ERRADO — um host que
        // este Worker não declara nem serve (erro de configuração real:
        // copy-paste do host de outro Worker numa migração). O host
        // "served" serve normalmente via dispatch. Sem a verificação de
        // sibling (#7733), `ownHandlingExists` sozinho bastaria pra dar
        // "ok" ao legado só por este workerDir ter ALGUM handler — mesmo o
        // redirect indo pra lugar nenhum relacionado.
        writeSrc(
          workersDir,
          "half-broken",
          "index.ts",
          `
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host === "half-broken-legacy.example.com") {
      return Response.redirect("https://outro-worker-qualquer.example.com" + url.pathname, 301);
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\\nAllow: /\\n");
    }
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        const siblingHosts = ["half-broken-served.example.com", "half-broken-legacy.example.com"];

        const served = classifyHostRobotsHandling(workersDir, "half-broken", "half-broken-served.example.com", siblingHosts);
        assert.deepEqual(served, { kind: "ok-direct" });

        // PEGO: o redirect aponta pra um host que não é sibling deste
        // Worker — nunca "ok" (nem "ok-redirect" nem "ok-direct").
        const legacy = classifyHostRobotsHandling(workersDir, "half-broken", "half-broken-legacy.example.com", siblingHosts);
        assert.equal(legacy.kind, "cannot-verify");
      },
    );
  });

  it("worker sem NENHUM handler de robots.txt (nem public/robots.txt, nem dispatch) → missing pro host único", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "no-robots", [{ host: "no-robots.example.com" }]);
        writeSrc(
          workersDir,
          "no-robots",
          "index.ts",
          `
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        const verdict = classifyHostRobotsHandling(workersDir, "no-robots", "no-robots.example.com");
        assert.deepEqual(verdict, { kind: "missing" });
      },
    );
  });

  it("roteamento não-analisável (redirect condicionado também por pathname) → cannot-verify, NUNCA ok", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "ambiguous-multi", [
          { host: "ambiguous-primary.example.com" },
          { host: "ambiguous-partial.example.com" },
        ]);
        writeSrc(
          workersDir,
          "ambiguous-multi",
          "index.ts",
          `
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Redirect PARCIAL: só redireciona /especial, tudo mais (inclusive
    // /robots.txt) cai direto no dispatch normal deste mesmo Worker. O
    // guard não pode assumir que /robots.txt segue o mesmo caminho do
    // redirect parcial nem o caminho do dispatch normal com confiança —
    // a condição testa url.pathname junto com url.host, então o padrão
    // redirect-tudo não casa.
    if (url.host === "ambiguous-partial.example.com" && url.pathname === "/especial") {
      return Response.redirect("https://ambiguous-primary.example.com/especial", 301);
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\\nAllow: /\\n");
    }
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        const verdict = classifyHostRobotsHandling(workersDir, "ambiguous-multi", "ambiguous-partial.example.com");
        assert.equal(verdict.kind, "cannot-verify");
      },
    );
  });

  it("redirect-tudo cujo alvo não é resolvível (concatenação, não const/literal) → cannot-verify", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "unresolvable-target", [
          { host: "unresolvable-target.example.com" },
        ]);
        writeSrc(
          workersDir,
          "unresolvable-target",
          "index.ts",
          `
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host === "unresolvable-target.example.com") {
      const dest = pickDestinationSomehow(url);
      return Response.redirect(dest, 301);
    }
    return new Response("ok");
  },
};

function pickDestinationSomehow(url: URL): string {
  return "https://" + url.host;
}
`,
        );
      },
      (workersDir) => {
        const verdict = classifyHostRobotsHandling(
          workersDir,
          "unresolvable-target",
          "unresolvable-target.example.com",
        );
        assert.equal(verdict.kind, "cannot-verify");
      },
    );
  });

  it("analyzeHostBranching: host ausente de qualquer condição → no-branch (host canônico implícito)", () => {
    const source = `
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/robots.txt") return new Response("ok");
    return new Response("ok");
  },
};
`;
    assert.deepEqual(analyzeHostBranching(source, "solo.example.com"), { kind: "no-branch" });
  });

  // Achados do self-review da PR #7818: operandos invertidos (`CONST ===
  // url.host`) e negação (`url.host !== CONST`) mencionam o host mas não são
  // o padrão redirect-tudo reconhecido — precisam contar como "mencionado,
  // mas não reconhecido" (unresolvable-branch), NUNCA cair silenciosamente
  // em "no-branch" (que trataria o host como canônico implícito e poderia
  // produzir um ok-direct/ok-redirect falso).
  it("analyzeHostBranching: operandos invertidos (CONST === url.host) → unresolvable-branch, nunca no-branch", () => {
    const source = `
export const LEGACY_HOST = "legacy.example.com";
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (LEGACY_HOST === url.host) {
      return Response.redirect("https://canonical.example.com" + url.pathname, 301);
    }
    return new Response("ok");
  },
};
`;
    const result = analyzeHostBranching(source, "legacy.example.com");
    assert.equal(result.kind, "unresolvable-branch");
  });

  it("analyzeHostBranching: negação (url.host !== CONST) → unresolvable-branch, nunca no-branch", () => {
    const source = `
export const CANONICAL_HOST = "canonical.example.com";
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host !== CANONICAL_HOST) {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\\nAllow: /\\n");
    return new Response("ok");
  },
};
`;
    // O host CANÔNICO também é "mencionado" (via negação) e não casa o
    // padrão redirect-tudo — então também vira unresolvable-branch, mesmo
    // sendo o host que efetivamente funciona. É o preço da precisão
    // conservadora: o guard nunca inventa reconhecimento de negação, então
    // avisa "não sei" em vez de arriscar um falso "sei" no lado oposto.
    const result = analyzeHostBranching(source, "canonical.example.com");
    assert.equal(result.kind, "unresolvable-branch");
  });

  it("classifyHostRobotsHandling: bloco redirect-tudo COMENTADO (código morto) não é lido como roteamento vivo", () => {
    withFixtureWorkersDir(
      (workersDir) => {
        writeWrangler(workersDir, "commented-out", [{ host: "commented-out.example.com" }]);
        writeSrc(
          workersDir,
          "commented-out",
          "index.ts",
          `
// Isto é código morto de um refactor anterior — NÃO deve ser lido como
// roteamento vivo:
// if (url.host === "commented-out.example.com") {
//   return Response.redirect("https://outro.example.com" + url.pathname, 301);
// }
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("ok");
  },
};
`,
        );
      },
      (workersDir) => {
        // Sem o strip de comentário, o bloco comentado seria lido como um
        // redirect-tudo real (achado do self-review da PR #7818) — o
        // veredito correto é "missing" (o worker de fato não serve nem
        // redireciona), nunca "ok-redirect".
        const verdict = classifyHostRobotsHandling(workersDir, "commented-out", "commented-out.example.com");
        assert.deepEqual(verdict, { kind: "missing" });
      },
    );
  });
});
