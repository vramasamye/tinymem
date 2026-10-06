/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute base URL of the onememory API (e.g. `http://127.0.0.1:7331`). Empty/absent →
   * same-origin relative (`/v1/...` via the Vite dev proxy or a shared origin).
   */
  readonly VITE_ONEMEMORY_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
