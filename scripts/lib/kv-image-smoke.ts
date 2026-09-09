/**
 * scripts/lib/kv-image-smoke.ts (#7663)
 *
 * Lógica pura (sem I/O) do smoke test que distingue *"esta imagem específica
 * não existe"* de *"o binding KV `POLL` está morto"* em `workers/site` —
 * ver `scripts/lib/shared/kv-image.ts` pro que o binding serve e #7657 pro
 * incidente que motivou `/img/{key}` existir nesse Worker.
 *
 * ## Por que isso não é coberto por `test/site-img-same-origin-7657.test.ts`
 *
 * Aquele teste confere ESTATICAMENTE que o `id` do KV bate entre
 * `workers/site/wrangler.toml` e `workers/poll/wrangler.toml` — pega typo
 * no arquivo-fonte. Não pega deploy parcial, drift entre preview/produção,
 * nem o namespace ser renomeado do lado da Cloudflare: nesses casos o `id`
 * declarado continua correto, mas `env.POLL.get(key)` devolve `null` pra
 * TODA key — indistinguível, do lado do Worker, de "esta capa não existe".
 * A resposta observável é um 404 com CORS, aparentemente saudável.
 *
 * ## A key estável usada pela verificação em runtime
 *
 * `KV_IMAGE_SMOKE_KEY` é uma key de CONVENÇÃO FIXA (`img-{AAMMDD}-01-eia-
 * {A|B}.jpg`, `noCacheBust: true` — ver `scripts/upload-images-public.ts`),
 * de uma edição já publicada há meses. Duas propriedades que a tornam
 * segura como âncora de smoke test:
 *
 *   1. Nenhum script deste repo DELETA keys `img-*` do KV — grep por
 *      `.delete(` em `scripts/*.ts`/`scripts/lib/**\/*.ts` não encontra
 *      nenhum caminho que toque uma key desse namespace (a única coisa que
 *      pode acontecer com ela é ser SOBRESCRITA por uma correção pós-envio
 *      da MESMA edição, o que nunca aconteceria numa edição de meses atrás,
 *      já fechada).
 *   2. Verificado AO VIVO em 09/09/2026 (leitura, `GET` público, sem
 *      efeito) que a key responde 200 `image/jpeg` via
 *      `https://diar.ia.br/img/{key}` — não é um valor assumido, é medido.
 *
 * Trade-off aceito: se ALGUÉM um dia purgar manualmente essa key específica
 * do KV (nenhum script faz isso hoje), o smoke test passaria a reportar
 * `binding-morto` por engano. Esse risco é preferível ao inverso — usar uma
 * key content-addressed da edição do dia, que muda toda edição e exigiria
 * manter este arquivo sincronizado com o pipeline diário só pra não virar
 * falso alarme constante.
 */

/** Key de convenção fixa (#1704, `noCacheBust: true`) de uma edição de
 * meses atrás — nunca deletada, nunca regenerada. Ver docstring do módulo
 * pra prova de que ela existe hoje. */
export const KV_IMAGE_SMOKE_KEY = "img-260601-01-eia-A.jpg";

/** Host que serve `/img/{key}` a partir do MESMO namespace KV que
 * `eia.diar.ia.br` (workers/poll) — é o apex, `workers/site`, que o #7657
 * passou a servir também, mesma origem do documento (motivo do #7657). */
export const KV_IMAGE_SMOKE_URL = `https://diar.ia.br/img/${KV_IMAGE_SMOKE_KEY}`;

/** Os 3 estados exigidos pela issue (#7663) — rede indisponível/DNS/5xx
 * NUNCA vira `binding-morto` (falso alarme) nem `ok` (o defeito que a
 * issue descreve ficaria mascarado). */
export type KvImageBindingStatus = "ok" | "binding-morto" | "cannot-verify";

export interface KvImageSmokeResult {
  status: KvImageBindingStatus;
  /** Frase curta, pronta pra log/e-mail — nunca contém segredo. */
  detail: string;
}

/**
 * Descrição mínima de uma resposta HTTP — desacoplada de `Response` do
 * Fetch API pra a função de classificação continuar pura/testável sem
 * mockar um objeto `Response` inteiro.
 */
export interface KvImageSmokeHttpOutcome {
  status: number;
  contentType: string | null;
}

/**
 * Classifica o RESULTADO de uma tentativa de rede já concluída (sucesso OU
 * falha) — pura, sem `fetch` aqui dentro. `runKvImageSmokeCheck` (abaixo) é
 * quem faz a chamada real e entrega o resultado normalizado pra esta
 * função decidir.
 *
 * Contrato exigido pela issue #7663:
 *   - 200 + `Content-Type: image/jpeg` → `ok`
 *   - 404 (key ausente — só pode ser a nossa key estável, então "ausente"
 *     aqui SÓ significa binding morto ou key removida, nunca "esta imagem
 *     não existe") → `binding-morto`
 *   - qualquer coisa que não permita concluir com confiança (erro de rede
 *     — `outcome.error` —, 5xx do lado do Cloudflare, ou um status/content-
 *     type inesperado que também não é o 404 que indicaria falha real) →
 *     `cannot-verify`
 */
export function classifyKvImageSmokeOutcome(
  outcome: { ok: true; response: KvImageSmokeHttpOutcome } | { ok: false; error: unknown },
): KvImageSmokeResult {
  if (!outcome.ok) {
    return {
      status: "cannot-verify",
      detail: `erro de rede ao verificar o binding KV: ${describeError(outcome.error)}`,
    };
  }

  const { status, contentType } = outcome.response;

  if (status === 200) {
    if (contentType != null && contentType.startsWith("image/jpeg")) {
      return { status: "ok", detail: `200 ${contentType} — binding KV vivo` };
    }
    // 200 mas não é a imagem esperada — não é o 404 que indicaria binding
    // morto, mas também não é a confirmação positiva esperada. Indeterminado.
    return {
      status: "cannot-verify",
      detail: `200 com Content-Type inesperado (${contentType ?? "ausente"}) — resposta não reconhecida`,
    };
  }

  if (status === 404) {
    return {
      status: "binding-morto",
      detail:
        `404 em /img/${KV_IMAGE_SMOKE_KEY} — key de convenção fixa e nunca deletada; ` +
        "404 aqui só é explicável por binding KV morto (deploy parcial, drift preview/produção, " +
        "namespace renomeado do lado da Cloudflare) ou pela key ter sido removida manualmente do KV",
    };
  }

  if (status >= 500) {
    return { status: "cannot-verify", detail: `${status} do lado do Cloudflare — indeterminado, não é o Worker` };
  }

  return { status: "cannot-verify", detail: `status HTTP inesperado (${status}) — resposta não reconhecida` };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Timeout default da checagem — mesma ordem de grandeza de
 * `home-meta-check.ts` (`FETCH_TIMEOUT_MS = 15_000`). Nunca deixa o smoke
 * test pendurado indefinidamente em rede degradada. */
export const KV_IMAGE_SMOKE_FETCH_TIMEOUT_MS = 15_000;

/** User-Agent explícito — sem ele a Cloudflare devolve challenge (achado
 * conhecido do projeto, ver memory `curl-sem-user-agent-recebe-challenge-
 * cloudflare`). */
export const KV_IMAGE_SMOKE_USER_AGENT = "diaria-studio-kv-image-smoke/1 (+https://diar.ia.br)";

/** Assinatura mínima de `fetch` que este módulo consome — injetável em
 * teste, sem depender do lib.dom global. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

/**
 * Executa o `GET` real (via `fetchImpl` injetado) contra
 * `KV_IMAGE_SMOKE_URL` e devolve o resultado já classificado. Nunca lança —
 * qualquer exceção (rede, timeout, DNS) vira `cannot-verify` via
 * `classifyKvImageSmokeOutcome`.
 */
export async function runKvImageSmokeCheck(
  fetchImpl: FetchLike,
  url: string = KV_IMAGE_SMOKE_URL,
  timeoutMs: number = KV_IMAGE_SMOKE_FETCH_TIMEOUT_MS,
): Promise<KvImageSmokeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout após ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": KV_IMAGE_SMOKE_USER_AGENT },
      signal: controller.signal,
    });
    return classifyKvImageSmokeOutcome({
      ok: true,
      response: { status: res.status, contentType: res.headers.get("content-type") },
    });
  } catch (error) {
    return classifyKvImageSmokeOutcome({ ok: false, error });
  } finally {
    clearTimeout(timer);
  }
}
