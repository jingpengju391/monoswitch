use crate::model::{HostStatus, PlatformInfo};

#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux;
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(target_os = "windows")]
use windows as backend;

pub use backend::switch;

pub fn status() -> Result<HostStatus, crate::model::AppError> {
    let (backend, displays, warnings) = backend::status()?;
    #[cfg(target_os = "linux")]
    let system_setup = {
        let check = crate::linux_setup::check();
        Some(crate::model::SystemSetup {
            needs_repair: !check.issues.is_empty(),
            can_repair: check.can_repair,
            issues: check.issues,
        })
    };
    #[cfg(not(target_os = "linux"))]
    let system_setup = None;
    Ok(HostStatus {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: info(),
        backend,
        displays,
        warnings,
        system_setup,
    })
}

fn info() -> PlatformInfo {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .or_else(system_hostname)
        .unwrap_or_else(|| "我的电脑".into())
        .trim()
        .chars()
        .take(255)
        .collect();
    #[cfg(target_os = "linux")]
    let distribution = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| linux::distribution(&s));
    #[cfg(not(target_os = "linux"))]
    let distribution = None;
    PlatformInfo {
        os: std::env::consts::OS.into(),
        distribution,
        arch: std::env::consts::ARCH.into(),
        hostname,
    }
}

fn system_hostname() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        crate::command::run(
            std::path::Path::new("/bin/hostname"),
            &[],
            std::time::Duration::from_secs(2),
        )
        .ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
