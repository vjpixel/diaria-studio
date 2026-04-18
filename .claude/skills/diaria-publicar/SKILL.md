Dispara os Stages 6 e 7 da edição Diar.ia: cria a newsletter no Beehiiv como rascunho + envia email de teste, e publica os 6 posts sociais (LinkedIn × 3 + Facebook × 3) como rascunho ou agendados.

## Uso

- `/diaria-publicar all YYYY-MM-DD` — roda Stage 6 e Stage 7 em sequência
- `/diaria-publicar newsletter YYYY-MM-DD` — só Stage 6 (Beehiiv)
- `/diaria-publicar social YYYY-MM-DD` — só Stage 7 (LinkedIn + Facebook)

Se não passar data, usa a data de hoje.

## Pré-requisitos

- Edição com Stages 1–5 completos em `data/editions/{YYMMDD}/`:
  - `02-reviewed.md`, `03-{linkedin,facebook}-d{1,2,3}.md`, `04-eai.md` + `04-eai.jpg`, `05-d{1,2,3}.jpg`
- Chrome com extensão **Claude in Chrome** ativa (ver `docs/browser-publish-setup.md`)
- Logado em Beehiiv, LinkedIn e Facebook (Meta Business Suite) no Chrome
- Bloco `publishing` em `platform.config.json` configurado:
  - `newsletter.template` (ex: `"Default"`)
  - `newsletter.test_email`
  - `social.fallback_schedule.{linkedin,facebook}.{d1_time,d2_time,d3_time,day_offset}`

## O que faz

### Stage 6 — `publish-newsletter`

1. Abre Beehiiv no Chrome.
2. Cria novo post usando o template configurado (default: `"Default"`).
3. Preenche título, subtítulo, corpo (com imagens dos destaques + bloco "É AI?"), cover.
4. **Salva como rascunho** (não agenda, não publica).
5. Envia **email de teste** para o endereço em `publishing.newsletter.test_email`.
6. Grava `06-published.json` com `draft_url` e `test_email_sent_at`.
7. **Gate humano**: mostrar URL do rascunho + confirmação de envio do teste. Editor revisa o email e publica manualmente do dashboard Beehiiv.

### Stage 7 — `publish-social`

1. Itera por LinkedIn × (d1, d2, d3) + Facebook × (d1, d2, d3).
2. Para cada post:
   - **Tenta salvar como rascunho** primeiro.
   - Se a UI não suportar rascunho, **agenda** no horário configurado em `fallback_schedule`.
3. Append imediato em `07-social-published.json` após cada post (resume-aware: re-rodar pula posts já publicados).
4. **Gate humano**: mostrar 6 URLs + status (rascunho ou agendado) + horários.

## Output

- `data/editions/{YYMMDD}/06-published.json` — `draft_url`, `test_email_sent_at`, `template_used`
- `data/editions/{YYMMDD}/07-social-published.json` — array de 6 posts com `platform`, `destaque`, `url`, `status`, `scheduled_at`

## Notas

- **Nada é publicado automaticamente.** Newsletter sempre vira rascunho + teste; social vira rascunho ou agendado. O editor sempre revisa e dispara manualmente do dashboard de cada plataforma.
- **Resume-aware**: se Stage 7 for interrompido após 3 posts, re-rodar `/diaria-publicar social` pula os 3 já publicados e termina os outros 3.
- Se o login de uma plataforma expirar, o post correspondente fica com `status: "failed"` e os outros prosseguem — re-logar e re-rodar pega os que faltam.
- Para rodar como parte do pipeline completo, use `/diaria-edicao` — ele chama estes stages automaticamente após Stage 5.
