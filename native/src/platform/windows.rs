//! Windows DDC/CI uses physical-monitor handles, never screen coordinates.
//! API sequence: https://learn.microsoft.com/windows/win32/monitor/using-the-low-level-monitor-configuration-functions

use std::{mem::size_of, ptr};

use windows_sys::Win32::{
    Devices::Display::{
        CapabilitiesRequestAndCapabilitiesReply, DestroyPhysicalMonitor,
        GetCapabilitiesStringLength, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, PHYSICAL_MONITOR,
        SetVCPFeature,
    },
    Foundation::{HANDLE, LPARAM, RECT},
    Graphics::Gdi::{
        DISPLAY_DEVICE_ACTIVE, DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors,
        GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    },
};

use crate::{
    inputs::{parse_capabilities, standard_inputs},
    model::{AppError, Backend, Display, InputSource, SwitchResult},
};

const INPUT_SOURCE_VCP: u8 = 0x60;
const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 1;
const MAX_MONITORS: usize = 128;
const MAX_CAPABILITIES_BYTES: u32 = 65_536;

/// The guard exists before the acquisition call, so even partially populated
/// arrays are cleaned up if the driver returns a failure.
struct PhysicalMonitors(Vec<PHYSICAL_MONITOR>);

impl PhysicalMonitors {
    fn acquire(logical: HMONITOR) -> Result<Self, String> {
        let mut count = 0;
        // SAFETY: logical was returned by EnumDisplayMonitors; count is writable.
        if unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(logical, &mut count) } == 0 {
            return Err(last_error("GetNumberOfPhysicalMonitorsFromHMONITOR"));
        }
        if count == 0 || count as usize > MAX_MONITORS {
            return Err(format!(
                "Windows returned an invalid physical monitor count: {count}"
            ));
        }
        let mut monitors = Self(vec![PHYSICAL_MONITOR::default(); count as usize]);
        // SAFETY: the zero-initialized array has exactly count writable entries.
        if unsafe { GetPhysicalMonitorsFromHMONITOR(logical, count, monitors.0.as_mut_ptr()) } == 0
        {
            return Err(last_error("GetPhysicalMonitorsFromHMONITOR"));
        }
        Ok(monitors)
    }

    fn take(&mut self, index: usize) -> Option<PhysicalMonitor> {
        let handle = self.0[index].hPhysicalMonitor;
        self.0[index].hPhysicalMonitor = ptr::null_mut();
        if handle.is_null() {
            None
        } else {
            Some(PhysicalMonitor(handle))
        }
    }
}

impl Drop for PhysicalMonitors {
    fn drop(&mut self) {
        for monitor in &self.0 {
            // Copy the handle: PHYSICAL_MONITOR is a packed Windows structure.
            let handle = monitor.hPhysicalMonitor;
            if !handle.is_null() {
                // SAFETY: this guard owns all remaining non-null handles.
                unsafe { DestroyPhysicalMonitor(handle) };
            }
        }
    }
}

struct PhysicalMonitor(HANDLE);

impl Drop for PhysicalMonitor {
    fn drop(&mut self) {
        // SAFETY: this handle was transferred out of PhysicalMonitors exactly once.
        unsafe { DestroyPhysicalMonitor(self.0) };
    }
}

struct Monitor {
    id: String,
    name: String,
    physical: Option<PhysicalMonitor>,
    identity_unambiguous: bool,
    warning: Option<String>,
}

struct LogicalInfo {
    device_name: String,
    display_name: String,
    interface: Option<String>,
}

struct Enumeration {
    handles: [HMONITOR; MAX_MONITORS],
    count: usize,
    overflow: bool,
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _bounds: *mut RECT,
    data: LPARAM,
) -> i32 {
    // SAFETY: enumerate passes a live, exclusive Enumeration pointer, and the
    // Win32 callback is synchronous. No allocation or panic can cross this ABI.
    let enumeration = unsafe { &mut *(data as *mut Enumeration) };
    if enumeration.count == MAX_MONITORS {
        enumeration.overflow = true;
        return 0;
    }
    enumeration.handles[enumeration.count] = monitor;
    enumeration.count += 1;
    1
}

fn enumerate() -> Result<(Vec<Monitor>, Vec<String>), AppError> {
    let mut enumeration = Enumeration {
        handles: [ptr::null_mut(); MAX_MONITORS],
        count: 0,
        overflow: false,
    };
    // SAFETY: no clipping DC/rect; callback receives the live stack context.
    let ok = unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(collect_monitor),
            &mut enumeration as *mut Enumeration as LPARAM,
        )
    };
    if enumeration.overflow {
        return Err(AppError::new(
            "ENUMERATION_FAILED",
            "Windows 返回的显示器数量超出了限制。",
        ));
    }
    if ok == 0 {
        return Err(
            AppError::new("ENUMERATION_FAILED", "Windows 无法枚举显示器。")
                .details(last_error("EnumDisplayMonitors")),
        );
    }

    let mut monitors = Vec::new();
    let mut warnings = Vec::new();
    for &logical in &enumeration.handles[..enumeration.count] {
        let info = match logical_info(logical) {
            Ok(info) => info,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        let mut physical = match PhysicalMonitors::acquire(logical) {
            Ok(physical) => physical,
            Err(error) => {
                monitors.push(Monitor {
                    id: monitor_identity(&info, &info.display_name, true),
                    name: info.display_name,
                    physical: None,
                    identity_unambiguous: true,
                    warning: Some(format!(
                        "此显示器暂时无法使用 DDC/CI。请检查显示器的 DDC/CI 设置、线缆和扩展坞。{error}"
                    )),
                });
                continue;
            }
        };
        let descriptions: Vec<String> = physical
            .0
            .iter()
            .map(|monitor| {
                let wide = monitor.szPhysicalMonitorDescription;
                let description = wide_string(&wide);
                if description.is_empty() {
                    info.display_name.clone()
                } else {
                    description
                }
            })
            .collect();
        for (index, description) in descriptions.iter().enumerate() {
            let single = descriptions.len() == 1;
            let unique = descriptions
                .iter()
                .filter(|other| *other == description)
                .count()
                == 1;
            let mut id = monitor_identity(&info, description, single);
            let warning = if !unique {
                // Win32 does not document a mapping between multiple physical
                // handles and EnumDisplayDevices children. Never guess it.
                id.push_str(&format!(":ambiguous:{index}"));
                Some(
                    "Windows 返回了多个无法区分的物理显示器，已禁用切换，以免操作错误的显示器。"
                        .into(),
                )
            } else if !single || info.interface.is_none() {
                Some("Windows 未提供唯一的显示器设备接口，当前选择按连接位置和名称保存。更换线缆或显示器后，请重新选择。".into())
            } else {
                None
            };
            monitors.push(Monitor {
                id,
                name: description.clone(),
                physical: physical.take(index),
                identity_unambiguous: unique,
                warning,
            });
        }
    }
    if monitors.is_empty() && enumeration.count > 0 {
        return Err(AppError::new(
            "ENUMERATION_FAILED",
            "Windows 已检测到显示器，但无法读取其信息。",
        )
        .details(warnings.join("\n")));
    }
    // A faulty/clone driver can expose duplicate device interfaces. Keep them
    // visible, but never allow a stored ID to select an arbitrary first match.
    for index in 0..monitors.len() {
        let duplicate = monitors
            .iter()
            .filter(|item| item.id == monitors[index].id)
            .count()
            > 1;
        if duplicate {
            monitors[index].identity_unambiguous = false;
            append_warning(
                &mut monitors[index].warning,
                "Windows 返回了重复的显示器标识，已禁用此显示器的切换。",
            );
        }
    }
    monitors.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((monitors, warnings))
}

fn logical_info(monitor: HMONITOR) -> Result<LogicalInfo, String> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: MONITORINFOEXW starts with MONITORINFO and cbSize describes the full allocation.
    if unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) } == 0 {
        return Err(last_error("GetMonitorInfoW"));
    }
    let device_name = wide_string(&info.szDevice);
    let mut children = Vec::new();
    for index in 0..MAX_MONITORS as u32 {
        let mut child = DISPLAY_DEVICEW {
            cb: size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // SAFETY: szDevice is the null-terminated name returned by Windows;
        // child has its required size initialized and is writable.
        if unsafe {
            EnumDisplayDevicesW(
                info.szDevice.as_ptr(),
                index,
                &mut child,
                EDD_GET_DEVICE_INTERFACE_NAME,
            )
        } == 0
        {
            break;
        }
        if child.StateFlags & DISPLAY_DEVICE_ACTIVE != 0 {
            children.push((
                wide_string(&child.DeviceID),
                wide_string(&child.DeviceString),
            ));
        }
    }
    let interface = if children.len() == 1 && !children[0].0.is_empty() {
        Some(children[0].0.clone())
    } else {
        None
    };
    let display_name = children
        .first()
        .map(|child| child.1.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| device_name.clone());
    Ok(LogicalInfo {
        device_name,
        display_name,
        interface,
    })
}

fn monitor_identity(info: &LogicalInfo, physical_name: &str, single: bool) -> String {
    if single && let Some(interface) = &info.interface {
        return format!("win:{}", interface.to_lowercase());
    }
    // A GDI connection name plus the physical description survives enumeration
    // reorderings, unlike an ID based solely on the array index.
    format!(
        "win:gdi:{}:{}",
        info.device_name.to_lowercase(),
        physical_name.to_lowercase()
    )
}

pub fn status() -> Result<(Backend, Vec<Display>, Vec<String>), AppError> {
    let (monitors, mut warnings) = enumerate()?;
    if monitors.is_empty() {
        warnings.push("当前 Windows 会话未发现已启用的显示器。".into());
    }
    let displays = monitors.iter().map(inspect).collect();
    Ok((
        Backend {
            name: "Windows DDC/CI (Dxva2)".into(),
            available: true,
            hint: None,
        },
        displays,
        warnings,
    ))
}

fn inspect(monitor: &Monitor) -> Display {
    let mut display = Display {
        id: monitor.id.clone(),
        name: monitor.name.clone(),
        serial: None,
        current_input: None,
        inputs: Vec::new(),
        input_detection: "standard".into(),
        can_switch: false,
        warning: monitor.warning.clone(),
    };
    let Some(physical) = &monitor.physical else {
        append_warning(&mut display.warning, "无法获取可用的 DDC/CI 显示器连接。");
        return display;
    };
    match read_current_input(physical) {
        Ok(current) => {
            display.current_input = current;
            display.can_switch = monitor.identity_unambiguous;
            if current.is_none() {
                append_warning(
                    &mut display.warning,
                    "显示器已响应 DDC/CI，但返回的当前输入源编号无法识别。",
                );
            }
        }
        Err(error) => {
            append_warning(
                &mut display.warning,
                &format!(
                    "此显示器未响应 DDC/CI 输入源查询，暂时无法切换。请在显示器菜单中启用 DDC/CI，并检查连接。{error}"
                ),
            );
            return display;
        }
    }
    let (inputs, reported, warning) =
        choose_inputs(read_capabilities(physical), display.current_input);
    display.inputs = inputs;
    display.input_detection = if reported { "reported" } else { "standard" }.into();
    if let Some(warning) = warning {
        append_warning(&mut display.warning, &warning);
    }
    display
}

fn read_current_input(monitor: &PhysicalMonitor) -> Result<Option<u8>, String> {
    let mut current = 0;
    // SAFETY: the physical handle is live; only the current-value pointer is used.
    if unsafe {
        GetVCPFeatureAndVCPFeatureReply(
            monitor.0,
            INPUT_SOURCE_VCP,
            ptr::null_mut(),
            &mut current,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error("GetVCPFeatureAndVCPFeatureReply(0x60)"));
    }
    Ok(u8::try_from(current).ok().filter(|value| *value != 0))
}

fn read_capabilities(monitor: &PhysicalMonitor) -> Result<String, String> {
    let mut length = 0;
    // SAFETY: the physical handle is live and length is writable.
    if unsafe { GetCapabilitiesStringLength(monitor.0, &mut length) } == 0 {
        return Err(last_error("GetCapabilitiesStringLength"));
    }
    if !(1..=MAX_CAPABILITIES_BYTES).contains(&length) {
        return Err(format!(
            "The driver reported an invalid capabilities length: {length}"
        ));
    }
    let mut buffer = vec![0u8; length as usize];
    // SAFETY: buffer has precisely the requested capacity and is writable.
    if unsafe { CapabilitiesRequestAndCapabilitiesReply(monitor.0, buffer.as_mut_ptr(), length) }
        == 0
    {
        return Err(last_error("CapabilitiesRequestAndCapabilitiesReply"));
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or_else(|| "The capabilities reply was not null-terminated.".to_string())?;
    if !buffer[..end].is_ascii() {
        return Err("The capabilities reply was not ASCII.".into());
    }
    Ok(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

fn choose_inputs(
    capabilities: Result<String, String>,
    current: Option<u8>,
) -> (Vec<InputSource>, bool, Option<String>) {
    match capabilities {
        Ok(capabilities) => {
            let inputs = parse_capabilities(&capabilities);
            if !inputs.is_empty() {
                return (inputs, true, None);
            }
            (standard_inputs(current), false, Some("显示器未报告可用的输入源列表。当前列出的是标准候选项，可能与实际接口不同，请确认后选择。".into()))
        }
        Err(error) => (
            standard_inputs(current),
            false,
            Some(format!(
                "无法读取显示器支持的输入源。当前列出的是标准候选项，可能与实际接口不同，请确认后选择。{error}"
            )),
        ),
    }
}

pub fn switch(display_id: &str, input: u8) -> Result<SwitchResult, AppError> {
    if input == 0 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "输入源编号必须在 1 到 255 之间。",
        ));
    }
    let (monitors, _) = enumerate()?;
    let mut matches = monitors.iter().filter(|monitor| monitor.id == display_id);
    let monitor = matches.next().ok_or_else(|| {
        AppError::new("DISPLAY_NOT_FOUND", "所选显示器已断开，请刷新后重新选择。")
    })?;
    if matches.next().is_some() || !monitor.identity_unambiguous {
        return Err(AppError::new(
            "AMBIGUOUS_DISPLAY",
            "Windows 无法唯一识别此显示器，请选择其他显示器或尝试直接连接。",
        ));
    }
    let physical = monitor
        .physical
        .as_ref()
        .ok_or_else(|| AppError::new("DDC_UNAVAILABLE", "此显示器未提供可用的 DDC/CI 接口。"))?;
    // Recheck the actual device at write time; never trust cached extension state.
    read_current_input(physical).map_err(|error| {
        AppError::new(
            "DDC_UNAVAILABLE",
            "显示器未响应输入源查询，因此未发送切换命令。",
        )
        .details(error)
    })?;
    // SAFETY: the handle is live and the input is a validated one-byte VCP value.
    if unsafe { SetVCPFeature(physical.0, INPUT_SOURCE_VCP, u32::from(input)) } == 0 {
        return Err(
            AppError::new("SWITCH_FAILED", "Windows 无法发送输入源切换命令。")
                .details(last_error("SetVCPFeature(0x60)")),
        );
    }
    // Do not poll after the write: changing inputs may immediately disconnect
    // this computer's DDC channel. Success acknowledges submission, not video.
    Ok(SwitchResult::accepted())
}

fn wide_string(value: &[u16]) -> String {
    String::from_utf16_lossy(
        &value[..value
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(value.len())],
    )
}

fn append_warning(warning: &mut Option<String>, text: &str) {
    match warning {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(text);
        }
        None => *warning = Some(text.into()),
    }
}

fn last_error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_identity_survives_gdi_reordering() {
        let first = LogicalInfo {
            device_name: "\\\\.\\DISPLAY1".into(),
            display_name: "Panel".into(),
            interface: Some("\\\\?\\DISPLAY#ABC#INSTANCE".into()),
        };
        let second = LogicalInfo {
            device_name: "\\\\.\\DISPLAY7".into(),
            display_name: "Panel".into(),
            interface: first.interface.clone(),
        };
        assert_eq!(
            monitor_identity(&first, "Panel", true),
            monitor_identity(&second, "Panel", true)
        );
        assert_ne!(
            monitor_identity(&first, "Panel", true),
            monitor_identity(&first, "Panel", false)
        );
    }

    #[test]
    fn unavailable_capabilities_are_explicitly_standard_candidates() {
        let (inputs, reported, warning) = choose_inputs(Err("DDC timeout".into()), Some(0x1b));
        assert!(!reported);
        assert!(!inputs.is_empty());
        assert!(inputs.iter().any(|input| input.value == 0x1b));
        assert!(warning.unwrap().contains("DDC timeout"));
    }

    #[test]
    fn reported_inputs_come_from_the_actual_capabilities() {
        let (inputs, reported, warning) = choose_inputs(
            Ok("(prot(monitor)type(LCD)vcp(10 60(0F 11 12) D6(01 04)))".into()),
            Some(0x1b),
        );
        assert!(reported);
        assert_eq!(
            inputs.iter().map(|input| input.value).collect::<Vec<_>>(),
            vec![0x0f, 0x11, 0x12]
        );
        assert!(warning.is_none());
    }

    #[test]
    fn other_vcp_values_do_not_become_reported_inputs() {
        let (inputs, reported, warning) =
            choose_inputs(Ok("(vcp(10 12 14(05 08) D6(01 04)))".into()), Some(0x1b));
        assert!(!reported);
        assert!(warning.is_some());
        assert!(inputs.iter().any(|input| input.value == 0x1b));
    }
}
