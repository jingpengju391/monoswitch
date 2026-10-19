use crate::model::AppError;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 256 * 1024;

pub fn executable(name: &str, preferred: &[&str]) -> Option<PathBuf> {
    preferred
        .iter()
        .map(PathBuf::from)
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name)),
        )
        .find(|p| p.is_file())
}

/// No shell or inherited stdin; time and output limits apply to every helper command.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String, AppError> {
    let mut child = Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                "BACKEND_UNAVAILABLE",
                "无法启动显示器控制程序。请检查安装和执行权限。",
            )
            .details(error.to_string())
        })?;
    let deadline = Instant::now() + timeout;
    let (sender, receiver) = mpsc::channel();
    for (is_stdout, pipe) in [
        (
            true,
            Box::new(child.stdout.take().expect("piped stdout")) as Box<dyn Read + Send>,
        ),
        (
            false,
            Box::new(child.stderr.take().expect("piped stderr")) as Box<dyn Read + Send>,
        ),
    ] {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = sender.send((is_stdout, result));
        });
    }
    drop(sender);
    let result = (|| {
        let mut stdout = None;
        let mut stderr = None;
        let mut exit = None;
        loop {
            while let Ok((is_stdout, result)) = receiver.try_recv() {
                let bytes = result.map_err(|e| {
                    AppError::new("BACKEND_IO", "读取控制程序输出失败。").details(e.to_string())
                })?;
                if bytes.len() as u64 > OUTPUT_LIMIT {
                    return Err(AppError::new(
                        "BACKEND_OUTPUT_LIMIT",
                        "控制程序返回了过大的响应。",
                    ));
                }
                if is_stdout {
                    stdout = Some(bytes);
                } else {
                    stderr = Some(bytes);
                }
            }
            if exit.is_none() {
                exit = child.try_wait().map_err(|e| {
                    AppError::new("BACKEND_IO", "检查控制程序状态失败。").details(e.to_string())
                })?;
            }
            if let (Some(status), Some(out), Some(err)) = (&exit, &stdout, &stderr) {
                let out = String::from_utf8_lossy(out).into_owned();
                let err = String::from_utf8_lossy(err);
                if status.success() {
                    return Ok(out);
                }
                return Err(
                    AppError::new("BACKEND_COMMAND_FAILED", "显示器控制程序未完成请求。").details(
                        format!("{} {}", err.trim(), out.trim())
                            .trim()
                            .chars()
                            .take(2000)
                            .collect::<String>(),
                    ),
                );
            }
            if Instant::now() >= deadline {
                return Err(AppError::new(
                    "BACKEND_TIMEOUT",
                    "显示器控制请求超时。请检查 DDC/CI 设置和连接。",
                ));
            }
            thread::sleep(Duration::from_millis(15));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn command_timeout_and_output_limit() {
        let error = run(Path::new("/bin/sleep"), &["1"], Duration::from_millis(50)).unwrap_err();
        assert_eq!(error.code, "BACKEND_TIMEOUT");
        let error = run(Path::new("/usr/bin/yes"), &[], Duration::from_secs(2)).unwrap_err();
        assert_eq!(error.code, "BACKEND_OUTPUT_LIMIT");
    }
    #[test]
    fn preserves_argument_boundaries_without_shell() {
        assert_eq!(
            run(
                Path::new("/bin/echo"),
                &["$(not-a-command); value"],
                Duration::from_secs(1)
            )
            .unwrap()
            .trim(),
            "$(not-a-command); value"
        );
    }
}
