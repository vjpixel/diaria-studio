/**
 * scripts/lib/shared/kit-doi.ts (#7723 — extração; DOI em todos os workers)
 *
 * Maquinaria ÚNICA do double opt-in do Kit, consumida pelos TRÊS workers que
 * criam assinante (`poll`, `cursos`, `reativar`). Nasceu dentro do `poll`
 * (`doi-form-guard-7723.ts` + `optin-flag-6340.ts` + dois helpers privados de
 * `subscribe.ts`) e foi extraída quando o editor mandou ligar o DOI em todos
 * os lugares: três cópias da mesma regra é exatamente como um worker fica
 * para trás em silêncio — a classe de bug do próprio #7723.
 *
 * "Única" é literal, e custou uma segunda passada: a 1ª versão desta extração
 * moveu só a flag e o guard, deixando `resolveKitCreateState`/
 * `vincularKitDoiForm` DUPLICADOS (cópia local no `poll`, versão nova aqui) —
 * enquanto este mesmo docstring já afirmava unificação. O review pegou, e o
 * `poll` passou a consumir daqui de verdade. Se alguém for reintroduzir uma
 * cópia local em qualquer worker, é este parágrafo que explica por que não.
 *
 * O mecanismo, em uma frase: cria o assinante `state: "inactive"` e o VINCULA
 * a um designer form do Kit com "Send confirmation email" ligado — é o
 * vínculo que dispara o e-mail. Sem esse vínculo, `inactive` é uma prisão:
 * nada promove inactive→active sozinho.
 */

/**
 * Forms de SISTEMA do Kit (`format: null` em `GET /v4/forms`): não aparecem
 * em "Landing pages & forms", as URLs de edição dão 404, e **não têm o toggle
 * "Send confirmation email"**. O vínculo responde `201` normalmente mesmo
 * assim — nada falha, nada é enviado.
 *
 * Foi o estado real de 26/08 a 09/09/2026: `KIT_DOI_FORM_ID` apontava para
 * `9839463` ("Newsletter site") e nenhum e-mail de confirmação saiu, sem
 * erro, sem log, sem ninguém notar.
 *
 * Allowlist estática de propósito, em vez de consultar `GET /v4/forms/{id}`:
 * esta decisão roda no caminho quente do cadastro e é síncrona — uma chamada
 * de rede aqui acrescentaria um modo de falha novo ("API fora → decidir o
 * quê?"). Os ids de sistema são poucos, conhecidos e estáveis, e a lista mora
 * versionada, não em env: o ponto é justamente impedir que config errada passe.
 */
export const KIT_SYSTEM_FORM_IDS: readonly string[] = ["9839463", "9870650"];

export type DoiFormVerdict =
  | { ok: true; formId: string }
  | { ok: false; reason: "ausente" }
  | { ok: false; reason: "form-de-sistema"; formId: string };

/** Decide se `KIT_DOI_FORM_ID` aponta para um form que de fato envia confirmação. */
export function verificarDoiForm(formId: string | undefined): DoiFormVerdict {
  const id = (formId ?? "").trim();
  if (id === "") return { ok: false, reason: "ausente" };
  if (KIT_SYSTEM_FORM_IDS.includes(id)) return { ok: false, reason: "form-de-sistema", formId: id };
  return { ok: true, formId: id };
}

/**
 * Mensagem de log para veredito inválido — `null` quando não há o que logar.
 *
 * Ausência de id é caminho DOCUMENTADO (worker fora do rollout), não anomalia:
 * não loga. Form de sistema é config errada que já custou duas semanas de
 * silêncio: loga alto, nomeando o id, o problema, o que foi feito no lugar e
 * onde está o procedimento. Foi a falta de sinal que escondeu o #7723.
 */
export function mensagemDoiFormInvalido(v: DoiFormVerdict): string | null {
  if (v.ok || v.reason === "ausente") return null;
  return (
    `[kit-doi] KIT_DOI_FORM_ID="${v.formId}" é um form de SISTEMA do Kit — não tem o toggle ` +
    `"Send confirmation email" e NUNCA envia confirmação (o vínculo responde 201 mesmo assim). ` +
    `Cadastro criado como "active" em vez de "inactive", de propósito: "inactive" sem caminho de ` +
    `confirmação prende o assinante para sempre (#6565). Procedimento para corrigir: ` +
    `docs/kit-doi-confirmation-copy.md.`
  );
}

/**
 * Rollout do double opt-in, worker a worker (#6340, padrão #6048).
 *
 * `poll` entrou em 26/08/2026 e passou a funcionar de verdade em 09/09/2026
 * (#7723 — até então apontava para form de sistema). `cursos` e `reativar`
 * entraram em 09/09/2026, por instrução direta do editor ("habilita DOI em
 * todos os lugares").
 *
 * Base existente (assinantes já `active`) fica FORA por desenho: eles já
 * consentiram, e reconfirmar retroativamente derrubaria gente que nunca
 * pediu para sair.
 */
/**
 * Os workers que criam assinante no Kit. Conjunto FECHADO e conhecido em
 * tempo de compilação — por isso vale a pena derivar o tipo dele.
 *
 * A 1ª versão desta extração tipava `worker: string`, porque `.includes()`
 * reclamava do union literal. Isso resolvia o erro pelo lado errado: alargar
 * o array em vez de estreitar o parâmetro. O custo era um typo
 * (`resolveKitCreateState(id, "cursoss")`) compilar e o assinante nascer sem
 * DOI, **em silêncio** — a mesma classe de bug que o #7723 existe para
 * fechar, reintroduzida pela própria correção. Achado do review desta PR.
 */
export const KIT_DOI_WORKERS = ["poll", "cursos", "reativar"] as const;
export type KitDoiWorker = (typeof KIT_DOI_WORKERS)[number];

/** Estado com que o assinante é criado no Kit. Nomeado para não se dissolver
 * em `string` ao atravessar a fronteira dos workers. */
export type KitCreateState = "active" | "inactive";

export const DOUBLE_OPT_IN_FLAG: {
  enabledForWorkers: readonly KitDoiWorker[];
  createState: "inactive";
  confirmationSource: string;
  brevoPendingSegment: boolean;
  scopeExcludesLegacyBase: boolean;
} = {
  enabledForWorkers: KIT_DOI_WORKERS,
  createState: "inactive",
  confirmationSource: "kit-form",
  brevoPendingSegment: true,
  scopeExcludesLegacyBase: true,
};

/**
 * Estado com que o assinante nasce neste worker.
 *
 * `"active"` (sem DOI) em dois casos, os dois deliberados: worker fora do
 * rollout, ou form de confirmação inutilizável. O segundo é o guard do #7723 —
 * criar `inactive` sem caminho de confirmação é pior que não ter DOI.
 */
export function resolveKitCreateState(
  formId: string | undefined,
  worker: KitDoiWorker,
  log: (msg: string) => void = console.error,
): KitCreateState {
  const veredito = verificarDoiForm(formId);
  if (!veredito.ok) {
    const aviso = mensagemDoiFormInvalido(veredito);
    if (aviso) log(`${aviso} (worker: ${worker})`);
    return "active";
  }
  return DOUBLE_OPT_IN_FLAG.enabledForWorkers.includes(worker)
    ? DOUBLE_OPT_IN_FLAG.createState
    : "active";
}

/**
 * Extrai o `subscriber.id` da resposta de criação, distinguindo as TRÊS causas
 * de "não deu" — que antes colapsavam num `undefined` só (achado do review).
 *
 * Importa porque este é o ramo que deixa alguém `inactive` sem vínculo, ou
 * seja, preso: sem saber se o JSON não parseou, se o campo faltou, ou se veio
 * com o tipo errado, investigar depois é adivinhação.
 */
export type SubscriberIdExtraction =
  | { ok: true; id: number }
  | { ok: false; motivo: "parse-falhou"; detalhe: string }
  | { ok: false; motivo: "campo-ausente" }
  | { ok: false; motivo: "tipo-inesperado"; bruto: string };

export async function extrairSubscriberId(res: Response): Promise<SubscriberIdExtraction> {
  let corpo: unknown;
  try {
    corpo = await res.clone().json();
  } catch (err) {
    return { ok: false, motivo: "parse-falhou", detalhe: String(err) };
  }
  const bruto = (corpo as { subscriber?: { id?: unknown } } | null | undefined)?.subscriber?.id;
  if (bruto === undefined || bruto === null) return { ok: false, motivo: "campo-ausente" };
  if (typeof bruto !== "number") return { ok: false, motivo: "tipo-inesperado", bruto: String(bruto) };
  return { ok: true, id: bruto };
}

/** Mensagem do fracasso de extração, já com o e-mail — sem ele, o log nomeia
 * um problema que ninguém consegue localizar depois. */
export function mensagemSubscriberIdAusente(
  e: Extract<SubscriberIdExtraction, { ok: false }>,
  email: string,
  status: number,
): string {
  const causa =
    e.motivo === "parse-falhou" ? `resposta não parseou como JSON (${e.detalhe})`
    : e.motivo === "tipo-inesperado" ? `subscriber.id veio como ${JSON.stringify(e.bruto)}, não number`
    : "resposta 2xx sem subscriber.id";
  return (
    `[kit-doi] ${causa} — status ${status}, e-mail ${email}. NÃO foi possível vincular ao form DOI: ` +
    `o e-mail de confirmação não saiu e o assinante fica "inactive" até alguém vincular à mão.`
  );
}

export interface VincularDoiFormOpts {
  apiKey: string;
  base: string;
  formId?: string;
  subscriberId: number;
  /** URL de origem gravada no Kit como referrer do vínculo. */
  referrer: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Vincula o assinante ao designer form — É ISTO que dispara o e-mail de
 * confirmação.
 *
 * Best-effort de propósito: NUNCA lança nem falha a assinatura. Um cadastro
 * que deu certo não pode ser desfeito porque o e-mail de confirmação não
 * saiu; o assinante fica `inactive` e o log acusa. Falhar aqui e reverter lá
 * seria trocar um problema recuperável por um irrecuperável.
 */
export async function vincularKitDoiForm(opts: VincularDoiFormOpts): Promise<void> {
  const { apiKey, base, formId, subscriberId, referrer } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? console.error;
  if (!formId) return;
  try {
    const res = await fetchImpl(`${base}/forms/${formId}/subscribers/${subscriberId}`, {
      method: "POST",
      headers: { "X-Kit-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ referrer }),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "<unreadable>");
      log(
        `[vincularKitDoiForm] Kit respondeu ${res.status} ao vincular subscriber ${subscriberId} ` +
        `ao form ${formId}: ${bodyText.slice(0, 500)}`,
      );
    }
  } catch (err) {
    log(`[vincularKitDoiForm] fetch exception: ${String(err)}`);
  }
}
