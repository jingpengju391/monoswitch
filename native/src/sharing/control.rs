//! Small mutually authenticated TLS channel; permits focus selection and bounded display-name exchange.
use super::*;
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use std::net::{SocketAddr, TcpListener, TcpStream};

#[derive(Debug)]
pub(super) struct Pinned(pub(super) String);
impl Pinned {
    fn check(&self, cert: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        if format!("{:x}", Sha256::digest(cert.as_ref())) == self.0 {
            Ok(())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }
}
macro_rules! signatures {
    () => {
        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            signature: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(
                message,
                cert,
                signature,
                &rustls::crypto::ring::default_provider().signature_verification_algorithms,
            )
        }
        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            signature: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(
                message,
                cert,
                signature,
                &rustls::crypto::ring::default_provider().signature_verification_algorithms,
            )
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    };
}
impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.check(end)?;
        Ok(ServerCertVerified::assertion())
    }
    signatures!();
}
impl ClientCertVerifier for Pinned {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        end: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.check(end)?;
        Ok(ClientCertVerified::assertion())
    }
    signatures!();
}
pub(super) fn credentials(
    secret: &Secret,
) -> Result<
    (
        Vec<CertificateDer<'static>>,
        rustls::pki_types::PrivateKeyDer<'static>,
    ),
    AppError,
> {
    let key = rustls_pemfile::private_key(&mut secret.key.as_bytes())
        .map_err(io_error)?
        .ok_or_else(|| failure("键鼠配对密钥损坏，请重新配对。"))?;
    Ok((vec![CertificateDer::from(secret.der.clone())], key))
}
pub(super) fn socket(stream: &TcpStream) -> Result<(), AppError> {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(4)))
        .map_err(io_error)?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(4)))
        .map_err(io_error)
}

pub(super) fn listen(
    secret: &Secret,
    config: &Config,
    alive: Arc<AtomicBool>,
    state: Arc<Mutex<Status>>,
) -> Result<JoinHandle<()>, AppError> {
    let (cert, key) = credentials(secret)?;
    let tls = rustls::ServerConfig::builder()
        .with_client_cert_verifier(Arc::new(Pinned(config.peer.fingerprint.to_lowercase())))
        .with_single_cert(cert, key)
        .map_err(io_error)?;
    let tls = Arc::new(tls);
    let listener = TcpListener::bind(("0.0.0.0", config.port + 1))
        .map_err(|e| failure("无法开启联动控制端口，请检查端口占用。").details(e.to_string()))?;
    listener.set_nonblocking(true).map_err(io_error)?;
    Ok(thread::spawn(move || {
        while alive.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let result = (|| -> Result<(), AppError> {
                        socket(&stream)?;
                        let connection =
                            rustls::ServerConnection::new(tls.clone()).map_err(io_error)?;
                        let mut stream = rustls::StreamOwned::new(connection, stream);
                        let mut command = [0];
                        stream.read_exact(&mut command).map_err(io_error)?;
                        if !alive.load(Ordering::Acquire) || command[0] > 2 {
                            return Err(failure("无效的联动请求。"));
                        }
                        if command[0] == 2 {
                            let name = read_name(&mut stream)?;
                            let own = {
                                let mut state = state.lock().unwrap();
                                if !state.running {
                                    return Err(failure("键鼠共享未运行。"));
                                }
                                state.peer_name = name;
                                state.own_name.clone()
                            };
                            return write_name(&mut stream, &own);
                        }
                        let result = focus(&state, command[0] == 1);
                        let reply = match result {
                            Ok(()) => "OK".to_owned(),
                            Err(e) => e.message,
                        };
                        stream
                            .write_all(format!("{reply}\n").as_bytes())
                            .map_err(io_error)?;
                        stream.flush().map_err(io_error)
                    })();
                    // Unauthenticated clients cannot change state or issue input events.
                    let _ = result;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(50))
                }
                Err(_) => break,
            }
        }
    }))
}
fn focus(state: &Arc<Mutex<Status>>, receiver: bool) -> Result<(), AppError> {
    {
        let state = state.lock().unwrap();
        if !state.running || !state.connected {
            return Err(failure("另一台电脑尚未连入键鼠共享，未切换画面。"));
        }
        if state.active != receiver {
            return Ok(());
        }
    }
    super::focus::switch(receiver)?;
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(2) {
        let state = state.lock().unwrap();
        if !state.connected {
            return Err(failure("键鼠连接已断开，未切换画面。"));
        }
        if state.active != receiver {
            return Ok(());
        }
        drop(state);
        thread::sleep(std::time::Duration::from_millis(20));
    }
    Err(failure("未确认键鼠焦点切换，请检查发送端输入权限。"))
}
pub(super) fn switch(
    secret: &Secret,
    config: &Config,
    state: &Arc<Mutex<Status>>,
) -> Result<(), AppError> {
    if config.role == Role::Server {
        return focus(state, true);
    }
    let mut stream = connect(secret, config)?;
    stream.write_all(&[0]).map_err(io_error)?;
    stream.flush().map_err(io_error)?;
    let mut reply = String::new();
    BufReader::new(stream.take(1024))
        .read_line(&mut reply)
        .map_err(io_error)?;
    if reply.trim() == "OK" {
        Ok(())
    } else {
        Err(failure(if reply.is_empty() {
            "发送端未确认键鼠切换。"
        } else {
            reply.trim()
        }))
    }
}

fn connect(
    secret: &Secret,
    config: &Config,
) -> Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>, AppError> {
    let address: IpAddr = config.address.parse().map_err(io_error)?;
    let tcp = TcpStream::connect_timeout(
        &SocketAddr::new(address, config.port + 1),
        std::time::Duration::from_secs(2),
    )
    .map_err(|e| {
        failure("无法连接发送端的联动端口，请更新两边组件并允许相邻 TCP 端口。")
            .details(e.to_string())
    })?;
    socket(&tcp)?;
    let (cert, key) = credentials(secret)?;
    let tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(config.peer.fingerprint.to_lowercase())))
        .with_client_auth_cert(cert, key)
        .map_err(io_error)?;
    let connection = rustls::ClientConnection::new(
        Arc::new(tls),
        ServerName::try_from("monoswitch.local").unwrap(),
    )
    .map_err(io_error)?;
    Ok(rustls::StreamOwned::new(connection, tcp))
}

pub(super) fn validate_name(name: &Option<String>) -> Result<(), AppError> {
    if let Some(name) = name
        && (name.trim().is_empty()
            || name.chars().count() > 60
            || name.chars().any(char::is_control))
    {
        return Err(failure("电脑名称无效。"));
    }
    Ok(())
}
fn read_name(stream: &mut impl Read) -> Result<Option<String>, AppError> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take(512))
        .read_until(b'\n', &mut bytes)
        .map_err(io_error)?;
    if bytes.last() != Some(&b'\n') {
        return Err(failure("电脑名称无效。"));
    }
    let name: Option<String> = serde_json::from_slice(&bytes).map_err(io_error)?;
    validate_name(&name)?;
    Ok(name)
}
fn write_name(stream: &mut impl Write, name: &Option<String>) -> Result<(), AppError> {
    validate_name(name)?;
    serde_json::to_writer(&mut *stream, name).map_err(io_error)?;
    stream.write_all(b"\n").map_err(io_error)?;
    stream.flush().map_err(io_error)
}
pub(super) fn sync_names(
    secret: Secret,
    config: Config,
    alive: Arc<AtomicBool>,
    state: Arc<Mutex<Status>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while alive.load(Ordering::Acquire) {
            let name = state.lock().unwrap().own_name.clone();
            // Wait for Chrome to supply the saved name, avoiding stale hostname updates.
            if name.is_some() {
                let result = exchange_name(&secret, &config, &name);
                if let Ok(peer) = result
                    && alive.load(Ordering::Acquire)
                {
                    state.lock().unwrap().peer_name = peer;
                }
            }
            // Interruptible delay keeps stop/re-pair responsive.
            for _ in 0..20 {
                if !alive.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    })
}

fn exchange_name(
    secret: &Secret,
    config: &Config,
    name: &Option<String>,
) -> Result<Option<String>, AppError> {
    let mut stream = connect(secret, config)?;
    stream.write_all(&[2]).map_err(io_error)?;
    write_name(&mut stream, name)?;
    read_name(&mut stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> Secret {
        let cert = rcgen::generate_simple_self_signed(vec!["monoswitch.local".into()]).unwrap();
        Secret {
            certificate: cert.cert.pem(),
            key: cert.key_pair.serialize_pem(),
            der: cert.cert.der().to_vec(),
        }
    }

    #[test]
    fn names_are_bounded_and_control_characters_rejected() {
        for mut data in [
            b"\"bad\\nname\"\n".as_slice(),
            b"\"\n",
            b"\"no terminator\"",
        ] {
            assert!(read_name(&mut data).is_err());
        }
        assert!(validate_name(&Some("x".repeat(61))).is_err());
        assert!(validate_name(&Some(" ".into())).is_err());
        assert!(validate_name(&Some("工作电脑".into())).is_ok());
    }

    #[test]
    fn pinned_tls_exchanges_renames_without_changing_input_focus() {
        let server = secret();
        let client = secret();
        let stranger = secret();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port() - 1;
        drop(listener);
        let server_config = Config {
            role: Role::Server,
            peer: client.identity(),
            address: String::new(),
            port,
            follow_display: false,
            display_id: "test".into(),
            input: 15,
        };
        let client_config = Config {
            role: Role::Client,
            peer: server.identity(),
            address: "127.0.0.1".into(),
            ..server_config.clone()
        };
        let alive = Arc::new(AtomicBool::new(true));
        let state = Arc::new(Mutex::new(Status {
            running: true,
            active: true,
            own_name: Some("主机".into()),
            ..Status::default()
        }));
        let worker = listen(&server, &server_config, alive.clone(), state.clone()).unwrap();
        let result = exchange_name(&client, &client_config, &Some("副机".into())).unwrap();
        assert_eq!(result.as_deref(), Some("主机"));
        assert_eq!(state.lock().unwrap().peer_name.as_deref(), Some("副机"));
        assert!(exchange_name(&stranger, &client_config, &Some("伪造".into())).is_err());
        assert_eq!(state.lock().unwrap().peer_name.as_deref(), Some("副机"));
        state.lock().unwrap().own_name = Some("新的主机".into());
        assert_eq!(
            exchange_name(&client, &client_config, &Some("新的副机".into()))
                .unwrap()
                .as_deref(),
            Some("新的主机")
        );
        assert_eq!(state.lock().unwrap().peer_name.as_deref(), Some("新的副机"));
        assert!(state.lock().unwrap().active);
        let client_state = Arc::new(Mutex::new(Status {
            own_name: Some("自动同步副机".into()),
            ..Status::default()
        }));
        let sync = sync_names(client, client_config, alive.clone(), client_state.clone());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && client_state.lock().unwrap().peer_name.is_none() {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            client_state.lock().unwrap().peer_name.as_deref(),
            Some("新的主机")
        );
        assert_eq!(
            state.lock().unwrap().peer_name.as_deref(),
            Some("自动同步副机")
        );
        alive.store(false, Ordering::Release);
        sync.join().unwrap();
        worker.join().unwrap();
    }
}
