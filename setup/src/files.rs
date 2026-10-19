use anyhow::{Context, Result, ensure};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SNAPSHOT_BYTES: u64 = 4 * 1024 * 1024;

pub fn nonce() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("无法创建目录：{}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write next to the destination, sync, then atomically replace its directory
/// entry. On Windows fs::rename cannot replace an existing destination.
pub fn write(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let parent = path.parent().context("文件缺少父目录")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".monoswitch-new-{}", nonce()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if executable {
                0o700
            } else {
                0o600
            }))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, path)
    })();
    let _ = fs::remove_file(&temporary);
    result.with_context(|| format!("无法写入：{}", path.display()))
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target)?;
    Ok(())
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both paths are live, null-terminated UTF-16 buffers.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub struct Snapshot {
    path: PathBuf,
    original: Option<(Vec<u8>, fs::Permissions)>,
}

impl Snapshot {
    pub fn capture(path: &Path) -> Result<Self> {
        let original = match fs::symlink_metadata(path) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "安装目标不是普通文件：{}",
                    path.display()
                );
                ensure!(
                    metadata.len() <= MAX_SNAPSHOT_BYTES,
                    "现有配置文件过大：{}",
                    path.display()
                );
                Some((fs::read(path)?, metadata.permissions()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("无法备份：{}", path.display()));
            }
        };
        Ok(Self {
            path: path.to_owned(),
            original,
        })
    }

    pub fn restore(&self) -> Result<()> {
        if let Some((bytes, permissions)) = &self.original {
            write(&self.path, bytes, false)?;
            fs::set_permissions(&self.path, permissions.clone())?;
        } else {
            remove(&self.path)?;
        }
        Ok(())
    }
}

pub fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("无法删除：{}", path.display())),
    }
}

pub fn restore_all(snapshots: &[Snapshot]) -> Result<()> {
    let failures: Vec<_> = snapshots
        .iter()
        .rev()
        .filter_map(|snapshot| snapshot.restore().err())
        .map(|error| format!("{error:#}"))
        .collect();
    ensure!(
        failures.is_empty(),
        "配置恢复未完成：{}",
        failures.join("；")
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_restore_previous_bytes_and_remove_new_files() {
        let root = std::env::temp_dir().join(format!("monoswitch-files-{}", nonce()));
        fs::create_dir_all(&root).unwrap();
        let existing = root.join("existing.json");
        let new = root.join("new.json");
        write(&existing, b"previous", false).unwrap();
        let snapshots = [
            Snapshot::capture(&existing).unwrap(),
            Snapshot::capture(&new).unwrap(),
        ];
        write(&existing, b"updated", false).unwrap();
        write(&new, b"new", false).unwrap();
        restore_all(&snapshots).unwrap();
        assert_eq!(fs::read(existing).unwrap(), b"previous");
        assert!(!new.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
