/**
 * workers/poll/src/doi-form-guard-7723.ts (#7723)
 *
 * A lógica MUDOU DE CASA em 09/09/2026, quando o editor mandou ligar o DOI em
 * todos os workers: mora em `scripts/lib/shared/kit-doi.ts`, compartilhada por
 * `poll`, `cursos` e `reativar`. Três cópias da mesma regra é exatamente como
 * um worker fica para trás em silêncio — a classe de bug desta própria issue.
 *
 * Este arquivo permanece como re-export para não quebrar os importadores
 * existentes (`subscribe.ts`, `test/doi-form-guard-7723.test.ts`).
 */
export {
  KIT_SYSTEM_FORM_IDS,
  verificarDoiForm,
  mensagemDoiFormInvalido,
  type DoiFormVerdict,
} from "../../../scripts/lib/shared/kit-doi.ts";
