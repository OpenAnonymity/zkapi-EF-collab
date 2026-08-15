/* tslint:disable */
/* eslint-disable */

export function browser_complete_response(config_json: string, args_json: string): string;

export function browser_confirm_deposit(config_json: string, args_json: string): string;

export function browser_generate_deposit(): string;

export function browser_prepare_request(config_json: string, state_json: string, args_json: string, proving_key: Uint8Array): string;

export function browser_prepare_withdrawal(config_json: string, state_json: string, args_json: string, proving_key: Uint8Array): string;

export function browser_tree_path(snapshot_json: string, note_id: number, require_existing: boolean): string;

export function browser_wallet_status(state_json?: string | null, journal_json?: string | null): string;

export function browser_withdrawal_nullifier(state_json: string): string;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly browser_complete_response: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_confirm_deposit: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_generate_deposit: () => [number, number, number, number];
    readonly browser_prepare_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly browser_prepare_withdrawal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly browser_tree_path: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_wallet_status: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_withdrawal_nullifier: (a: number, b: number) => [number, number, number, number];
    readonly start: () => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
