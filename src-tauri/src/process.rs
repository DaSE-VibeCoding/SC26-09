use std::fmt;
use std::io::{self, Read};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const INITIAL_CAPTURE_CAPACITY: usize = 64 * 1024;

#[derive(Debug)]
pub struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug)]
pub enum CommandError {
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Timeout(Duration),
    OutputDrainTimeout(&'static str),
    OutputReaderStopped(&'static str),
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::Timeout(duration) => {
                write!(
                    formatter,
                    "command timed out after {:.1}s",
                    duration.as_secs_f64()
                )
            }
            Self::OutputDrainTimeout(stream) => {
                write!(formatter, "{stream} did not close after the command exited")
            }
            Self::OutputReaderStopped(stream) => {
                write!(formatter, "{stream} reader stopped unexpectedly")
            }
        }
    }
}

impl std::error::Error for CommandError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

pub fn run_command(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BoundedOutput, CommandError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|source| CommandError::Io {
        operation: "unable to start command",
        source,
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate(&mut child);
            return Err(CommandError::Io {
                operation: "unable to capture command stdout",
                source: io::Error::other("stdout pipe was not created"),
            });
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate(&mut child);
            return Err(CommandError::Io {
                operation: "unable to capture command stderr",
                source: io::Error::other("stderr pipe was not created"),
            });
        }
    };

    let stdout_receiver = match spawn_reader("pelican-stdout", stdout, stdout_limit) {
        Ok(receiver) => receiver,
        Err(error) => {
            terminate(&mut child);
            return Err(error);
        }
    };
    let stderr_receiver = match spawn_reader("pelican-stderr", stderr, stderr_limit) {
        Ok(receiver) => receiver,
        Err(error) => {
            terminate(&mut child);
            return Err(error);
        }
    };

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate(&mut child);
                return Err(CommandError::Timeout(timeout));
            }
            Ok(None) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(PROCESS_POLL_INTERVAL));
            }
            Err(source) => {
                terminate(&mut child);
                return Err(CommandError::Io {
                    operation: "unable to poll command",
                    source,
                });
            }
        }
    };

    let drain_deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
    let stdout = receive_capture(stdout_receiver, drain_deadline, "stdout")?;
    let stderr = receive_capture(stderr_receiver, drain_deadline, "stderr")?;
    Ok(BoundedOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn spawn_reader<R>(
    thread_name: &'static str,
    reader: R,
    limit: usize,
) -> Result<Receiver<io::Result<Capture>>, CommandError>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let _ = sender.send(capture_output(reader, limit));
        })
        .map_err(|source| CommandError::Io {
            operation: "unable to start output reader",
            source,
        })?;
    Ok(receiver)
}

fn capture_output(mut reader: impl Read, limit: usize) -> io::Result<Capture> {
    let mut bytes = Vec::with_capacity(limit.min(INITIAL_CAPTURE_CAPACITY));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let length = reader.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let captured = remaining.min(length);
        bytes.extend_from_slice(&buffer[..captured]);
        truncated |= captured < length;
    }
    Ok(Capture { bytes, truncated })
}

fn receive_capture(
    receiver: Receiver<io::Result<Capture>>,
    deadline: Instant,
    stream: &'static str,
) -> Result<Capture, CommandError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(source)) => Err(CommandError::Io {
            operation: if stream == "stdout" {
                "unable to read command stdout"
            } else {
                "unable to read command stderr"
            },
            source,
        }),
        Err(RecvTimeoutError::Timeout) => Err(CommandError::OutputDrainTimeout(stream)),
        Err(RecvTimeoutError::Disconnected) => Err(CommandError::OutputReaderStopped(stream)),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{run_command, CommandError};
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn captures_stdout_and_stderr() {
        let output = run_command(
            Command::new("/bin/sh").args(["-c", "printf pelican; printf warning >&2"]),
            Duration::from_secs(1),
            1_024,
            1_024,
        )
        .expect("run command");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"pelican");
        assert_eq!(output.stderr, b"warning");
        assert!(!output.stdout_truncated);
        assert!(!output.stderr_truncated);
    }

    #[test]
    fn bounds_captured_output_while_draining_the_pipe() {
        let output = run_command(
            Command::new("/bin/sh").args(["-c", "printf 123456789"]),
            Duration::from_secs(1),
            4,
            1_024,
        )
        .expect("run command");
        assert_eq!(output.stdout, b"1234");
        assert!(output.stdout_truncated);
    }

    #[test]
    fn terminates_command_at_deadline() {
        let start = Instant::now();
        let error = run_command(
            Command::new("/bin/sh").args(["-c", "exec sleep 2"]),
            Duration::from_millis(50),
            1_024,
            1_024,
        )
        .expect_err("command should time out");
        assert!(matches!(error, CommandError::Timeout(_)));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
