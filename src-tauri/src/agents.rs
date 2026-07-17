use crate::process::run_command;
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);
const LOGIN_SHELL_STDOUT_LIMIT: usize = 1024 * 1024;
const LOGIN_SHELL_STDERR_LIMIT: usize = 64 * 1024;
static EXECUTABLE_DIRECTORIES: OnceLock<Vec<PathBuf>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallation {
    agent_id: &'static str,
    executable: Option<String>,
    installed: bool,
}

const AGENTS: [(&str, &str); 3] = [("codex", "codex"), ("claude-code", "claude"), ("pi", "pi")];

#[tauri::command]
pub async fn discover_agents() -> Vec<AgentInstallation> {
    tauri::async_runtime::spawn_blocking(discover_agents_blocking)
        .await
        .unwrap_or_default()
}

fn discover_agents_blocking() -> Vec<AgentInstallation> {
    // Building the search path can invoke the user's login shell. Do it once,
    // not once per agent, to keep application startup responsive.
    let directories = executable_directories();
    AGENTS
        .iter()
        .map(|(agent_id, executable)| {
            let resolved = resolve_executable(executable, directories);
            AgentInstallation {
                agent_id,
                installed: resolved.is_some(),
                executable: resolved.map(|path| path.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

pub(crate) fn executable_directories() -> &'static [PathBuf] {
    EXECUTABLE_DIRECTORIES.get_or_init(build_executable_directories)
}

pub(crate) fn cached_executable_directories() -> Option<&'static [PathBuf]> {
    EXECUTABLE_DIRECTORIES.get().map(Vec::as_slice)
}

fn build_executable_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path));
    }

    #[cfg(unix)]
    directories.extend(login_shell_path());

    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);

    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        directories.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
            home.join(".local/share/mise/shims"),
            home.join(".local/share/pnpm"),
            home.join("Library/pnpm"),
            home.join(".codex/bin"),
            home.join(".nvm/current/bin"),
            home.join(".local/share/fnm/aliases/default/bin"),
            home.join(".fnm/aliases/default/bin"),
        ]);
        directories.extend(versioned_node_directories(&home.join(".nvm/versions/node")));
    }

    directories = directories
        .into_iter()
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(absolute_path)
        .collect();
    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

fn resolve_executable(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    directories
        .iter()
        .find_map(|directory| resolve_in_directory(directory, name))
}

pub(crate) fn resolve_agent_executable(name: &str) -> Option<PathBuf> {
    resolve_executable(name, executable_directories())
}

fn versioned_node_directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut directories = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path().join("bin"))
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        node_version(right)
            .cmp(&node_version(left))
            .then_with(|| right.cmp(left))
    });
    directories
}

fn node_version(path: &Path) -> Vec<u64> {
    path.parent()
        .and_then(Path::file_name)
        .map(|version| {
            version
                .to_string_lossy()
                .trim_start_matches('v')
                .split(|character: char| !character.is_ascii_digit())
                .filter_map(|part| part.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(unix)]
fn login_shell_path() -> Vec<PathBuf> {
    let Some(shell) = env::var_os("SHELL") else {
        return Vec::new();
    };
    let mut command = Command::new(shell);
    command.args(["-lc", "printf %s \"$PATH\""]);
    let Ok(output) = run_command(
        &mut command,
        LOGIN_SHELL_TIMEOUT,
        LOGIN_SHELL_STDOUT_LIMIT,
        LOGIN_SHELL_STDERR_LIMIT,
    ) else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout_truncated {
        return Vec::new();
    }
    let path = String::from_utf8_lossy(&output.stdout);
    env::split_paths(path.as_ref()).collect()
}

#[cfg(unix)]
fn resolve_in_directory(directory: &Path, name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join(name);
    let executable = path
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false);
    executable.then(|| absolute_path(path))
}

#[cfg(windows)]
fn resolve_in_directory(directory: &Path, name: &str) -> Option<PathBuf> {
    let candidate = directory.join(name);
    if candidate.is_file() {
        return Some(absolute_path(candidate));
    }

    let extensions = env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(|extension| extension.trim_start_matches('.').to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|extensions| !extensions.is_empty())
        .unwrap_or_else(|| vec!["COM".into(), "EXE".into(), "BAT".into(), "CMD".into()]);

    extensions.into_iter().find_map(|extension| {
        let candidate = candidate.with_extension(extension);
        candidate.is_file().then(|| absolute_path(candidate))
    })
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map(|directory| directory.join(&path))
            .unwrap_or(path)
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_in_directory, AGENTS};

    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn first_class_agent_order_is_stable() {
        assert_eq!(
            AGENTS,
            [("codex", "codex"), ("claude-code", "claude"), ("pi", "pi")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_only_executable_files_to_absolute_paths() {
        let directory =
            std::env::temp_dir().join(format!("pelican-agent-resolution-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("create test directory");
        let executable = directory.join("pelican-test-agent");
        fs::write(&executable, b"#!/bin/sh\n").expect("write executable");

        let mut permissions = executable.metadata().expect("metadata").permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&executable, permissions).expect("set non-executable permissions");
        assert!(resolve_in_directory(&directory, "pelican-test-agent").is_none());

        let mut permissions = executable.metadata().expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable permissions");
        let resolved =
            resolve_in_directory(&directory, "pelican-test-agent").expect("resolve executable");
        assert!(resolved.is_absolute());
        assert_eq!(resolved, executable);

        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
