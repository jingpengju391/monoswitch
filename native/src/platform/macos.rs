use crate::{
    command,
    inputs::{parse_capabilities, standard_inputs},
    model::{AppError, Backend, Display, SwitchResult},
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(16);
const SETUP: &str = "安装并运行 BetterDisplay，开启 Settings → Application → Integration 的 CLI / Notification，并启用此显示器的 DDC 控制。支持 Intel 与 Apple Silicon；无需单独安装 betterdisplaycli。";

fn binary() -> Option<PathBuf> {
    command::executable(
        "betterdisplaycli",
        &[
            "/opt/homebrew/bin/betterdisplaycli",
            "/usr/local/bin/betterdisplaycli",
        ],
    )
    .or_else(|| {
        let system = PathBuf::from("/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay");
        system.is_file().then_some(system)
    })
    .or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay"))
            .filter(|path| path.is_file())
    })
}

#[derive(Debug)]
struct Detected {
    uuid: String,
    name: String,
    serial: Option<String>,
}
impl Detected {
    fn id(&self) -> String {
        format!("mac:uuid:{}", self.uuid)
    }
    fn selector(&self) -> String {
        format!("-UUID={}", self.uuid)
    }
}

fn valid_uuid(uuid: &str) -> bool {
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

/// BetterDisplay emits JSON identifiers. Accept a single object, arrays, and sequential
/// JSON objects for multiple devices. Do not extract numbers/names from arbitrary text.
fn identifiers(text: &str) -> Result<Vec<Detected>, AppError> {
    fn visit(value: &Value, output: &mut Vec<Detected>, depth: u8) {
        if depth > 8 {
            return;
        }
        if let Some(object) = value.as_object() {
            if let Some(uuid) = object.get("UUID").and_then(Value::as_str) {
                let device_type = object
                    .get("deviceType")
                    .and_then(Value::as_str)
                    .unwrap_or("Display");
                if !device_type.eq_ignore_ascii_case("Display") || !valid_uuid(uuid) {
                    return;
                }
                if output.iter().any(|d| d.uuid.eq_ignore_ascii_case(uuid)) {
                    return;
                }
                let name = ["name", "productName", "originalName"]
                    .iter()
                    .find_map(|key| {
                        object
                            .get(*key)
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                    })
                    .unwrap_or("外接显示器")
                    .to_owned();
                let serial = object
                    .get("alphanumericSerial")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        object
                            .get("serial")
                            .and_then(|v| {
                                v.as_str()
                                    .map(str::to_owned)
                                    .or_else(|| v.as_u64().map(|n| n.to_string()))
                            })
                            .filter(|s| s != "0" && !s.is_empty())
                    });
                output.push(Detected {
                    uuid: uuid.to_ascii_uppercase(),
                    name,
                    serial,
                });
            } else {
                for value in object.values() {
                    visit(value, output, depth + 1);
                }
            }
        } else if let Some(array) = value.as_array() {
            for value in array {
                visit(value, output, depth + 1);
            }
        }
    }
    let mut output = Vec::new();
    let mut saw_value = false;
    for item in serde_json::Deserializer::from_str(text).into_iter::<Value>() {
        let value = item.map_err(|e| {
            AppError::new(
                "BACKEND_FORMAT",
                "BetterDisplay 返回的显示器列表不是有效 JSON。请更新 BetterDisplay 后重试。",
            )
            .details(e.to_string())
        })?;
        if !value.is_array() && !value.is_object() {
            return Err(AppError::new(
                "BACKEND_FORMAT",
                "BetterDisplay 返回了无法识别的显示器列表。",
            ));
        }
        saw_value = true;
        visit(&value, &mut output, 0);
    }
    if !saw_value && !text.trim().is_empty() {
        return Err(AppError::new(
            "BACKEND_FORMAT",
            "BetterDisplay 显示器列表为空。",
        ));
    }
    Ok(output)
}

fn current_input(text: &str) -> Option<u8> {
    let text = text.trim();
    let value = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u8::from_str_radix(hex, 16).ok()
    } else {
        text.parse::<u8>().ok()
    };
    value.filter(|value| *value != 0)
}

fn list(program: &Path) -> Result<Vec<Detected>, AppError> {
    let output = command::run(program, &["get", "-type=Display", "-identifiers"], TIMEOUT)?;
    identifiers(&output)
}

fn read_input(program: &Path, display: &Detected) -> Result<u8, AppError> {
    let selector = display.selector();
    let output = command::run(
        program,
        &["get", &selector, "-feature=ddc", "-vcp=0x60", "-value"],
        TIMEOUT,
    )?;
    current_input(&output).ok_or_else(|| {
        AppError::new(
            "DDC_UNSUPPORTED",
            "显示器未返回有效输入源（VCP 0x60）。请检查 BetterDisplay 的 DDC 控制及接线。",
        )
    })
}

fn inspect(program: &Path, display: Detected) -> Display {
    let current = read_input(program, &display);
    let selector = display.selector();
    let inputs = command::run(
        program,
        &["get", &selector, "-ddcCapabilitiesString"],
        TIMEOUT,
    )
    .ok()
    .map(|s| parse_capabilities(&s))
    .unwrap_or_default();
    let reported = !inputs.is_empty();
    let mut warnings: Vec<String> = Vec::new();
    if current.is_err() {
        warnings.push(
            "无法读取 VCP 0x60；内置屏幕、虚拟显示器或不支持 DDC 的连接不能切换输入。".into(),
        );
    }
    if !reported {
        warnings.push("未获取到显示器输入列表；显示的是常见编号，请按实际端口确认。".into());
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
                name: "BetterDisplay".into(),
                available: false,
                hint: Some(SETUP.into()),
            },
            Vec::new(),
            Vec::new(),
        ));
    };
    let mut warnings: Vec<String> = Vec::new();
    let found = match list(&program) {
        Ok(found) => found,
        Err(error) => {
            return Ok((
                Backend {
                    name: "BetterDisplay".into(),
                    available: true,
                    hint: Some(SETUP.into()),
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
    let displays = std::thread::scope(|scope| {
        let tasks: Vec<_> = found
            .into_iter()
            .take(16)
            .map(|display| {
                let program = &program;
                scope.spawn(move || inspect(program, display))
            })
            .collect();
        tasks
            .into_iter()
            .map(|task| task.join().expect("display inspection thread"))
            .collect::<Vec<_>>()
    });
    if displays.is_empty() {
        warnings.push("BetterDisplay 未报告可用的物理显示器。请检查显示器连接并刷新。".into());
    }
    Ok((
        Backend {
            name: "BetterDisplay".into(),
            available: true,
            hint: None,
        },
        displays,
        warnings,
    ))
}

pub fn switch(display_id: &str, input: u8) -> Result<SwitchResult, AppError> {
    if input == 0 {
        return Err(AppError::new("INVALID_REQUEST", "输入源必须为 1–255。"));
    }
    let program = binary().ok_or_else(|| AppError::new("BACKEND_UNAVAILABLE", SETUP))?;
    let found = list(&program)?;
    let display = found.iter().find(|d| d.id() == display_id).ok_or_else(|| {
        AppError::new(
            "DISPLAY_NOT_FOUND",
            "显示器已断开或标识改变，请刷新后重新选择。",
        )
    })?;
    read_input(&program, display)?;
    let selector = display.selector();
    let value = format!("-value={input}");
    command::run(
        &program,
        &["set", &selector, "-feature=ddc", "-vcp=0x60", &value],
        TIMEOUT,
    )?;
    Ok(SwitchResult::accepted())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_upstream_identifier_object() {
        let displays = identifiers(include_str!(
            "../../tests/fixtures/betterdisplay-identifiers.json"
        ))
        .unwrap();
        assert_eq!(displays.len(), 1);
        assert_eq!(displays[0].name, "LG ULTRAGEAR+");
        assert_eq!(displays[0].serial.as_deref(), Some("509RMYA5Z930"));
        assert_eq!(
            displays[0].id(),
            "mac:uuid:D3293027-2260-44D6-AEC9-3E44016C85AE"
        );
    }
    #[test]
    fn parses_arrays_and_sequential_objects_but_filters_virtual_devices() {
        let object = include_str!("../../tests/fixtures/betterdisplay-identifiers.json");
        assert_eq!(identifiers(&format!("[{object}]")).unwrap().len(), 1);
        assert_eq!(
            identifiers(&format!("{object}\n{object}")).unwrap().len(),
            1
        );
        assert!(
            identifiers(&object.replace("\"Display\"", "\"VirtualScreen\""))
                .unwrap()
                .is_empty()
        );
        assert!(identifiers("Failed.").is_err());
        assert!(identifiers("17").is_err());
    }
    #[test]
    fn rejects_ambiguous_or_invalid_ddc_readback() {
        assert_eq!(current_input("17\n"), Some(17));
        assert_eq!(current_input("0x0F"), Some(15));
        for value in ["-1", "256", "17\n15", "Failed.", "0"] {
            assert_eq!(current_input(value), None);
        }
    }
    #[cfg(unix)]
    #[test]
    fn fallback_keeps_observed_input_without_claiming_reported_capabilities() {
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
            "monoswitch-betterdisplay-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
        fs::create_dir_all(&root.0).unwrap();
        let program = root.0.join("betterdisplaycli");
        fs::write(
            &program,
            r#"#!/bin/sh
printf '%s\n' "$*" >> "${0%/*}/calls"
case "$*" in
  'get -UUID=D3293027-2260-44D6-AEC9-3E44016C85AE -feature=ddc -vcp=0x60 -value')
    printf '%s\n' '27' ;;
  'get -UUID=D3293027-2260-44D6-AEC9-3E44016C85AE -ddcCapabilitiesString')
    exit 1 ;;
  *) exit 2 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let display = inspect(
            &program,
            Detected {
                uuid: "D3293027-2260-44D6-AEC9-3E44016C85AE".into(),
                name: "Test monitor".into(),
                serial: Some("TEST001".into()),
            },
        );
        assert!(display.can_switch);
        assert_eq!(display.current_input, Some(0x1b));
        assert_eq!(display.input_detection, "standard");
        assert!(display.inputs.iter().any(|input| input.value == 0x1b));
        assert!(display.warning.is_some());
        assert!(
            fs::read_to_string(root.0.join("calls"))
                .unwrap()
                .lines()
                .all(|call| call.starts_with("get "))
        );
    }
}
