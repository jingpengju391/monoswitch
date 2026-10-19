use crate::{
    command,
    inputs::{parse_capabilities, standard_inputs},
    model::{AppError, Backend, Display, SwitchResult},
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(12);
const SETUP: &str = "缺少显示器控制组件，请点击“自动配置”。显示器菜单中的 DDC/CI 开关需要开启。";
const PERMISSIONS: &str = "请先完成“自动配置”；若仍无法读取，请检查显示器连接及 DDC/CI 开关。";

fn binary() -> Option<PathBuf> {
    command::executable("ddcutil", &["/usr/bin/ddcutil", "/usr/local/bin/ddcutil"])
}

pub fn distribution(text: &str) -> Option<String> {
    ["PRETTY_NAME", "NAME", "ID"].iter().find_map(|key| {
        text.lines()
            .find_map(|line| line.strip_prefix(&format!("{key}=")))
            .map(|value| value.trim().trim_matches('"').trim_matches('\'').to_owned())
            .filter(|s| !s.is_empty())
    })
}

#[derive(Debug)]
struct Detected {
    bus: u32,
    name: String,
    serial: Option<String>,
    identity: String,
}
impl Detected {
    fn id(&self) -> String {
        // Include the monitor fingerprint so a reused bus cannot select a different model/serial.
        let hash = self.identity.bytes().fold(0xcbf29ce484222325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
        format!("linux:i2c:{}:{hash:016x}", self.bus)
    }
}

fn detect(text: &str) -> Vec<Detected> {
    let mut output = Vec::new();
    let mut valid = false;
    let mut bus = None;
    let mut monitor = None;
    let flush = |output: &mut Vec<Detected>, bus: Option<u32>, monitor: Option<&str>| {
        if let (Some(bus), Some(monitor)) = (bus, monitor) {
            let fields: Vec<_> = monitor.splitn(3, ':').map(str::trim).collect();
            let name = fields
                .get(1)
                .copied()
                .filter(|s| !s.is_empty())
                .unwrap_or(monitor)
                .to_owned();
            let serial = fields
                .get(2)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "Unspecified");
            output.push(Detected {
                bus,
                name,
                serial,
                identity: monitor.to_owned(),
            });
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("Display ") || line.starts_with("Invalid display") {
            if valid {
                flush(&mut output, bus, monitor);
            }
            valid = line
                .strip_prefix("Display ")
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok())
                .is_some();
            bus = None;
            monitor = None;
        } else if valid {
            if let Some(value) = line.strip_prefix("I2C bus:") {
                bus = value
                    .trim()
                    .strip_prefix("/dev/i2c-")
                    .and_then(|s| s.parse().ok());
            }
            if let Some(value) = line.strip_prefix("Monitor:") {
                monitor = Some(value.trim());
            }
        }
    }
    if valid {
        flush(&mut output, bus, monitor);
    }
    output
}

fn current_input(text: &str) -> Option<u8> {
    text.lines().find_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 4
            || fields[0] != "VCP"
            || !fields[1].eq_ignore_ascii_case("60")
            || fields[2] != "SNC"
        {
            return None;
        }
        let hex = fields[3]
            .strip_prefix("0x")
            .or_else(|| fields[3].strip_prefix('x'))
            .unwrap_or(fields[3]);
        u8::from_str_radix(hex, 16).ok().filter(|value| *value != 0)
    })
}

fn list(program: &Path) -> Result<Vec<Detected>, AppError> {
    let raw = command::run(program, &["detect", "--brief"], Duration::from_secs(15))?;
    Ok(detect(&raw))
}

fn read_input(program: &Path, display: &Detected) -> Result<u8, AppError> {
    let bus = display.bus.to_string();
    let raw = command::run(
        program,
        &["--bus", &bus, "getvcp", "60", "--terse"],
        TIMEOUT,
    )?;
    current_input(&raw).ok_or_else(|| {
        AppError::new(
            "DDC_UNSUPPORTED",
            "显示器未返回有效的输入源（VCP 0x60）。请检查 DDC/CI 和连接。",
        )
    })
}

fn inspect(program: &Path, display: Detected) -> Display {
    let current = read_input(program, &display);
    let bus = display.bus.to_string();
    let inputs = command::run(
        program,
        &["--bus", &bus, "capabilities", "--terse"],
        TIMEOUT,
    )
    .ok()
    .map(|s| parse_capabilities(&s))
    .unwrap_or_default();
    let reported = !inputs.is_empty();
    let mut warnings = Vec::new();
    if current.is_err() {
        warnings.push(format!("无法读取输入源。{PERMISSIONS}"));
    }
    if !reported {
        warnings.push("显示器未报告输入列表；显示的是常见编号，请按显示器实际端口确认。".into());
    }
    if display.serial.is_none() {
        warnings.push("显示器未报告序列号；更换接线后请重新选择显示器。".into());
    }
    let current_input = current.as_ref().ok().copied();
    Display {
        id: display.id(),
        name: display.name,
        serial: display.serial,
        current_input,
        can_switch: current.is_ok(),
        inputs: if reported {
            inputs
        } else {
            standard_inputs(current_input)
        },
        input_detection: if reported { "reported" } else { "standard" }.into(),
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    }
}

pub fn status() -> Result<(Backend, Vec<Display>, Vec<String>), AppError> {
    let Some(program) = binary() else {
        return Ok((
            Backend {
                name: "ddcutil".into(),
                available: false,
                hint: Some(SETUP.into()),
            },
            Vec::new(),
            Vec::new(),
        ));
    };
    status_with(&program)
}

fn status_with(program: &Path) -> Result<(Backend, Vec<Display>, Vec<String>), AppError> {
    let mut warnings = Vec::new();
    let found = match list(program) {
        Ok(found) => found,
        Err(error) => {
            return Ok((
                Backend {
                    name: "ddcutil".into(),
                    available: true,
                    hint: Some(PERMISSIONS.into()),
                },
                Vec::new(),
                vec![format!(
                    "{} {}",
                    error.message,
                    error.details.unwrap_or_default()
                )],
            ));
        }
    };
    if found.len() > 16 {
        warnings.push("仅扫描前 16 台显示器。".into());
    }
    // Independent I2C buses are inspected in parallel, keeping total wait bounded.
    let displays = std::thread::scope(|scope| {
        let tasks: Vec<_> = found
            .into_iter()
            .take(16)
            .map(|display| scope.spawn(move || inspect(program, display)))
            .collect();
        tasks
            .into_iter()
            .map(|task| task.join().expect("display inspection thread"))
            .collect::<Vec<_>>()
    });
    if displays.is_empty() {
        warnings.push(format!("未发现支持 DDC/CI 的 I2C 显示器。{PERMISSIONS}"));
    }
    Ok((
        Backend {
            name: "ddcutil".into(),
            available: true,
            hint: None,
        },
        displays,
        warnings,
    ))
}

pub fn switch(display_id: &str, input: u8) -> Result<SwitchResult, AppError> {
    let program = binary().ok_or_else(|| AppError::new("BACKEND_UNAVAILABLE", SETUP))?;
    switch_with(&program, display_id, input)
}

fn switch_with(program: &Path, display_id: &str, input: u8) -> Result<SwitchResult, AppError> {
    if input == 0 {
        return Err(AppError::new("INVALID_REQUEST", "输入源必须为 1–255。"));
    }
    let found = list(program)?;
    let display = found.iter().find(|d| d.id() == display_id).ok_or_else(|| {
        AppError::new(
            "DISPLAY_NOT_FOUND",
            "显示器已断开或连接编号改变，请刷新后重新选择。",
        )
    })?;
    read_input(program, display)?;
    let bus = display.bus.to_string();
    let value = input.to_string();
    command::run(program, &["--bus", &bus, "setvcp", "60", &value], TIMEOUT)?;
    Ok(SwitchResult::accepted())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_official_ddcutil_brief_format_and_ignores_invalid_display() {
        let displays = detect(include_str!("../../tests/fixtures/ddcutil-detect.txt"));
        assert_eq!(displays.len(), 2);
        assert_eq!(displays[0].bus, 7);
        assert_eq!(displays[1].name, "DELL P2411H");
        assert_eq!(displays[1].serial.as_deref(), Some("F8NDP11G119U"));
        assert_ne!(displays[0].id(), displays[1].id());
    }
    #[test]
    fn parses_hex_snc_input_and_rejects_failure() {
        assert_eq!(current_input("VCP 60 SNC x11\n"), Some(17));
        assert_eq!(current_input("VCP 60 SNC 0x0f"), Some(15));
        assert_eq!(current_input("VCP 60 ERR"), None);
        assert_eq!(current_input("VCP 10 C 50 100"), None);
        assert_eq!(current_input("VCP 60 SNC x100"), None);
    }
    #[test]
    fn detects_manjaro_without_executing_os_release() {
        assert_eq!(
            distribution("NAME=Manjaro\nPRETTY_NAME=\"Manjaro Linux\"\nID=manjaro"),
            Some("Manjaro Linux".into())
        );
        assert_eq!(distribution("ID=arch"), Some("arch".into()));
    }
    #[cfg(unix)]
    #[test]
    fn fake_ddcutil_exercises_status_and_only_targeted_input_write() {
        use std::{
            fs,
            os::unix::fs::PermissionsExt,
            time::{SystemTime, UNIX_EPOCH},
        };
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let root = Fixture(std::env::temp_dir().join(format!(
                "monoswitch-ddc-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
        fs::create_dir_all(&root.0).unwrap();
        let program = root.0.join("ddcutil");
        fs::write(
            &program,
            r#"#!/bin/sh
printf '%s\n' "$*" >> "${0%/*}/calls"
case "$*" in
  'detect --brief')
    printf '%s\n' 'Display 1' '   I2C bus: /dev/i2c-7' '   Monitor: DEL:Test Display:TEST001' ;;
  '--bus 7 getvcp 60 --terse')
    if [ -f "${0%/*}/fallback" ]; then
      printf '%s\n' 'VCP 60 SNC x1b'
    else
      printf '%s\n' 'VCP 60 SNC x0f'
    fi ;;
  '--bus 7 capabilities --terse')
    if [ -f "${0%/*}/fallback" ]; then exit 1; fi
    printf '%s\n' '(prot(monitor)vcp(10 60(0F 11 12)))' ;;
  '--bus 7 setvcp 60 17')
    if [ -f "${0%/*}/reject" ]; then
      printf '%s\n' 'simulated permission denied' >&2
      exit 1
    fi ;;
  *) printf '%s\n' 'unexpected command' >&2; exit 2 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let (backend, displays, warnings) = status_with(&program).unwrap();
        assert!(backend.available);
        assert!(warnings.is_empty());
        assert_eq!(displays.len(), 1);
        let display = &displays[0];
        assert!(display.can_switch);
        assert_eq!(display.current_input, Some(15));
        assert_eq!(display.input_detection, "reported");
        assert_eq!(
            display.inputs.iter().map(|i| i.value).collect::<Vec<_>>(),
            [15, 17, 18]
        );
        let log = root.0.join("calls");
        assert!(!fs::read_to_string(&log).unwrap().contains("setvcp"));
        assert!(switch_with(&program, &display.id, 17).unwrap().accepted);
        let accepted_calls = fs::read_to_string(&log).unwrap();
        assert_eq!(
            accepted_calls
                .lines()
                .filter(|s| *s == "--bus 7 setvcp 60 17")
                .count(),
            1
        );
        assert_eq!(
            switch_with(&program, "linux:i2c:8:forged;ignored", 17)
                .unwrap_err()
                .code,
            "DISPLAY_NOT_FOUND"
        );
        assert_eq!(
            switch_with(&program, &display.id, 0).unwrap_err().code,
            "INVALID_REQUEST"
        );
        let rejected_calls = fs::read_to_string(&log).unwrap();
        assert_eq!(
            rejected_calls
                .lines()
                .filter(|s| s.contains("setvcp"))
                .count(),
            1
        );
        fs::write(root.0.join("reject"), b"").unwrap();
        assert_eq!(
            switch_with(&program, &display.id, 17).unwrap_err().code,
            "BACKEND_COMMAND_FAILED"
        );
        let calls_before_fallback = fs::read_to_string(&log).unwrap();
        fs::write(root.0.join("fallback"), b"").unwrap();
        let (_, displays, _) = status_with(&program).unwrap();
        let fallback = &displays[0];
        assert!(fallback.can_switch);
        assert_eq!(fallback.current_input, Some(0x1b));
        assert_eq!(fallback.input_detection, "standard");
        assert!(fallback.inputs.iter().any(|input| input.value == 0x1b));
        assert!(fallback.inputs.iter().any(|input| input.value == 2));
        assert!(fallback.inputs.iter().any(|input| input.value == 4));
        let calls_after_fallback = fs::read_to_string(&log).unwrap();
        assert!(!calls_after_fallback[calls_before_fallback.len()..].contains("setvcp"));
    }
}
