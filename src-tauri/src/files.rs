use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_DEPTH: usize = 4;
const MAX_ENTRIES: usize = 1_500;
const IGNORED_DIRECTORIES: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    relative_path: String,
    is_directory: bool,
    depth: usize,
}

#[tauri::command]
pub async fn list_workspace_files(root: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_files_blocking(root))
        .await
        .map_err(|error| format!("Unable to schedule workspace scan: {error}"))?
}

fn list_workspace_files_blocking(root: String) -> Result<Vec<FileEntry>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("Workspace path is not a directory".into());
    }

    let mut entries = Vec::new();
    collect_entries(root_path, root_path, 0, &mut entries)?;
    Ok(entries)
}

fn collect_entries(
    root: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<FileEntry>,
) -> Result<(), String> {
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        return Ok(());
    }

    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    children.sort_by_key(|entry| {
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(true);
        (is_file, entry.file_name().to_string_lossy().to_lowercase())
    });

    for child in children {
        if output.len() >= MAX_ENTRIES {
            break;
        }
        let name = child.file_name().to_string_lossy().into_owned();
        let is_directory = child.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_directory && IGNORED_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }
        let path = child.path();
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        output.push(FileEntry {
            name,
            relative_path,
            is_directory,
            depth,
        });
        if is_directory {
            collect_entries(root, &path, depth + 1, output)?;
        }
    }
    Ok(())
}
