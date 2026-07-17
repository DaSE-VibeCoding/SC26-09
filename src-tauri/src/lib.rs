mod agents;
mod files;
mod git;
mod process;
mod sessions;
mod terminal;

use agents::discover_agents;
use files::list_workspace_files;
use git::{git_changes, git_diff};
use sessions::discover_agent_sessions;
use terminal::{terminal_resize, terminal_spawn, terminal_stop, terminal_write, TerminalManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            discover_agents,
            discover_agent_sessions,
            list_workspace_files,
            git_changes,
            git_diff,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pelican");
}
