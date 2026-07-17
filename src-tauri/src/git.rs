use crate::process::{run_command, BoundedOutput};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MAX_CHANGES: usize = 5_000;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const GIT_STATUS_CAPTURE_LIMIT: usize = 16 * 1024 * 1024;
const GIT_DIFF_CAPTURE_LIMIT: usize = MAX_DIFF_BYTES + 4;
const GIT_PATH_CAPTURE_LIMIT: usize = 1024 * 1024;
const GIT_STDERR_CAPTURE_LIMIT: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    path: String,
    index_status: String,
    worktree_status: String,
}

#[tauri::command]
pub async fn git_changes(root: String) -> Result<Vec<GitChange>, String> {
    tauri::async_runtime::spawn_blocking(move || git_changes_blocking(root))
        .await
        .map_err(|error| format!("Unable to schedule Git status: {error}"))?
}

fn git_changes_blocking(root: String) -> Result<Vec<GitChange>, String> {
    let root = validate_root(&root)?;
    let mut command = git_command(&root);
    command.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let output = run_git(&mut command, GIT_STATUS_CAPTURE_LIMIT)?;

    if !output.status.success() {
        let details = output_message(&output);
        // A workspace does not have to be a Git repository. Keep the file browser
        // usable in that case while surfacing real Git failures to the caller.
        if details.contains("not a git repository") {
            return Ok(Vec::new());
        }
        return Err(command_error("read Git status", &output));
    }
    if output.stdout_truncated {
        return Err("Unable to read Git status: output exceeded the 16 MiB limit".into());
    }

    Ok(parse_status_output(&output.stdout))
}

fn parse_status_output(output: &[u8]) -> Vec<GitChange> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    let mut changes: Vec<GitChange> = Vec::new();
    let mut positions = HashMap::<String, usize>::new();

    while let Some(entry) = records.next() {
        let Some(change) = parse_status_entry(entry) else {
            continue;
        };

        // In porcelain v1's -z format a rename/copy is encoded as two NUL
        // records: `XY destination\0source\0`. The source record has no status
        // prefix and must not become a second, corrupt change entry.
        if is_rename_or_copy(&change) {
            let _ = records.next();
        }

        if let Some(position) = positions.get(&change.path).copied() {
            merge_change(&mut changes[position], change);
        } else if changes.len() < MAX_CHANGES {
            positions.insert(change.path.clone(), changes.len());
            changes.push(change);
        }
    }

    changes
}

fn parse_status_entry(entry: &[u8]) -> Option<GitChange> {
    if entry.len() < 4 || entry[2] != b' ' {
        return None;
    }
    let path = String::from_utf8_lossy(&entry[3..]).into_owned();
    if path.is_empty() {
        return None;
    }
    Some(GitChange {
        path,
        index_status: char::from(entry[0]).to_string(),
        worktree_status: char::from(entry[1]).to_string(),
    })
}

fn is_rename_or_copy(change: &GitChange) -> bool {
    matches!(change.index_status.as_str(), "R" | "C")
        || matches!(change.worktree_status.as_str(), "R" | "C")
}

fn merge_change(current: &mut GitChange, incoming: GitChange) {
    merge_status(&mut current.index_status, incoming.index_status);
    merge_status(&mut current.worktree_status, incoming.worktree_status);
}

fn merge_status(current: &mut String, incoming: String) {
    fn priority(status: &str) -> u8 {
        match status {
            " " => 0,
            "?" => 1,
            _ => 2,
        }
    }

    if priority(&incoming) > priority(current) {
        *current = incoming;
    }
}

#[tauri::command]
pub async fn git_diff(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_blocking(root, path))
        .await
        .map_err(|error| format!("Unable to schedule Git diff: {error}"))?
}

fn git_diff_blocking(root: String, path: String) -> Result<String, String> {
    let root = validate_root(&root)?;
    validate_relative_path(&path)?;

    let staged = tracked_diff(&root, &path, true)?;
    let unstaged = tracked_diff(&root, &path, false)?;
    let untracked = is_untracked(&root, &path)?
        .then(|| untracked_diff(&root, &path))
        .transpose()?;
    let mut sections = Vec::new();
    if !staged.is_empty() {
        sections.push(("Staged changes", staged));
    }
    if !unstaged.is_empty() {
        sections.push(("Unstaged changes", unstaged));
    }
    if let Some(untracked) = untracked.filter(|diff| !diff.is_empty()) {
        sections.push(("Untracked file", untracked));
    }
    let mut diff = match sections.len() {
        0 => String::new(),
        1 => sections.pop().expect("one diff section").1,
        _ => sections
            .into_iter()
            .map(|(label, contents)| format!("{label}:\n{contents}"))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    truncate_diff(&mut diff, false);
    Ok(diff)
}

fn tracked_diff(root: &Path, path: &str, cached: bool) -> Result<String, String> {
    let mut command = git_command(root);
    command.arg("--literal-pathspecs").arg("diff");
    if cached {
        command.arg("--cached");
    }
    command
        .args([
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
        ])
        .arg(path);
    let output = run_git(&mut command, GIT_DIFF_CAPTURE_LIMIT)?;
    if !output.status.success() {
        return Err(command_error("read Git diff", &output));
    }
    Ok(decode_diff(&output))
}

fn is_untracked(root: &Path, path: &str) -> Result<bool, String> {
    let mut command = git_command(root);
    command
        .arg("--literal-pathspecs")
        .args(["ls-files", "--others", "--exclude-standard", "-z", "--"])
        .arg(path);
    let output = run_git(&mut command, GIT_PATH_CAPTURE_LIMIT)?;
    if !output.status.success() {
        return Err(command_error("inspect untracked file", &output));
    }
    if output.stdout_truncated {
        return Err("Unable to inspect untracked file: output exceeded the 1 MiB limit".into());
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .any(|entry| entry == path.as_bytes()))
}

fn untracked_diff(root: &Path, path: &str) -> Result<String, String> {
    #[cfg(unix)]
    const NULL_DEVICE: &str = "/dev/null";
    #[cfg(windows)]
    const NULL_DEVICE: &str = "NUL";

    let mut command = git_command(root);
    command
        .args([
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            NULL_DEVICE,
        ])
        .arg(path);
    let output = run_git(&mut command, GIT_DIFF_CAPTURE_LIMIT)?;

    // `git diff --no-index` returns 1 when differences were found.
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(command_error("read untracked file diff", &output));
    }
    let diff = decode_diff(&output);
    if diff.is_empty() && root.join(path).symlink_metadata().is_ok() {
        return Ok(format!("New empty file: {path}\n"));
    }
    Ok(diff)
}

fn decode_diff(output: &BoundedOutput) -> String {
    let mut diff = String::from_utf8_lossy(&output.stdout).into_owned();
    truncate_diff(&mut diff, output.stdout_truncated);
    diff
}

fn truncate_diff(diff: &mut String, force_marker: bool) {
    if diff.len() <= MAX_DIFF_BYTES && !force_marker {
        return;
    }
    if diff.len() > MAX_DIFF_BYTES {
        let mut end = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        diff.truncate(end);
    }
    diff.push_str("\n\n… Diff truncated by Pelican (2 MiB limit).\n");
}

fn run_git(command: &mut Command, stdout_limit: usize) -> Result<BoundedOutput, String> {
    run_command(
        command,
        GIT_COMMAND_TIMEOUT,
        stdout_limit,
        GIT_STDERR_CAPTURE_LIMIT,
    )
    .map_err(|error| format!("Unable to run Git: {error}"))
}

fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(["-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(root)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn output_message(output: &BoundedOutput) -> String {
    let mut stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !stderr.is_empty() {
        if output.stderr_truncated {
            stderr.push_str(" … (stderr truncated)");
        }
        return stderr;
    }
    let mut stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.stdout_truncated {
        stdout.push_str(" … (stdout truncated)");
    }
    stdout
}

fn command_error(action: &str, output: &BoundedOutput) -> String {
    let details = output_message(output);
    if details.is_empty() {
        format!("Unable to {action}: Git exited with {}", output.status)
    } else {
        format!("Unable to {action}: {details}")
    }
}

fn validate_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if !path.is_dir() {
        return Err("Workspace path is not a directory".into());
    }
    path.canonicalize()
        .map_err(|error| format!("Unable to resolve workspace path: {error}"))
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\0')
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Git path must be relative to the workspace".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        git_changes_blocking, git_diff_blocking, parse_status_output, truncate_diff,
        validate_relative_path, MAX_DIFF_BYTES,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_REPOSITORY: AtomicUsize = AtomicUsize::new(0);

    struct TestRepository {
        path: PathBuf,
    }

    impl TestRepository {
        fn new(initialize_git: bool) -> Self {
            let suffix = NEXT_REPOSITORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("pelican-git-test-{}-{suffix}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create test repository");
            let repository = Self { path };
            if initialize_git {
                repository.git(&["init", "-q"]);
                repository.git(&["config", "user.email", "pelican@example.invalid"]);
                repository.git(&["config", "user.name", "Pelican Test"]);
            }
            repository
        }

        fn git(&self, arguments: &[&str]) {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.path)
                .args(arguments)
                .output()
                .expect("run Git in test repository");
            assert!(
                output.status.success(),
                "Git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn write(&self, path: &str, contents: &str) {
            fs::write(self.path.join(path), contents).expect("write test file");
        }

        fn path_string(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parses_porcelain_status() {
        let changes = parse_status_output(b" M src/App.tsx\0");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "src/App.tsx");
        assert_eq!(changes[0].index_status, " ");
        assert_eq!(changes[0].worktree_status, "M");
    }

    #[test]
    fn consumes_rename_source_record() {
        let changes = parse_status_output(b"R  new name.txt\0old name.txt\0");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "new name.txt");
        assert_eq!(changes[0].index_status, "R");
    }

    #[test]
    fn coalesces_duplicate_paths_from_staged_delete_and_untracked_recreation() {
        let changes = parse_status_output(b"D  same.txt\0?? same.txt\0");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "same.txt");
        assert_eq!(changes[0].index_status, "D");
        assert_eq!(changes[0].worktree_status, "?");
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        assert!(validate_relative_path("src/lib.rs").is_ok());
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/tmp/secret").is_err());
        assert!(validate_relative_path("").is_err());
    }

    #[test]
    fn truncates_diff_on_a_utf8_boundary() {
        let mut diff = "a".repeat(MAX_DIFF_BYTES - 1);
        diff.push('界');
        truncate_diff(&mut diff, false);
        assert!(diff.contains("Diff truncated by Pelican"));
        assert!(diff.is_char_boundary(MAX_DIFF_BYTES - 1));
    }

    #[test]
    fn non_git_workspace_has_no_changes() {
        let repository = TestRepository::new(false);
        assert!(git_changes_blocking(repository.path_string())
            .expect("read non-Git workspace")
            .is_empty());
    }

    #[test]
    fn reports_staged_unstaged_and_untracked_diffs() {
        let repository = TestRepository::new(true);
        repository.write("tracked.txt", "base\n");
        repository.git(&["add", "tracked.txt"]);
        repository.git(&["commit", "-qm", "base"]);

        repository.write("tracked.txt", "base\nstaged\n");
        repository.git(&["add", "tracked.txt"]);
        repository.write("tracked.txt", "base\nstaged\nunstaged\n");
        repository.write("untracked.txt", "new file\n");

        let changes = git_changes_blocking(repository.path_string()).expect("read Git changes");
        assert_eq!(changes.len(), 2);

        let tracked = git_diff_blocking(repository.path_string(), "tracked.txt".into())
            .expect("read tracked diff");
        assert!(tracked.contains("Staged changes:"));
        assert!(tracked.contains("+staged"));
        assert!(tracked.contains("Unstaged changes:"));
        assert!(tracked.contains("+unstaged"));

        let untracked = git_diff_blocking(repository.path_string(), "untracked.txt".into())
            .expect("read untracked diff");
        assert!(untracked.contains("new file mode"));
        assert!(untracked.contains("+new file"));
    }

    #[test]
    fn shows_recreated_file_alongside_staged_deletion() {
        let repository = TestRepository::new(true);
        repository.write("same.txt", "old\n");
        repository.git(&["add", "same.txt"]);
        repository.git(&["commit", "-qm", "base"]);
        repository.git(&["rm", "-q", "same.txt"]);
        repository.write("same.txt", "replacement\n");

        let diff = git_diff_blocking(repository.path_string(), "same.txt".into())
            .expect("read recreated file diff");
        assert!(diff.contains("Staged changes:"));
        assert!(diff.contains("-old"));
        assert!(diff.contains("Untracked file:"));
        assert!(diff.contains("+replacement"));
    }
}
