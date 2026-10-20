//! One-time bearer invitation over pinned TLS. Invitation expires after five minutes.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    version: u8,
    name: String,
    platform: Value,
    input: u8,
    monitor: Value,
    pub sharing: Identity,
}
impl Profile {
    fn validate(&self) -> Result<(), AppError> {
        if self.version != 1
            || self.input == 0
            || !self.sharing.valid()
            || self.name.is_empty()
            || self.name.len() > 240
            || self.name.chars().any(char::is_control)
            || !self.platform.is_object()
            || !self.monitor.is_object()
            || serde_json::to_vec(self).map_err(io_error)?.len() > 4096
        {
            return Err(failure("配对信息无效，请重新生成配对码。"));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    version: u8,
    token: String,
    addresses: Vec<Ipv4Addr>,
    port: u16,
    profile: Profile,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Join {
    token: String,
    profile: Profile,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub peer: Profile,
    pub address: String,
    pub port: u16,
}
pub struct Pairing {
    pub code: String,
    result: Arc<Mutex<Option<Paired>>>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    started: std::time::Instant,
}
impl Drop for Pairing {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Pairing {
    pub fn result(&self) -> Option<Paired> {
        self.result.lock().unwrap().clone()
    }
    pub fn expired(&self) -> bool {
        self.started.elapsed() > std::time::Duration::from_secs(300)
    }
}
fn read<T: serde::de::DeserializeOwned>(stream: &mut impl Read) -> Result<T, AppError> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).map_err(io_error)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > 8192 {
        return Err(failure("配对请求过大。"));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).map_err(io_error)?;
    serde_json::from_slice(&bytes).map_err(io_error)
}
fn write(stream: &mut impl Write, value: &impl Serialize) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(value).map_err(io_error)?;
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(io_error)?;
    stream.write_all(&bytes).map_err(io_error)?;
    stream.flush().map_err(io_error)
}
fn local(ip: &Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}
fn own_profile(mut value: Value, identity: Identity) -> Result<Profile, AppError> {
    if !value.is_object() {
        return Err(failure("本机配置信息无效。"));
    }
    value["sharing"] = serde_json::to_value(identity).map_err(io_error)?;
    let profile: Profile = serde_json::from_value(value).map_err(io_error)?;
    profile.validate()?;
    Ok(profile)
}
pub fn host(profile: Value, port: u16) -> Result<Pairing, AppError> {
    if !(1024..65535).contains(&port) {
        return Err(failure("配对端口无效。"));
    }
    identity()?;
    let secret = load_secret(&root()?)?.ok_or_else(|| failure("配对身份不存在。"))?;
    let addresses: Vec<_> = if_addrs::get_if_addrs()
        .map_err(io_error)?
        .into_iter()
        .filter_map(|item| match item.ip() {
            IpAddr::V4(ip) if local(&ip) => Some(ip),
            _ => None,
        })
        .take(8)
        .collect();
    if addresses.is_empty() {
        return Err(failure("未找到局域网 IPv4 地址，请先连接局域网。"));
    }
    host_with_secret(profile, port, &secret, addresses)
}
fn host_with_secret(
    profile: Value,
    port: u16,
    secret: &Secret,
    addresses: Vec<Ipv4Addr>,
) -> Result<Pairing, AppError> {
    let profile = own_profile(profile, secret.identity())?;
    let mut random = [0; 32];
    getrandom::getrandom(&mut random).map_err(io_error)?;
    let offer = Offer {
        version: 1,
        token: URL_SAFE_NO_PAD.encode(random),
        addresses,
        port,
        profile,
    };
    let code = format!(
        "MS2.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&offer).map_err(io_error)?)
    );
    let (cert, key) = control::credentials(secret)?;
    let tls = Arc::new(
        rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert, key)
            .map_err(io_error)?,
    );
    let listener = TcpListener::bind(("0.0.0.0", port + 1)).map_err(|e| {
        failure("配对端口被占用，请先停止旧共享或 Deskflow 会话。").details(e.to_string())
    })?;
    listener.set_nonblocking(true).map_err(io_error)?;
    let alive = Arc::new(AtomicBool::new(true));
    let result = Arc::new(Mutex::new(None));
    let flag = alive.clone();
    let received = result.clone();
    let started = std::time::Instant::now();
    let thread = thread::spawn(move || {
        while flag.load(Ordering::Acquire)
            && started.elapsed() < std::time::Duration::from_secs(300)
        {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = (|| -> Result<(), AppError> {
                        control::socket(&stream)?;
                        let connection =
                            rustls::ServerConnection::new(tls.clone()).map_err(io_error)?;
                        let mut stream = rustls::StreamOwned::new(connection, stream);
                        let join: Join = read(&mut stream)?;
                        // The 256-bit invitation is single-use; a handshake alone grants no access.
                        if join.token != offer.token
                            || !flag.load(Ordering::Acquire)
                            || join.profile.sharing == offer.profile.sharing
                        {
                            return Err(failure("配对码无效。"));
                        }
                        join.profile.validate()?;
                        write(&mut stream, &offer.profile)?;
                        *received.lock().unwrap() = Some(Paired {
                            peer: join.profile,
                            address: String::new(),
                            port,
                        });
                        flag.store(false, Ordering::Release);
                        Ok(())
                    })();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
    });
    Ok(Pairing {
        code,
        result,
        alive,
        thread: Some(thread),
        started,
    })
}
pub fn join(code: &str, profile: Value) -> Result<Paired, AppError> {
    join_with_identity(code, profile, identity()?)
}
fn join_with_identity(code: &str, profile: Value, identity: Identity) -> Result<Paired, AppError> {
    if code.len() > 8192 {
        return Err(failure("配对码过长。"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(
            code.trim()
                .strip_prefix("MS2.")
                .ok_or_else(|| failure("请粘贴发送端生成的 MS2 配对码。"))?,
        )
        .map_err(io_error)?;
    let offer: Offer = serde_json::from_slice(&bytes).map_err(io_error)?;
    offer.profile.validate()?;
    if offer.version != 1
        || offer.token.len() != 43
        || offer.addresses.is_empty()
        || offer.addresses.len() > 8
        || !offer.addresses.iter().all(local)
        || !(1024..65535).contains(&offer.port)
    {
        return Err(failure("配对码无效，请重新生成。"));
    }
    let profile = own_profile(profile, identity)?;
    if profile.sharing == offer.profile.sharing {
        return Err(failure("这是本机配对码，请在另一台电脑输入。"));
    }
    let tls = Arc::new(
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(control::Pinned(
                offer.profile.sharing.fingerprint.to_lowercase(),
            )))
            .with_no_client_auth(),
    );
    for address in &offer.addresses {
        let result = (|| -> Result<Paired, AppError> {
            let tcp = TcpStream::connect_timeout(
                &SocketAddr::new(IpAddr::V4(*address), offer.port + 1),
                std::time::Duration::from_millis(700),
            )
            .map_err(io_error)?;
            control::socket(&tcp)?;
            let connection = rustls::ClientConnection::new(
                tls.clone(),
                rustls::pki_types::ServerName::try_from("monoswitch.local").unwrap(),
            )
            .map_err(io_error)?;
            let mut stream = rustls::StreamOwned::new(connection, tcp);
            write(
                &mut stream,
                &Join {
                    token: offer.token.clone(),
                    profile: profile.clone(),
                },
            )?;
            let peer: Profile = read(&mut stream)?;
            peer.validate()?;
            if peer.sharing != offer.profile.sharing {
                return Err(failure("发送端身份不一致，请重新配对。"));
            }
            Ok(Paired {
                peer,
                address: address.to_string(),
                port: offer.port,
            })
        })();
        if result.is_ok() {
            return result;
        }
    }
    Err(failure(
        "无法连接发送端：请保持发送端配对页面开启，确认同一局域网且允许 TCP 24800 和 24801；配对码五分钟后失效。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Value {
        serde_json::json!({"version":1,"name":"Test","platform":{"os":"linux","arch":"x86_64","hostname":"test"},"monitor":{"name":"Test"},"input":15})
    }
    #[test]
    fn invitation_rejects_remote_addresses_and_malformed_profiles() {
        let identity = Identity {
            id: format!("ms-{}", "a".repeat(16)),
            fingerprint: "a".repeat(64),
        };
        assert!(join_with_identity("MS1.bad", profile(), identity.clone()).is_err());
        let offer = Offer {
            version: 1,
            token: "a".repeat(43),
            addresses: vec![Ipv4Addr::new(8, 8, 8, 8)],
            port: 24800,
            profile: own_profile(profile(), identity.clone()).unwrap(),
        };
        let code = format!(
            "MS2.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&offer).unwrap())
        );
        assert!(join_with_identity(&code, profile(), identity).is_err());
    }
    #[test]
    fn one_way_pairing_delivers_both_identities_and_consumes_invitation() {
        let address = if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .find_map(|a| match a.ip() {
                IpAddr::V4(ip) if local(&ip) => Some(ip),
                _ => None,
            });
        let Some(address) = address else { return }; // Requires a local network interface.
        let path =
            std::env::temp_dir().join(format!("monoswitch-pairing-test-{}", std::process::id()));
        let a = path.join("a");
        let b = path.join("b");
        let first = create_identity(&a).unwrap();
        let second = create_identity(&b).unwrap();
        let port = (29000..30000)
            .find(|port| TcpListener::bind(("0.0.0.0", *port + 1)).is_ok())
            .unwrap();
        let host = host_with_secret(
            profile(),
            port,
            &load_secret(&a).unwrap().unwrap(),
            vec![address],
        )
        .unwrap();
        // A wrong invitation token must not pair or disclose the sender profile.
        let mut wrong: Offer =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&host.code[4..]).unwrap()).unwrap();
        wrong.token = "x".repeat(43);
        let wrong = format!(
            "MS2.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&wrong).unwrap())
        );
        assert!(join_with_identity(&wrong, profile(), second.clone()).is_err());
        assert!(host.result().is_none());
        let joined = join_with_identity(&host.code, profile(), second.clone()).unwrap();
        assert_eq!(joined.peer.sharing, first);
        let deadline = std::time::Instant::now();
        while host.result().is_none() {
            assert!(deadline.elapsed().as_secs() < 2);
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(host.result().unwrap().peer.sharing, second);
        drop(host);
        fs::remove_dir_all(path).unwrap();
    }
}
