import type { SuperHarnessApi } from '../shared/types';

declare global {
  interface Window {
    superHarness: SuperHarnessApi;
  }
}

export {};
