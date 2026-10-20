//! Trigger only MonoSwitch's two fixed Deskflow hotkeys on the sender.
use super::{AppError, failure};

#[cfg(target_os = "linux")]
pub fn switch(receiver: bool) -> Result<(), AppError> {
    if std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland") {
        return Err(failure(
            "当前 Wayland 发送端不支持按钮联动，请使用 X11 会话。",
        ));
    }
    switch_x11(None, receiver)
}
#[cfg(target_os = "linux")]
pub(super) fn switch_x11(display: Option<&str>, receiver: bool) -> Result<(), AppError> {
    use x11rb::{
        connection::Connection,
        protocol::{xproto::ConnectionExt, xtest::ConnectionExt as _},
    };
    let (connection, _) = x11rb::connect(display).map_err(super::io_error)?;
    let setup = connection.setup();
    let mapping = connection
        .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
        .map_err(super::io_error)?
        .reply()
        .map_err(super::io_error)?;
    let find = |symbol| {
        mapping
            .keysyms
            .chunks(mapping.keysyms_per_keycode as usize)
            .position(|symbols| symbols.contains(&symbol))
            .map(|index| setup.min_keycode + index as u8)
            .ok_or_else(|| failure("无法找到键鼠切换快捷键，请检查键盘布局。"))
    };
    let modifiers = [find(0xffe3)?, find(0xffe1)?]; // Control_L, Shift_L
    let key = find(if receiver { 0xffc6 } else { 0xffc5 })?; // F9 / F8
    let held = connection
        .query_keymap()
        .map_err(super::io_error)?
        .reply()
        .map_err(super::io_error)?
        .keys;
    let is_down = |key: u8| held[key as usize / 8] & (1 << (key % 8)) != 0;
    if is_down(key) {
        return Err(failure("请松开 F8/F9 后重新切换。"));
    }
    let modifiers: Vec<_> = modifiers.into_iter().filter(|key| !is_down(*key)).collect();
    for key in modifiers.iter().copied().chain(std::iter::once(key)) {
        connection
            .xtest_fake_input(2, key, 0, 0, 0, 0, 0)
            .map_err(super::io_error)?
            .check()
            .map_err(super::io_error)?;
    }
    for key in std::iter::once(key).chain(modifiers.iter().rev().copied()) {
        connection
            .xtest_fake_input(3, key, 0, 0, 0, 0, 0)
            .map_err(super::io_error)?
            .check()
            .map_err(super::io_error)?;
    }
    connection.flush().map_err(super::io_error)
}

#[cfg(windows)]
pub fn switch(receiver: bool) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let modifiers = [VK_CONTROL, VK_SHIFT];
    let mut keys: Vec<(u16, bool)> = Vec::new();
    for key in modifiers {
        if unsafe { GetAsyncKeyState(key as i32) } >= 0 {
            keys.push((key, false));
        }
    }
    let function = if receiver { VK_F9 } else { VK_F8 };
    if unsafe { GetAsyncKeyState(function as i32) } < 0 {
        return Err(failure("请松开 F8/F9 后重新切换。"));
    }
    let releases: Vec<_> = keys.iter().rev().map(|(key, _)| (*key, true)).collect();
    keys.extend([(function, false), (function, true)]);
    keys.extend(releases);
    let inputs: Vec<_> = keys
        .into_iter()
        .map(|(key, up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent != inputs.len() as u32 {
        return Err(failure("系统未接受键鼠切换，请检查输入权限。"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn switch(receiver: bool) -> Result<(), AppError> {
    use std::ffi::c_void;
    // Resolve system frameworks at runtime so cross builds do not require an Apple SDK.
    let services = unsafe {
        libloading::Library::new(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
        )
    }
    .map_err(super::io_error)?;
    let foundation = unsafe {
        libloading::Library::new(
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        )
    }
    .map_err(super::io_error)?;
    let create: libloading::Symbol<unsafe extern "C" fn(*const c_void, u16, bool) -> *mut c_void> =
        unsafe { services.get(b"CGEventCreateKeyboardEvent") }.map_err(super::io_error)?;
    let flags: libloading::Symbol<unsafe extern "C" fn(*mut c_void, u64)> =
        unsafe { services.get(b"CGEventSetFlags") }.map_err(super::io_error)?;
    let post: libloading::Symbol<unsafe extern "C" fn(u32, *mut c_void)> =
        unsafe { services.get(b"CGEventPost") }.map_err(super::io_error)?;
    let trusted: libloading::Symbol<unsafe extern "C" fn() -> bool> =
        unsafe { services.get(b"AXIsProcessTrusted") }.map_err(super::io_error)?;
    let release: libloading::Symbol<unsafe extern "C" fn(*const c_void)> =
        unsafe { foundation.get(b"CFRelease") }.map_err(super::io_error)?;
    if !unsafe { trusted() } {
        return Err(failure(
            "请在 macOS 辅助功能中允许 MonoSwitch 本地组件控制键盘。",
        ));
    }
    for down in [true, false] {
        let event = unsafe { create(std::ptr::null(), if receiver { 101 } else { 100 }, down) };
        if event.is_null() {
            return Err(failure("系统未接受键鼠切换，请检查输入权限。"));
        }
        unsafe {
            flags(event, (1 << 17) | (1 << 18));
            post(0, event);
            release(event);
        }
    }
    Ok(())
}
