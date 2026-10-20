//! Small mutually authenticated TLS channel; only permits selecting sender/receiver.
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
                        if !alive.load(Ordering::Acquire) || command[0] > 1 {
                            return Err(failure("无效的联动请求。"));
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
    let mut stream = rustls::StreamOwned::new(connection, tcp);
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
