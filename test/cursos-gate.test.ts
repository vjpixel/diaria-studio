/**
 * cursos-gate.test.ts (#4052)
 *
 * Cobre `workers/cursos/src/index.ts` fim-a-fim (fetch handler completo) +
 * `gate.ts` + `cookie.ts` + `subscribe.ts`: os dois caminhos de entrada
 * (?email= da newsletter e cookie de sessão), a tela de gate, verificação,
 * cadastro inline, e rate-limit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/cursos/src/index.ts";
import { subscriberKvKey } from "../scripts/lib/shared/subscriber-verify.ts";
import { issueSessionCookie } from "../workers/cursos/src/cookie.ts";
import { CURSOS_FULL_HTML } from "../workers/cursos/src/courses-full.generated.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  } as unknown as KVNamespace;
}

const TEASER_HTML = "<html><body>teaser fallback</body></html>";
function makeAssets(): Fetcher {
  return {
    fetch: async () => new Response(TEASER_HTML, { headers: { "Content-Type": "text/html" } }),
  } as unknown as Fetcher;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: makeAssets(),
    CURSOS_SUBSCRIBERS: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

describe("workers/cursos GET / (#4052)", () => {
  it("sem ?email= e sem cookie → serve o teaser (ASSETS.fetch)", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/"), env);
    assert.equal(await res.text(), TEASER_HTML);
  });

  it("?email= de assinante ativo → serve o HTML completo E seta cookie", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  // #4320: sem esta linha, o alarme de erro do worker (scripts/cursos-error-alarm.ts)
  // não tinha denominador pra calcular a taxa de "?email= não confirmado" — só
  // o numerador (o branch de falha logo abaixo já logava). Mesmo cuidado de
  // redação dos `console.warn` de falha: NUNCA interpolar o e-mail no log.
  it("?email= de assinante ativo → loga a confirmação (console.log), SEM vazar o e-mail (#4320)", async () => {
    const email = "assinante-log@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await worker.fetch(
        new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
        env,
      );
    } finally {
      console.log = originalLog;
    }

    assert.equal(lines.length, 1, `esperava exatamente 1 console.log, obteve ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /\?email= confirmado como assinante ativo/);
    assert.doesNotMatch(lines[0], new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("?email= de e-mail NÃO assinante → cai pro teaser, sem vazar o sinal negativo", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/?email=ninguem@example.com"),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
  });

  it("cookie de sessão válido → serve o HTML completo sem precisar de ?email=", async () => {
    const cookieValue = await issueSessionCookie("cookie-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
  });

  it("cookie inválido (secret errado) → cai pro teaser", async () => {
    const cookieValue = await issueSessionCookie("outro-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
  });
});

describe("workers/cursos GET /gate (#4052)", () => {
  it("responde HTML com o form de gate", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate"), env);
    const body = await res.text();
    assert.match(body, /gate-form/);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
  });
});

describe("workers/cursos POST /gate/verify (#4052)", () => {
  it("assinante ativo → ok:true + cookie", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("não-assinante → ok:false, error not_active, SEM cookie", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ninguem@example.com" }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.equal(getCookieHeader(res), null);
  });

  it("e-mail inválido → 400", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "não-é-email" }),
      }),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("honeypot preenchido → resposta fake-fail 200, sem revelar ao bot", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website: "http://spam.example.com" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, false);
  });

  it("rate-limit: 9ª tentativa do mesmo IP em 1h é bloqueada (limite 8)", async () => {
    const env = baseEnv();
    const mkReq = () =>
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
        body: JSON.stringify({ email: "x@example.com" }),
      });
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) last = await worker.fetch(mkReq(), env);
    assert.equal(last!.status, 429);
  });
});

describe("workers/cursos POST /gate/subscribe (#4052)", () => {
  function subReq(body: unknown) {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sem opt-in → 400 optin_required", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: false }), env);
    assert.equal(res.status, 400);
  });

  it("Beehiiv não configurado (secrets ausentes) → 503 subscribe_unavailable", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: true }), env);
    assert.equal(res.status, 503);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, "subscribe_unavailable");
  });

  it("sucesso (secrets configurados) → 200 + cookie de sessão", async () => {
    const env = baseEnv({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "novo@example.com", optin: true }), env);
      assert.equal(res.status, 200);
      assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("honeypot preenchido → 200 fake-success, nenhuma chamada à Beehiiv", async () => {
    const env = baseEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("não deveria ser chamado");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(
        subReq({ email: "x@example.com", optin: true, website: "http://spam.example.com" }),
        env,
      );
      assert.equal(res.status, 200);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("workers/cursos POST /gate/logout (#4052)", () => {
  it("limpa o cookie de sessão", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate/logout", { method: "POST" }), env);
    assert.match(getCookieHeader(res) ?? "", /Max-Age=0/);
  });
});

/**
 * #4305 — regressões do follow-up. Os casos abaixo só passaram a importar
 * quando `run_worker_first` fez o script de fato rodar em `/`: antes disso o
 * asset era servido sem `handleIndex` existir na prática, e nada aqui podia
 * ser observado em produção.
 */

/** Captura `console.error`/`console.warn` pra afirmar que uma degradação
 * deixou rastro. Necessário porque quase todo caminho de falha aqui responde
 * 200/teaser ou um 4xx/5xx genérico — sem o log, o único jeito de saber que
 * algo quebrou seria um leitor reclamando. `error` = quebrou; `warn` = caminho
 * de degradação esperado, cuja TAXA é o sinal (1% é normal, 100% é o gate
 * quebrado). */
function captureErrorLogs() {
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines: string[] = [];
  const warns: string[] = [];
  const fmt = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  console.error = (...args: unknown[]) => {
    lines.push(fmt(args));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(fmt(args));
  };
  return {
    lines,
    warns,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

describe("workers/cursos: gate no follow-up #4305", () => {
  it("/index.html é gateado igual a / — mesmo asset, mesmo tratamento", async () => {
    const email = "assinante@example.com";
    const cookie = await issueSessionCookie("cookie-secret", email);
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/index.html", {
        headers: { Cookie: cookie.split(";")[0] },
      }),
      env,
    );
    // Antes do #4305, `fetch` só casava `pathname === "/"`, então este request
    // caía no `env.ASSETS.fetch` do fim e devolvia o teaser cru mesmo com
    // cookie válido — `run_worker_first` prometia cobrir `/index.html` e o
    // roteamento não entregava.
    assert.equal(await res.text(), CURSOS_FULL_HTML);
  });

  it("/index.html?email= de assinante ativo também desbloqueia e seta cookie", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/index.html?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("KV lançando exceção degrada pro teaser, não derruba a home", async () => {
    // `run_worker_first` acoplou a home ao sucesso de `handleIndex`. Sem o
    // fail-soft, um throw do KV subiria pro `fetch` e a página inteira cairia
    // — pior que o bug original, que ao menos sempre mostrava o teaser.
    const explodingKV = {
      get: async () => {
        throw new Error("KV indisponível");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    const env = baseEnv({ CURSOS_SUBSCRIBERS: explodingKV });
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(new Request("https://cursos.diar.ia.br/?email=alguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TEASER_HTML);
    // O 200 silencioso some do gráfico de erro nativo do Cloudflare, que um
    // 500 daria de graça. O log é o ÚNICO sinal que sobra — se alguém apagar
    // o `console.error`, a degradação vira invisível e nada mais avisa.
    assert.equal(logs.lines.length, 1, "a degradação precisa deixar rastro");
    assert.match(logs.lines[0], /handleIndex falhou/);
    assert.match(logs.lines[0], /url=/, "sem contexto de request não dá pra distinguir 1 request de 100%");
    // 3º passe de review (fb030eda): o `catch` é genérico — qualquer exceção
    // não tratada no handler cai aqui, inclusive com `?email=` de assinante
    // real na URL. `request.url` cru vazaria PII pro log de plataforma; o
    // param precisa vir redigido.
    assert.ok(!logs.lines[0].includes("alguem@example.com"), "e-mail não pode vazar no log de exceção genérica");
    assert.match(
      logs.lines[0],
      /email=%5Bredacted%5D/,
      "o param redigido ainda precisa aparecer (url-encoded) pra sinalizar que havia email na URL",
    );
  });

  it("?email= não-ativo loga a taxa SEM o endereço — merge tag quebrada é indistinguível sem isso", async () => {
    // A resposta continua idêntica a "não mandou email nenhum" (anti-probing
    // do #4052 preservado); o log é servidor-side e invisível pro visitante.
    // Sem ele, uma merge tag quebrada produz este caminho em 100% dos cliques
    // da newsletter e some no meio do tráfego normal.
    const env = baseEnv();
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(new Request("https://cursos.diar.ia.br/?email=ninguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(await res.text(), TEASER_HTML, "resposta não pode mudar — anti-probing");
    assert.equal(logs.warns.length, 1);
    assert.match(logs.warns[0], /não confirmado como assinante ativo/);
    assert.ok(
      !logs.warns[0].includes("ninguem@example.com"),
      "endereço de assinante não pode ir parar em log de plataforma (PII a troco de nada)",
    );
  });

  it("?email= malformado loga como provável merge tag não resolvida", async () => {
    const env = baseEnv();
    const logs = captureErrorLogs();
    try {
      await worker.fetch(new Request("https://cursos.diar.ia.br/?email=%7B%7Bemail%7D%7D"), env);
    } finally {
      logs.restore();
    }
    assert.equal(logs.warns.length, 1);
    assert.match(logs.warns[0], /malformado/);
  });

  it("falha do cadastro na Beehiiv loga — 502 mudo derrubaria todo signup sem rastro", async () => {
    const env = baseEnv({ BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await handleGateSubscribe(
        new Request("https://cursos.diar.ia.br/gate/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "novo@example.com", optin: true }),
        }),
        env,
        { fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch },
      );
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 502);
    assert.ok(
      logs.lines.some((l) => /cadastro na Beehiiv falhou/.test(l)),
      "sem log, Beehiiv fora do ar mata todo cadastro do gate em silêncio",
    );
  });

  it("fetch pra Beehiiv lançando (rede caída) loga — ramo distinto de resposta HTTP não-ok", async () => {
    // 3º passe de review (fb030eda): o `catch` de `subscribeToBeehiiv` cobre o
    // `fetch` LANÇANDO (DNS/rede), não só devolvendo status não-ok — ramo
    // testado acima. Sem este teste, um `fetchImpl` que rejeita nunca exercita
    // o `console.error("[cursos] fetch pra Beehiiv lançou:", err)`.
    const env = baseEnv({ BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await handleGateSubscribe(
        new Request("https://cursos.diar.ia.br/gate/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "novo@example.com", optin: true }),
        }),
        env,
        {
          fetchImpl: (async () => {
            throw new Error("network down");
          }) as unknown as typeof fetch,
        },
      );
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 502);
    assert.ok(
      logs.lines.some((l) => /fetch pra Beehiiv lançou/.test(l)),
      "exceção de rede no fetch da Beehiiv precisa deixar rastro distinto de resposta não-ok",
    );
  });

  it("sem COOKIE_HMAC_SECRET, / loga — é o ramo que NÃO passa pelo catch", async () => {
    // Desvio de fluxo, não exceção: sem log próprio, um deploy sem o secret
    // serviria teaser pra assinante ativo vindo da newsletter com zero sinal
    // em qualquer camada — nem status HTTP, nem log.
    const env = baseEnv({ COOKIE_HMAC_SECRET: undefined as unknown as string });
    const logs = captureErrorLogs();
    try {
      await worker.fetch(new Request("https://cursos.diar.ia.br/?email=alguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(logs.lines.length, 1);
    assert.match(logs.lines[0], /COOKIE_HMAC_SECRET ausente/);
  });

  it("sem COOKIE_HMAC_SECRET, / serve o teaser (degradação explícita, não exceção)", async () => {
    // A primeira versão deste guard foi escrita com a justificativa errada
    // ("cookie assinado com chave vazia, forjável"). Não é o que acontece:
    // `TextEncoder().encode(undefined)` de fato não lança, mas o
    // `crypto.subtle.importKey` seguinte rejeita chave de tamanho zero com
    // `DataError` (spec da WebCrypto — verificado em Node). Sem o guard isto
    // QUEBRA, não vaza. O guard existe pra trocar a exceção por degradação
    // explícita e logada, não pra fechar um bypass.
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({
      CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }),
      COOKIE_HMAC_SECRET: undefined as unknown as string,
    });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
  });

  it("sem COOKIE_HMAC_SECRET, /gate/verify responde 503 em vez de estourar exceção", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({
      CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }),
      COOKIE_HMAC_SECRET: undefined as unknown as string,
    });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    assert.equal(res.status, 503);
    assert.equal(getCookieHeader(res), null);
  });

  it("sem COOKIE_HMAC_SECRET, /gate/subscribe recusa ANTES de criar assinante na Beehiiv", async () => {
    // Ordem importa: cadastrar e só depois falhar deixaria a pessoa dentro da
    // Beehiiv e fora da página, sem nada a fazer.
    let beehiivChamada = false;
    const env = baseEnv({
      COOKIE_HMAC_SECRET: undefined as unknown as string,
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
    });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const res = await handleGateSubscribe(
      new Request("https://cursos.diar.ia.br/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "novo@example.com", optin: true }),
      }),
      env,
      {
        fetchImpl: (async () => {
          beehiivChamada = true;
          return new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 });
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(res.status, 503);
    assert.equal(beehiivChamada, false, "não pode chamar a Beehiiv se o cadastro não vai poder entrar");
  });
});

/**
 * #4321 — `checkGateSubscriber` deixa de colapsar "verificado negativo" e
 * "não conseguimos verificar" no mesmo `not_active`. Critério de aceite
 * central: a resposta HTTP ao visitante É IDÊNTICA nos dois casos (anti-
 * probing do #4052 intacto) — só o log distingue. Os 2 call sites afetados:
 * `handleIndex` (caminho `?email=` da newsletter) e `/gate/verify`.
 */
describe("workers/cursos: checkGateSubscriber distingue verification_failed (#4321)", () => {
  /** KV sempre vazio (chave ausente) — força `checkGateSubscriber` a cair no
   * caminho secundário (Beehiiv `by_email`), que é o único que produz
   * `verification_failed`. */
  function beehiivEnv(): Env {
    return baseEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
  }

  const FAILURE_STATUSES = [401, 429, 503] as const;

  for (const status of FAILURE_STATUSES) {
    it(`/gate/verify: Beehiiv responde ${status} → resposta not_active IDÊNTICA ao negativo confirmado, mas loga diferente`, async () => {
      const env = beehiivEnv();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("err", { status })) as typeof fetch;
      const logs = captureErrorLogs();
      let res: Response;
      try {
        res = await worker.fetch(
          new Request("https://cursos.diar.ia.br/gate/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "talvez-assinante@example.com" }),
          }),
          env,
        );
      } finally {
        globalThis.fetch = originalFetch;
        logs.restore();
      }
      const data = (await res.json()) as { ok: boolean; error: string };
      // Resposta ao visitante: byte-idêntica ao caso "confirmed_negative"
      // (ver teste "não-assinante → ok:false, error not_active" acima) — o
      // status HTTP e o corpo NÃO podem entregar que houve uma falha de
      // verificação em vez de um negativo real.
      assert.equal(res.status, 200);
      assert.equal(data.ok, false);
      assert.equal(data.error, "not_active");
      assert.equal(getCookieHeader(res), null);
      // Log distingue: precisa mencionar a falha de verificação, não o texto
      // genérico de "não confirmado como assinante ativo".
      assert.ok(
        logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
        `esperava log de verification_failed pro status ${status}`,
      );
    });
  }

  it("/gate/verify: Beehiiv responde 404 (negativo confirmado) → não loga como verification_failed", async () => {
    const env = beehiivEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(
        new Request("https://cursos.diar.ia.br/gate/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ninguem@example.com" }),
        }),
        env,
      );
    } finally {
      globalThis.fetch = originalFetch;
      logs.restore();
    }
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.ok(
      !logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
      "404 é negativo confirmado — não deve logar como falha de verificação",
    );
  });

  it("handleIndex (?email=): Beehiiv responde 500 → cai pro teaser IDÊNTICO ao negativo confirmado, loga diferente (error, não warn)", async () => {
    const env = beehiivEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(
        new Request("https://cursos.diar.ia.br/?email=talvez-assinante@example.com"),
        env,
      );
    } finally {
      globalThis.fetch = originalFetch;
      logs.restore();
    }
    // Resposta idêntica ao caso "?email= de e-mail NÃO assinante" acima —
    // teaser, sem cookie, sem qualquer sinal do tipo de falha.
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
    assert.ok(
      logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
      "esperava log error de verification_failed",
    );
    assert.equal(logs.warns.length, 0, "não deve emitir o warn genérico de negativo confirmado neste ramo");
  });
});
