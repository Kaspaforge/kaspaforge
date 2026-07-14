// kaspa-safe/web/assets/core7.js — shared v7 WASM core (multi-address HD wallet spending).
import init, * as core from './vault-core-v7/kaspa_safe_core.js';
export const ready = init();
export { core };
