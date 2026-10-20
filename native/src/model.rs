use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Status {},
    SharingStatus {},
    SharingSetName {
        name: String,
    },
    SharingInstall {},
    SharingIdentity {},
    SharingStart {
        config: crate::sharing::Config,
    },
    SharingStop {},
    SharingSwitch {},
    SharingPairHost {
        profile: serde_json::Value,
    },
    SharingPairJoin {
        code: String,
        profile: serde_json::Value,
    },
    Repair {},
    Switch {
        #[serde(rename = "displayId")]
        display_id: String,
        input: u8,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    pub arch: String,
    pub hostname: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSource {
    pub value: u8,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    pub current_input: Option<u8>,
    pub inputs: Vec<InputSource>,
    pub input_detection: String,
    pub can_switch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Backend {
    pub name: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HostStatus {
    pub version: String,
    pub platform: PlatformInfo,
    pub backend: Backend,
    pub displays: Vec<Display>,
    pub warnings: Vec<String>,
    #[serde(rename = "systemSetup", skip_serializing_if = "Option::is_none")]
    pub system_setup: Option<SystemSetup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSetup {
    pub needs_repair: bool,
    pub can_repair: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SwitchResult {
    pub accepted: bool,
    pub message: String,
}

impl SwitchResult {
    pub fn accepted() -> Self {
        Self {
            accepted: true,
            message: "切换命令已接受。输入源切换可能断开当前连接，请在显示器上确认结果。".into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
    pub fn details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AppError {}
