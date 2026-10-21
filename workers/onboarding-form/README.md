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
2. KV `ONBOARDING_FORM` + secret `RESPONSES_TOKEN` (ver `wrangler.toml`).
3. Rota pública (o workflow de deploy já existe: `.github/workflows/deploy-onboarding-form.yml`).
4. `onboarding.followup.form_url` / `form_responses_url` no `platform.config.json`
   e `ONBOARDING_FORM_TOKEN` no `.env` do servidor.

Enquanto isso, o envio dos e-mails do formulário fica travado
(`formContentGate` → `form_nao_configurado` / `texto_pendente`).
