# AGENTS.md — LiteLLM Chat Plugin for Backstage

## Mission

Build a Backstage plugin that lets developers chat with LLM models through a LiteLLM proxy, grounded in knowledge bases stored in a pgvector vector store — with per-user governance (budget, model ACLs, rate limits) inherited automatically from the existing LiteLLM Governance plugin (`@acarmisc/backstage-plugin-litellm` / `@acarmisc/backstage-plugin-litellm-backend`, repo: `backstage-plugin-litellm-govai`).

The chat plugin is a **thin client** architecture: Backstage holds no RAG logic, no embeddings pipeline, no chunking, no reranker. LiteLLM owns the entire retrieval-augmented generation layer. Backstage is the UI + the streaming proxy + the identity bridge.

## Why this architecture

The govai plugin already solved the hard problems:

- **Backend-held master key** — the LiteLLM master key never reaches the browser.
- **Backstage identity → LiteLLM `user_id` resolution** — `resolveUserId(req, auth)` extracts the Backstage user entity ref from the request token; `toLiteLLMUserId(entityRef, userIdDomain)` maps it to a LiteLLM user_id (with optional email domain suffix).
- **Per-user virtual key minting** — `/keys/generate` creates `sk-` keys scoped to a user, with budget/tpm/rpm/model limits.
- **Autoprovisioning** — `getOrProvisionUser()` creates a LiteLLM user on first access if `litellm.provisioning.enabled` is true, with role-based overrides from Backstage group memberships.
- **Model catalogue proxying** — `/models` returns the LiteLLM proxy's model list, normalised to a `ModelInfo[]` shape.

The chat plugin reuses all of this by **importing from the govai package**, not duplicating it. The only genuinely new engineering is:

1. **SSE streaming proxy** — piping LiteLLM's Server-Sent Events stream through the Backstage Express backend to the browser without buffering.
2. **RAG invocation** — calling LiteLLM's `/v1/rag/query` (or `/v1/chat/completions` with `vector_store_ids`) with the user's selected vector store.
3. **Chat UI** — a streaming chat page with model/KB/key pickers, citation rendering, and client-side thread management.

## Key design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Packaging | Separate plugin pair (`plugin-litellm-chat` + `plugin-litellm-chat-backend`) | Independently versionable; keeps governance and chat concerns decoupled; matches govai's monorepo pattern. |
| Thread persistence | Client-side ephemeral (React state + localStorage) | LiteLLM is stateless — each turn resends full history anyway. Zero backend schema. Add DB persistence later if users ask. |
| RAG endpoint | `/v1/rag/query` primary, `/v1/chat/completions` + `vector_store_ids` fallback | `/v1/rag/query` is model-agnostic (prepend-context, not provider-native tool). Fallback handles LiteLLM versions where `/rag/query` isn't mounted. |
| Chat key strategy | User picks a key in the UI (dropdown from their existing keys) | Spend attribution to the user's chosen key; per-key budget/limits enforced natively by LiteLLM; no surprise auto-minted keys. |
| UI surfaces | Full chat page at `/ai-chat` | v1 ships the page. Sidebar modal and home widget are future work. |
| Cross-package reuse | Import `LiteLLMClient`, `resolveUserId`, `toLiteLLMUserId`, `getOrProvisionUser`, `ProvisioningError`, types from govai backend; import `LiteLlmApi`, `liteLlmApiRef`, types from govai frontend | Govai is the single source of truth for identity, key management, and the LiteLLM client. Chat plugin adds only chat-specific routes and components. |

## Target environment (GKE)

- **Cluster**: `gke_abs-digital-playground_europe-west1_abs-ces-n8n`
- **LiteLLM proxy**: `http://litellm.litellm.svc.cluster.local:4000` (namespace `litellm`, image `docker.litellm.ai/berriai/litellm-database:v1.90.0`, 1 replica)
- **pgvector service**: `http://litellm-pgvector.litellm.svc.cluster.local:8000` (namespace `litellm`, image `europe-west1-docker.pkg.dev/abs-digital-playground/containers/litellm-pgvector:768-v1`, embeddings via `openai/nomic-embed-text` at 768 dimensions, auth via `PG_VECTOR_API_KEY`)
- **Redis**: `litellm-redis.litellm.svc.cluster.local:6379` (exact-match response cache, TTL 3600s)
- **Vector stores**: DB-backed in LiteLLM (not in `config.yaml`). Registered via `scripts/register-vector-store.sh`. LiteLLM resolves vector-store search from the DB registry at query time.
- **Backstage**: namespace `backstage`, 2 replicas, image `europe-west1-docker.pkg.dev/abs-digital-playground/ces-innovation/ces-backstage:<sha>`, port 7007, Postgres at `backstage-postgres.backstage.svc.cluster.local:5432`
- **Auth**: Keycloak OIDC, realm `solution-innovation`, issuer `https://auth.ces.abssrv.it/realms/solution-innovation`
- **LiteLLM config**: `store_model_in_db: true` (models managed via REST/UI, not config.yaml), `forward_client_headers_to_llm_api: true`, `drop_params: true`, OTEL callbacks enabled, `cache: true` on Redis

## Existing govai plugin — what's exported and reusable

### Backend (`@acarmisc/backstage-plugin-litellm-backend`)

| Export | What it does |
|---|---|
| `LiteLLMClient` | Class wrapping LiteLLM REST API with master-key auth. Methods: `getUserInfo`, `createUser`, `updateUser`, `listKeys`, `generateKey`, `updateKey`, `deleteKeys`, `regenerateKey`, `listModels`, `getTeamInfo`, `getUsage`, `getTeamUsage`. **JSON-only** — does not support streaming. |
| `resolveUserId(req, auth)` | Extracts Backstage user entity ref from request Bearer token via `auth.authenticate()`. Returns `string \| undefined`. |
| `toLiteLLMUserId(entityRef, userIdDomain)` | Maps `user:default/john.doe` + `example.com` → `john.doe@example.com`. Handles already-email-shaped entity names. |
| `getOrProvisionUser(...)` | Ensures a LiteLLM user exists, provisioning from catalog profile + role overrides if enabled. Single-flight cache prevents thundering herd. Throws `ProvisioningError` on failure. |
| `ProvisioningError` | Error class with `status` and `body: {error, hint, provisioning}`. Map upstream LiteLLM errors to this for consistent browser-facing error shape. |
| `readProvisioningDefaults(config)` | Reads `litellm.provisioning.*` config block. |
| `readRoleConfigs(config)` | Reads `litellm.provisioning.roles[]` array. |
| `KeycloakJWTVerifier`, `newDefaultVerifier`, bridge functions | CLI bridge auth — **not needed for chat v1** (chat is browser-only, uses Backstage auth). |
| Types: `LiteLLMConfig`, `UserInfo`, `VirtualKey`, `ModelInfo`, `GenerateKeyRequest`, `GenerateKeyResponse`, etc. | Shared type definitions. |

### Frontend (`@acarmisc/backstage-plugin-litellm`)

| Export | What it does |
|---|---|
| `liteLlmApiRef` | `createApiRef` for the governance API. The chat plugin reuses this to call `/keys` and `/models` — no duplication. |
| `LiteLlmApi` | API client class. Methods: `getUserInfo`, `listKeys`, `generateKey`, `updateKey`, `deleteKey`, `listModels`, `getTeams`, `getUsage`, `getTeamUsage`. Base path `/api/litellm`. |
| `litellmPlugin` | The frontend plugin (registers the `/litellm` page + API). The chat plugin is a **separate** plugin that coexists. |
| Types: `UserInfo`, `VirtualKey`, `ModelInfo`, etc. | Shared type definitions. |

## New plugin: backend (`@acarmisc/backstage-plugin-litellm-chat-backend`)

### Routes (all under `/api/litellm-chat`, all Backstage-auth-authenticated)

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | `{ status: 'ok' }` |
| `/vector_stores` | GET | Lists LiteLLM vector stores for the KB picker. Calls `GET /v1/vector_stores` on LiteLLM. |
| `/chat/stream` | POST | Streaming chat proxy. The one new piece of engineering. |
| `/chat/completions` | POST | Non-streaming chat variant. |

### `/chat/stream` request body (from browser)

```json
{
  "model": "claude-3-5-sonnet",
  "messages": [{ "role": "user", "content": "..." }],
  "vector_store_id": "vs_pgvec_xxx",
  "top_k": 5,
  "user_key": "sk-..."
}
```

### `/chat/stream` backend flow

1. `resolveUserId(req, auth)` → `toLiteLLMUserId(...)` — confirm identity (no provisioning required for chat; the user's key must already exist).
2. If `vector_store_id` is present:
   - **Primary**: `POST {LITELLM_BASE_URL}/v1/rag/query` with `{ model, messages, retrieval_config: { vector_store_id, custom_llm_provider: 'pg_vector', top_k }, stream: true }`, header `Authorization: Bearer <user_key>`.
   - **Fallback** (if `/v1/rag/query` returns 404): `POST {LITELLM_BASE_URL}/v1/chat/completions` with `{ model, messages, vector_store_ids: [vector_store_id], stream: true }`, same auth header.
3. If `vector_store_id` is null/empty: `POST /v1/chat/completions` with `{ model, messages, stream: true }` (plain chat, no RAG).
4. Pipe the SSE response through to the browser:
   - `res.setHeader('Content-Type', 'text/event-stream')`
   - `res.setHeader('Cache-Control', 'no-cache, no-transform')`
   - `res.setHeader('X-Accel-Buffering', 'no')`
   - `res.flushHeaders()`
   - `upstream.body.pipe(res)`
   - On `req.on('close')`: abort the upstream fetch (client disconnected).
   - On upstream error: emit `data: {"error":"..."}\n\n` then end.
5. **No `express.json()` on this route** (or route-level skip). **No compression middleware on this path.** These buffer the stream.

### Config schema (`config.d.ts`)

Reads the same `litellm.baseUrl` / `litellm.masterKey` / `litellm.userIdDomain` / `litellm.provisioning.*` that govai defines. One optional addition:

```yaml
litellm:
  chat:
    defaultModel: claude-3-5-sonnet        # optional, pre-selected in UI
    defaultVectorStoreId:                   # optional, pre-selected in UI
    maxRequestBudget:                       # optional, USD guard (real enforcement is per-key in LiteLLM)
```

### Plugin registration

```typescript
createBackendPlugin({
  pluginId: 'litellm-chat',
  register(reg) {
    reg.registerInit({
      deps: { httpRouter, config, logger, auth, discovery },
      async init({ httpRouter, config, logger, auth, discovery }) {
        const router = await createRouter({ config, logger, auth, discovery });
        httpRouter.use(router);
      },
    });
  },
});
```

No `addAuthPolicy` overrides — all routes use Backstage auth (no Keycloak bridge for chat in v1).

## New plugin: frontend (`@acarmisc/backstage-plugin-litellm-chat`)

### API client (`src/api.ts`)

New `LiteLlmChatApi` + `liteLlmChatApiRef`. Reuses the existing `liteLlmApiRef` from govai for `/keys` and `/models`.

| Method | Purpose |
|---|---|
| `listVectorStores()` | `GET /api/litellm-chat/vector_stores` → `VectorStore[]` |
| `chatStream(req, onToken, onDone, onError)` | Opens `fetch` to `/api/litellm-chat/chat/stream`, reads SSE via `ReadableStream` reader, parses `data:` lines, calls callbacks. Returns `AbortController` for stop. |
| `chatCompletions(req)` | Non-streaming variant. |

### Types (`src/types.ts`)

```typescript
interface VectorStore { id: string; name: string; file_count?: number; status?: string; }
interface ChatRequest { model: string; messages: Message[]; vector_store_id?: string; top_k?: number; user_key: string; }
interface Message { role: 'user' | 'assistant' | 'system'; content: string; }
interface ChatStreamChunk { delta?: string; error?: string; search_results?: SearchResult[]; }
interface SearchResult { filename: string; score: number; text: string; }
interface Citation { filename: string; score: number; snippet: string; }
interface ChatResult { content: string; citations: Citation[]; }
```

### State management (`src/hooks/useChat.ts`)

- `threads: Thread[]` in `useState`, persisted to `localStorage` under `litellm-chat:threads:<userId>`.
- `Thread = { id, title, messages: Message[], model, vectorStoreId, keyAlias, createdAt, updatedAt }`.
- `useChat` exposes: `threads`, `activeThread`, `newThread()`, `selectThread(id)`, `deleteThread(id)`, `sendMessage(text)`, `stopGeneration()`.

### Components

| Component | Responsibility |
|---|---|
| `ChatPage` | Page shell at `/ai-chat`. Left thread sidebar, main chat area. |
| `ChatComposer` | Textarea + send button + stop button. Pickers row above it. |
| `ModelPicker` | Dropdown from `liteLlmApiRef.listModels()`. Preselects `config.chat.defaultModel`. |
| `VectorStorePicker` | Dropdown from `listVectorStores()`. "None (no grounding)" option. Preselects `config.chat.defaultVectorStoreId`. |
| `KeyPicker` | Dropdown from `liteLlmApiRef.listKeys()`. Shows `key_alias` (fallback: masked `key_name`). Required before first send. Empty state: link to `/litellm`. |
| `MessageList` | User messages right-aligned, assistant left. Assistant body as markdown. Citations panel below each assistant message. |
| `CitationsPanel` | Collapsible. Shows source filename + relevance score. Expandable to show retrieved snippet. |
| `StreamingIndicator` | Pulsing cursor while tokens arrive. |
| `ErrorBanner` | SSE error or fetch failure (e.g. 401 from LiteLLM — key out of budget). |

### Plugin registration

```tsx
const liteLlmChatApi = ApiBlueprint.make({
  params: defineParams => defineParams({
    api: liteLlmChatApiRef,
    deps: { fetchApi: fetchApiRef },
    factory: ({ fetchApi }) => new LiteLlmChatApi(fetchApi),
  }),
});

const chatPage = PageBlueprint.make({
  params: {
    path: '/ai-chat',
    title: 'AI Chat',
    icon: <ChatIcon />,
    loader: async () => (await import('./components/ChatPage')).ChatPage,
  },
});

export const litellmChatPlugin = createFrontendPlugin({
  pluginId: 'litellm-chat',
  extensions: [liteLlmChatApi, chatPage],
});
```

## Repository structure

```
backstage-plugin-litellm-rag-ai/
├── package.json                           # monorepo root
├── AGENTS.md                              # this file
├── todo.txt                               # phased task list
├── README.md
└── packages/
    ├── plugin-litellm-chat/               # @acarmisc/backstage-plugin-litellm-chat
    │   ├── package.json
    │   ├── build.js
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── plugin.tsx
    │       ├── api.ts
    │       ├── types.ts
    │       ├── hooks/
    │       │   └── useChat.ts
    │       └── components/
    │           ├── ChatPage.tsx
    │           ├── ChatComposer.tsx
    │           ├── MessageList.tsx
    │           ├── ModelPicker.tsx
    │           ├── VectorStorePicker.tsx
    │           ├── KeyPicker.tsx
    │           ├── CitationsPanel.tsx
    │           └── ErrorBanner.tsx
    └── plugin-litellm-chat-backend/       # @acarmisc/backstage-plugin-litellm-chat-backend
        ├── package.json
        ├── build.js
        ├── config.d.ts
        ├── tsconfig.json
        └── src/
            ├── index.ts
            ├── plugin.ts
            ├── router.ts
            ├── stream.ts                  # SSE proxy helper
            └── types.ts
```

## Phases (see todo.txt for granular tasks)

1. **Scaffold** — both packages, package.json, tsconfig, build.js, config.d.ts, stubs. Link in target Backstage monorepo.
2. **Verify LLM** — confirm `/v1/rag/query` exists on v1.90.0, confirm `/v1/chat/completions` + `vector_store_ids` fallback shape, confirm `/v1/vector_stores` returns pgvector stores, verify SSE passthrough through Backstage's `HttpRouterService`.
3. **Backend stream** — `proxySSE()` in `stream.ts`: headers, pipe, error handling, client disconnect.
4. **Backend router** — `/health`, `/vector_stores`, `/chat/stream`, `/chat/completions`. Import govai machinery. Plugin registration.
5. **Frontend API** — `LiteLlmChatApi`, types, SSE reader, `AbortController`.
6. **Frontend hooks** — `useChat` thread state, localStorage, `sendMessage`, `stopGeneration`.
7. **Frontend UI** — all components, pickers, plugin registration, exports.
8. **Integration** — wire into target Backstage, deploy to GKE, verify against live pgvector.

## Things NOT in v1

- **DB-backed threads** — client-side ephemeral only. Revisit if users ask.
- **Bridge/CLI auth for chat** — chat is browser-only. The govai Keycloak bridge is for key minting by the Abby CLI.
- **Custom chunking/reranker/hybrid search** — LiteLLM's `retrieval_config` gives `top_k` and optional rerank. If fine-grained retrieval control is needed later, build a dedicated retrieval service.
- **File upload** — pgvector ingests files via its own admin API. Backstage chat is query-side only.
- **Sidebar modal / home widget** — v1 ships the `/ai-chat` page only.

## Build and test

```bash
# Build (from target Backstage monorepo)
yarn workspace @acarmisc/backstage-plugin-litellm-chat build
yarn workspace @acarmisc/backstage-plugin-litellm-chat-backend build

# Test
yarn workspace @acarmisc/backstage-plugin-litellm-chat test
yarn workspace @acarmisc/backstage-plugin-litellm-chat-backend test
```

## Release

Same tag pattern as govai:

```bash
git tag litellm-chat@X.Y.Z          # or litellm-chat-backend@X.Y.Z
git push origin litellm-chat@X.Y.Z
```

CI verifies tag version matches `package.json`, builds, publishes to npm, creates GitHub Release.

## Reference repos

- **govai plugin** (sibling): `/Users/andrea/Projects/personal/backstage-plugin-litellm-govai`
  - Frontend: `packages/plugin-litellm/` (`@acarmisc/backstage-plugin-litellm@0.4.0`)
  - Backend: `packages/plugin-litellm-backend/` (`@acarmisc/backstage-plugin-litellm-backend@0.3.3`)
- **This plugin** (greenfield): `/Users/andrea/Projects/personal/backstage-plugin-litellm-rag-ai`

## Open questions to verify during phase 2

1. Does `/v1/rag/query` exist on LiteLLM v1.90.0? If not, the fallback to `/v1/chat/completions` + `vector_store_ids` handles it — but confirm the fallback's response shape for citations (search metadata field name may differ).
2. Does Backstage's `HttpRouterService` default middleware (compression in particular) buffer SSE streams? If yes, add the chat route to a compression skip-list or use `res.flushHeaders()` aggressively. If that doesn't work, fall back to a raw Node http handler via `httpRouter.addAuthPolicy` + custom route.