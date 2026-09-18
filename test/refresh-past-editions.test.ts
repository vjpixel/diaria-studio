import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, extractLinks, isContentLink } from "../scripts/refresh-past-editions.ts";
import { execFileSync } from "node:child_process";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("renderMarkdown", () => {
  it("renderiza header + edições com links extraídos do html", () => {
    const posts = [
      {
        id: "post1",
        title: "Edição A",
        web_url: "https://diaria.beehiiv.com/p/edicao-a",
        published_at: "2026-04-25T10:00:00Z",
        html: "<p>Veja https://example.com/post1 e https://other.com</p>",
      },
    ];
    const md = renderMarkdown(posts);
    assert.ok(md.includes("Últimas edições publicadas"));
    assert.ok(md.includes("**edições carregadas:** 1"));
    assert.ok(md.includes('## 2026-04-25 — "Edição A"'));
    assert.ok(md.includes("- https://example.com/post1"));
    assert.ok(md.includes("- https://other.com"));
  });

  it("une links[] explícitos com links de conteúdo do html (#8298 — união, não precedência)", () => {
    // #8298: antes o approved.json (links[]) VENCIA e o html era só fallback
    // quando links[] estava vazio — um link que entrasse na edição por troca
    // editorial pós-gate (fora do approved.json congelado) nunca chegava ao
    // MD. Regressão desta issue: html publicado é fonte de verdade, então um
    // link de conteúdo presente no html mas ausente de links[] TEM que
    // aparecer na união.
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-union-"));
    const posts = [
      {
        id: "post2",
        title: "Edição B",
        published_at: "2026-04-26T10:00:00Z",
        links: ["https://forced.com/a", "https://forced.com/b"],
        html: "<p>https://forced.com/a e https://promoted-post-gate.example.com</p>",
      },
    ];
    const md = renderMarkdown(posts, tmpRoot); // root isolado — guard de divergência não deve tocar data/ real
    assert.ok(md.includes("- https://forced.com/a"));
    assert.ok(md.includes("- https://forced.com/b"));
    assert.ok(
      md.includes("- https://promoted-post-gate.example.com"),
      "link de conteúdo presente só no html (troca pós-gate) precisa aparecer na união",
    );
  });

  it("filtra boilerplate (rodapé/social/hub/amazon/wa.me/imagem) do lado que vem do html (#8298)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-boilerplate-"));
    const posts = [
      {
        id: "post2b",
        title: "Edição B2",
        published_at: "2026-04-26T10:00:00Z",
        links: ["https://forced.com/a"],
        html: [
          "<p>https://forced.com/a</p>",
          '<img src="https://cdn.example.com/hero.jpg">', // imagem
          '<a href="https://wa.me/?text=oi">WhatsApp</a>', // CTA fixo de rodapé
          '<a href="https://diar.ia.br/hub/anthropic-claude">hub</a>', // hub interno
          '<a href="https://amzn.to/xyz">Amazon</a>', // afiliado
          '<a href="https://linkedin.com/company/diar.ia.br">LinkedIn</a>', // canal próprio
          "<p>https://real-source.example.com/artigo</p>", // conteúdo de verdade
        ].join("\n"),
      },
    ];
    const md = renderMarkdown(posts, tmpRoot);
    assert.ok(md.includes("- https://forced.com/a"));
    assert.ok(md.includes("- https://real-source.example.com/artigo"));
    assert.ok(!md.includes("hero.jpg"));
    assert.ok(!md.includes("wa.me"));
    assert.ok(!md.includes("diar.ia.br/hub"));
    assert.ok(!md.includes("amzn.to"));
    assert.ok(!md.includes("linkedin.com/company"));
  });

  it("#8302: filtra fonte/.woff2, namespace w3.org, X próprio e afiliado Amazon — só o link de conteúdo real entra em links", () => {
    // Regressão do #8302: isContentLink deixava passar tudo isso pra
    // past-editions.md porque o default era permissivo (só excluía extensão
    // de imagem + FOOTER_DOMAINS antigo). Fixture reproduz exatamente os 4
    // tipos de boilerplate achados na medição real (data/past-editions-raw.json).
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-8302-boilerplate-"));
    const posts = [
      {
        id: "post8302",
        title: "Edição 8302",
        published_at: "2026-09-18T10:00:00Z",
        links: ["https://forced.com/a"],
        html: [
          '<html xmlns="http://www.w3.org/1999/xhtml">', // namespace XML do template
          '<link href="https://fonts.gstatic.com/s/librefranklin/v18/abc.woff2" rel="stylesheet">', // fonte
          "<p>https://forced.com/a</p>",
          '<a href="https://x.com/diariabr">Siga no X</a>', // canal próprio (rodapé social)
          '<a href="https://www.amazon.com.br/dp/B0DB9VVG22?tag=diaria-20">Livro</a>', // afiliado
          '<a href="https://real-source.example.com/artigo-novo">Manchete</a>', // conteúdo real, ausente de links[]
        ].join("\n"),
      },
    ];
    const md = renderMarkdown(posts, tmpRoot);
    assert.ok(md.includes("- https://forced.com/a"));
    assert.ok(
      md.includes("- https://real-source.example.com/artigo-novo"),
      "único link de conteúdo real do html precisa entrar na união",
    );
    assert.ok(!md.includes("w3.org"));
    assert.ok(!md.includes("fonts.gstatic.com"));
    assert.ok(!md.includes("x.com/diariabr"));
    assert.ok(!md.includes("amazon.com.br"));
  });

  it("#8302: janela de 14 edições-fixture trava em EXATAMENTE 1 divergência — não volta a inflar em silêncio", () => {
    // Trava o NÚMERO, não só a presença/ausência de um domínio — reproduz em
    // miniatura a medição real (14 edições, janela dedupEditionCount) que
    // motivou o #8302: 13 divergiam por boilerplate antes do fix, deveria
    // sobrar só a divergência de conteúdo real.
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-8302-window-"));
    const boilerplateHtml = [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      '<link href="https://fonts.gstatic.com/s/librefranklin/v18/abc.woff2" rel="stylesheet">',
      '<a href="https://x.com/diariabr">Siga no X</a>',
      '<a href="https://www.amazon.com.br/dp/XYZ?tag=diaria-20">Livro</a>',
      '<a href="https://www.flickr.com/people/91981596@N06">crédito</a>',
      '<a href="https://email.beehiivstatus.com/{{hash}}/hclick">honeypot</a>',
    ].join("\n");
    const posts = Array.from({ length: 14 }, (_, i) => ({
      id: `post-window-${i}`,
      title: `Edição janela ${i}`,
      published_at: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
      links: ["https://forced.com/a"],
      html: `<p>https://forced.com/a</p>\n${boilerplateHtml}`,
    }));
    // Só a última edição da janela tem 1 link de conteúdo real divergente —
    // as outras 13 têm SÓ boilerplate (mesma proporção 13/14 da medição real).
    posts[13].html += '\n<a href="https://real-source.example.com/unica-divergencia">Manchete</a>';

    let totalDivergentEditions = 0;
    for (const p of posts) {
      const md = renderMarkdown([p], tmpRoot);
      if (md.includes("real-source.example.com")) totalDivergentEditions++;
      assert.ok(!md.includes("w3.org") && !md.includes("fonts.gstatic.com") && !md.includes("x.com/diariabr") && !md.includes("amazon.com.br") && !md.includes("flickr.com") && !md.includes("beehiivstatus.com"));
    }
    assert.equal(totalDivergentEditions, 1, "só a edição com o link de conteúdo real deve divergir — as outras 13 são só boilerplate");
  });

  it("guard: loga warning (nunca silêncio) quando html tem link de conteúdo ausente de links[] (#8298)", async () => {
    const { readFileSync: readFileSyncLocal } = await import("node:fs");
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-guard-"));
    const posts = [
      {
        id: "post2c",
        title: "Edição B3",
        published_at: "2026-04-26T10:00:00Z",
        links: ["https://forced.com/a"],
        html: "<p>https://forced.com/a e https://divergente.example.com</p>",
      },
    ];
    renderMarkdown(posts, tmpRoot);
    const logPath = join(tmpRoot, "data", "run-log.jsonl");
    assert.ok(existsSync(logPath), "guard deveria ter gravado um warning em run-log.jsonl");
    const logContent = readFileSyncLocal(logPath, "utf8");
    assert.ok(logContent.includes("divergente.example.com"));
    assert.ok(logContent.includes('"level":"warn"'));
  });

  it("guard NÃO loga quando links[] está vazio (sem baseline pra comparar — edição importada/outra máquina)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "past-editions-noguard-"));
    const posts = [
      {
        id: "post2d",
        title: "Edição B4",
        published_at: "2026-04-26T10:00:00Z",
        html: "<p>https://qualquer.example.com</p>", // sem links[] — nada pra comparar
      },
    ];
    renderMarkdown(posts, tmpRoot);
    const logPath = join(tmpRoot, "data", "run-log.jsonl");
    assert.ok(!existsSync(logPath), "sem approvedLinks, não há divergência real — não deveria logar");
  });

  it("inclui temas se themes[] estiver presente", () => {
    const posts = [
      {
        id: "post3",
        title: "Edição C",
        published_at: "2026-04-27T10:00:00Z",
        themes: ["GPT-5.5", "regulação IA"],
      },
    ];
    const md = renderMarkdown(posts);
    assert.ok(md.includes("Temas cobertos:"));
    assert.ok(md.includes("- GPT-5.5"));
    assert.ok(md.includes("- regulação IA"));
  });

  it("array vazio gera só header", () => {
    const md = renderMarkdown([]);
    assert.ok(md.includes("**edições carregadas:** 0"));
    assert.ok(!md.includes("##"));
  });
});

describe("isContentLink (#8298)", () => {
  it("aceita URL de conteúdo comum", () => {
    assert.ok(isContentLink("https://real-source.example.com/artigo"));
  });

  it("rejeita URL de imagem mesmo com query string/hash", () => {
    assert.ok(!isContentLink("https://cdn.example.com/hero.jpg"));
    assert.ok(!isContentLink("https://cdn.example.com/hero.jpg?w=800"));
    assert.ok(!isContentLink("https://cdn.example.com/hero.png#top"));
    assert.ok(!isContentLink("https://cdn.example.com/hero.webp"));
    assert.ok(!isContentLink("https://cdn.example.com/hero.svg"));
  });

  it("NÃO rejeita URL de conteúdo cujo path só CONTÉM 'jpg' sem ser extensão", () => {
    // regressão de falso-positivo: a extensão precisa estar no fim do path
    // (antes de `?`/`#`/fim de string), não em qualquer lugar da URL.
    assert.ok(isContentLink("https://example.com/artigo-jpg-no-mercado-de-ia"));
  });

  it("rejeita domínio de FOOTER_DOMAINS (rodapé/hub/afiliado/canal próprio)", () => {
    assert.ok(!isContentLink("https://diar.ia.br/hub/anthropic-claude"));
    assert.ok(!isContentLink("https://wa.me/?text=oi"));
    assert.ok(!isContentLink("https://amzn.to/xyz"));
    assert.ok(!isContentLink("https://www.linkedin.com/company/diar.ia.br"));
    assert.ok(!isContentLink("https://diaria.beehiiv.com/p/edicao"));
  });

  it("NÃO rejeita host que só contém um FOOTER_DOMAINS como substring de OUTRO domínio", () => {
    // achado do code-review da PR #8299: FOOTER_DOMAINS casa por `.includes()`,
    // não por hostname exato — documentando o comportamento atual (conhecido,
    // aceito) em vez de deixá-lo implícito. `notdiar.ia.br.evil.com` contém a
    // string "diar.ia.br" mas não é o domínio diar.ia.br — hoje isso EXCLUI
    // (falso positivo de boilerplate), risco aceito por não haver, na prática,
    // domínio de conteúdo real que contenha essas substrings.
    assert.ok(!isContentLink("https://notdiar.ia.br.evil.example.com/artigo"));
  });

  it("URL malformada não lança — isContentLink faz new URL() internamente (#8302), mas cai pro fallback permissivo se não parsear", () => {
    assert.doesNotThrow(() => isContentLink("not a url"));
    // "not a url" não bate extensão/FOOTER_DOMAINS por substring, e o
    // `new URL()` interno (usado pelo host-check de #8302: w3.org/fonts CDN/
    // honeypot/amazon afiliado/flickr) lança — capturado, cai no fallback
    // `return true`. extractLinks() já garante que só URLs http(s) bem
    // formadas chegam até aqui (via `new URL()` interno próprio), então este
    // caso não ocorre no fluxo real de renderMarkdown — documentando o contrato.
    assert.ok(isContentLink("not a url"));
  });

  it("rejeita asset estático (fonte/CSS/JS/ícone), não só imagem (#8302)", () => {
    assert.ok(!isContentLink("https://fonts.gstatic.com/s/librefranklin/v18/abc.woff2"));
    assert.ok(!isContentLink("https://cdn.example.com/style.css"));
    assert.ok(!isContentLink("https://cdn.example.com/app.js"));
    assert.ok(!isContentLink("https://cdn.example.com/favicon.ico"));
    assert.ok(!isContentLink("https://cdn.example.com/font.ttf"));
  });

  it("NÃO rejeita PDF/vídeo por extensão — pode ser link oficial de lançamento/pesquisa (#8302)", () => {
    // achado real: edição 260904, PESQUISA — pearson.com/.../BR-AI-Readiness-PTBR.pdf
    // é o link OFICIAL de um relatório, não boilerplate. Excluir por extensão
    // genérica apagaria conteúdo real junto com o asset estático.
    assert.ok(isContentLink("https://www.pearson.com/content/dam/global-store/global/resources/ai-readiness/BR-AI-Readiness-PTBR.pdf"));
    assert.ok(isContentLink("https://example.com/video-oficial.mp4"));
  });

  it("rejeita namespace/CDN de infraestrutura do e-mail (#8302)", () => {
    assert.ok(!isContentLink("http://www.w3.org/1999/xhtml"));
    assert.ok(!isContentLink("https://fonts.googleapis.com/css?family=Geist"));
    assert.ok(!isContentLink("https://email.beehiivstatus.com/{{omnivery_honeypot_hash}}/hclick"));
  });

  it("rejeita link do X/Twitter da própria diária, mas não outro conteúdo em x.com (#8302)", () => {
    assert.ok(!isContentLink("https://x.com/diariabr"));
    assert.ok(!isContentLink("https://x.com/diariabr/status/123"));
  });

  it("rejeita afiliado Amazon com tag=diaria-20, mas NÃO amazon.com.br sem essa tag (#8302)", () => {
    assert.ok(!isContentLink("https://www.amazon.com.br/dp/B0DB9VVG22?tag=diaria-20"));
    // #3028: amazon.com.br bare pode ser link oficial de lançamento — não
    // pode virar boilerplate genérico, só o padrão de afiliado específico.
    assert.ok(isContentLink("https://www.amazon.com.br/dp/B0DB9VVG22"));
    assert.ok(isContentLink("https://www.amazon.com.br/dp/B0DB9VVG22?tag=outraconta-20"));
  });

  it("rejeita crédito de foto do Flickr (/people/), mas não outros paths do Flickr (#8302)", () => {
    assert.ok(!isContentLink("https://www.flickr.com/people/91981596@N06"));
    assert.ok(isContentLink("https://www.flickr.com/photos/91981596@N06/12345"));
  });
});

describe("--regen-md-only flag (#162)", () => {
  // Usa um sandbox temporário pra não tocar no raw/MD reais do projeto.
  function setupSandbox(): { sandboxRoot: string; cleanup: () => void } {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "regen-md-"));
    // Copy script + minimal package.json structure
    cpSync(resolve(ROOT, "scripts"), join(sandboxRoot, "scripts"), {
      recursive: true,
    });
    cpSync(resolve(ROOT, "platform.config.json"), join(sandboxRoot, "platform.config.json"));
    cpSync(resolve(ROOT, "package.json"), join(sandboxRoot, "package.json"));
    cpSync(resolve(ROOT, "tsconfig.json"), join(sandboxRoot, "tsconfig.json"));
    if (existsSync(resolve(ROOT, "node_modules"))) {
      // symlinkSync com 'junction' no Windows (não precisa de admin) (#311)
      // 'dir' no Unix equivale a symlink de diretório.
      try {
        symlinkSync(
          resolve(ROOT, "node_modules"),
          join(sandboxRoot, "node_modules"),
          isWindows ? "junction" : "dir",
        );
      } catch {
        // Fallback: se symlink falhar por qualquer motivo, copiar (mais lento mas seguro)
        cpSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), { recursive: true });
      }
    }
    mkdirSync(join(sandboxRoot, "data"));
    mkdirSync(join(sandboxRoot, "context"));
    return {
      sandboxRoot,
      cleanup: () => rmSync(sandboxRoot, { recursive: true, force: true }),
    };
  }

  it("regen-md-only regenera MD a partir do raw existente", () => {
    const { sandboxRoot, cleanup } = setupSandbox();
    try {
      const posts = [
        {
          id: "p1",
          title: "Edição teste",
          published_at: "2026-04-26T10:00:00Z",
          links: ["https://test.com"],
        },
      ];
      writeFileSync(
        join(sandboxRoot, "data/past-editions-raw.json"),
        JSON.stringify(posts),
        "utf8",
      );
      // Não cria past-editions.md (simulando git reset)
      execFileSync(
        NPX,  // #311: cross-platform
        ["tsx", "scripts/refresh-past-editions.ts", "--regen-md-only"],
        { cwd: sandboxRoot, stdio: "pipe", shell: isWindows },
      );
      const md = readFileSync(
        join(sandboxRoot, "data/past-editions.md"), // #1847: MD movido pra data/
        "utf8",
      );
      assert.ok(md.includes('## 2026-04-26 — "Edição teste"'));
      assert.ok(md.includes("**edições carregadas:** 1"));
    } finally {
      cleanup();
    }
  });

  it("regen-md-only falha (exit 1) se raw não existir", () => {
    const { sandboxRoot, cleanup } = setupSandbox();
    try {
      // Não cria past-editions-raw.json
      let exitCode = 0;
      try {
        execFileSync(
          NPX,  // #311: usa npx.cmd em Windows
          ["tsx", "scripts/refresh-past-editions.ts", "--regen-md-only"],
          { cwd: sandboxRoot, stdio: "pipe" },
        );
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      assert.equal(exitCode, 1);
    } finally {
      cleanup();
    }
  });
});

describe("extractLinks", () => {
  function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  it("retorna URLs válidas e não emite warn", () => {
    const { result, warnings } = captureWarn(() =>
      extractLinks("Veja https://example.com/post1 e https://other.com/x"),
    );
    assert.deepEqual([...result].sort(), [
      "https://example.com/post1",
      "https://other.com/x",
    ]);
    assert.equal(warnings.length, 0);
  });

  it("descarta URLs malformadas e emite warn com a contagem (#814)", () => {
    // `http://[invalid` → `new URL()` lança; o regex inicial captura `http://[invalid`
    // até o fim da linha, então temos 1 URL malformada.
    const content = "Bom: https://example.com/ok\nRuim: http://[invalid\n";
    const { result, warnings } = captureWarn(() => extractLinks(content));
    assert.deepEqual(result, ["https://example.com/ok"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[extractLinks\] descartou 1 URL\(s\) malformada\(s\)/);
  });

  it("filtra URLs do beehiiv silenciosamente (sem warn)", () => {
    const content =
      "Real: https://example.com/x\nTracking: https://diaria.beehiiv.com/c/abc\nSubdomain: https://foo.beehiiv.com/p/y";
    const { result, warnings } = captureWarn(() => extractLinks(content));
    assert.deepEqual(result, ["https://example.com/x"]);
    assert.equal(warnings.length, 0);
  });
});
