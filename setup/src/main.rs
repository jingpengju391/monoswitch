#![cfg_attr(windows, windows_subsystem = "windows")]

mod cleanup;
mod deploy;
mod files;
#[cfg(target_os = "linux")]
#[path = "../../shared/linux_setup.rs"]
mod linux_setup;
mod plan;
mod registry;
mod ui;

include!(concat!(env!("OUT_DIR"), "/payload.rs"));

use anyhow::{Result, bail};
use std::path::PathBuf;

#[derive(Default)]
struct Args {
    quiet: bool,
    isolated: Option<PathBuf>,
    uninstall: bool,
    skip_system: bool,
}

fn args() -> Result<Option<Args>> {
    let mut parsed = Args::default();
    let mut values = std::env::args_os().skip(1);
    while let Some(value) = values.next() {
        match value.to_str() {
            Some("--quiet") => parsed.quiet = true,
            Some("--skip-system") => parsed.skip_system = true,
            Some("--uninstall") => parsed.uninstall = true,
            Some("--isolated-dir") => {
                let path = values
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--isolated-dir 缺少目录参数"))?;
                parsed.isolated = Some(PathBuf::from(path));
            }
            Some("--version") => {
                println!("MonoSwitch Setup {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--help") | Some("-h") => {
                println!(
                    "MonoSwitch Setup\n  --quiet                 不显示完成对话框（系统授权仍可能出现）\n  --skip-system           仅安装本机组件，跳过系统依赖配置\n  --isolated-dir <path>   仅在指定目录测试，不修改真实浏览器或注册表\n  --uninstall             卸载当前用户的本机组件\n  --version               显示版本"
                );
                return Ok(None);
            }
            _ => bail!("无法识别的参数：{}", value.to_string_lossy()),
        }
    }
    Ok(Some(parsed))
}

fn main() {
    let options = match args() {
        Ok(Some(options)) => options,
        Ok(None) => return,
        Err(error) => {
            eprintln!("{error:#}");
            if !std::env::args_os().any(|value| value == "--quiet") {
                ui::show(&format!("MonoSwitch 安装参数有误。\n\n{error:#}"), true);
            }
            std::process::exit(1);
        }
    };
    let result = (|| {
        let plan = plan::Plan::current(options.isolated.as_deref())?;
        if options.uninstall {
            deploy::uninstall(&plan)
        } else {
            anyhow::ensure!(!PAYLOAD.is_empty(), "安装包缺少本机组件，无法继续安装");
            #[cfg(target_os = "linux")]
            let system_warning = if !plan.isolated && !options.skip_system {
                linux_setup::repair().err()
            } else {
                None
            };
            let mut data = deploy::install(&plan, PAYLOAD, env!("MONOSWITCH_EXTENSION_ID"))?;
            #[cfg(target_os = "linux")]
            if !plan.isolated && !options.skip_system {
                if let Some(error) = system_warning {
                    data["warnings"].as_array_mut().unwrap().push(error.into());
                }
                data["systemReady"] = linux_setup::check().issues.is_empty().into();
            }
            #[cfg(not(target_os = "linux"))]
            let _ = &mut data;
            Ok(data)
        }
    })();
    let message = match &result {
        Ok(data) => {
            let base = if options.uninstall {
                "MonoSwitch 本机组件已卸载。浏览器扩展可在扩展管理页面移除。"
            } else if options.isolated.is_some() {
                "MonoSwitch 隔离安装完成。真实浏览器和系统注册表未修改。"
            } else if cfg!(target_os = "linux") {
                "MonoSwitch 本地组件已安装。返回 Chrome，扩展会自动连接并检查显示器。\n如仍有系统配置未完成，可在扩展中点击“自动配置”。"
            } else {
                "MonoSwitch 本地组件已安装。返回 Chrome，扩展会自动连接并检查显示器。\n如提示控制后端未就绪，请按扩展中的说明完成设置。"
            };
            let warnings = data["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if warnings.is_empty() {
                base.into()
            } else {
                format!("{base}\n\n{warnings}")
            }
        }
        Err(error) => format!(
            "MonoSwitch {}未完成。\n\n{error:#}",
            if options.uninstall {
                "卸载"
            } else {
                "安装"
            }
        ),
    };
    let needs_attention = match &result {
        Ok(data) => data["warnings"]
            .as_array()
            .is_some_and(|warnings| !warnings.is_empty()),
        Err(_) => true,
    };
    if !needs_attention
        && !options.uninstall
        && options.isolated.is_none()
        && !options.skip_system
        && let Err(error) = cleanup::remove_installer()
    {
        eprintln!("安装已完成，安装器未能自动删除：{error}");
    }
    if !options.quiet && needs_attention {
        ui::show(&message, result.is_err());
    }
    match result {
        Ok(data) => println!("{}", serde_json::json!({"ok": true, "data": data})),
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::json!({"ok": false, "error": format!("{error:#}")})
            );
            std::process::exit(1);
        }
    }
}
