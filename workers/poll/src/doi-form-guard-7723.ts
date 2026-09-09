/**
 * doi-form-guard-7723.ts (#7723)
 *
 * Guard puro: `KIT_DOI_FORM_ID` precisa apontar para um form que de fato
 * consiga enviar o e-mail de confirmação.
 *
 * ## O bug que isto fecha
 *
 * O double opt-in do #6340 depende de DUAS coisas: o subscriber nascer
 * `inactive` E o vínculo (`POST /v4/forms/{form}/subscribers/{id}`) apontar
 * para um form com "Send confirmation email" ligado. O #6565 já cobriu a
 * ausência de `KIT_DOI_FORM_ID`. Faltava o caso pior: o id **presente e
 * inútil**.
 *
 * `KIT_DOI_FORM_ID` valeu `9839463` ("Newsletter site") desde o #6340. Esse
 * é um form de **sistema** — `GET /v4/forms` devolve `format: null`, ele não
 * aparece em `Landing pages & forms`, e as URLs de edição
 * (`/forms/{id}/settings`, `/forms/designers/{id}/edit`) dão 404. Não existe
 * onde ligar o toggle. O vínculo respondia `201` normalmente e nenhum e-mail
 * saía.
 *
 * Medido em 09/09/2026: filtro `Status is Unconfirmed` no painel do Kit
 * devolvia **1** assinante contra 866 no total, e 25/25 dos cadastros mais
 * recentes entravam `active`. Um teste do trajeto real dos workers confirmou
 * a diferença: com o form de sistema, nenhum e-mail; com um designer form
 * (`format: "sticky bar"`), o e-mail de confirmação chegou no mesmo segundo
 * do vínculo.
 *
 * Sem este guard, reapontar `KIT_DOI_FORM_ID` de volta para um form de
 * sistema — por engano de config, ou por alguém "restaurando" o valor
 * antigo — reproduz o estado de silêncio: cadastro nasce `inactive`, nada
 * confirma, e a pessoa fica presa para sempre (nada no Kit promove
 * `inactive → active` sozinho).
 *
 * ## Por que uma allowlist explícita, e não um lookup na API
 *
 * `resolveKitCreateState` roda no caminho quente do cadastro e é síncrono.
 * Consultar `GET /v4/forms/{id}` ali acrescentaria uma chamada de rede antes
 * de decidir o `state`, com um modo de falha novo (API fora → decidir o quê?).
 * Os ids de sistema são poucos, conhecidos e estáveis; listá-los é mais
 * barato e não pode falhar. A lista mora aqui, versionada, e não numa var de
 * ambiente — o ponto é justamente impedir que config errada passe.
 */

/**
 * Forms de SISTEMA da conta Kit da diária — `format: null`, sem página de
 * edição, sem toggle de confirmação. Medidos via `GET /v4/forms` em
 * 09/09/2026.
 *
 * `9839463` "Newsletter site" — o valor que `KIT_DOI_FORM_ID` teve do #6340
 * até esta issue, e a causa do double opt-in nunca ter funcionado.
 * `9870650` "Creator Network" — gerado pelo Creator Network do Kit.
 */
export const KIT_SYSTEM_FORM_IDS: readonly string[] = ["9839463", "9870650"];

export type DoiFormVerdict =
  /** Sem `KIT_DOI_FORM_ID` — comportamento do #6565, cria `active`. */
  | { ok: false; reason: "ausente" }
  /** Id presente mas de form de sistema: nunca enviaria confirmação. */
  | { ok: false; reason: "form-de-sistema"; formId: string }
  /** Id presente e não é de sistema — o caminho de confirmação existe. */
  | { ok: true; formId: string };

/**
 * Decide se `KIT_DOI_FORM_ID` habilita o double opt-in.
 *
 * Puro e sem rede: recebe o valor cru da env e devolve o veredito. O caller
 * (`resolveKitCreateState`) traduz `ok: false` em `state: "active"` — nunca
 * criar `inactive` sem caminho de confirmação, que é a regra do #6565.
 */
export function verificarDoiForm(formId: string | undefined): DoiFormVerdict {
  const id = (formId ?? "").trim();
  if (id === "") return { ok: false, reason: "ausente" };
  if (KIT_SYSTEM_FORM_IDS.includes(id)) return { ok: false, reason: "form-de-sistema", formId: id };
  return { ok: true, formId: id };
}

/**
 * Mensagem de log para o veredito negativo. Só `form-de-sistema` produz
 * texto: "ausente" já é o caminho documentado do #6565 e não é anomalia.
 *
 * Loga alto de propósito — este é exatamente o estado que passou despercebido
 * de 26/08 a 09/09 porque nada reclamava.
 */
export function mensagemDoiFormInvalido(v: DoiFormVerdict): string | null {
  if (v.ok || v.reason !== "form-de-sistema") return null;
  return (
    `[doi-form-guard] #7723: KIT_DOI_FORM_ID=${v.formId} é um form de SISTEMA do Kit ` +
    `(sem "Send confirmation email"), então NENHUM e-mail de confirmação sairia. ` +
    `Criando subscriber como "active" em vez de prendê-lo em "inactive" para sempre. ` +
    `Aponte para um designer form com o toggle ligado — ver docs/kit-doi-confirmation-copy.md.`
  );
}
