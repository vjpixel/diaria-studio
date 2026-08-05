/**
 * test/verify-scheduled-post.test.ts (#2074)
 *
 * Testa a lógica principal de verify-scheduled-post.ts com mocks.
 * NUNCA chama a API Beehiiv real.
 *
 * Regressão central (260611): editor confirmou "agendado" mas a API mostrou
 * `status: published` com `publish_date = now` — o clique foi Publish (envio
 * imediato), não Schedule. Este teste cobre os dois desfechos:
 *   A) scheduled corretamente (publish_date no futuro)
 *   B) publicado imediato (publish_date <= now)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { verifyScheduledPost } from "../scripts/verify-scheduled-post.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "verify-scheduled-post.ts");
const NOW = new Date("2026-06-11T01:30:00Z");

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Cria um edition_dir temporário com 05-published.json de stub.
 * Limpa automaticamente após o teste via return do dir.
 */
function makeTmpEditionDir(opts?: { withPublishedJson?: boolean }): string {
  const dir = resolve(tmpdir(), `diaria-test-vspost-${Date.now()}`);
  const internalDir = resolve(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  if (opts?.withPublishedJson !== false) {
    // _internal/05-published.json stub
    writeFileSync(
      resolve(internalDir, "05-published.json"),
      JSON.stringify({
        draft_url: "https://app.beehiiv.com/posts/post_test/edit",
        status: "draft",
        title: "Test title",
        test_email_sent_at: "2026-06-11T01:00:00Z",
      }),
      "utf8",
    );
  }
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors in tests
  }
}

// ── testes ────────────────────────────────────────────────────────────────────

describe("verifyScheduledPost (#2074)", () => {
  it("desfecho A: scheduled corretamente — publish_date no futuro", () => {
    const dir = makeTmpEditionDir();
    try {
      const futureDate = Math.floor(NOW.getTime() / 1000) + 8 * 3600; // 8h futuro
      const post = {
        id: "post_abc",
        status: "confirmed",
        publish_date: futureDate,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "scheduled");
      assert.equal(result.immediate_send_detected, false);
      assert.equal(result.published_json_updated, false);
      assert.ok(result.scheduled_at, "deve ter scheduled_at no futuro");
      assert.equal(result.published_at, null);
      assert.equal(result.post_id, "post_abc");

      // 05-published.json NÃO deve ter sido modificado
      const updated = JSON.parse(readFileSync(resolve(dir, "_internal", "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "draft", "status não deve mudar para scheduled corretamente");
    } finally {
      cleanupDir(dir);
    }
  });

  it("desfecho B: publicado imediato — publish_date no passado (caso 260611)", () => {
    const dir = makeTmpEditionDir();
    try {
      // publish_date = now (envio imediato às 22:46 BRT — cenário real 260611)
      const publishedAt = Math.floor(NOW.getTime() / 1000); // = now exato
      const post = {
        id: "post_260611",
        status: "confirmed",
        publish_date: publishedAt,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);
      assert.equal(result.scheduled_at, null);
      assert.ok(result.published_at, "deve ter published_at");

      // 05-published.json deve ter sido atualizado com status: published
      const updated = JSON.parse(readFileSync(resolve(dir, "_internal", "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published", "status deve ser atualizado para published");
      assert.ok(updated.published_at, "published_at deve estar presente");
    } finally {
      cleanupDir(dir);
    }
  });

  it("desfecho B: publicado imediato — publish_date 1min no passado", () => {
    const dir = makeTmpEditionDir();
    try {
      const justPast = Math.floor(NOW.getTime() / 1000) - 60; // 1 minuto atrás
      const post = {
        id: "post_just_past",
        status: "confirmed",
        publish_date: justPast,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
    } finally {
      cleanupDir(dir);
    }
  });

  it("boundary: publish_date exatamente = now → published (não scheduled)", () => {
    const dir = makeTmpEditionDir();
    try {
      const exactNow = Math.floor(NOW.getTime() / 1000);
      const post = {
        id: "post_boundary",
        status: "confirmed",
        publish_date: exactNow,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      // resolveBeehiivState: publishMs > now.getTime() → strictamente maior
      // publish_date * 1000 = now.getTime() → NÃO strictamente maior → published
      assert.equal(result.state, "published");
    } finally {
      cleanupDir(dir);
    }
  });

  it("boundary: publish_date = now + 1s → scheduled (ainda no futuro)", () => {
    const dir = makeTmpEditionDir();
    try {
      const justFuture = Math.floor(NOW.getTime() / 1000) + 1;
      const post = {
        id: "post_just_future",
        status: "confirmed",
        publish_date: justFuture,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "scheduled");
      assert.equal(result.immediate_send_detected, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("draft sem publish_date → unknown (nenhuma ação sobre 05-published.json)", () => {
    const dir = makeTmpEditionDir();
    try {
      const post = {
        id: "post_draft",
        status: "draft",
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "draft");
      assert.equal(result.immediate_send_detected, false);
      assert.equal(result.published_json_updated, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("sem 05-published.json: immediate_send_detected sem crash + published_json_updated=false", () => {
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      const pastDate = Math.floor(NOW.getTime() / 1000) - 3600;
      const post = {
        id: "post_nojson",
        status: "confirmed",
        publish_date: pastDate,
      };
      // Não deve lançar — apenas avisar no stderr e setar published_json_updated=false
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "published");
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, false, "sem o arquivo, não atualiza");
    } finally {
      cleanupDir(dir);
    }
  });

  it("05-published.json no root (path legado) também é atualizado", () => {
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      // Colocar 05-published.json no root, não no _internal
      writeFileSync(
        resolve(dir, "05-published.json"),
        JSON.stringify({ status: "draft", title: "test" }),
        "utf8",
      );
      const pastDate = Math.floor(NOW.getTime() / 1000) - 100;
      const post = {
        id: "post_root",
        status: "confirmed",
        publish_date: pastDate,
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);

      const updated = JSON.parse(readFileSync(resolve(dir, "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published");
    } finally {
      cleanupDir(dir);
    }
  });

  // #2104: publish_date negativo não deve gerar 'published' falso
  it("#2104 regressão: publish_date negativo → unknown (não immediate_send_detected)", () => {
    const dir = makeTmpEditionDir();
    try {
      const post = {
        id: "post_neg_date",
        status: "confirmed",
        publish_date: -1, // campo mal populado pela API
      };
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.state, "unknown");
      assert.equal(result.immediate_send_detected, false, "publish_date negativo não deve disparar alerta de envio imediato");
      assert.equal(result.published_json_updated, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("D3 regressão: 05-published.json contendo null não apaga campos existentes", () => {
    // JSON.parse("null") retorna null; { ...null, status } produz {} silenciosamente.
    // O guard typeof previne isso — verifica que campos originais são preservados.
    const dir = makeTmpEditionDir({ withPublishedJson: false });
    try {
      // Arquivo corrompido com conteúdo "null"
      const internalDir = resolve(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(resolve(internalDir, "05-published.json"), "null", "utf8");

      const pastDate = Math.floor(NOW.getTime() / 1000) - 100;
      const post = {
        id: "post_corrupt",
        status: "confirmed",
        publish_date: pastDate,
      };
      // Não deve lançar, deve atualizar status mesmo com arquivo corrompido
      const result = verifyScheduledPost(post, dir, NOW);
      assert.equal(result.immediate_send_detected, true);
      assert.equal(result.published_json_updated, true);

      const updated = JSON.parse(readFileSync(resolve(internalDir, "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published");
      assert.ok(updated.published_at, "published_at deve estar presente");
      // Campos originais eram null (arquivo corrompido) — garantir que não há
      // draft_url/title fantasmas de null espalhados
      assert.equal(Object.keys(updated).sort().join(","), "published_at,status");
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("verify-scheduled-post exit semantics (#4638)", () => {
  // Regression test pro crash Windows libuv. O bug: process.exit(N) dentro
  // de main() forçava shutdown do libuv enquanto o fetch agent ainda tinha
  // sockets keep-alive abertos, disparando a assertion UV_HANDLE_CLOSING
  // (exit 127/134) mesmo com o JSON de resultado já impresso corretamente
  // no stdout. Mesma classe já corrigida em validate-gemini-config.ts (#1401)
  // e check-google-token.ts. Fix: process.exitCode + return, deixando o
  // event loop drenar naturalmente.
  //
  // O check estático abaixo garante que main() não chama process.exit()
  // diretamente — single source of truth pra detectar a regressão.
  // Portável em Linux/Mac (CI) e Windows (onde o bug original aparecia).

  it("main() usa process.exitCode em vez de process.exit() (#4638)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // Strip line comments pra não matchar referências em // process.exit() ...
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    // Pega só o corpo da função main()
    const mainMatch = sourceNoComments.match(/async function main\(\)[\s\S]*?\n\}\n/);
    assert.ok(mainMatch, "main() function não encontrada no script");
    const mainBody = mainMatch[0];
    // Bug original: process.exit(N) dentro de main()
    // Fix: deve usar process.exitCode pra evitar UV_HANDLE_CLOSING no Windows
    assert.equal(
      /process\.exit\s*\(/.test(mainBody),
      false,
      "main() não pode chamar process.exit() — usar process.exitCode (#4638 Windows crash)",
    );
    // Este assert só confirma que a substring aparece EM ALGUM LUGAR do corpo
    // de main() — não que CADA branch individualmente define exitCode antes
    // de sair (um `return` removido de um branch específico não quebraria
    // este check, porque outro branch ainda contém a string). A garantia de
    // "todos os branches" vem do describe "e2e via mock HTTP server" abaixo,
    // que exercita scheduled/published/draft/erro-de-API via CLI real e
    // verifica o exit code de cada um.
    assert.match(mainBody, /process\.exitCode/, "main() deve setar process.exitCode em algum branch");
  });

  it("catch handler do isMainModule() também usa process.exitCode (#4638)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    const catchMatch = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() não encontrado no script");
    const catchBody = catchMatch[0];
    assert.equal(
      /process\.exit\s*\(/.test(catchBody),
      false,
      "catch de main() não pode chamar process.exit() — usar process.exitCode (#4638 Windows crash)",
    );
    assert.match(catchBody, /process\.exitCode/, "catch de main() deve setar process.exitCode");
  });

  it("script sem --post-id sai limpo com exit 2 (cross-platform smoke)", () => {
    // Smoke test: spawnSync sem args obrigatórios cai no branch de validação
    // de args (exit 2) — ANTES de qualquer fetch. Este teste específico NÃO
    // reproduz a race condition original (não há socket keep-alive em voo
    // quando o processo sai, porque não houve fetch nenhum); ele só cobre
    // ponta-a-ponta o caminho isMainModule()/exitCode pro branch mais
    // barato de disparar. A cobertura real do bug — exit limpo com um fetch
    // de verdade ainda em voo — está no describe "e2e via mock HTTP server"
    // abaixo, que exercita os branches PÓS-fetch (scheduled/published/
    // draft/erro-de-API) via mock server local.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT],
      { encoding: "utf8", env: process.env, timeout: 30_000 },
    );
    assert.equal(result.status, 2, `exit code esperado 2, veio ${result.status} (stderr: ${result.stderr?.slice(0, 200)})`);
  });
});

describe("verify-scheduled-post e2e via mock HTTP server (#4638)", () => {
  // O crash original só podia acontecer nos branches que rodam DEPOIS de
  // fetchPost() — com um fetch de verdade em voo (socket keep-alive aberto)
  // quando o processo sai. Os testes acima (assert estático + smoke sem
  // --post-id) não cobrem isso: nenhum deles chega a chamar fetch. Este
  // describe spawna o script REAL (mesmo binário `--import tsx` usado no
  // smoke acima) contra um mock HTTP server local, usando o override
  // BEEHIIV_API_URL (scripts/lib/beehiiv-config.ts:36-41, "usado por testes
  // que apontam pra mock server local") — mesmo padrão de
  // test/close-poll-nested.test.ts (servidor HTTP local + spawn do CLI
  // real). Cobre os 4 pontos de saída pós-fetch: erro de API, scheduled,
  // immediate_send_detected e o fallback (draft/unknown).
  //
  // spawnSync bloquearia o event loop deste processo de teste — e o mock
  // server roda NO MESMO processo — então o spawn aqui é assíncrono
  // (mesma razão documentada em close-poll-nested.test.ts).

  const PUB_ID = "pub_test_4638";

  function spawnScriptAsync(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
        env,
        timeout: 30_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    });
  }

  /** Mock mínimo de GET /publications/{pubId}/posts/{postId} — nunca toca a API Beehiiv real. */
  function startMockBeehiiv(
    expectedPath: string,
    respond: { status: number; body: unknown },
  ): Promise<{ server: Server; url: string }> {
    return new Promise((resolvePromise) => {
      const server = createServer((req, res) => {
        const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("content-type", "application/json");
        if (pathname !== expectedPath) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `unexpected path ${pathname}` }));
          return;
        }
        res.writeHead(respond.status);
        res.end(JSON.stringify(respond.body));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolvePromise({ server, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  function makeTmpEditionDirE2e(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-test-vspost-e2e-"));
    mkdirSync(resolve(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("branch scheduled → exit 0 (fetch real em voo, publish_date no futuro)", async () => {
    const postId = "post_e2e_scheduled";
    const path = `/publications/${PUB_ID}/posts/${postId}`;
    const futureUnix = Math.floor(Date.now() / 1000) + 3600; // 1h no futuro
    const { server, url } = await startMockBeehiiv(path, {
      status: 200,
      body: { data: { id: postId, status: "confirmed", publish_date: futureUnix } },
    });
    const dir = makeTmpEditionDirE2e();
    try {
      const r = await spawnScriptAsync(
        ["--post-id", postId, "--edition-dir", dir],
        {
          ...process.env,
          BEEHIIV_API_KEY: "test-key-4638",
          BEEHIIV_PUBLICATION_ID: PUB_ID,
          BEEHIIV_API_URL: url,
        },
      );
      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.state, "scheduled");
      assert.equal(out.immediate_send_detected, false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("branch immediate_send_detected → exit 1 (fetch real em voo, publish_date no passado)", async () => {
    const postId = "post_e2e_published";
    const path = `/publications/${PUB_ID}/posts/${postId}`;
    const pastUnix = Math.floor(Date.now() / 1000) - 3600; // 1h no passado
    const { server, url } = await startMockBeehiiv(path, {
      status: 200,
      body: { data: { id: postId, status: "confirmed", publish_date: pastUnix } },
    });
    const dir = makeTmpEditionDirE2e();
    writeFileSync(
      resolve(dir, "_internal", "05-published.json"),
      JSON.stringify({ status: "draft", title: "e2e test" }),
      "utf8",
    );
    try {
      const r = await spawnScriptAsync(
        ["--post-id", postId, "--edition-dir", dir],
        {
          ...process.env,
          BEEHIIV_API_KEY: "test-key-4638",
          BEEHIIV_PUBLICATION_ID: PUB_ID,
          BEEHIIV_API_URL: url,
        },
      );
      assert.equal(r.status, 1, `esperado exit 1 — stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.state, "published");
      assert.equal(out.immediate_send_detected, true);
      assert.equal(out.published_json_updated, true);

      const updated = JSON.parse(readFileSync(resolve(dir, "_internal", "05-published.json"), "utf8")) as Record<string, unknown>;
      assert.equal(updated.status, "published");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("branch fallback (draft/unknown) → exit 2 (fetch real em voo, sem scheduled nem published)", async () => {
    const postId = "post_e2e_draft";
    const path = `/publications/${PUB_ID}/posts/${postId}`;
    const { server, url } = await startMockBeehiiv(path, {
      status: 200,
      body: { data: { id: postId, status: "draft" } },
    });
    const dir = makeTmpEditionDirE2e();
    try {
      const r = await spawnScriptAsync(
        ["--post-id", postId, "--edition-dir", dir],
        {
          ...process.env,
          BEEHIIV_API_KEY: "test-key-4638",
          BEEHIIV_PUBLICATION_ID: PUB_ID,
          BEEHIIV_API_URL: url,
        },
      );
      assert.equal(r.status, 2, `esperado exit 2 — stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.state, "draft");
      assert.equal(out.immediate_send_detected, false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("branch erro de API (fetch resolve mas HTTP não-ok) → exit 2 (catch de fetchPost)", async () => {
    const postId = "post_e2e_apierror";
    const path = `/publications/${PUB_ID}/posts/${postId}`;
    const { server, url } = await startMockBeehiiv(path, {
      status: 500,
      body: { error: "internal error simulado" },
    });
    const dir = makeTmpEditionDirE2e();
    try {
      const r = await spawnScriptAsync(
        ["--post-id", postId, "--edition-dir", dir],
        {
          ...process.env,
          BEEHIIV_API_KEY: "test-key-4638",
          BEEHIIV_PUBLICATION_ID: PUB_ID,
          BEEHIIV_API_URL: url,
        },
      );
      assert.equal(r.status, 2, `esperado exit 2 — stderr: ${r.stderr}`);
      assert.match(r.stderr, /erro API/, "deve logar o erro de API no stderr");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
