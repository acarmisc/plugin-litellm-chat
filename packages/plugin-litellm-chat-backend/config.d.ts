export interface Config {
  litellm: {
    /**
     * Base URL of the LiteLLM proxy instance.
     * @visibility backend
     */
    baseUrl: string;

    /**
     * LiteLLM master key for admin operations. Never exposed to the frontend.
     * @visibility secret
     */
    masterKey: string;

    /**
     * Email domain appended to the Backstage user entity name to form the
     * LiteLLM user_id. Inherited from the govai plugin config.
     * @visibility backend
     */
    userIdDomain?: string;

    /**
     * Optional chat-specific defaults. Pre-selected in the UI when present.
     * All fields optional — the user can override in the pickers.
     * @visibility frontend
     */
    chat?: {
      /**
       * Model ID pre-selected in the model picker on first load.
       */
      defaultModel?: string;

      /**
       * Vector store ID pre-selected in the KB picker on first load.
       */
      defaultVectorStoreId?: string;

      /**
       * Soft USD guard surfaced to the UI. Real enforcement is per-key
       * in LiteLLM; this is advisory only.
       */
      maxRequestBudget?: number;
    };
  };
}