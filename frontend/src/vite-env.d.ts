/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KNAIC_API?: string;
  readonly VITE_KNAIC_API_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
