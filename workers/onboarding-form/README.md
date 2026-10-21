# onboarding-form (#10605): ainda sem KV nem rota pública

Formulário de perfil/interesses do onboarding (decisão do editor, 20/10/2026:
form próprio num Worker nosso). O executor `scripts/onboarding-followup-run.ts`
lê as respostas daqui (`GET /api/respostas`) e marca "preencheu" no store
(`data/onboarding/store.json` → `followup.people[id].form_filled_at`), o que
para os lembretes na hora. `scripts/audience-run.ts` lê o mesmo endpoint e soma
as respostas ao perfil de audiência (`context/audience-profile.md`).

Contrato e perguntas: `scripts/lib/onboarding-form-contract.ts`
(`FORM_QUESTIONS`, rascunho aguardando aprovação do editor). HTML:
`src/render.ts` (mobile primeiro, sem dependência de runtime de Worker).

## Falta para publicar

1. Editor aprovar as perguntas (`FORM_QUESTIONS`) e os 2 textos de e-mail
   (rascunhos em `context/templates/onboarding-followup/`, copiados para
   `data/snippets/` por `onboarding-followup-run.ts --init-snippets`).
2. KV `ONBOARDING_FORM` + secrets `RESPONSES_TOKEN` e
   `ONBOARDING_FORM_LINK_SECRET` (ver `wrangler.toml`).
3. Rota pública (o workflow de deploy já existe: `.github/workflows/deploy-onboarding-form.yml`).
4. `onboarding.followup.form_url` / `form_responses_url` no `platform.config.json`
   e `ONBOARDING_FORM_TOKEN` no `.env` do servidor.

5. Link assinado por pessoa (#10657): o mesmo `ONBOARDING_FORM_LINK_SECRET`
   no `.env`/Doppler do executor, e o custom field `form_sig` criado no Kit
   (o executor grava nele a assinatura de cada pessoa antes do lote, e o
   link usa `{{ subscriber.form_sig }}`).

Enquanto isso, o envio dos e-mails do formulário fica travado
(`formContentGate` → `form_nao_configurado` / `texto_pendente` /
`assinatura_nao_configurada`; `campo_assinatura_ausente` se o Kit não guardar
o `form_sig`).

## Link assinado (#10657)

O link do e-mail é `{form_url}?email={{ subscriber.email_address | url_encode }}&sig={{ subscriber.form_sig }}`,
com `sig = base64url(HMAC-SHA256(ONBOARDING_FORM_LINK_SECRET, "onboarding-form:v1:" + e-mail normalizado))`
(`scripts/lib/onboarding-form-link-sig.ts`). O Worker:

- `GET /` sem assinatura válida: página "Link inválido" (403), sem formulário;
- `POST /enviar`: e-mail e assinatura vêm de campos ocultos; assinatura que
  não bate com o e-mail enviado responde 403 e não grava nada no KV.

Assim ninguém marca outra pessoa como "preencheu" nem sobrescreve as
respostas dela.
