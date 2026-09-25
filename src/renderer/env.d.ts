/// <reference types="vite/client" />
import type { HopecodeApi } from '../shared/ipc';

declare global {
  interface Window {
    hopecode: HopecodeApi;
  }
}

export {};
