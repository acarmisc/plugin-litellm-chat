var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/api.ts
import { createApiRef } from "@backstage/core-plugin-api";
function normalizeChunk(raw) {
  if (raw && typeof raw === "object" && ("error" in raw || "delta" in raw)) {
    return raw;
  }
  const chunk = {};
  const delta = raw?.choices?.[0]?.delta;
  const content = delta?.content ?? delta?.reasoning_content;
  if (typeof content === "string") chunk.delta = content;
  if (Array.isArray(raw?.search_results)) {
    chunk.search_results = raw.search_results.map((r) => ({
      filename: r.filename ?? r.file_name ?? r.source ?? r.name ?? "",
      score: typeof r.score === "number" ? r.score : 0,
      text: r.text ?? r.snippet ?? r.content ?? ""
    }));
  }
  if (raw?.error) chunk.error = String(raw.error);
  return chunk;
}
var liteLlmChatApiRef, BASE_PATH, LiteLlmChatApi;
var init_api = __esm({
  "src/api.ts"() {
    "use strict";
    liteLlmChatApiRef = createApiRef({
      id: "plugin.litellm-chat.api"
    });
    BASE_PATH = "/api/litellm-chat";
    LiteLlmChatApi = class {
      constructor(fetchApi) {
        this.fetchApi = fetchApi;
      }
      async listVectorStores() {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/vector_stores`);
        if (!res.ok) throw new Error(`vector_stores ${res.status}`);
        return res.json();
      }
      async getChatConfig() {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/config`);
        if (!res.ok) {
          return { defaultModel: null, defaultVectorStoreId: null, maxRequestBudget: null };
        }
        return res.json();
      }
      chatStream(req, onToken, onDone, onError) {
        const controller = new AbortController();
        (async () => {
          try {
            const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/stream`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(req),
              signal: controller.signal
            });
            if (!res.ok || !res.body) {
              const text = await res.text().catch(() => "");
              onError(new Error(`${res.status}: ${text || res.statusText}`));
              return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (; ; ) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") {
                  onDone();
                  return;
                }
                try {
                  const raw = JSON.parse(payload);
                  const chunk = normalizeChunk(raw);
                  if (chunk.delta || chunk.error || chunk.search_results) {
                    onToken(chunk);
                  }
                } catch {
                }
              }
            }
            onDone();
          } catch (err) {
            if (err.name === "AbortError") return;
            onError(err);
          }
        })();
        return controller;
      }
      async chatCompletions(req) {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...req, stream: false })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`${res.status}: ${text}`);
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? data.content ?? "";
        const rawResults = data.search_results ?? data.citations ?? [];
        const citations = rawResults.map((r) => ({
          filename: r.filename ?? r.file_name ?? r.source ?? r.name ?? "",
          score: typeof r.score === "number" ? r.score : 0,
          snippet: r.text ?? r.snippet ?? r.content ?? ""
        }));
        return { content, citations };
      }
      async mintChatKey(opts) {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts ?? {})
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`mint key ${res.status}: ${text}`);
        }
        return res.json();
      }
      async deleteChatKey(key) {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/key`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`delete key ${res.status}: ${text}`);
        }
        return res.json();
      }
    };
  }
});

// src/hooks/useChat.ts
import { useState, useCallback, useRef, useEffect } from "react";
import { useApi } from "@backstage/core-plugin-api";
function loadThreads(userId) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveThreads(userId, threads) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${userId}`, JSON.stringify(threads));
  } catch {
  }
}
function genId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function useChat(opts) {
  const { userId, model, vectorStoreId, keyAlias, keyToken, topK } = opts;
  const api = useApi(liteLlmChatApiRef);
  const [threads, setThreads] = useState(() => loadThreads(userId));
  const [activeId, setActiveId] = useState(
    () => threads[0]?.id ?? null
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [citations, setCitations] = useState([]);
  const abortRef = useRef(null);
  useEffect(() => {
    saveThreads(userId, threads);
  }, [userId, threads]);
  const activeThread = threads.find((t) => t.id === activeId) ?? null;
  const newThread = useCallback(() => {
    const thread = {
      id: genId(),
      title: "New chat",
      messages: [],
      model,
      vectorStoreId,
      keyAlias,
      keyToken,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    setThreads((prev) => [thread, ...prev]);
    setActiveId(thread.id);
    setError(null);
    setCitations([]);
  }, [model, vectorStoreId, keyAlias, keyToken]);
  const selectThread = useCallback((id) => {
    setActiveId(id);
    setError(null);
    setCitations([]);
  }, []);
  const deleteThread = useCallback(
    (id) => {
      const thread = threads.find((t) => t.id === id);
      const remaining = threads.filter((t) => t.id !== id);
      setThreads(remaining);
      if (activeId === id) {
        setActiveId(remaining[0]?.id ?? null);
      }
      if (thread?.keyToken) {
        api.deleteChatKey(thread.keyToken).catch(() => {
        });
      }
    },
    [activeId, threads, api]
  );
  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);
  const sendMessage = useCallback(
    (text) => {
      if (!text.trim() || !activeThread || !keyToken) return;
      setError(null);
      setCitations([]);
      const userMsg = { role: "user", content: text };
      const assistantMsg = { role: "assistant", content: "" };
      const threadId = activeThread.id;
      const updatedMessages = [...activeThread.messages, userMsg, assistantMsg];
      setThreads(
        (prev) => prev.map(
          (t) => t.id === threadId ? {
            ...t,
            messages: updatedMessages,
            title: t.messages.length === 0 ? text.slice(0, 40) : t.title,
            model,
            vectorStoreId,
            keyAlias,
            keyToken,
            updatedAt: Date.now()
          } : t
        )
      );
      setIsStreaming(true);
      const reqMessages = updatedMessages.slice(0, -1);
      const controller = api.chatStream(
        {
          model,
          messages: reqMessages,
          vector_store_id: vectorStoreId ?? void 0,
          top_k: topK,
          user_key: keyToken
        },
        (chunk) => {
          if (chunk.error) {
            setError(chunk.error);
            return;
          }
          if (chunk.search_results) {
            setCitations(
              chunk.search_results.map((r) => ({
                filename: r.filename,
                score: r.score,
                snippet: r.text
              }))
            );
          }
          if (chunk.delta) {
            setThreads(
              (prev) => prev.map((t) => {
                if (t.id !== threadId) return t;
                const msgs = [...t.messages];
                const last = msgs[msgs.length - 1];
                msgs[msgs.length - 1] = {
                  ...last,
                  content: last.content + chunk.delta
                };
                return { ...t, messages: msgs, updatedAt: Date.now() };
              })
            );
          }
        },
        () => {
          setIsStreaming(false);
          abortRef.current = null;
        },
        (err) => {
          setError(err.message);
          setIsStreaming(false);
          abortRef.current = null;
        }
      );
      abortRef.current = controller;
    },
    [activeThread, api, keyToken, model, vectorStoreId, keyAlias, topK]
  );
  return {
    threads,
    activeThread,
    newThread,
    selectThread,
    deleteThread,
    sendMessage,
    stopGeneration,
    isStreaming,
    error,
    citations
  };
}
var STORAGE_PREFIX;
var init_useChat = __esm({
  "src/hooks/useChat.ts"() {
    "use strict";
    init_api();
    STORAGE_PREFIX = "litellm-chat:threads";
  }
});

// src/components/ModelPicker.tsx
import React, { useEffect as useEffect2, useState as useState2 } from "react";
import { Select, MenuItem, FormControl, InputLabel } from "@mui/material";
import { useApi as useApi2 } from "@backstage/core-plugin-api";
import { liteLlmApiRef } from "@acarmisc/backstage-plugin-litellm";
var ModelPicker;
var init_ModelPicker = __esm({
  "src/components/ModelPicker.tsx"() {
    "use strict";
    ModelPicker = ({
      value,
      onChange,
      defaultModel
    }) => {
      const liteLlmApi = useApi2(liteLlmApiRef);
      const [models, setModels] = useState2([]);
      const [loading, setLoading] = useState2(true);
      useEffect2(() => {
        let alive = true;
        liteLlmApi.listModels().then((all) => {
          if (!alive) return;
          const m = all.filter((x) => !x.model_name.startsWith("claude"));
          setModels(m);
          if (!value && m.length) {
            const def = defaultModel && m.find((x) => x.model_name === defaultModel)?.model_name || m[0].model_name;
            onChange(def);
          }
        }).catch(() => {
        }).finally(() => alive && setLoading(false));
        return () => {
          alive = false;
        };
      }, []);
      return /* @__PURE__ */ React.createElement(FormControl, { size: "small", sx: { minWidth: 200 } }, /* @__PURE__ */ React.createElement(InputLabel, null, "Model"), /* @__PURE__ */ React.createElement(
        Select,
        {
          value,
          label: "Model",
          onChange: (e) => onChange(e.target.value),
          disabled: loading
        },
        models.map((m) => /* @__PURE__ */ React.createElement(MenuItem, { key: m.model_name, value: m.model_name }, m.model_name))
      ));
    };
  }
});

// src/components/VectorStorePicker.tsx
import React2, { useEffect as useEffect3, useState as useState3 } from "react";
import { Select as Select2, MenuItem as MenuItem2, FormControl as FormControl2, InputLabel as InputLabel2 } from "@mui/material";
import { useApi as useApi3 } from "@backstage/core-plugin-api";
var VectorStorePicker;
var init_VectorStorePicker = __esm({
  "src/components/VectorStorePicker.tsx"() {
    "use strict";
    init_api();
    VectorStorePicker = ({
      value,
      onChange,
      defaultVectorStoreId
    }) => {
      const chatApi = useApi3(liteLlmChatApiRef);
      const [stores, setStores] = useState3([]);
      const [loading, setLoading] = useState3(true);
      useEffect3(() => {
        let alive = true;
        chatApi.listVectorStores().then((s) => {
          if (!alive) return;
          setStores(s);
          if (value === null && s.length) {
            const def = defaultVectorStoreId && s.find((x) => x.id === defaultVectorStoreId)?.id || null;
            onChange(def);
          }
        }).catch(() => {
        }).finally(() => alive && setLoading(false));
        return () => {
          alive = false;
        };
      }, []);
      return /* @__PURE__ */ React2.createElement(FormControl2, { size: "small", sx: { minWidth: 200 } }, /* @__PURE__ */ React2.createElement(InputLabel2, null, "Knowledge base"), /* @__PURE__ */ React2.createElement(
        Select2,
        {
          value: value ?? "",
          label: "Knowledge base",
          onChange: (e) => onChange(e.target.value === "" ? null : e.target.value),
          disabled: loading
        },
        /* @__PURE__ */ React2.createElement(MenuItem2, { value: "" }, /* @__PURE__ */ React2.createElement("em", null, "None (no grounding)")),
        stores.map((s) => /* @__PURE__ */ React2.createElement(MenuItem2, { key: s.id, value: s.id }, s.name, " ", s.file_count != null ? `(${s.file_count})` : ""))
      ));
    };
  }
});

// src/components/KeyPicker.tsx
import React3, { useState as useState4 } from "react";
import { Button, Box, Typography, CircularProgress, Tooltip, IconButton } from "@mui/material";
import KeyIcon from "@mui/icons-material/VpnKey";
import DeleteIcon from "@mui/icons-material/Delete";
import { useApi as useApi4 } from "@backstage/core-plugin-api";
var KeyPicker;
var init_KeyPicker = __esm({
  "src/components/KeyPicker.tsx"() {
    "use strict";
    init_api();
    KeyPicker = ({ value, onChange, onDelete }) => {
      const chatApi = useApi4(liteLlmChatApiRef);
      const [loading, setLoading] = useState4(false);
      const [error, setError] = useState4(null);
      const handleGenerate = async () => {
        setLoading(true);
        setError(null);
        try {
          const keyInfo = await chatApi.mintChatKey();
          onChange({ alias: keyInfo.key_alias, token: keyInfo.key });
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      };
      const handleDelete = async () => {
        if (!value.token) return;
        try {
          await chatApi.deleteChatKey(value.token);
        } catch {
        }
        onDelete?.();
        onChange({ alias: "", token: "" });
      };
      if (value.token) {
        return /* @__PURE__ */ React3.createElement(Box, { sx: { display: "flex", alignItems: "center", gap: 1, minWidth: 200 } }, /* @__PURE__ */ React3.createElement(KeyIcon, { fontSize: "small", color: "success" }), /* @__PURE__ */ React3.createElement(Typography, { variant: "body2", sx: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" } }, value.alias || "chat key"), /* @__PURE__ */ React3.createElement(Tooltip, { title: "Delete chat key" }, /* @__PURE__ */ React3.createElement(IconButton, { edge: "end", size: "small", onClick: handleDelete }, /* @__PURE__ */ React3.createElement(DeleteIcon, { fontSize: "small" }))));
      }
      return /* @__PURE__ */ React3.createElement(Box, { sx: { minWidth: 200 } }, /* @__PURE__ */ React3.createElement(
        Button,
        {
          size: "small",
          variant: "outlined",
          startIcon: loading ? /* @__PURE__ */ React3.createElement(CircularProgress, { size: 16 }) : /* @__PURE__ */ React3.createElement(KeyIcon, null),
          onClick: handleGenerate,
          disabled: loading
        },
        loading ? "Minting\u2026" : "Generate chat key"
      ), error && /* @__PURE__ */ React3.createElement(Typography, { variant: "caption", color: "error", sx: { display: "block", mt: 0.5 } }, error));
    };
  }
});

// src/components/CitationsPanel.tsx
import React4, { useState as useState5 } from "react";
import {
  Collapse,
  IconButton as IconButton2,
  Box as Box2,
  Typography as Typography2,
  Chip
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
var CitationsPanel;
var init_CitationsPanel = __esm({
  "src/components/CitationsPanel.tsx"() {
    "use strict";
    CitationsPanel = ({ citations }) => {
      const [expanded, setExpanded] = useState5(false);
      if (!citations.length) return null;
      return /* @__PURE__ */ React4.createElement(Box2, { sx: { mt: 1, border: 1, borderColor: "divider", borderRadius: 1 } }, /* @__PURE__ */ React4.createElement(
        Box2,
        {
          sx: {
            display: "flex",
            alignItems: "center",
            cursor: "pointer",
            px: 1,
            py: 0.5
          },
          onClick: () => setExpanded((v) => !v)
        },
        /* @__PURE__ */ React4.createElement(IconButton2, { size: "small", sx: { p: 0.5, transform: expanded ? "rotate(180deg)" : "none" } }, /* @__PURE__ */ React4.createElement(ExpandMoreIcon, { fontSize: "small" })),
        /* @__PURE__ */ React4.createElement(Typography2, { variant: "caption", color: "text.secondary" }, citations.length, " source", citations.length > 1 ? "s" : "")
      ), /* @__PURE__ */ React4.createElement(Collapse, { in: expanded }, /* @__PURE__ */ React4.createElement(Box2, { sx: { px: 1, pb: 1 } }, citations.map((c, i) => /* @__PURE__ */ React4.createElement(Box2, { key: i, sx: { mb: 1 } }, /* @__PURE__ */ React4.createElement(Box2, { sx: { display: "flex", gap: 1, alignItems: "center" } }, /* @__PURE__ */ React4.createElement(Typography2, { variant: "body2", fontWeight: 500 }, c.filename), /* @__PURE__ */ React4.createElement(
        Chip,
        {
          size: "small",
          label: c.score.toFixed(3),
          color: "primary",
          variant: "outlined"
        }
      )), /* @__PURE__ */ React4.createElement(
        Typography2,
        {
          variant: "body2",
          color: "text.secondary",
          sx: {
            mt: 0.5,
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: "0.75rem"
          }
        },
        c.snippet
      ))))));
    };
  }
});

// src/components/MessageList.tsx
import React5 from "react";
import { Box as Box3, Typography as Typography3 } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
var blink, MessageList;
var init_MessageList = __esm({
  "src/components/MessageList.tsx"() {
    "use strict";
    init_CitationsPanel();
    blink = {
      "@keyframes blink": {
        "0%, 50%": { opacity: 1 },
        "51%, 100%": { opacity: 0 }
      }
    };
    MessageList = ({
      messages,
      citations,
      isStreaming
    }) => {
      return /* @__PURE__ */ React5.createElement(
        Box3,
        {
          sx: {
            flex: 1,
            overflowY: "auto",
            px: 2,
            py: 1,
            display: "flex",
            flexDirection: "column",
            gap: 1.5
          }
        },
        messages.length === 0 && /* @__PURE__ */ React5.createElement(
          Box3,
          {
            sx: {
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }
          },
          /* @__PURE__ */ React5.createElement(Typography3, { color: "text.secondary" }, "Start a conversation\u2026")
        ),
        messages.map((msg, i) => {
          const isUser = msg.role === "user";
          const isLast = i === messages.length - 1;
          const showCitations = !isUser && isLast && !isStreaming && citations.length > 0;
          return /* @__PURE__ */ React5.createElement(
            Box3,
            {
              key: i,
              sx: {
                alignSelf: isUser ? "flex-end" : "flex-start",
                maxWidth: "80%"
              }
            },
            /* @__PURE__ */ React5.createElement(
              Box3,
              {
                sx: {
                  bgcolor: isUser ? "primary.main" : "background.paper",
                  color: isUser ? "primary.contrastText" : "text.primary",
                  border: isUser ? "none" : 1,
                  borderColor: "divider",
                  borderRadius: 2,
                  px: 1.5,
                  py: 1,
                  wordBreak: "break-word",
                  "& p": { margin: 0 },
                  "& pre": { overflowX: "auto", maxWidth: "100%" },
                  "& code": {
                    fontFamily: "monospace",
                    fontSize: "0.85em",
                    bgcolor: isUser ? "transparent" : "action.hover",
                    px: 0.5,
                    borderRadius: 0.5
                  },
                  "& pre code": { bgcolor: "transparent", px: 0 }
                }
              },
              isUser ? /* @__PURE__ */ React5.createElement(Box3, { sx: { whiteSpace: "pre-wrap" } }, msg.content) : msg.content ? /* @__PURE__ */ React5.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, msg.content) : isStreaming && isLast ? /* @__PURE__ */ React5.createElement(
                Box3,
                {
                  component: "span",
                  sx: {
                    display: "inline-block",
                    width: 8,
                    height: 16,
                    bgcolor: "text.primary",
                    animation: "blink 1s step-end infinite",
                    verticalAlign: "text-bottom",
                    ...blink
                  }
                }
              ) : null
            ),
            showCitations && /* @__PURE__ */ React5.createElement(CitationsPanel, { citations })
          );
        })
      );
    };
  }
});

// src/components/ErrorBanner.tsx
import React6 from "react";
import { Alert, AlertTitle } from "@mui/material";
var ErrorBanner;
var init_ErrorBanner = __esm({
  "src/components/ErrorBanner.tsx"() {
    "use strict";
    ErrorBanner = ({ error, onDismiss }) => {
      if (!error) return null;
      return /* @__PURE__ */ React6.createElement(Alert, { severity: "error", onClose: onDismiss, sx: { mb: 1 } }, /* @__PURE__ */ React6.createElement(AlertTitle, null, "Chat error"), error);
    };
  }
});

// src/components/ChatPage.tsx
var ChatPage_exports = {};
__export(ChatPage_exports, {
  ChatPage: () => ChatPage
});
import React7, { useEffect as useEffect4, useState as useState6, useRef as useRef2 } from "react";
import {
  Box as Box4,
  Button as Button2,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton as IconButton3,
  Divider,
  Typography as Typography4,
  Collapse as Collapse2,
  Tooltip as Tooltip2,
  InputBase
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon2 from "@mui/icons-material/Delete";
import SettingsIcon from "@mui/icons-material/Settings";
import ExpandMoreIcon2 from "@mui/icons-material/ExpandMore";
import ChatIcon from "@mui/icons-material/Chat";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import { useApi as useApi5, identityApiRef } from "@backstage/core-plugin-api";
var SIDEBAR_WIDTH, ChatPage;
var init_ChatPage = __esm({
  "src/components/ChatPage.tsx"() {
    "use strict";
    init_api();
    init_useChat();
    init_ModelPicker();
    init_VectorStorePicker();
    init_KeyPicker();
    init_MessageList();
    init_ErrorBanner();
    SIDEBAR_WIDTH = 280;
    ChatPage = () => {
      const chatApi = useApi5(liteLlmChatApiRef);
      const identityApi = useApi5(identityApiRef);
      const [userId, setUserId] = useState6("default");
      const [config, setConfig] = useState6({
        defaultModel: null,
        defaultVectorStoreId: null,
        maxRequestBudget: null
      });
      const [model, setModel] = useState6("");
      const [vectorStoreId, setVectorStoreId] = useState6(null);
      const [keyVal, setKeyVal] = useState6({
        alias: "",
        token: ""
      });
      const [showSettings, setShowSettings] = useState6(true);
      const [input, setInput] = useState6("");
      const messagesEndRef = useRef2(null);
      const messagesContainerRef = useRef2(null);
      useEffect4(() => {
        chatApi.getChatConfig().then(setConfig).catch(() => {
        });
        identityApi.getCredentials().then((c) => setUserId(c.token ? "oidc" : "default")).catch(() => {
        });
      }, [chatApi, identityApi]);
      const chat = useChat({
        userId,
        model,
        vectorStoreId,
        keyAlias: keyVal.alias,
        keyToken: keyVal.token,
        topK: 5
      });
      const messages = chat.activeThread?.messages ?? [];
      const isStreaming = chat.isStreaming;
      useEffect4(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, [messages, isStreaming]);
      const handleSend = () => {
        if (!input.trim() || !keyVal.token || isStreaming) return;
        if (!chat.activeThread) {
          chat.newThread();
        }
        chat.sendMessage(input.trim());
        setInput("");
      };
      const handleKeyDown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      };
      return /* @__PURE__ */ React7.createElement(Box4, { sx: { display: "flex", height: "100dvh", overflow: "hidden" } }, /* @__PURE__ */ React7.createElement(
        Box4,
        {
          sx: {
            width: SIDEBAR_WIDTH,
            flexShrink: 0,
            borderRight: 1,
            borderColor: "divider",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }
        },
        /* @__PURE__ */ React7.createElement(Box4, { sx: { p: 1.5 } }, /* @__PURE__ */ React7.createElement(
          Button2,
          {
            fullWidth: true,
            variant: "outlined",
            startIcon: /* @__PURE__ */ React7.createElement(AddIcon, null),
            onClick: chat.newThread,
            size: "small"
          },
          "New chat"
        )),
        /* @__PURE__ */ React7.createElement(Box4, { sx: { flex: 1, overflowY: "auto", minHeight: 0 } }, /* @__PURE__ */ React7.createElement(List, { dense: true }, chat.threads.map((t) => /* @__PURE__ */ React7.createElement(
          ListItem,
          {
            key: t.id,
            disablePadding: true,
            secondaryAction: /* @__PURE__ */ React7.createElement(
              IconButton3,
              {
                edge: "end",
                size: "small",
                onClick: (e) => {
                  e.stopPropagation();
                  chat.deleteThread(t.id);
                }
              },
              /* @__PURE__ */ React7.createElement(DeleteIcon2, { fontSize: "small" })
            )
          },
          /* @__PURE__ */ React7.createElement(
            ListItemButton,
            {
              selected: chat.activeThread?.id === t.id,
              onClick: () => chat.selectThread(t.id),
              sx: { pr: 6 }
            },
            /* @__PURE__ */ React7.createElement(
              ListItemText,
              {
                primary: t.title,
                primaryTypographyProps: { noWrap: true, variant: "body2" },
                secondaryTypographyProps: { noWrap: true, variant: "caption" }
              }
            )
          )
        )))),
        /* @__PURE__ */ React7.createElement(Divider, null),
        /* @__PURE__ */ React7.createElement(Box4, { sx: { flexShrink: 0 } }, /* @__PURE__ */ React7.createElement(
          Box4,
          {
            sx: {
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              px: 1.5,
              py: 1,
              bgcolor: "action.hover"
            },
            onClick: () => setShowSettings((v) => !v)
          },
          /* @__PURE__ */ React7.createElement(SettingsIcon, { fontSize: "small", sx: { mr: 1 } }),
          /* @__PURE__ */ React7.createElement(Typography4, { variant: "overline", sx: { flex: 1 } }, "Settings"),
          /* @__PURE__ */ React7.createElement(
            ExpandMoreIcon2,
            {
              fontSize: "small",
              sx: {
                transform: showSettings ? "rotate(180deg)" : "none",
                transition: "transform 0.2s"
              }
            }
          )
        ), /* @__PURE__ */ React7.createElement(Collapse2, { in: showSettings }, /* @__PURE__ */ React7.createElement(Box4, { sx: { p: 1.5, display: "flex", flexDirection: "column", gap: 1.5 } }, /* @__PURE__ */ React7.createElement(ModelPicker, { value: model, onChange: setModel, defaultModel: config.defaultModel }), /* @__PURE__ */ React7.createElement(
          VectorStorePicker,
          {
            value: vectorStoreId,
            onChange: setVectorStoreId,
            defaultVectorStoreId: config.defaultVectorStoreId
          }
        ), /* @__PURE__ */ React7.createElement(
          KeyPicker,
          {
            value: keyVal,
            onChange: setKeyVal,
            onDelete: () => {
              if (chat.activeThread?.keyToken) {
                chatApi.deleteChatKey(chat.activeThread.keyToken).catch(() => {
                });
              }
            }
          }
        ))))
      ), /* @__PURE__ */ React7.createElement(
        Box4,
        {
          sx: {
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }
        },
        /* @__PURE__ */ React7.createElement(
          Box4,
          {
            sx: {
              flexShrink: 0,
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: "divider",
              display: "flex",
              alignItems: "center",
              gap: 1
            }
          },
          /* @__PURE__ */ React7.createElement(ChatIcon, { fontSize: "small", color: "action" }),
          /* @__PURE__ */ React7.createElement(Typography4, { variant: "subtitle2", noWrap: true, sx: { flex: 1 } }, chat.activeThread?.title ?? "AI Chat"),
          model && /* @__PURE__ */ React7.createElement(Typography4, { variant: "caption", color: "text.secondary" }, model)
        ),
        chat.error && /* @__PURE__ */ React7.createElement(Box4, { sx: { px: 2, pt: 1 } }, /* @__PURE__ */ React7.createElement(ErrorBanner, { error: chat.error, onDismiss: () => {
        } })),
        /* @__PURE__ */ React7.createElement(
          Box4,
          {
            ref: messagesContainerRef,
            sx: {
              flex: 1,
              overflowY: "auto",
              minHeight: 0
            }
          },
          /* @__PURE__ */ React7.createElement(
            MessageList,
            {
              messages,
              citations: chat.citations,
              isStreaming
            }
          ),
          /* @__PURE__ */ React7.createElement("div", { ref: messagesEndRef })
        ),
        /* @__PURE__ */ React7.createElement(
          Box4,
          {
            sx: {
              flexShrink: 0,
              borderTop: 1,
              borderColor: "divider",
              px: 2,
              py: 1.5,
              display: "flex",
              gap: 1,
              alignItems: "flex-end"
            }
          },
          /* @__PURE__ */ React7.createElement(
            InputBase,
            {
              multiline: true,
              minRows: 1,
              maxRows: 5,
              fullWidth: true,
              placeholder: keyVal.token ? "Send a message\u2026  (Enter to send, Shift+Enter for newline)" : "Generate a chat key in Settings to start\u2026",
              value: input,
              onChange: (e) => setInput(e.target.value),
              onKeyDown: handleKeyDown,
              disabled: !keyVal.token,
              sx: {
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                px: 1.5,
                py: 0.75,
                fontSize: "0.9rem"
              }
            }
          ),
          isStreaming ? /* @__PURE__ */ React7.createElement(Tooltip2, { title: "Stop" }, /* @__PURE__ */ React7.createElement(IconButton3, { color: "error", onClick: chat.stopGeneration }, /* @__PURE__ */ React7.createElement(StopIcon, null))) : /* @__PURE__ */ React7.createElement(Tooltip2, { title: "Send" }, /* @__PURE__ */ React7.createElement(
            IconButton3,
            {
              color: "primary",
              onClick: handleSend,
              disabled: !input.trim() || !keyVal.token
            },
            /* @__PURE__ */ React7.createElement(SendIcon, null)
          ))
        )
      ));
    };
  }
});

// src/plugin.tsx
init_api();
import React8 from "react";
import { Chat as ChatIcon2 } from "@mui/icons-material";
import {
  createFrontendPlugin,
  ApiBlueprint,
  PageBlueprint,
  fetchApiRef
} from "@backstage/frontend-plugin-api";
var liteLlmChatApi = ApiBlueprint.make({
  params: (defineParams) => defineParams({
    api: liteLlmChatApiRef,
    deps: { fetchApi: fetchApiRef },
    factory: ({ fetchApi }) => new LiteLlmChatApi(fetchApi)
  })
});
var chatPage = PageBlueprint.make({
  params: {
    path: "/ai-chat",
    title: "AI Chat",
    icon: /* @__PURE__ */ React8.createElement(ChatIcon2, null),
    loader: async () => {
      const { ChatPage: ChatPage2 } = await Promise.resolve().then(() => (init_ChatPage(), ChatPage_exports));
      return /* @__PURE__ */ React8.createElement(ChatPage2, null);
    }
  }
});
var litellmChatPlugin = createFrontendPlugin({
  pluginId: "litellm-chat",
  extensions: [liteLlmChatApi, chatPage]
});

// src/index.ts
init_ChatPage();
init_api();
export {
  ChatPage,
  LiteLlmChatApi,
  liteLlmChatApiRef,
  litellmChatPlugin
};
//# sourceMappingURL=index.esm.js.map
