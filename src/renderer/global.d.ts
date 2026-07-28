import type { SottoDesktopApi } from '../shared/contracts';

declare global {
  interface Window {
    sotto: SottoDesktopApi;
  }
}

export {};
