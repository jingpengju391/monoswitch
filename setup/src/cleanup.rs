use std::{io, path::Path};

pub fn remove_installer() -> io::Result<()> {
    remove_packaged_installer(&std::env::current_exe()?)
}

fn remove_packaged_installer(exe: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if exe.file_name().is_some_and(|name| {
        name == "Install MonoSwitch"
            || name.to_str().is_some_and(|name| {
                (name.starts_with("Install MonoSwitch") || name.starts_with("monoswitch-setup-v"))
                    && name.ends_with(".run")
            })
    }) {
        std::fs::remove_file(exe)?;
    }
    #[cfg(target_os = "macos")]
    if let Some(macos) = exe.parent()
        && let Some(contents) = macos.parent()
        && let Some(app) = contents.parent()
        && exe
            .file_name()
            .is_some_and(|name| name == "monoswitch-setup")
        && macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && app
            .file_name()
            .is_some_and(|name| name == "Install MonoSwitch.app")
    {
        // Delete only our two packaged files, never recursively remove a folder.
        std::fs::remove_file(exe)?;
        std::fs::remove_file(contents.join("Info.plist"))?;
        std::fs::remove_dir(macos)?;
        std::fs::remove_dir(contents)?;
        std::fs::remove_dir(app)?;
    }
    #[cfg(windows)]
    if exe
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("monoswitch-setup-v") && name.ends_with(".exe"))
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        // Windows locks running executables. A bounded helper removes only this
        // file after exit; the path is data, never interpolated into code.
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "for ($i=0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; try { Remove-Item -LiteralPath $env:MONOSWITCH_CLEANUP_EXE -ErrorAction Stop; exit 0 } catch {} }; exit 1"])
            .env("MONOSWITCH_CLEANUP_EXE", exe)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn deletes_only_packaged_installer_and_preserves_neighbors() {
        let root =
            std::env::temp_dir().join(format!("monoswitch-cleanup-{}", crate::files::nonce()));
        std::fs::create_dir(&root).unwrap();
        let installer = root.join("Install MonoSwitch (1).run");
        let neighbor = root.join("keep.txt");
        std::fs::write(&installer, b"installer").unwrap();
        std::fs::write(&neighbor, b"keep").unwrap();
        remove_packaged_installer(&neighbor).unwrap();
        remove_packaged_installer(&installer).unwrap();
        assert!(!installer.exists());
        assert_eq!(std::fs::read(&neighbor).unwrap(), b"keep");
        std::fs::remove_dir_all(root).unwrap();
    }
}
