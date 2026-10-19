use crate::plan::Plan;
use anyhow::{Result, ensure};

pub struct Registry {
    #[cfg(windows)]
    values: Vec<(String, bool, Option<winreg::RegValue>)>,
}

impl Registry {
    pub fn capture(plan: &Plan) -> Result<Self> {
        #[cfg(windows)]
        {
            use winreg::{RegKey, enums::*};
            let mut values = Vec::new();
            // Isolated mode never even reads the real registry.
            if !plan.isolated {
                for path in &plan.registry {
                    match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(path, KEY_READ) {
                        Ok(key) => {
                            let value = match key.get_raw_value("") {
                                Ok(value) => Some(value),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                                Err(error) => return Err(error.into()),
                            };
                            values.push((path.clone(), true, value));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            values.push((path.clone(), false, None))
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            Ok(Self { values })
        }
        #[cfg(not(windows))]
        {
            ensure!(
                plan.registry.is_empty() || plan.isolated,
                "无法在当前平台修改 Windows 注册表"
            );
            Ok(Self {})
        }
    }

    pub fn register(&self, plan: &Plan) -> Result<()> {
        if plan.isolated && !plan.registry.is_empty() {
            let entries: Vec<_> = plan
                .registry
                .iter()
                .zip(&plan.manifests)
                .map(|(key, path)| serde_json::json!({"root":"HKCU", "key":key, "value":path}))
                .collect();
            crate::files::write(
                &plan.registry_plan(),
                &serde_json::to_vec_pretty(&entries)?,
                false,
            )?;
        }
        #[cfg(windows)]
        if !plan.isolated {
            use winreg::{RegKey, enums::*};
            for (path, manifest) in plan.registry.iter().zip(&plan.manifests) {
                let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(path)?;
                key.set_value("", &manifest.to_string_lossy().as_ref())?;
            }
        }
        Ok(())
    }

    pub fn unregister(
        &self,
        plan: &Plan,
        owned_manifests: &[std::path::PathBuf],
    ) -> Result<Vec<String>> {
        let mut warnings: Vec<String> = Vec::new();
        if plan.isolated && !plan.registry.is_empty() {
            crate::files::remove(&plan.registry_plan())?;
        }
        #[cfg(windows)]
        if !plan.isolated {
            use winreg::{RegKey, enums::*};
            let root = RegKey::predef(HKEY_CURRENT_USER);
            for (path, manifest) in plan.registry.iter().zip(&plan.manifests) {
                if !owned_manifests.contains(manifest) {
                    continue;
                }
                let key = match root.open_subkey_with_flags(path, KEY_READ | KEY_WRITE) {
                    Ok(key) => key,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                let current: String = match key.get_value("") {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if current != manifest.to_string_lossy() {
                    warnings.push(format!("已保留其他程序修改的注册表项：{path}"));
                    continue;
                }
                key.delete_value("")?;
                let empty = key.enum_values().next().is_none() && key.enum_keys().next().is_none();
                drop(key);
                if empty {
                    root.delete_subkey(path)?;
                }
            }
        }
        #[cfg(not(windows))]
        let _ = (&mut warnings, owned_manifests);
        Ok(warnings)
    }

    pub fn restore(&self) -> Result<()> {
        #[cfg(windows)]
        {
            use winreg::{RegKey, enums::*};
            let mut errors = Vec::new();
            for (path, existed, value) in self.values.iter().rev() {
                let result: Result<()> = (|| {
                    let root = RegKey::predef(HKEY_CURRENT_USER);
                    if let Some(value) = value {
                        root.create_subkey(path)?.0.set_raw_value("", value)?;
                    } else if *existed {
                        let (key, _) = root.create_subkey(path)?;
                        if let Err(error) = key.delete_value("")
                            && error.kind() != std::io::ErrorKind::NotFound
                        {
                            return Err(error.into());
                        }
                    } else if let Err(error) = root.delete_subkey(path)
                        && error.kind() != std::io::ErrorKind::NotFound
                    {
                        return Err(error.into());
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    errors.push(format!("{path}: {error:#}"));
                }
            }
            ensure!(errors.is_empty(), "注册表恢复未完成：{}", errors.join("；"));
        }
        Ok(())
    }
}
