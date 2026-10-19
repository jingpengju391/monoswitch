pub fn show(message: &str, failed: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let body: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "MonoSwitch".encode_utf16().chain(Some(0)).collect();
        // SAFETY: strings are live null-terminated UTF-16; no owner window.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK
                    | if failed {
                        MB_ICONERROR
                    } else {
                        MB_ICONINFORMATION
                    },
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        // The message is argv data, never interpolated into AppleScript source.
        let _ = std::process::Command::new("/usr/bin/osascript").args(["-e",
            "on run argv\ndisplay dialog (item 1 of argv) with title \"MonoSwitch\" buttons {\"好\"} default button 1\nend run", message]).status();
        let _ = failed;
    }
    #[cfg(target_os = "linux")]
    {
        let displayed = std::process::Command::new("zenity")
            .args([
                if failed { "--error" } else { "--info" },
                "--title=MonoSwitch",
                "--no-wrap",
                "--text",
                message,
            ])
            .status()
            .is_ok_and(|status| status.success());
        if displayed {
            return;
        }
        let displayed = std::process::Command::new("kdialog")
            .args([
                "--title",
                "MonoSwitch",
                if failed { "--error" } else { "--msgbox" },
                message,
            ])
            .status()
            .is_ok_and(|status| status.success());
        if displayed {
            return;
        }
        // A desktop without dialog packages can still display a plain text
        // result. CLI callers also receive the structured stdout/stderr result.
        let path = std::env::temp_dir().join(format!(
            "monoswitch-setup-result-{}.txt",
            crate::files::nonce()
        ));
        if crate::files::write(&path, message.as_bytes(), false).is_ok() {
            let _ = std::process::Command::new("xdg-open").arg(path).spawn();
        }
    }
}
