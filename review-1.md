# Review 1 — LiteLLM Chat Plugin for Backstage

## Summary

The plugin is well-structured and the frontend system pattern (ApiBlueprint/PageBlueprint) correctly matches the target Backstage app. However, **the backend will not build**: it imports `resolveUserId` and `toLiteLLMUserId` from the govai package, but govai's `index.ts` does not export them. Additionally, GKE verification revealed that the `/v1/rag/query` endpoint (the primary RAG path) fails against the live pgvector setup due to a LiteLLM v1.90.0 limitation — only the `/v1/chat/completions` + `vector_store_ids` fallback actually works. There are also several TypeScript compile errors in the frontend from unused imports/vars and an invalid MUI prop.

## Critical issues (must fix before build)

### C1. Backend imports symbols that govai does not export — build fails
`packages/plugin-litellm-chat-backend/src/router.ts:6-8` imports:
```ts
import { resolveUserId, toLiteLLMUserId } from '@acarmisc/backstage-plugin-litellm-backend';
```
But govai's `packages/plugin-litellm-backend/src/index.ts` does NOT export `resolveUserId`, `toLiteLLMUserId`, `getOrProvisionUser`, or `ProvisioningError`. Those symbols live in `provisioning.ts` and are only re-exported via `router.ts` (`export { ProvisioningError }`), but **not** from the package `index.ts`. Confirmed by `tsc --noEmit`:
```
src/router.ts(6,3): error TS2614: Module '"@acarmisc/backstage-plugin-litellm-backend"' has no exported member 'resolveUserId'.
src/router.ts(7,3): error TS2614: Module '"@acarmisc/backstage-plugin-litellm-backend"' has no exported member 'toLiteLLMUserId'.
```
**Fix:** Either (a) update govai's `index.ts` to re-export `{ resolveUserId, toLiteLLMUserId, getOrProvisionUser, ProvisioningError }` from `./provisioning` and publish a new govai backend version, or (b) the chat backend should duplicate/inline these helpers. Option (a) matches AGENTS.md's "import from govai" decision.

### C2. `/v1/rag/query` primary RAG path is broken on GKE — only fallback works
Verified live on the cluster (LiteLLM v1.90.0, pgvector store `general` id `e019cb67-...`):
- `/v1/rag/query` with `retrieval_config: { vector_store_id, custom_llm_provider: 'pg_vector', top_k }` returns **500**: `PG Vector API base URL is required. Set PG_VECTOR_API_BASE environment variable or pass api_base in litellm_params.`
- The vector store's DB record HAS `litellm_params.api_base = "http://litellm-pgvector:8000"`, but LiteLLM v1.90.0's `_execute_query_pipeline` (in `litellm/rag/main.py`) calls `litellm.vector_stores.asearch()` **without** forwarding the DB-stored `litellm_params.api_base`. It only passes `vector_store_id`, `query`, `max_num_results`, `custom_llm_provider`, and `**kwargs` — and the rag/query endpoint does not extract `api_base` from `retrieval_config`.
- Passing `api_base` at the request top level is **blocked** by LiteLLM's client-side credential guard (401: `api_base is not allowed in request body`).
- `PG_VECTOR_API_BASE` env var is NOT set on the LiteLLM pod (only `PG_VECTOR_API_KEY` is).

The `/v1/chat/completions` + `vector_store_ids` fallback **works** — verified both non-streaming (returns `search_results` array in response) and streaming (SSE deltas with `choices[0].delta.content` and `choices[0].delta.reasoning_content`).

**Fix (one of):**
1. Set `PG_VECTOR_API_BASE=http://litellm-pgvector:8000` on the LiteLLM deployment (ops fix, unblocks rag/query).
2. OR swap the chat backend's primary/fallback: make `/v1/chat/completions` + `vector_store_ids` the **primary** path, and `/v1/rag/query` the fallback (or drop rag/query for v1). This matches what actually works on the cluster today.

### C3. `/v1/vector_stores` endpoint is wrong — should be `/v1/vector_store/list`
`router.ts:62` calls `GET {baseUrl}/v1/vector_stores`. Verified on GKE: `/v1/vector_stores` is the **OpenAI-compatible passthrough** — it forwards to the OpenAI API and returns `invalid_api_key` when called with the LiteLLM master key. The LiteLLM-native listing endpoint is `/v1/vector_store/list` (also available at `/vector_store/list`), which returns:
```json
{ "object": "list", "data": [{ "vector_store_id": "...", "vector_store_name": "...", "custom_llm_provider": "pg_vector", ... }], "total_count": 2, "current_page": 1, "total_pages": 1 }
```
The response normalization at `router.ts:74-77` (`data.data ?? data.vector_stores ?? []`) happens to work on the list shape, but the field names differ: the backend `VectorStore` type uses `id`/`name`/`file_count` while LiteLLM returns `vector_store_id`/`vector_store_name` (no `file_count`). The frontend `VectorStorePicker` will show empty labels unless the backend maps `vector_store_id → id` and `vector_store_name → name`.

**Fix:** Change `router.ts:62` to `${baseUrl}/v1/vector_store/list`, and normalize: `data.data.map(s => ({ id: s.vector_store_id, name: s.vector_store_name, status: s.custom_llm_provider }))`.

## Important issues (should fix before deploy)

### I1. Frontend has TypeScript compile errors (6 errors)
`npx tsc -p tsconfig.json --noEmit` on the frontend fails:
- `ChatPage.tsx:9` — `Typography` imported but unused (`noUnusedLocals`).
- `ChatPage.tsx:82` — `ListItemButton` does not accept `secondaryAction` prop. MUI's `secondaryAction` belongs on `ListItem`, not `ListItemButton`. The delete button renders but won't typecheck.
- `ChatPage.tsx:119` — `ErrorBanner` `error` prop typed as `string` but `chat.error ?? undefined` is `string | undefined`. Change `ErrorBannerProps.error` to `string | undefined` or make it `error?: string`.
- `ModelPicker.tsx:2` — `Box` imported but unused.
- `useChat.ts:104` — `prev` parameter in `setActiveId(prev => ...)` is declared but unused (stale-closure bug — see I2).

### I2. `deleteThread` has a stale-closure bug and dead code
`useChat.ts:100-111`:
```ts
const deleteThread = useCallback((id: string) => {
  setThreads(prev => prev.filter(t => t.id !== id));
  if (activeId === id) {
    setActiveId(prev => {
      const remaining = threads.filter(t => t.id !== id);  // ← `threads` is the closure value, STALE
      return remaining[0]?.id ?? null;
    });
  }
}, [activeId, threads]);
```
`threads` inside `setActiveId` is the closure-captured value from when the callback was created — but `setThreads(prev => ...)` on the line above just scheduled a state update that hasn't applied yet. `remaining` is computed from the OLD `threads` array (which still contains the deleted item), so `remaining[0]?.id` may return the just-deleted thread's id. Fix: compute remaining from the functional update, or move the `setActiveId` logic into a `useEffect` that watches `threads`.

### I3. `express.json()` is applied to `/chat/stream` — contradicts AGENTS.md
`router.ts:46` does `router.use(express.json())` which applies to ALL routes including `/chat/stream`. AGENTS.md:110 explicitly says "No `express.json()` on this route". In practice this works because the request body is small JSON and `express.json()` parses it fully before the handler runs — the SSE *response* is not affected by the request body parser. The real risk AGENTS.md warns about is **compression** on the response, not the request parser. Backstage's `HttpRouterService` does not add compression by default (confirmed by govai plugin.ts not skipping it). So this is a spec-compliance flag, not a runtime bug. Still, to match the locked design, apply `express.json()` only to `/chat/completions` and `/chat/stream` request parsing is fine since the request is small — but document the deviation.

### I4. Backend missing `winston` devDependency
`router.ts:4` and `stream.ts:2` import `import type { Logger } from 'winston'`. `winston` is not in `package.json` devDependencies. Type-check fails: `Cannot find module 'winston'`. Add `"winston": "^3.0.0"` to devDependencies (or `@types/winston` if only types needed — but winston ships its own types).

### I5. SSE error chunk shape doesn't match frontend parser
`stream.ts:87` emits `data: {"error":"..."}\n\n` on upstream error. The frontend `api.ts:92-94` parses `data:` payloads as `ChatStreamChunk` (`{ delta?, error?, search_results? }`). This works. However, the **normal** LiteLLM SSE chunks have shape `{ choices: [{ delta: { content, reasoning_content } }], ... }` — NOT `{ delta: "..." }`. The frontend `api.ts:93` casts every `data:` payload to `ChatStreamChunk` and the `useChat.ts:175` reads `chunk.delta` (string). But LiteLLM emits OpenAI-shaped chunks where the delta is nested at `choices[0].delta.content`. The current `onToken` callback in `useChat.ts` only handles `chunk.delta` (top-level string) and `chunk.search_results` — it will NEVER receive content from real LiteLLM streams because the content is at `chunk.choices[0].delta.content`.

**Fix:** The backend `proxySSE` currently pipes raw SSE bytes through unchanged (correct). The frontend SSE parser must extract content from the OpenAI chunk shape: `chunk.choices?.[0]?.delta?.content`. Update `ChatStreamChunk` type and `useChat.ts` onToken handler to map OpenAI delta shape → `{ delta: string }`.

### I6. `/config` route is not in AGENTS.md route table
`router.ts:52` adds `GET /config` returning chat defaults. AGENTS.md:76-81 lists only `/health`, `/vector_stores`, `/chat/stream`, `/chat/completions`. The `/config` route is a reasonable addition (the frontend `getChatConfig()` depends on it) but it's an undocumented extra. Either add it to AGENTS.md or note the deviation.

## Minor issues (nice to fix)

### M1. `noUnusedLocals` + underscore-prefixed vars
`router.ts:99` and `:149` declare `const _userId = toLiteLLMUserId(...)` which is unused. TypeScript's `noUnusedLocals` does NOT exempt underscore-prefixed vars by default (unlike `noUnusedParameters` which does NOT either in this config). The intent is to validate identity resolution without using the result. Fix: either remove the assignment (`toLiteLLMUserId(tokenEntityRef, userIdDomain)` as a statement) or restructure to actually use `_userId` (e.g. log it). The `_userId` assignment provides no security value — the user's key authenticates them to LiteLLM, not the resolved user_id.

### M2. `ModelPicker`/`VectorStorePicker` `useEffect` has empty deps but reads `value`/`defaultModel`
`ModelPicker.tsx:39` `useEffect(() => {...}, [])` — empty deps, but the effect reads `value`, `defaultModel`, `onChange`. React exhaustive-deps would flag this. Same in `VectorStorePicker.tsx:40`. Intent is "run once on mount to preselect default" — acceptable, but `onChange`/`value` could change. Low risk for v1.

### M3. `CitationsPanel` `score.toFixed(3)` may crash on null
`CitationsPanel.tsx:50` — `c.score.toFixed(3)` assumes `score` is always a number. The `Citation` type says `number`, but the `chatCompletions` mapping at `api.ts:127` defaults to `r.score ?? 0`. If LiteLLM omits score, it becomes 0 — safe. Minor.

### M4. No markdown rendering — AGENTS.md says "Assistant body as markdown"
AGENTS.md:182: "Assistant body as markdown." Current `MessageList.tsx:65` uses `whiteSpace: 'pre-wrap'` and renders plain text. No `react-markdown` dependency. Assistant messages with markdown formatting (bold, code blocks, lists) will render as raw text. Add `react-markdown` + `remark-gfm` to dependencies and render assistant content through it (with sanitization — `rehype-raw` off, or use `DOMPurify`).

### M5. `StreamingIndicator` component mentioned in AGENTS.md but not a separate file
AGENTS.md:184 lists `StreamingIndicator` as a component. The repo has no `StreamingIndicator.tsx` — the indicator is inlined in `MessageList.tsx:70-75` as a `▋` char with CSS animation. The `animation: 'pulse 1s infinite'` keyframe is not defined anywhere in the component — it relies on a global `pulse` keyframe being present (MUI/Backstage theme provides it in some themes). May render as static cursor. Define the keyframe inline or use `@mui/material` `Skeleton`/`CircularProgress`.

### M6. `KeyPicker` uses `VirtualKey` but govai exports it as a type-only export
`KeyPicker.tsx:5` imports `import type { VirtualKey } from '@acarmisc/backstage-plugin-litellm'`. Govai's `index.ts:10` does `export * from './types'` and `types.ts` exports `VirtualKey`. This works. However, `KeyPicker.tsx:48` reads `x.key` and `x.key_alias` — govai's `VirtualKey` type has `key: string` and `key_alias?: string`. The `k.key.slice(0, 7)` assumes `key` is a string (it is). Fine, but the `key_alias` fallback uses `k.key.slice(0, 8) + '…'` at line 51 vs `k.key.slice(0, 7) + '…'` at line 60 — inconsistent truncation length (8 vs 7). Minor cosmetic.

### M7. `config.d.ts` may conflict with govai's `config.d.ts`
Both govai backend and chat backend define `config.d.ts` with `litellm.*` config. When both plugins are installed in the same Backstage app, Backstage merges config schemas. The chat backend's `config.d.ts` re-declares `litellm.baseUrl`, `litellm.masterKey`, `litellm.userIdDomain` (already in govai's) plus the new `litellm.chat.*`. TypeScript interface merging should merge these (additive), but if field types differ it errors. The chat backend marks `masterKey` as `@visibility secret` and govai likely does too — verify they match. Low risk but worth checking after both are wired in.

## Verified against GKE

Cluster context: `gke_abs-digital-playground_europe-west1_abs-ces-n8n`

| Check | Result |
|---|---|
| LiteLLM pod running in `litellm` ns | YES — `litellm-775f4bd6b5-rt9gf` (2/2 Running), image `docker.litellm.ai/berriai/litellm-database:v1.90.0` |
| LiteLLM service port 4000 | YES — `litellm` ClusterIP `34.118.236.198:4000/TCP` |
| pgvector pod running | YES — `litellm-pgvector-bc4f855f9-7kqnd` (1/1 Running) |
| pgvector service port 8000 | YES — `litellm-pgvector` ClusterIP `34.118.232.188:8000/TCP` |
| Redis running | YES — `litellm-redis-5556687748-c6qhk` |
| Backstage service port 7007 | YES — `backstage` ClusterIP `34.118.229.97:7007/TCP` |
| Backstage Postgres | YES — `backstage-postgres:5432/TCP` |
| `/v1/rag/query` endpoint exists on v1.90.0 | YES (in OpenAPI) — but **fails at runtime** with `PG_VECTOR_API_BASE is required` (see C2) |
| `/v1/vector_stores` returns pgvector stores | NO — OpenAI passthrough, rejects master key (see C3) |
| `/v1/vector_store/list` returns pgvector stores | YES — 2 stores: `oo-kb` (`5af1e002-...`) and `general` (`e019cb67-...`), both `custom_llm_provider: pg_vector`, `api_base: http://litellm-pgvector:8000` |
| `/v1/chat/completions` + `vector_store_ids` (non-stream) | YES — returns 200 with `choices[0].message.content` + top-level `search_results` array |
| `/v1/chat/completions` + `vector_store_ids` (stream) | YES — SSE deltas with `choices[0].delta.content` and `choices[0].delta.reasoning_content` |
| LiteLLM master key | Resolved from `litellm-secrets` secret (full value `sk-iU3sjnqnXBqmpWUV9tfRomGv6NRaVwD9bqTEnOgvT9c=`) |
| `PG_VECTOR_API_BASE` env var on LiteLLM pod | NOT SET (only `PG_VECTOR_API_KEY` is) — root cause of rag/query failure |

## Verified against target Backstage

Target app: `/Users/andrea/Projects/abstract-ces/playground/backstage-abstract-ces`

| Check | Result |
|---|---|
| Frontend system | NEW (`createApp` from `@backstage/frontend-defaults`, plugins as `/alpha` features) |
| Backend system | NEW (`createBackend` from `@backstage/backend-defaults`, `backend.add(import(...))`) |
| `ApiBlueprint`/`PageBlueprint` usage | YES — govai frontend `plugin.tsx` uses the same pattern as chat plugin |
| Existing govai frontend wired | YES — `packages/app/src/App.tsx:17,41` imports `litellmPlugin` and adds to features |
| Existing govai backend wired | YES — `packages/backend/src/index.ts:89` `backend.add(import('@acarmisc/backstage-plugin-litellm-backend'))` with `@ts-expect-error` for missing types subpath |
| Chat plugin `plugin.tsx` pattern matches | YES — identical structure to govai's working `plugin.tsx` |
| Chat backend `plugin.ts` pattern matches | YES — identical to govai's working `plugin.ts` (minus the bridge auth policy, which chat doesn't need) |
| `identityApiRef` import from `@backstage/core-plugin-api` | Correct — `identityApiRef` is exported from `@backstage/core-plugin-api` (used in `ChatPage.tsx:14`) |

**Conclusion:** The plugin registration pattern is correct for this target app. No frontend-system migration needed. The chat plugin can be wired in by adding `litellmChatPlugin` to `App.tsx` features and `backend.add(import('@acarmisc/backstage-plugin-litellm-chat-backend'))` to `backend/src/index.ts`.

## File-by-file findings

### Backend

- `src/index.ts` — Fine. Exports plugin, router, proxySSE, types.
- `src/plugin.ts` — Correct. Matches govai pattern. Deps (`httpRouter, config, logger, auth, discovery`) match AGENTS.md:131.
- `src/router.ts` — **C1** (broken imports), **C3** (wrong vector_stores endpoint), **I3** (express.json on stream route), **I6** (undocumented /config route), **M1** (`_userId` unused).
- `src/stream.ts` — **I4** (missing winston dep). `Readable.fromWeb` verified available in Node 18+ (stable 20+). SSE headers (lines 22-27) match AGENTS.md:103-105. Abort handling (line 20 `res.on('close')` → `controller.abort()`) is correct — aborts the upstream fetch. Fallback logic (lines 56-63) checks `err.status === 404` — correct. No race condition: `res.on('close')` fires once on client disconnect, aborts upstream, the upstream stream errors with AbortError which is caught at line 79. One gap: if `fetchUpstream` for the fallback also fails, it throws into the outer catch which writes an error chunk — fine.
- `src/types.ts` — Matches AGENTS.md:157-164 spec. `ChatResult.citations` uses inline type instead of `Citation` interface — minor.
- `config.d.ts` — Correctly extends litellm config with `chat.*`. `@visibility frontend` on `chat.*` is correct since the frontend reads defaults via `/config`.
- `package.json` — **I4** missing `winston` devDep. `@backstage/types` dependency is unused (no import of it in src). `react`/`react-dom` not needed (backend plugin) — correctly absent.
- `build.js` — Correct. `@acarmisc/backstage-plugin-litellm-backend` is external (good — won't bundle govai). But once C1 is fixed (govai exports the symbols), this will work.
- `tsconfig.json` — `noUnusedLocals: true` + `noUnusedParameters: true` are strict; causes M1 failures. Fine to keep strict, just fix the code.

### Frontend

- `src/index.ts` — Fine. Exports plugin, ChatPage, API ref, types.
- `src/plugin.tsx` — Correct. Matches govai's pattern exactly. Will work in target app.
- `src/api.ts` — **I5** (SSE chunk shape mismatch). SSE reader (lines 72-99) handles partial chunks correctly via `buffer.split('\n')` + `buffer = lines.pop()`. `AbortController` returned correctly (line 107). `getChatConfig` graceful fallback (line 44). `chatCompletions` citation mapping (lines 123-129) handles multiple field name variants — good defensive coding.
- `src/types.ts` — Matches AGENTS.md:157-164. Adds `ChatConfig` and `Thread` (with `keyToken` — reasonable extension for client-side key storage).
- `src/hooks/useChat.ts` — **I2** (deleteThread stale closure), **I1** (`prev` unused). `sendMessage` correctly patches the assistant message via functional `setThreads` (lines 176-187). localStorage key `litellm-chat:threads:<userId>` matches AGENTS.md:169. Thread title auto-set on first message (line 138) — nice.
- `src/components/ChatPage.tsx` — **I1** (unused `Typography`, invalid `secondaryAction` prop, `ErrorBanner` type mismatch). `identityApiRef` usage correct. `userId` set to `'oidc'` or `'default'` based on token presence (line 44) — simplistic but functional.
- `src/components/ChatComposer.tsx` — Fine. Enter-to-send, Shift+Enter for newline. Stop button appears during streaming.
- `src/components/MessageList.tsx` — **M4** (no markdown rendering). Citation display logic (line 46) only shows on last assistant message when not streaming — correct.
- `src/components/ModelPicker.tsx` — **I1** (unused `Box`). Uses `liteLlmApiRef` from govai correctly. Preselects defaultModel or first model.
- `src/components/VectorStorePicker.tsx` — Fine. "None (no grounding)" option present (AGENTS.md:180). Preselects defaultVectorStoreId.
- `src/components/KeyPicker.tsx` — **M6** (inconsistent truncation 8 vs 7). Empty state links to `/litellm` (AGENTS.md:181). Correct use of `liteLlmApiRef.listKeys()`.
- `src/components/CitationsPanel.tsx` — **M3** (score.toFixed assumes number). Collapsible, shows filename + score + snippet. Matches AGENTS.md:183.
- `src/components/ErrorBanner.tsx` — **I1** (`error` prop type should be optional).
- `package.json` — Missing `react-markdown` (M4). `react-use` in deps but not imported anywhere — could remove. `@backstage/core-components` in deps but not imported — could remove.
- `build.js` — Correct. ESM + CJS dual output. `packages: 'external'` keeps deps external (good for Backstage monorepo).
- `tsconfig.json` — `emitDeclarationOnly: true` + esbuild for JS — correct pattern.

### Root
- `package.json` — Minimal monorepo root. Fine.
- `README.md` — Accurate route table. Lists `/config` (matches implementation, though not in AGENTS.md).

## Recommendations (ordered)

1. **Fix C1** — Update govai's `packages/plugin-litellm-backend/src/index.ts` to add: `export { resolveUserId, toLiteLLMUserId, getOrProvisionUser, ProvisioningError } from './provisioning';`. Build + publish govai backend 0.3.4. Bump chat backend's dep to `^0.3.4`.
2. **Fix C2** — Decide RAG strategy:
   - (Ops) Set `PG_VECTOR_API_BASE=http://litellm-pgvector:8000` env var on the LiteLLM deployment, OR
   - (Code) Swap primary/fallback in `router.ts:154-179`: make `/v1/chat/completions` + `vector_store_ids` primary, drop or demote `/v1/rag/query`.
3. **Fix C3** — Change `router.ts:62` to `/v1/vector_store/list` and normalize response: `data.data.map(s => ({ id: s.vector_store_id, name: s.vector_store_name, status: s.custom_llm_provider }))`.
4. **Fix I1** — Resolve all 6 frontend tsc errors: remove unused `Typography`/`Box` imports, fix `ListItemButton` `secondaryAction` (use `ListItem` wrapper or `disablePadding` + `ListItemIcon`), make `ErrorBannerProps.error` optional, remove unused `prev` param.
5. **Fix I2** — Rewrite `deleteThread` to avoid stale `threads` closure: `setActiveId(threads.find(t => t.id !== id)?.id ?? null)` computed from a `threads` that's guaranteed fresh, or use a `useEffect` watching `threads`/`activeId`.
6. **Fix I4** — Add `"winston": "^3.0.0"` to backend `devDependencies`.
7. **Fix I5** — Update frontend SSE chunk parsing to handle OpenAI shape: `chunk.choices?.[0]?.delta?.content` → delta string. Update `ChatStreamChunk` type or add a mapping in `useChat.ts` onToken.
8. **Fix M4** — Add `react-markdown` + `remark-gfm` to frontend deps. Render assistant content as markdown with sanitization.
9. **Document I6** — Add `/config` route to AGENTS.md route table, or note in README.
10. **Verify M7** — After wiring both govai + chat backend in the target app, run `backstage-cli config:check` to confirm no `config.d.ts` merge conflicts.
11. **Integration test** — After fixes 1-7, `yarn add` both packages to the target Backstage monorepo, add `litellmChatPlugin` to `App.tsx` features and `backend.add(import('@acarmisc/backstage-plugin-litellm-chat-backend'))` to `backend/src/index.ts`, build, and verify `/ai-chat` loads.