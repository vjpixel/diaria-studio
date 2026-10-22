# Publicar o app OAuth Google em "Produção" (causa-raiz da expiração de 7 dias)

> **Estado atual (#10785): feito.** O app OAuth do projeto GCP
> `gen-lang-client-0315370011` (client de `GOOGLE_CLIENT_ID`) foi publicado
> em produção em 22/10/2026, por decisão do editor. Tokens emitidos a partir
> daí não vencem em 7 dias. O aviso por idade do refresh token
> (`expiring_soon` em `checkTokenHealth`) saiu junto; o health-check segue
> alarmando o que continua valendo em produção: refresh falhando
> (`invalid_grant`, token revogado ou inválido). O resto desta página é o
> histórico do problema.

## Sintoma (#1973)

O token OAuth do Google (`data/.credentials.json`) **expira a cada ~7 dias**, derrubando de uma vez:

- `drive-sync.ts` (Stage 0/3/4) → `invalid_grant: Token has been expired or revoked`
- `inbox-drain.ts` (Stage 1) → submissões do editor para o inbox editorial **perdidas**
- `upload-images-public --mode social` (Stage 4) → imagens sociais sem Drive

## Causa raiz

Apps OAuth no Google Cloud Console em **"Publishing status: Testing"** têm refresh tokens que **expiram em 7 dias** (limite imposto pelo Google para apps não-verificados). Como o pipeline roda quase diário mas nem sempre dentro da janela de 7d, o refresh token caduca silenciosamente entre edições.

## Mitigações (em ordem de robustez)

### 1. Alerta proativo (já implementado — #1973)

- Stage 0 §0c roda `npx tsx scripts/check-google-token.ts` **antes** de qualquer passo que dependa de Drive/Gmail. Banner único e claro se o token estiver expirado ou revogado, em vez de 3 falhas espalhadas. (Até o #10785 também avisava pela idade do refresh token vs o limite de 7d.)
- `inbox-drain.ts` com `invalid_grant` emite warn LOUD: **submissões do editor podem ter sido perdidas** + ação (`oauth-setup.ts` → `/diaria-inbox`).
- `oauth-setup.ts` carimba `refresh_obtained_ms` (desde o #10785, só informativo).

Resolve o **impacto silencioso**, mas não a recorrência (ainda precisa re-auth a cada ~7d).

### 2. Publicar o app em "Produção" (resolve a causa raiz)

No [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):

1. **Publishing status → "Publish App"** (move de Testing → In production).
2. Como o app usa escopos sensíveis (`drive`, `gmail.readonly`/`labels`/`modify`), o Google pede **verificação** (App verification). Para uso **interno/pessoal** (o app só autentica a conta do próprio editor, não distribui), há dois caminhos:
   - **User type "Internal"** (se a conta for de um Google Workspace): refresh tokens não expiram em 7d, sem verificação. Requer Workspace.
   - **User type "External" + "In production"** sem passar pela verificação completa: o app fica funcional para os **test users** já adicionados, mas com o aviso "unverified app" no consent. Para uso pessoal isso é aceitável — refresh tokens deixam de expirar em 7d uma vez publicado (mesmo sem verificação completa, contanto que não exceda o limite de usuários).
3. Após publicar, rodar `npx tsx scripts/oauth-setup.ts` **uma vez** pra obter um refresh token novo (agora de longa duração).

> ⚠️ A conta usada é pessoal (`vjpixel@gmail.com` / inbox `diaria.editor@gmail.com`), não Workspace — então o caminho provável é **External + In production** com os test users mantidos. Confirmar no console se a opção "Publish App" está disponível sem forçar verificação completa (depende dos escopos).

### 3. Custo zero

Ambas as mitigações são gratuitas (não envolvem GCP billing). Publicar o app é a única forma de eliminar a re-autenticação recorrente.

## Verificação

```bash
npx tsx scripts/check-google-token.ts   # exit 0 = válido; banner se expirado/revogado
```

Relacionado: `scripts/google-auth.ts` (`checkTokenHealth`), `scripts/oauth-setup.ts`, `scripts/inbox-drain.ts` (`isAuthExpiredError`), #494.
