use crate::{
    files::{self, Snapshot},
    plan::{HOST, Plan},
    registry::Registry,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

fn lock(plan: &Plan) -> Result<fs::File> {
    plan.validate()?;
    files::private_directory(&plan.state)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(plan.state.join("setup.lock"))?;
    fs2::FileExt::try_lock_exclusive(&file)
        .context("另一个 MonoSwitch 安装或卸载正在进行，请稍后重试")?;
    Ok(file)
}

fn snapshots(plan: &Plan) -> Result<Vec<Snapshot>> {
    let mut paths = plan.manifests.clone();
    paths.push(plan.receipt());
    if plan.isolated && !plan.registry.is_empty() {
        paths.push(plan.registry_plan());
    }
    paths.iter().map(|path| Snapshot::capture(path)).collect()
}

fn previous_binary(plan: &Plan) -> Result<Option<PathBuf>> {
    let receipt = match fs::metadata(plan.receipt()) {
        Ok(info) => {
            ensure!(info.len() <= 1024 * 1024, "现有安装记录过大，无法读取");
            fs::read(plan.receipt())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let receipt: Value = serde_json::from_slice(&receipt).context("现有安装记录损坏")?;
    ensure!(
        receipt["schema"] == 1 && receipt["host"] == HOST,
        "现有安装记录无法识别"
    );
    let binary = PathBuf::from(
        receipt["binary"]
            .as_str()
            .context("安装记录缺少本机组件路径")?,
    );
    ensure!(
        plan.owns_binary(&binary),
        "安装记录指向 MonoSwitch 目录之外，已停止操作"
    );
    Ok(Some(binary))
}

fn rollback(snapshots: &[Snapshot], registry: &Registry, error: anyhow::Error) -> anyhow::Error {
    // Attempt both restores even when one fails, so a single damaged browser
    // folder cannot prevent other browsers or registry values from recovering.
    let files = files::restore_all(snapshots);
    let keys = registry.restore();
    match (files, keys) {
        (Ok(()), Ok(())) => error.context("操作未完成，原有浏览器配置已恢复"),
        (files, keys) => error.context(format!(
            "恢复未完成。文件：{}；注册表：{}",
            files
                .err()
                .map(|error| format!("{error:#}"))
                .unwrap_or_else(|| "已恢复".into()),
            keys.err()
                .map(|error| format!("{error:#}"))
                .unwrap_or_else(|| "已恢复".into())
        )),
    }
}

pub fn install(plan: &Plan, payload: &[u8], extension: &str) -> Result<Value> {
    install_inner(plan, payload, extension, None)
}

fn install_inner(
    plan: &Plan,
    payload: &[u8],
    extension: &str,
    fail_after_manifest: Option<usize>,
) -> Result<Value> {
    ensure!(
        !payload.is_empty(),
        "此安装包缺少本机组件，请重新下载完整安装包"
    );
    ensure!(
        extension.len() == 32
            && extension
                .bytes()
                .all(|value| (b'a'..=b'p').contains(&value)),
        "此安装包的 Chrome 扩展标识无效"
    );
    let _lock = lock(plan)?;
    let saved = snapshots(plan)?;
    let previous = previous_binary(plan)?;
    let registry = Registry::capture(plan)?;
    let binary = plan.binary();
    files::private_directory(binary.parent().context("组件缺少父目录")?)?;
    let result: Result<()> = (|| {
        // Versioned binaries keep an already-running Chrome host intact. Only
        // the small manifest is atomically replaced when an upgrade commits.
        files::write(&binary, payload, true)?;
        let manifest = json!({"name": HOST, "description": "MonoSwitch display input switcher", "path": binary,
            "type": "stdio", "allowed_origins": [format!("chrome-extension://{extension}/")]});
        let bytes = serde_json::to_vec_pretty(&manifest)?;
        for (index, path) in plan.manifests.iter().enumerate() {
            files::write(path, &bytes, false)?;
            ensure!(fail_after_manifest != Some(index), "模拟配置写入失败");
        }
        registry.register(plan)?;
        let receipt = json!({"schema":1, "host":HOST, "binary":binary, "extensionId":extension,
            "version":env!("CARGO_PKG_VERSION"), "manifests":plan.manifests});
        files::write(
            &plan.receipt(),
            &serde_json::to_vec_pretty(&receipt)?,
            false,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        let error = rollback(&saved, &registry, error);
        // If restoring a manifest failed it may still refer to the new binary;
        // retaining the file is safer than breaking that surviving registration.
        let referenced = plan
            .manifests
            .iter()
            .any(|path| manifest_owns(path, &binary).unwrap_or(true));
        if !referenced {
            let _ = files::remove(&binary);
        }
        return Err(error);
    }
    let mut warnings = Vec::new();
    if let Some(previous) = previous
        && previous != binary
        && let Err(error) = files::remove(&previous)
    {
        warnings.push(format!(
            "旧组件仍在使用，已保留至退出浏览器后手动清理：{}。{error:#}",
            previous.display()
        ));
    }
    Ok(
        json!({"installed":true, "binary":binary, "extensionId":extension, "isolated":plan.isolated, "warnings":warnings}),
    )
}

fn manifest_owns(path: &std::path::Path, binary: &std::path::Path) -> Result<bool> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let manifest: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    Ok(manifest["name"] == HOST
        && manifest["path"]
            .as_str()
            .is_some_and(|path| std::path::Path::new(path) == binary))
}

pub fn uninstall(plan: &Plan) -> Result<Value> {
    let _lock = lock(plan)?;
    let saved = snapshots(plan)?;
    let Some(binary) = previous_binary(plan)? else {
        return Ok(json!({"installed":false,"isolated":plan.isolated,"warnings":[]}));
    };
    let registry = Registry::capture(plan)?;
    let owned: Vec<_> = plan
        .manifests
        .iter()
        .map(|path| Ok((path, manifest_owns(path, &binary)?)))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, owned)| *owned)
        .map(|(path, _)| path.clone())
        .collect();
    let mut warnings = Vec::new();
    for path in &plan.manifests {
        if path.exists() && !owned.contains(path) {
            warnings.push(format!("已保留其他程序修改的配置：{}", path.display()));
        }
    }
    let result: Result<()> = (|| {
        // Unregister first; the file remains available until both browser
        // registrations and the receipt have been removed successfully.
        warnings.extend(registry.unregister(plan, &owned)?);
        for path in &owned {
            files::remove(path)?;
        }
        files::remove(&plan.receipt())?;
        Ok(())
    })();
    if let Err(error) = result {
        return Err(rollback(&saved, &registry, error));
    }
    if let Err(error) = files::remove(&binary) {
        warnings.push(format!(
            "浏览器注册已移除，但组件仍在使用。关闭浏览器后可删除：{}。{error:#}",
            binary.display()
        ));
    }
    // Keep setup.lock and empty directories: unlinking a live lock would let a
    // second setup process lock a different inode during this transaction.
    Ok(json!({"installed":false,"isolated":plan.isolated,"warnings":warnings}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("monoswitch-setup-test-{}", files::nonce()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn isolated_install_upgrade_and_uninstall_preserve_other_files() {
        let sandbox = Sandbox::new();
        let plan = Plan::isolated(std::env::consts::OS, &sandbox.0);
        let first = install(&plan, b"first-host", EXTENSION).unwrap();
        let first_binary = PathBuf::from(first["binary"].as_str().unwrap());
        assert_eq!(fs::read(&first_binary).unwrap(), b"first-host");
        let manifest: Value =
            serde_json::from_slice(&fs::read(&plan.manifests[0]).unwrap()).unwrap();
        assert_eq!(
            manifest["allowed_origins"],
            json!([format!("chrome-extension://{EXTENSION}/")])
        );
        let other = plan.state.join("keep.txt");
        fs::write(&other, b"user content").unwrap();
        let next = install(&plan, b"second-host", EXTENSION).unwrap();
        assert_ne!(next["binary"], first["binary"]);
        assert!(!first_binary.exists());
        assert_eq!(
            fs::read(next["binary"].as_str().unwrap()).unwrap(),
            b"second-host"
        );
        uninstall(&plan).unwrap();
        assert!(!plan.receipt().exists());
        assert!(plan.manifests.iter().all(|path| !path.exists()));
        assert_eq!(fs::read(other).unwrap(), b"user content");
        uninstall(&plan).unwrap();
    }

    #[test]
    fn failed_upgrade_restores_exact_previous_registration_and_payload() {
        let sandbox = Sandbox::new();
        let plan = Plan::isolated(std::env::consts::OS, &sandbox.0);
        let first = install(&plan, b"first-host", EXTENSION).unwrap();
        let manifest = fs::read(&plan.manifests[0]).unwrap();
        let receipt = fs::read(plan.receipt()).unwrap();
        assert!(install_inner(&plan, b"broken-upgrade", EXTENSION, Some(0)).is_err());
        assert_eq!(fs::read(&plan.manifests[0]).unwrap(), manifest);
        assert_eq!(fs::read(plan.receipt()).unwrap(), receipt);
        assert_eq!(
            fs::read(first["binary"].as_str().unwrap()).unwrap(),
            b"first-host"
        );
        assert_eq!(fs::read_dir(plan.state.join("bin")).unwrap().count(), 1);
    }

    #[test]
    fn windows_isolation_only_writes_a_registry_plan() {
        let sandbox = Sandbox::new();
        let plan = Plan::isolated("windows", &sandbox.0);
        install(&plan, b"windows-host", EXTENSION).unwrap();
        let registry: Value =
            serde_json::from_slice(&fs::read(plan.registry_plan()).unwrap()).unwrap();
        assert_eq!(registry.as_array().unwrap().len(), 2);
        assert!(
            registry
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["root"] == "HKCU")
        );
        uninstall(&plan).unwrap();
        assert!(!plan.registry_plan().exists());
    }

    #[test]
    fn uninstall_preserves_a_replaced_foreign_manifest() {
        let sandbox = Sandbox::new();
        let plan = Plan::isolated(std::env::consts::OS, &sandbox.0);
        install(&plan, b"host", EXTENSION).unwrap();
        fs::write(
            &plan.manifests[0],
            br#"{"name":"another.host","path":"/another/program"}"#,
        )
        .unwrap();
        let result = uninstall(&plan).unwrap();
        assert!(plan.manifests[0].exists());
        assert!(!result["warnings"].as_array().unwrap().is_empty());
    }
}
