// Types for scripts/build-codex-acp.mjs (imported by tests/scripts/buildCodexAcp.test.ts).
export declare const ROOT: string;
export declare const TARGET: string;
export declare const OUT_DIR: string;
export declare const OUT: string;
export declare const STAMP: string;
export declare const BUN: string;
export declare const COMPILE_FLAGS: readonly string[];
export declare function compileArgs(entry: string, outfile: string, target?: string): string[];
export declare function sha256File(path: string): string;
export declare function stampKey(name: string, version: string, bunVersion: string): string;
export declare function stampMatches(stampText: string, key: string, sha256: string): boolean;
export declare function checkNoAutoload(bin: string): { ok: boolean; loaded: string[]; output: string };
export declare function build(opts?: { fresh?: boolean }): void;
