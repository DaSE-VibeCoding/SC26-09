use crate::agents::cached_executable_directories;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(20);
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(1);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct PtySpawnSpec {
    pub program: String,
    pub cwd: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
}

pub(crate) enum PtyEvent {
    Output(String),
    Exited { exit_code: u32, success: bool },
}

pub(crate) struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    stopper: PtyStopper,
}

#[derive(Clone)]
pub(crate) struct PtyStopper {
    control: Sender<PtyControl>,
}

pub(crate) struct PtyStopWait {
    response: Receiver<Result<(), String>>,
}

enum ReaderMessage {
    Data(Vec<u8>),
    Closed,
}
enum PtyControl {
    Stop(SyncSender<Result<(), String>>),
}

impl PtyStopper {
    pub fn request_stop(&self) -> Result<PtyStopWait, String> {
        let (reply, response) = sync_channel(1);
        self.control
            .send(PtyControl::Stop(reply))
            .map_err(|_| "Terminal session is no longer running")?;
        Ok(PtyStopWait { response })
    }
}

impl PtyStopWait {
    pub fn wait(self) -> Result<(), String> {
        self.response
            .recv_timeout(STOP_TIMEOUT)
            .map_err(|_| "Timed out while stopping terminal")?
    }
}

impl PtyHandle {
    pub fn send(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Unable to write to terminal: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("Unable to flush terminal input: {e}"))
    }
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Unable to resize terminal: {e}"))
    }
    pub fn stopper(&self) -> PtyStopper {
        self.stopper.clone()
    }
}

pub(crate) fn spawn(spec: PtySpawnSpec) -> Result<(PtyHandle, Receiver<PtyEvent>), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Unable to open terminal: {e}"))?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.cwd(&spec.cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(unix)]
    command.env("PWD", &spec.cwd);
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    if let Some(path) = terminal_path(&spec) {
        command.env("PATH", path);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Unable to launch {}: {e}", spec.program))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            cleanup_failed_spawn(child);
            return Err(format!("Unable to read terminal: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            cleanup_failed_spawn(child);
            return Err(format!("Unable to write terminal: {error}"));
        }
    };
    let (output_tx, output_rx) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let (control_tx, control_rx) = channel();
    let (event_tx, event_rx) = sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let stopper = PtyStopper {
        control: control_tx,
    };
    thread::spawn(move || read_output(reader, output_tx));
    thread::spawn(move || manage(child, output_rx, control_rx, event_tx));
    Ok((
        PtyHandle {
            writer,
            master: pair.master,
            stopper,
        },
        event_rx,
    ))
}

fn terminal_path(spec: &PtySpawnSpec) -> Option<OsString> {
    let mut dirs = Vec::new();
    if let Some(parent) = Path::new(&spec.program)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        dirs.push(parent.to_path_buf());
    }
    let path = spec
        .env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| OsString::from(v))
        .or_else(|| env::var_os("PATH"));
    if let Some(path) = path {
        dirs.extend(env::split_paths(&path));
    }
    if let Some(extra) = cached_executable_directories() {
        dirs.extend(extra.iter().cloned());
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    env::join_paths(dirs).ok()
}
fn cleanup_failed_spawn(mut child: Box<dyn Child + Send + Sync>) {
    let _ = child.kill();
    thread::spawn(move || {
        let _ = child.wait();
    });
}
fn read_output(mut reader: Box<dyn Read + Send>, tx: SyncSender<ReaderMessage>) {
    let mut buf = [0; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(ReaderMessage::Data(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
        }
    }
    let _ = tx.send(ReaderMessage::Closed);
}
fn manage(
    mut child: Box<dyn Child + Send + Sync>,
    output: Receiver<ReaderMessage>,
    control: Receiver<PtyControl>,
    events: SyncSender<PtyEvent>,
) {
    let mut decoder = Utf8StreamDecoder::default();
    let mut closed = false;
    let mut exit = None;
    let mut deadline = None;
    loop {
        while let Ok(PtyControl::Stop(reply)) = control.try_recv() {
            let result = child
                .kill()
                .map_err(|e| format!("Unable to stop terminal: {e}"));
            let _ = reply.send(result);
        }
        let wait = deadline
            .map(|d: Instant| {
                d.saturating_duration_since(Instant::now())
                    .min(CHILD_POLL_INTERVAL)
            })
            .unwrap_or(CHILD_POLL_INTERVAL);
        if closed {
            thread::sleep(wait)
        } else {
            match output.recv_timeout(wait) {
                Ok(ReaderMessage::Data(b)) => emit(&events, decoder.push(&b)),
                Ok(ReaderMessage::Closed) | Err(RecvTimeoutError::Disconnected) => closed = true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        if exit.is_none() {
            match child.try_wait() {
                Ok(Some(s)) => {
                    exit = Some((s.exit_code(), s.success()));
                    deadline = Some(Instant::now() + OUTPUT_DRAIN_GRACE);
                }
                Ok(None) => {}
                Err(_) => {
                    exit = Some((1, false));
                    deadline = Some(Instant::now() + OUTPUT_DRAIN_GRACE);
                }
            }
        }
        if exit.is_some() && (closed || deadline.is_some_and(|d| Instant::now() >= d)) {
            break;
        }
    }
    while let Ok(ReaderMessage::Data(b)) = output.try_recv() {
        emit(&events, decoder.push(&b));
    }
    emit(&events, decoder.finish());
    let (exit_code, success) = exit.unwrap_or((1, false));
    let _ = events.send(PtyEvent::Exited { exit_code, success });
}
fn emit(events: &SyncSender<PtyEvent>, data: String) {
    if !data.is_empty() {
        let _ = events.send(PtyEvent::Output(data));
    }
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}
impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(v) => {
                    out.push_str(v);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let n = e.valid_up_to();
                    if n > 0 {
                        out.push_str(std::str::from_utf8(&self.pending[..n]).unwrap());
                        self.pending.drain(..n);
                    }
                    if let Some(n) = e.error_len() {
                        out.push(char::REPLACEMENT_CHARACTER);
                        self.pending.drain(..n);
                    } else {
                        break;
                    }
                }
            }
        }
        out
    }
    fn finish(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{PtyControl, PtyStopper, Utf8StreamDecoder};
    use std::sync::mpsc::channel;
    #[test]
    fn split_utf8() {
        let mut d = Utf8StreamDecoder::default();
        let mut s = String::new();
        for b in "鹈鹕 🐦".as_bytes() {
            s.push_str(&d.push(&[*b]));
        }
        s.push_str(&d.finish());
        assert_eq!(s, "鹈鹕 🐦");
    }
    #[test]
    fn invalid_utf8() {
        let mut d = Utf8StreamDecoder::default();
        assert_eq!(d.push(b"ok\xffdone"), "ok\u{fffd}done");
    }

    #[test]
    fn stop_request_splits_acceptance_from_wait() {
        let (control, receiver) = channel();
        let stopper = PtyStopper { control };

        let wait = stopper.request_stop().expect("stop request accepted");
        let PtyControl::Stop(reply) = receiver.recv().expect("control message");
        reply.send(Ok(())).expect("reply accepted");

        assert!(wait.wait().is_ok());
    }
}
