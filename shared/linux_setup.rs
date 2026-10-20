//! Shared by the installer and the native host. Inspection never elevates.
use std::{
    fs,
    io::IsTerminal,
    path::Path,
    process::{Command, Stdio},
};

const SCRIPT: &str = include_str!("linux-setup.sh");

pub struct Check {
    pub issues: Vec<String>,
    pub can_repair: bool,
}

fn package_manager(release: &str) -> Option<&'static str> {
    let ids = release
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            matches!(key, "ID" | "ID_LIKE").then_some(value.trim_matches(['\'', '"']))
        })
        .flat_map(str::split_whitespace);
    for id in ids {
        match id {
            "arch" | "manjaro" => return Some("pacman"),
            "debian" | "ubuntu" => return Some("apt"),
            "fedora" | "rhel" | "centos" => return Some("dnf"),
            "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" | "suse" => return Some("zypper"),
            _ => (),
        }
    }
    None
}

fn executable(name: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    ["/usr/bin", "/usr/sbin", "/bin", "/sbin"]
        .iter()
        .find_map(|dir| {
            let path = format!("{dir}/{name}");
            fs::metadata(&path)
                .ok()
                .filter(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .map(|_| path)
        })
}

fn loads_module(text: &str) -> bool {
    text.lines().any(|line| {
        matches!(
            line.split('#').next().unwrap_or("").trim(),
            "i2c-dev" | "i2c_dev"
        )
    })
}

fn startup_enabled() -> bool {
    [
        "/etc/modules-load.d",
        "/usr/lib/modules-load.d",
        "/run/modules-load.d",
    ]
    .iter()
    .any(|dir| {
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                entry.path().extension().is_some_and(|ext| ext == "conf")
                    && fs::read_to_string(entry.path()).is_ok_and(|s| loads_module(&s))
            })
    })
}

pub fn check() -> Check {
    let has_ddcutil = executable("ddcutil").is_some();
    let mut issues = Vec::new();
    if !has_ddcutil {
        issues.push("安装显示器控制组件".into());
    }
    if !Path::new("/sys/class/i2c-dev").exists() {
        issues.push("启用显示器访问接口".into());
    }
    if !startup_enabled() {
        issues.push("设置开机自动启用".into());
    }
    if ![
        "/usr/lib/udev/rules.d/60-ddcutil-i2c.rules",
        "/etc/udev/rules.d/60-ddcutil-i2c.rules",
        "/etc/udev/rules.d/60-monoswitch-i2c.rules",
    ]
    .iter()
    .any(|p| Path::new(p).is_file())
    {
        issues.push("配置当前用户的设备访问权限".into());
    }
    let inaccessible_video_bus = fs::read_dir("/sys/class/i2c-dev")
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let video = entry.path().canonicalize().is_ok_and(|path| {
                path.ancestors().any(|parent| {
                    fs::read_to_string(parent.join("class"))
                        .is_ok_and(|class| class.trim().starts_with("0x03"))
                })
            });
            // Opening checks permissions only; no DDC reads or writes are performed.
            video
                && fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(Path::new("/dev").join(entry.file_name()))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
        });
    if inaccessible_video_bus {
        issues.push("更新当前会话的显示器访问权限".into());
    }
    let manager = package_manager(&fs::read_to_string("/etc/os-release").unwrap_or_default());
    let has_manager = manager.is_some_and(|manager| {
        executable(if manager == "apt" { "apt-get" } else { manager }).is_some()
    });
    let auth = executable("pkexec").is_some()
        || (std::io::stdin().is_terminal() && executable("sudo").is_some());
    Check {
        issues,
        can_repair: auth && (has_ddcutil || has_manager),
    }
}

pub fn repair() -> Result<(), String> {
    let check = check();
    if check.issues.is_empty() {
        return Ok(());
    }
    if !check.can_repair {
        return Err("当前系统没有可用的图形授权工具，或不支持自动安装依赖。请在终端重新运行安装器，或查看故障排查说明。".into());
    }
    let manager = package_manager(&fs::read_to_string("/etc/os-release").unwrap_or_default())
        .unwrap_or("none");
    let (auth, graphical) =
        if let Some(sudo) = executable("sudo").filter(|_| std::io::stdin().is_terminal()) {
            (sudo, false)
        } else {
            (executable("pkexec").ok_or("找不到系统图形授权工具")?, true)
        };
    let output = Command::new(auth)
        .args(["/bin/sh", "-c", SCRIPT, "monoswitch-system-setup", manager])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .stdin(if graphical {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("无法启动系统配置：{e}"))?;
    if !output.status.success() {
        if graphical && output.status.code() == Some(126) {
            return Err("已取消系统授权，未完成自动配置。可以稍后重试。".into());
        }
        let details: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1500)
            .collect();
        return Err(format!(
            "系统配置未完成，请检查授权、网络或软件包管理器后重试。{details}"
        ));
    }
    let remaining = self::check().issues;
    if !remaining.is_empty() {
        return Err(format!("系统配置仍有未完成项：{}", remaining.join("、")));
    }
    Ok(())
}

/// Installs only the optional, explicitly requested input-sharing backend.
#[allow(dead_code)]
pub fn install_sharing() -> Result<(), String> {
    let manager = package_manager(&fs::read_to_string("/etc/os-release").unwrap_or_default())
        .ok_or("当前发行版无法自动安装 Deskflow，请使用官方下载。")?;
    let auth = executable("pkexec").ok_or("找不到系统图形授权工具")?;
    let output = Command::new(auth)
        .args([
            "/bin/sh",
            "-c",
            include_str!("linux-sharing-setup.sh"),
            "monoswitch-input-setup",
            manager,
        ])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("无法安装键鼠组件：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "键鼠组件安装未完成，请检查授权或软件源。{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1500)
                .collect::<String>()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_supported_distributions_without_executing_release_contents() {
        for (release, expected) in [
            ("ID=manjaro\nID_LIKE=arch", Some("pacman")),
            ("ID=pop\nID_LIKE=\"ubuntu debian\"", Some("apt")),
            ("ID=fedora", Some("dnf")),
            ("ID=opensuse-tumbleweed", Some("zypper")),
            ("ID=unknown\nNAME=Ubuntu", None),
            ("ID=$(touch /tmp/unsafe)", None),
        ] {
            assert_eq!(package_manager(release), expected);
        }
    }
    #[test]
    fn distinguishes_active_module_lines_from_comments_and_other_modules() {
        assert!(loads_module("# comment\n i2c-dev # needed\n"));
        assert!(loads_module("i2c_dev"));
        assert!(!loads_module("# i2c-dev\ni2c-other\n"));
    }
}
