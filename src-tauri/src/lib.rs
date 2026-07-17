mod agents;
mod files;
mod git;
mod process;
mod session_host;
mod sessions;
mod terminal;

use agents::discover_agents;
use files::list_workspace_files;
use git::{git_changes, git_diff};
use session_host::{
    session_list, session_open, session_resize, session_send, session_stop, terminal_list_sessions,
    terminal_resize, terminal_spawn, terminal_stop, terminal_write, SessionHost,
};
use sessions::discover_agent_sessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(SessionHost::default())
        .invoke_handler(tauri::generate_handler![
            discover_agents,
            discover_agent_sessions,
            list_workspace_files,
            git_changes,
            git_diff,
            session_open,
            session_send,
            session_resize,
            session_stop,
            session_list,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_stop,
            terminal_list_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pelican");
}
