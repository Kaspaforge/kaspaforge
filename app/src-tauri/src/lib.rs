//! Kaspa Safe — Android entry point.
//!
//! Minimal Tauri 2 mobile shell: the whole product is the bundled web frontend
//! (`frontendDist: ../web`, staged by CI from `web/`), including the WASM signing
//! core. No Rust commands are exposed — the app talks only to the public HTTP API.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("Kaspa Safe: failed to start");
}
