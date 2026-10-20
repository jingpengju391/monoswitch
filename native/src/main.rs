#[cfg(any(unix, test))]
mod command;
mod framing;
mod inputs;
#[cfg(target_os = "linux")]
#[path = "../../shared/linux_setup.rs"]
mod linux_setup;
mod model;
mod platform;
mod sharing;

use model::{AppError, Request};
use serde_json::{Value, json};
use std::io;

fn response(result: Result<Value, AppError>) -> Value {
    match result {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

fn handle_session(bytes: &[u8], sharing: &mut sharing::Session) -> Value {
    let result = (|| {
        let request: Request = serde_json::from_slice(bytes).map_err(|e| {
            AppError::new("INVALID_REQUEST", "请求格式不正确或操作不受支持。")
                .details(e.to_string())
        })?;
        match request {
            Request::SharingInstall {} => {
                #[cfg(target_os = "linux")]
                {
                    linux_setup::install_sharing()
                        .map_err(|m| AppError::new("SHARING_INSTALL_FAILED", m))?;
                    Ok(json!(sharing.status()?))
                }
                #[cfg(not(target_os = "linux"))]
                {
                    Err(AppError::new(
                        "UNSUPPORTED",
                        "请安装官方 Deskflow 程序后重新检测。",
                    ))
                }
            }
            Request::SharingStatus {} => Ok(json!(sharing.status()?)),
            Request::SharingIdentity {} => Ok(json!(sharing::identity()?)),
            Request::SharingStart { config } => Ok(json!(sharing.start(config)?)),
            Request::SharingStop {} => {
                sharing.stop();
                Ok(json!(sharing.status()?))
            }
            Request::Status {} => Ok(json!(platform::status()?)),
            Request::Repair {} => {
                #[cfg(target_os = "linux")]
                {
                    linux_setup::repair()
                        .map_err(|message| AppError::new("SETUP_FAILED", message))?;
                    Ok(json!(platform::status()?))
                }
                #[cfg(not(target_os = "linux"))]
                Err(AppError::new("UNSUPPORTED", "此系统无需 Linux 自动配置。"))
            }
            Request::Switch { display_id, input } => {
                if input == 0
                    || display_id.is_empty()
                    || display_id.len() > 1024
                    || display_id.chars().any(char::is_control)
                {
                    return Err(AppError::new(
                        "INVALID_REQUEST",
                        "请选择有效显示器和 1–255 的输入源。",
                    ));
                }
                Ok(json!(platform::switch(&display_id, input)?))
            }
        }
    })();
    response(result)
}

fn serve(reader: &mut impl io::Read, writer: &mut impl io::Write) -> io::Result<()> {
    let mut sharing = sharing::Session::default();
    loop {
        match framing::read_frame(reader) {
            Ok(Some(bytes)) => framing::write_frame(writer, &handle_session(&bytes, &mut sharing))?,
            Ok(None) => return Ok(()),
            Err(error) => {
                framing::write_frame(
                    writer,
                    &response(Err(AppError::new(
                        "INVALID_FRAME",
                        "本地通信消息不完整或超出长度限制。",
                    )
                    .details(error.to_string()))),
                )?;
                return Err(error);
            }
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--status") {
        println!("{}", response(platform::status().map(|s| json!(s))));
        return;
    }
    // Chrome supplies its origin and (on Windows) parent window arguments.
    // They are never executed or forwarded to a backend.
    if let Err(error) = serve(&mut io::stdin().lock(), &mut io::stdout().lock()) {
        eprintln!("MonoSwitch native messaging: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn handle(bytes: &[u8]) -> Value {
        handle_session(bytes, &mut sharing::Session::default())
    }
    #[test]
    fn invalid_json_and_unknown_actions_do_not_touch_hardware() {
        for request in [
            b"{".as_slice(),
            br#"{"action":"shell","command":"id"}"#,
            br#"{"action":"switch","displayId":"anything","input":0}"#,
            br#"{"action":"switch","displayId":"anything","input":256}"#,
            br#"{"action":"status","unexpected":1}"#,
            br#"{"action":"repair","command":"id"}"#,
        ] {
            assert_eq!(handle(request)["error"]["code"], "INVALID_REQUEST");
        }
    }
    #[test]
    fn malformed_json_does_not_desynchronize_next_frame() {
        let mut input = Vec::new();
        for body in ["{", "{\"action\":\"unsupported\"}"] {
            input.extend_from_slice(&(body.len() as u32).to_ne_bytes());
            input.extend_from_slice(body.as_bytes());
        }
        let mut output = Vec::new();
        serve(&mut input.as_slice(), &mut output).unwrap();
        let mut reader = output.as_slice();
        for _ in 0..2 {
            let value: Value =
                serde_json::from_slice(&framing::read_frame(&mut reader).unwrap().unwrap())
                    .unwrap();
            assert_eq!(value["ok"], false);
        }
        assert!(framing::read_frame(&mut reader).unwrap().is_none());
    }
}
