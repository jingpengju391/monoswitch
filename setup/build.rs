use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=MONOSWITCH_SETUP_BINARY");
    println!("cargo:rerun-if-env-changed=MONOSWITCH_EXTENSION_ID");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let source = match env::var_os("MONOSWITCH_SETUP_BINARY") {
        Some(path) => {
            let path = PathBuf::from(path)
                .canonicalize()
                .expect("Host payload must exist");
            assert!(path.is_file(), "Host payload must be a regular file");
            println!("cargo:rerun-if-changed={}", path.display());
            format!("include_bytes!({path:?})")
        }
        // Allows development checks/tests; installing without a payload fails.
        None => "&[]".into(),
    };
    fs::write(
        output.join("payload.rs"),
        format!("pub const PAYLOAD: &[u8] = {source};\n"),
    )
    .expect("Write payload source");
    let extension = env::var("MONOSWITCH_EXTENSION_ID").unwrap_or_default();
    assert!(
        extension.is_empty()
            || (extension.len() == 32
                && extension
                    .bytes()
                    .all(|value| (b'a'..=b'p').contains(&value))),
        "MONOSWITCH_EXTENSION_ID must be 32 letters a–p"
    );
    println!("cargo:rustc-env=MONOSWITCH_EXTENSION_ID={extension}");
}
