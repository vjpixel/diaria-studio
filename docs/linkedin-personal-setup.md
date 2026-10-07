# LinkedIn pessoal automatizado (#9568)

O 4º post diário (item USE MELHOR, `## um` de `03-social.md`) sai na página
diar.ia.br pelo Stage 5. No perfil **pessoal** do editor, o mesmo texto saía
por lembrete manual do Stage 6. Com este setup ele sai sozinho, no mesmo
horário da página. Sem o setup (ou com o token vencido), nada quebra: o Stage
6 volta a mostrar o lembrete manual.

Decisão do editor (07/10/2026): **app LinkedIn separado**. O app da página
(`77tIvy0623oq84`) está em análise da Community Management API, que a LinkedIn
exige como produto único do app. Não adicionar nada nele.

## 1. Criar o app (uma vez)

1. Em https://www.linkedin.com/developers/apps, **Create app**. Nome sugerido:
   `diar.ia.br pessoal`. Página associada: a da diar.ia.br (a LinkedIn exige
   uma página, mas o post sai no perfil de quem autoriza).
2. Aba **Products**, pedir os dois (ambos têm aprovação imediata):
   - **Share on LinkedIn** (escopo `w_member_social`, para publicar);
   - **Sign In with LinkedIn using OpenID Connect** (escopos `openid profile`,
     só para descobrir a URN da pessoa).
3. Aba **Auth**, em **Authorized redirect URLs for your app**, adicionar
   exatamente:

   ```
   http://localhost:8766/linkedin/callback
   ```

4. Ainda na aba **Auth**, copiar o **Client ID** e o **Primary Client Secret**
   e gravar no Doppler (é de lá que o `.env` das duas máquinas sai):

   ```
   doppler secrets set LINKEDIN_PERSONAL_CLIENT_ID
   doppler secrets set LINKEDIN_PERSONAL_CLIENT_SECRET
   npm run sync-env
   ```

## 2. Rodar o OAuth (agora e a cada ~60 dias)

Na máquina do editor (Neo), com o navegador logado na conta **pessoal**:

```
npx tsx scripts/linkedin-personal-oauth.ts
```

O script abre o navegador, recebe o código em `localhost:8766`, troca pelo
token, lê a URN da pessoa em `/v2/userinfo` e grava, sem imprimir nenhum
valor, no Doppler e no `.env` local:

| Variável | Conteúdo |
|---|---|
| `LINKEDIN_PERSONAL_ACCESS_TOKEN` | token `w_member_social` (60 dias, sem refresh token) |
| `LINKEDIN_PERSONAL_PERSON_URN` | `urn:li:person:{id}` |
| `LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT` | expiração em ISO, lida pelo alarme |

Depois, no `300`: `npm run sync-env`. Opcional: `LINKEDIN_PERSONAL_API_VERSION`
(YYYYMM); vazio usa a versão de dois meses atrás, que a LinkedIn sempre suporta.

## 3. Armar a task no `300` (uma vez, depois do merge)

Task `Diaria-LinkedIn-Personal` (registro em `scripts/lib/scheduled-tasks.ts`),
diária às 07:46 BRT, um minuto depois de `publishing.social.use_melhor_time`.
Armar como as outras (`scripts/setup-systemd-timers.ts`, ver
`docs/scheduled-tasks-registry.md`).

## Como funciona

1. **Stage 6, antes do gate:** `publish-linkedin-personal.ts --check` diz se o
   automático está disponível (token presente, URN válida, não expirado). Se
   não está, o lembrete manual aparece igual a antes.
2. **Stage 6, depois do `ok`:** `publish-linkedin-personal.ts --arm
   --edition-dir {dir}` grava `_internal/06-linkedin-personal.json` com o
   texto (o mesmo que `resolve-post-pixel.ts` devolve: `## um`, sem markdown,
   com a UTM do Use Melhor), a capa do carrossel quando o carimbo está em dia, e
   o `scheduled_at` real da entry `linkedin`/`um` da página. Só arma se o plano
   do 4º post está `ready` e se o token vale até o horário do post.
3. **Task das 07:46:** `--fire-due` publica toda intenção `armed` de hoje ou
   ontem (BRT) cujo horário já passou, com até 3h de atraso. Antes da chamada
   grava `posting`, e por isso um crash nunca vira post duplicado. Resultado
   (`published` + `post_url`, ou `failed`/`expired` + motivo) fica no mesmo
   arquivo e no run-log; falha sai com exit 1 (o alarme de units systemd
   falhas pega).
4. **Alarme:** `linkedin-personal-token-alarm.ts`, 2º passo da mesma task.
   Abre issue P2 a 14 dias do vencimento e sobe para P1 a 3 dias ou depois de
   expirado. Fecha sozinha quando o token novo chega ao `.env` do `300`.

## Limitações

- A Posts API não agenda: se a task não rodar (máquina fora), o post não sai.
  O status fica `armed` até passar o limite de 3h e então vira `expired`.
- Só o 4º post (`## um`) é automatizado. Edição antiga com `## post_pixel`
  segue manual.
- Se o editor postar à mão numa edição já armada, o automático também posta.
  Quem arma é o `ok` do Stage 6; o lembrete diz quando o post é automático.
