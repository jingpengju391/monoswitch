use anyhow::{Context, Result, ensure};
use std::path::{Path, PathBuf};

pub const HOST: &str = "io.monoswitch.host";

pub struct Plan {
    pub state: PathBuf,
    pub manifests: Vec<PathBuf>,
    pub registry: Vec<String>,
    pub isolated: bool,
    pub executable_suffix: &'static str,
}

impl Plan {
    pub fn current(isolated: Option<&Path>) -> Result<Self> {
        if let Some(directory) = isolated {
            std::fs::create_dir_all(directory).context("无法创建隔离安装目录")?;
            let directory = directory.canonicalize()?;
            return Ok(Self::isolated(std::env::consts::OS, &directory));
        }
        let base = directories::BaseDirs::new().context("无法确定当前用户目录")?;
        Ok(Self::for_platform(
            std::env::consts::OS,
            base.home_dir(),
            base.data_local_dir(),
            base.config_dir(),
            false,
        ))
    }

    pub fn isolated(os: &str, home: &Path) -> Self {
        let (data, config) = match os {
            "windows" => (home.join("AppData/Local"), home.join("AppData/Local")),
            "macos" => (
                home.join("Library/Application Support"),
                home.join("Library/Application Support"),
            ),
            _ => (home.join(".local/share"), home.join(".config")),
        };
        Self::for_platform(os, home, &data, &config, true)
    }

    fn for_platform(os: &str, home: &Path, data: &Path, config: &Path, isolated: bool) -> Self {
        let state = data.join("monoswitch");
        let profiles: &[&str] = match os {
            "windows" => &["chrome", "chromium"],
            "macos" => &["Google/Chrome", "Chromium"],
            _ => &["google-chrome", "chromium"],
        };
        let manifests = profiles
            .iter()
            .map(|profile| {
                let folder = match os {
                    "windows" => state.join("native").join(profile),
                    "macos" => home
                        .join("Library/Application Support")
                        .join(profile)
                        .join("NativeMessagingHosts"),
                    _ => config.join(profile).join("NativeMessagingHosts"),
                };
                folder.join(format!("{HOST}.json"))
            })
            .collect();
        let registry = if os == "windows" {
            [r"Software\Google\Chrome", r"Software\Chromium"]
                .iter()
                .map(|root| format!(r"{root}\NativeMessagingHosts\{HOST}"))
                .collect()
        } else {
            Vec::new()
        };
        Self {
            state,
            manifests,
            registry,
            isolated,
            executable_suffix: if os == "windows" { ".exe" } else { "" },
        }
    }

    pub fn receipt(&self) -> PathBuf {
        self.state.join("setup-receipt.json")
    }
    pub fn registry_plan(&self) -> PathBuf {
        self.state.join("native/registry-plan.json")
    }
    pub fn binary(&self) -> PathBuf {
        self.state.join("bin").join(format!(
            "monoswitch-host-{}{}",
            crate::files::nonce(),
            self.executable_suffix
        ))
    }
    pub fn owns_binary(&self, binary: &Path) -> bool {
        binary.parent() == Some(self.state.join("bin").as_path())
            && binary
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("monoswitch-host-"))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.state.is_absolute() && self.manifests.iter().all(|path| path.is_absolute()),
            "安装路径必须是绝对路径"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_windows_paths_and_registry_are_contained() {
        let root = std::env::temp_dir().join("monoswitch-plan-check");
        let plan = Plan::isolated("windows", &root);
        assert!(plan.isolated);
        assert!(plan.state.starts_with(&root));
        assert!(plan.manifests.iter().all(|path| path.starts_with(&root)));
        assert_eq!(plan.registry.len(), 2);
        assert!(
            plan.binary()
                .extension()
                .is_some_and(|value| value == "exe")
        );
    }
    #[test]
    fn linux_uses_config_and_data_roots() {
        let root = std::env::temp_dir().join("monoswitch-xdg-check");
        let plan = Plan::for_platform(
            "linux",
            &root,
            &root.join("data"),
            &root.join("config"),
            false,
        );
        assert_eq!(plan.state, root.join("data/monoswitch"));
        assert!(plan.manifests[0].starts_with(root.join("config/google-chrome")));
    }
}
