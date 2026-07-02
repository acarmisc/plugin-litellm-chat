# Handoff — LiteLLM Chat Plugin for Backstage

## What shipped

Two npm packages + wired into target Backstage on GKE:

| Package | Version | npm |
|---|---|---|
| `@acarmisc/backstage-plugin-litellm-backend` (govai) | 0.3.4 | New exports: `resolveUserId`, `toLiteLLMUserId`, `getOrProvisionUser`, `ProvisioningError` |
| `@acarmisc/backstage-plugin-litellm-chat` (frontend) | 0.3.0 | ChatGPT-style UI, SSE reader, thread localStorage |
| `@acarmisc/backstage-plugin-litellm-chat-backend` (backend) | 0.2.0 | SSE proxy, vector store listing, chat key mint/delete |

**Live at:** https://backstage.ces.abstractstaging.it/ai-chat

## Architecture

Thin client: Backstage = UI + streaming proxy + identity bridge. LiteLLM owns RAG.

```
Browser → /api/litellm-chat/chat/stream → LiteLLM /v1/chat/completions (+ vector_store_ids)
                                         → LiteLLM /v1/rag/query (fallback)
```

- SSE piped via `Readable.fromWeb` → `res.write`. No buffering.
- Identity: govai `resolveUserId` + `toLiteLLMUserId` from Backstage OIDC token.
- Keys: backend mints dedicated `sk-` key per chat via master key (`POST /chat/key`). Real key returned once, stored in thread localStorage. Deleted on thread delete (`DELETE /chat/key`).
- RAG: primary path `/v1/chat/completions` + `vector_store_ids` (works on LiteLLM v1.90.0). Fallback `/v1/rag/query` (needs `PG_VECTOR_API_BASE` env on LiteLLM pod — not set currently).

## Key decisions made during build

1. **RAG endpoint swap**: AGENTS.md specified `/v1/rag/query` primary. GKE testing revealed it 500s (`PG_VECTOR_API_BASE` not set on LiteLLM pod). Swapped: `/v1/chat/completions` + `vector_store_ids` primary, `/v1/rag/query` fallback. Ops fix: set `PG_VECTOR_API_BASE=http://litellm-pgvector:8000` on LiteLLM deployment to enable rag/query.

2. **Vector stores endpoint**: `/v1/vector_stores` is OpenAI passthrough (rejects master key). Changed to `/v1/vector_store/list` (LiteLLM-native). Response normalized: `vector_store_id`→`id`, `vector_store_name`→`name`.

3. **Chat key strategy**: AGENTS.md said "user picks existing key from dropdown". Reality: LiteLLM `listKeys` returns hashed/masked tokens — unusable for auth. Changed to: backend mints dedicated chat key via master key, returns real `sk-` once. User clicks "Generate chat key" in sidebar settings. Key auto-deleted on thread delete.

4. **SSE chunk shape**: LiteLLM emits OpenAI shape `{choices:[{delta:{content}}]}`. Frontend `normalizeChunk()` flattens to `{delta: string}`.

5. **UI library**: Evaluated `@assistant-ui/react` (10.9k stars, ChatGPT-like). Rejected — uses shadcn/Tailwind/Radix, clashes with Backstage's MUI theme. Kept MUI, restructured to ChatGPT-style layout.

6. **Domain**: Added `backstage.ces.abstractstaging.it` to ingress (was only `abssrv.it`). Switched `APP_BASE_URL`. Keycloak OIDC client `backstage` has wildcard redirect URIs — no Keycloak config change needed. CSP updated to include `*.ces.abstractstaging.it`.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/litellm-chat/health` | GET | Health check |
| `/api/litellm-chat/config` | GET | Chat defaults (defaultModel, defaultVectorStoreId, maxRequestBudget) |
| `/api/litellm-chat/vector_stores` | GET | List LiteLLM vector stores (normalized) |
| `/api/litellm-chat/chat/key` | POST | Mint dedicated chat key (returns real sk-) |
| `/api/litellm-chat/chat/key` | DELETE | Delete chat key |
| `/api/litellm-chat/chat/stream` | POST | SSE streaming chat (RAG or plain) |
| `/api/litellm-chat/chat/completions` | POST | Non-streaming chat |

## Config

```yaml
litellm:
  baseUrl: http://litellm.litellm.svc.cluster.local:4000
  masterKey: ${LITELLM_MASTER_KEY}
  userIdDomain: example.com  # optional
  chat:
    defaultModel: claude-3-5-sonnet        # optional
    defaultVectorStoreId:                   # optional
    maxRequestBudget:                       # optional, advisory
```

## Repos

| Repo | Path |
|---|---|
| Chat plugin (this) | `/Users/andrea/Projects/personal/backstage-plugin-litellm-rag-ai` |
| Govai plugin (sibling) | `/Users/andrea/Projects/personal/backstage-plugin-litellm-govai` |
| Target Backstage | `/Users/andrea/Projects/abstract-ces/playground/backstage-abstract-ces` |

## GKE environment

- **Cluster**: `gke_abs-digital-playground_europe-west1_abs-ces-n8n`
- **LiteLLM**: `litellm` ns, v1.90.0, port 4000
- **pgvector**: `litellm` ns, port 8000, 768 dims
- **Backstage**: `backstage` ns, 2 replicas, port 7007
- **Vector stores registered**: `oo-kb` (`5af1e002-...`), `general` (`e019cb67-...`)
- **Keycloak**: `auth.ces.abssrv.it/realms/solution-innovation`, client `backstage` (wildcard redirects)

## npm publishing notes

Scoped packages under `@acarmisc` have registry propagation lag — `npm view` 404s for ~hours after publish even though `npm access get status` shows `public`. Workaround: target Backstage uses tarball URLs in `package.json` instead of version ranges:
```json
"@acarmisc/backstage-plugin-litellm-chat": "https://registry.npmjs.org/@acarmisc/backstage-plugin-litellm-chat/-/backstage-plugin-litellm-chat-0.3.0.tgz"
```
Once propagation completes, switch to `"^0.3.0"`.

## CI/CD

GitLab CI (`.gitlab-ci.yml`) on push to `main`:
1. Kaniko builds Docker image → Artifact Registry
2. Kustomize pins image tag → `kubectl apply -k k8s/overlays/production`
3. `kubectl rollout status deployment/backstage -n backstage`

~13min end-to-end.

## Verified on GKE

- [x] LiteLLM pod running, `/v1/vector_store/list` returns 2 stores
- [x] `/v1/chat/completions` + `vector_store_ids` streaming works (SSE deltas)
- [x] Backstage pod running with `litellm-chat` plugin loaded (init log confirms)
- [x] `/api/litellm-chat/health` → `{"status":"ok"}`
- [x] `/api/litellm-chat/vector_stores` → 2 pgvector stores
- [x] `/api/litellm-chat/config` → chat defaults
- [x] Auth enforced (401 without OIDC token)
- [x] Ingress serves both `abssrv.it` + `abstractstaging.it`
- [x] Keycloak OIDC redirect + CORS accepts `abstractstaging.it`
- [x] Sidebar has "AI Chat" link

## Not yet verified (needs browser session with OIDC login)

- [ ] End-to-end streaming chat with citations rendering
- [ ] "Generate chat key" button mints key successfully
- [ ] Key deletion on thread delete works
- [ ] Markdown rendering of assistant messages
- [ ] Auto-scroll during streaming
- [ ] Per-key budget enforcement (LiteLLM side)

## Known issues / TODO

1. **`PG_VECTOR_API_BASE` env var** not set on LiteLLM pod → `/v1/rag/query` 500s. Ops fix: add env var to LiteLLM deployment. Fallback path works regardless.

2. **npm registry propagation**: scoped packages not visible via `npm view` for hours. Using tarball URLs as workaround. Check `npm view @acarmisc/backstage-plugin-litellm-chat version` periodically — once it resolves, switch `package.json` to `^0.3.0`.

3. **No markdown sanitization**: `react-markdown` + `remark-gfm` render assistant content. No `rehype-raw` (good — no raw HTML). But no DOMPurify either. Low risk since content is LLM-generated, not user-injected.

4. **Thread persistence is localStorage only**: threads lost on browser data clear. Key stored in thread too — if localStorage cleared, orphaned `sk-` keys remain in LiteLLM (24h expiry mitigates).

5. **No DB-backed threads**: AGENTS.md decision — v1 is ephemeral. Revisit if users ask.

6. **CSP still references `abssrv.it`**: `connect-src` has both domains now, but Keycloak auth endpoint is `auth.ces.abssrv.it`. If Keycloak moves to `abstractstaging.it`, CSP needs update.

7. **`@backstage/core-components` + `react-use`** in frontend deps but unused. Can remove to slim bundle.

8. **`@backstage/types`** in backend deps but unused. Can remove.

## Review history

- `review-1.md` — first review (sub-agent). Found 3 critical + 6 important issues. All fixed.
- No review-2 yet. Recommend another review pass after browser testing.

## Files changed in target Backstage

| File | Change |
|---|---|
| `packages/app/package.json` | Added `@acarmisc/backstage-plugin-litellm-chat` dep (tarball URL) |
| `packages/app/src/App.tsx` | Import + add `litellmChatPlugin` to features |
| `packages/app/src/modules/nav/Sidebar.tsx` | Added "AI Chat" sidebar item with ChatIcon |
| `packages/backend/package.json` | Added `@acarmisc/backstage-plugin-litellm-chat-backend` dep, bumped govai to `^0.3.4` |
| `packages/backend/src/index.ts` | `backend.add(import('@acarmisc/backstage-plugin-litellm-chat-backend'))` |
| `app-config.production.yaml` | Added `*.ces.abstractstaging.it` to CSP `connect-src` |
| `k8s/base/22-backstage-deployment.yaml` | `APP_BASE_URL` → `https://backstage.ces.abstractstaging.it` |
| `k8s/base/26-backstage-ingress.yaml` | Added second host `backstage.ces.abstractstaging.it` + `backstage-staging-tls` secret |

## Files changed in govai plugin

| File | Change |
|---|---|
| `packages/plugin-litellm-backend/src/index.ts` | Added exports: `resolveUserId`, `toLiteLLMUserId`, `getOrProvisionUser`, `ProvisioningError`, etc. |
| `packages/plugin-litellm-backend/package.json` | Bumped 0.3.3 → 0.3.4 |

## Next steps

1. **Browser test**: login at https://backstage.ces.abstractstaging.it/ai-chat, generate key, send message, verify streaming + citations.
2. **Fix `PG_VECTOR_API_BASE`** on LiteLLM pod to enable `/v1/rag/query` primary path.
3. **Switch tarball URLs → version ranges** once npm propagation completes.
4. **Run review-2** sub-agent after browser testing.
5. **Clean unused deps** (`@backstage/core-components`, `react-use`, `@backstage/types`).