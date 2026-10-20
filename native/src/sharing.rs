//! Owns a Deskflow child for the lifetime of a Native Messaging connection.
//! Deskflow remains a separate executable; no third-party source is embedded.
use crate::model::AppError;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::{Duration, Instant};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};

fn failure(message: impl Into<String>) -> AppError {
    AppError::new("SHARING_FAILED", message)
}
fn io_error(error: impl std::fmt::Display) -> AppError {
    failure("无法配置键鼠共享，请查看连接详情。".to_string()).details(error.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub fingerprint: String,
}
impl Identity {
    pub fn valid(&self) -> bool {
        self.fingerprint.len() == 64
            && self.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            && self.id == format!("ms-{}", self.fingerprint[..16].to_ascii_lowercase())
    }
}
#[derive(Deserialize, Serialize)]
struct Secret {
    certificate: String,
    key: String,
    der: Vec<u8>,
}
impl Secret {
    fn identity(&self) -> Identity {
        let fingerprint = format!("{:x}", Sha256::digest(&self.der));
        Identity {
            id: format!("ms-{}", &fingerprint[..16]),
            fingerprint,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Server,
    Client,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub role: Role,
    pub peer: Identity,
    pub address: String,
    pub port: u16,
    pub follow_display: bool,
    pub display_id: String,
    pub input: u8,
}
impl Config {
    fn validate(&self, own: &Identity) -> Result<(), AppError> {
        if !self.peer.valid() || self.peer.id == own.id || self.port < 1024 {
            return Err(failure("键鼠配对配置无效，请重新交换配置。"));
        }
        if self.role == Role::Client || !self.address.is_empty() {
            let address = self
                .address
                .parse::<IpAddr>()
                .map_err(|_| failure("请输入键鼠所在电脑的局域网 IP 地址。"))?;
            let local = match address {
                IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
                IpAddr::V6(ip) => ip.is_unique_local(),
            };
            if !local {
                return Err(failure("键鼠共享仅支持局域网 IP 地址。"));
            }
        }
        if self.follow_display
            && (self.input == 0
                || self.display_id.is_empty()
                || self.display_id.len() > 1024
                || self.display_id.chars().any(char::is_control))
        {
            return Err(failure("请先选择本机显示器和输入接口。"));
        }
        Ok(())
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub running: bool,
    pub connected: bool,
    pub active: bool,
    pub role: Option<Role>,
    pub identity: Option<Identity>,
    pub last_error: Option<String>,
    pub display_message: Option<String>,
}

fn root() -> Result<PathBuf, AppError> {
    directories::BaseDirs::new()
        .map(|base| base.data_local_dir().join("monoswitch/input-sharing"))
        .ok_or_else(|| failure("无法确定键鼠共享配置目录。"))
}
fn directory(path: &Path) -> Result<(), AppError> {
    fs::create_dir_all(path).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    Ok(())
}
fn private_file(path: &Path) -> Result<File, AppError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = private_file(path)?;
    file.set_len(0).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)
}
fn load_secret(root: &Path) -> Result<Option<Secret>, AppError> {
    match fs::read(root.join("identity.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(io_error),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}
fn create_identity(root: &Path) -> Result<Identity, AppError> {
    directory(root)?;
    let lock = private_file(&root.join("identity.lock"))?;
    lock.lock_exclusive().map_err(io_error)?;
    if let Some(secret) = load_secret(root)? {
        return Ok(secret.identity());
    }
    let generated =
        rcgen::generate_simple_self_signed(vec!["monoswitch.local".into()]).map_err(io_error)?;
    let secret = Secret {
        certificate: generated.cert.pem(),
        key: generated.key_pair.serialize_pem(),
        der: generated.cert.der().to_vec(),
    };
    write_private(
        &root.join("identity.json"),
        &serde_json::to_vec(&secret).map_err(io_error)?,
    )?;
    Ok(secret.identity())
}
pub fn identity() -> Result<Identity, AppError> {
    create_identity(&root()?)
}

fn backend() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    let candidates: Vec<PathBuf> = ["/usr/bin/deskflow-core", "/usr/local/bin/deskflow-core"]
        .into_iter()
        .map(PathBuf::from)
        .collect();
    #[cfg(target_os = "macos")]
    let candidates: Vec<PathBuf> = [
        "/Applications/Deskflow.app/Contents/MacOS/deskflow-core",
        "/opt/homebrew/bin/deskflow-core",
        "/usr/local/bin/deskflow-core",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    #[cfg(windows)]
    let candidates: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|p| PathBuf::from(p).join("Deskflow/deskflow-core.exe"))
        .collect();
    candidates.into_iter().find(|path| path.is_file())
}
fn ini(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
fn configuration(root: &Path, own: &Identity, config: &Config) -> (String, String) {
    let (server, client) = if config.role == Role::Server {
        (&own.id, &config.peer.id)
    } else {
        (&config.peer.id, &own.id)
    };
    let screen = format!(
        "section: screens\n  {server}:\n  {client}:\nend\nsection: options\n  clipboardSharing = false\n  heartbeat = 2000\n  keystroke(control+shift+F8) = switchToScreen({server})\n  keystroke(control+shift+F9) = switchToScreen({client})\nend\n"
    );
    let ini = format!(
        "[core]\ncomputerName={}\nport={}\nprocessMode=1\npreventSleep=true\n[security]\ntlsEnabled=true\ncheckPeerFingerprints=true\ncertificate={}\n[server]\nexternalConfig=true\nexternalConfigFile={}\nenableClipboard=false\n[client]\nremoteHost={}\n[log]\nlevel=4\ntoFile=false\n",
        own.id,
        config.port,
        ini(&root.join("tls/identity.pem").to_string_lossy()),
        ini(&root.join("server.conf").to_string_lossy()),
        ini(&config.address)
    );
    (ini, screen)
}

fn prepare_files(root: &Path, own: &Secret, config: &Config) -> Result<(), AppError> {
    directory(&root.join("tls"))?;
    write_private(
        &root.join("tls/identity.pem"),
        format!("{}\n{}", own.key, own.certificate).as_bytes(),
    )?;
    let trust = format!(
        "v2:sha256:{}\n",
        config.peer.fingerprint.to_ascii_lowercase()
    );
    // Require a trusted certificate on both server and client. Never accept strangers automatically.
    for name in ["trusted-servers", "trusted-clients"] {
        write_private(&root.join("tls").join(name), trust.as_bytes())?;
    }
    let (settings, screens) = configuration(root, &own.identity(), config);
    write_private(&root.join("Deskflow.conf"), settings.as_bytes())?;
    write_private(&root.join("server.conf"), screens.as_bytes())?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    Connected,
    Disconnected,
    Enter,
    Leave,
    Error,
}
fn event(line: &str, peer: &Identity) -> Option<Event> {
    // Only fixed backend INFO/IPC records control state; no key events are logged.
    let message = line
        .split_once(": ")
        .map(|(_, s)| s.trim())
        .unwrap_or(line.trim());
    if message == "connected to server"
        || message == format!("client \"{}\" has connected", peer.id)
    {
        Some(Event::Connected)
    } else if message == "disconnected from server"
        || message == format!("client \"{}\" has disconnected", peer.id)
    {
        Some(Event::Disconnected)
    } else if matches!(message, "entering screen" | "entering computer") {
        Some(Event::Enter)
    } else if matches!(message, "leaving screen" | "leaving computer") {
        Some(Event::Leave)
    } else if line.contains("ERROR:") || line.contains("FATAL:") {
        Some(Event::Error)
    } else {
        None
    }
}
fn monitor(
    reader: impl Read + Send + 'static,
    state: Arc<Mutex<Status>>,
    alive: Arc<AtomicBool>,
    config: Config,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut discarding = false;
        loop {
            // Bound each record even if a faulty backend emits an unterminated line.
            let mut line = Vec::new();
            let read = reader.by_ref().take(8192).read_until(b'\n', &mut line);
            if !alive.load(Ordering::Acquire) || !matches!(read, Ok(n) if n > 0) {
                break;
            }
            let complete = line.last() == Some(&b'\n');
            if discarding || (line.len() == 8192 && !complete) {
                discarding = !complete;
                continue;
            }
            let line = String::from_utf8_lossy(&line);
            let Some(event) = event(&line, &config.peer) else {
                continue;
            };
            let follow = {
                let mut s = state.lock().unwrap();
                match event {
                    Event::Connected => {
                        s.connected = true;
                        s.last_error = None;
                    }
                    Event::Disconnected => {
                        s.connected = false;
                    }
                    Event::Enter => s.active = true,
                    Event::Leave => s.active = false,
                    Event::Error => s.last_error = Some(line.chars().take(500).collect()),
                }
                event == Event::Enter && config.follow_display && s.connected
            };
            if follow && alive.load(Ordering::Acquire) {
                let result = crate::platform::switch(&config.display_id, config.input);
                state.lock().unwrap().display_message = Some(match result {
                    Ok(_) => "已发送显示器切换指令，请确认画面。".into(),
                    Err(e) => format!("键鼠已切换，但显示器切换失败：{}", e.message),
                });
            }
        }
    })
}

#[derive(Default)]
pub struct Session {
    child: Option<Child>,
    lock: Option<File>,
    threads: Vec<JoinHandle<()>>,
    alive: Arc<AtomicBool>,
    state: Arc<Mutex<Status>>,
}
impl Session {
    pub fn status(&mut self) -> Result<Status, AppError> {
        if let Some(child) = self.child.as_mut()
            && let Some(exit) = child.try_wait().map_err(io_error)?
        {
            self.stop();
            self.state
                .lock()
                .unwrap()
                .last_error
                .get_or_insert_with(|| format!("键鼠共享程序已退出（{exit}），请检查权限和连接。"));
        }
        let mut state = self.state.lock().unwrap().clone();
        state.installed = backend().is_some();
        state.identity = load_secret(&root()?)?.map(|s| s.identity());
        Ok(state)
    }
    pub fn start(&mut self, config: Config) -> Result<Status, AppError> {
        if self.child.is_some() {
            return Err(failure("请先停止当前键鼠共享，再修改配置。"));
        }
        let root = root()?;
        let own = load_secret(&root)?.ok_or_else(|| failure("请先生成本机键鼠配对信息。"))?;
        config.validate(&own.identity())?;
        let executable = backend().ok_or_else(|| failure("请先安装 Deskflow 1.26 或更新版本。"))?;
        let lock = private_file(&root.join("session.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| failure("另一个窗口已在运行键鼠共享。"))?;
        prepare_files(&root, &own, &config)?;
        let mut command = Command::new(executable);
        command
            .args([
                if config.role == Role::Server {
                    "server"
                } else {
                    "client"
                },
                "--settings",
            ])
            .arg(root.join("Deskflow.conf"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(io_error)?;
        self.alive.store(true, Ordering::Release);
        *self.state.lock().unwrap() = Status {
            installed: true,
            running: true,
            active: config.role == Role::Server,
            role: Some(config.role),
            identity: Some(own.identity()),
            ..Status::default()
        };
        if let Some(stdout) = child.stdout.take() {
            self.threads.push(monitor(
                stdout,
                self.state.clone(),
                self.alive.clone(),
                config.clone(),
            ));
        }
        if let Some(stderr) = child.stderr.take() {
            self.threads.push(monitor(
                stderr,
                self.state.clone(),
                self.alive.clone(),
                config,
            ));
        }
        self.child = Some(child);
        self.lock = Some(lock);
        self.status()
    }
    pub fn stop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
        self.lock = None;
        let mut state = self.state.lock().unwrap();
        state.running = false;
        state.connected = false;
        state.active = false;
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn peer() -> Identity {
        Identity {
            id: format!("ms-{}", "a".repeat(16)),
            fingerprint: "a".repeat(64),
        }
    }
    fn config() -> Config {
        Config {
            role: Role::Client,
            peer: peer(),
            address: "192.168.1.2".into(),
            port: 24800,
            follow_display: false,
            display_id: "".into(),
            input: 0,
        }
    }
    #[test]
    fn rejects_untrusted_or_injected_configuration() {
        let own = Identity {
            id: format!("ms-{}", "b".repeat(16)),
            fingerprint: "b".repeat(64),
        };
        let valid = config();
        assert!(valid.validate(&own).is_ok());
        for address in [
            "8.8.8.8",
            "127.0.0.1",
            "0.0.0.0",
            "192.168.1.2\n[security]",
            "example.org",
            "::1",
        ] {
            let mut bad = valid.clone();
            bad.address = address.into();
            assert!(bad.validate(&own).is_err());
        }
        let mut bad = valid.clone();
        bad.peer.id = "bad\nend".into();
        assert!(bad.validate(&own).is_err());
        let mut bad = valid;
        bad.peer = own.clone();
        assert!(bad.validate(&own).is_err());
    }
    #[test]
    fn private_identity_is_stable_and_public_config_contains_no_secret() {
        let path = std::env::temp_dir().join(format!(
            "monoswitch-sharing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = create_identity(&path).unwrap();
        assert!(first.valid());
        assert_eq!(first, create_identity(&path).unwrap());
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path.join("identity.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn generated_config_enables_auth_and_uses_fixed_hotkeys() {
        let (ini, screens) = configuration(Path::new("/tmp/a folder"), &peer(), &config());
        assert!(ini.contains("tlsEnabled=true\ncheckPeerFingerprints=true"));
        assert!(screens.contains("clipboardSharing = false"));
        assert!(screens.contains("control+shift+F8"));
        assert!(!screens.contains("section: links"));
    }
    #[test]
    fn log_events_do_not_treat_errors_as_success() {
        assert_eq!(
            event("[time] INFO: entering screen", &peer()),
            Some(Event::Enter)
        );
        assert_eq!(
            event("[time] NOTE: connected to server", &peer()),
            Some(Event::Connected)
        );
        assert_eq!(
            event("[time] WARNING: failed to connect to server", &peer()),
            None
        );
        assert_eq!(
            event("[time] ERROR: unknown fingerprint", &peer()),
            Some(Event::Error)
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod integration;
