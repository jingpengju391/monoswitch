//! Explicit opt-in test: real Deskflow over TLS between two isolated Xvfb desktops.
use super::*;

struct Sandbox {
    root: PathBuf,
    children: Vec<Child>,
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        for child in self.children.iter_mut().rev() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn wait_log(path: &Path, expected: &str) {
    let start = Instant::now();
    loop {
        let text = fs::read_to_string(path).unwrap_or_default();
        if text.contains(expected) {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(12),
            "Missing {expected} in {}:\n{text}",
            path.display()
        );
        thread::sleep(Duration::from_millis(100));
    }
}
fn xvfb(tools: &Path, sandbox: &mut Sandbox) -> String {
    let mut child = Command::new(tools.join("usr/bin/Xvfb"))
        .args([
            "-displayfd",
            "1",
            "-screen",
            "0",
            "1024x768x24",
            "-nolisten",
            "tcp",
            "-noreset",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut display = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut display)
        .unwrap();
    sandbox.children.push(child);
    format!(":{}", display.trim())
}
fn core(tools: &Path, root: &Path, display: &str, role: Role, log: &Path) -> Child {
    let file = File::create(log).unwrap();
    Command::new(tools.join("usr/bin/deskflow-core"))
        .args([
            if role == Role::Server {
                "server"
            } else {
                "client"
            },
            "--new-instance",
            "--settings",
        ])
        .arg(root.join("Deskflow.conf"))
        .env("DISPLAY", display)
        .env("QT_QPA_PLATFORM", "xcb")
        .env("LD_LIBRARY_PATH", tools.join("usr/lib"))
        .env("XDG_RUNTIME_DIR", root)
        .stdin(Stdio::null())
        .stdout(file.try_clone().unwrap())
        .stderr(file)
        .spawn()
        .unwrap()
}
fn xdo(tools: &Path, display: &str, args: &[&str]) -> String {
    let output = Command::new(tools.join("usr/bin/xdotool"))
        .args(args)
        .env("DISPLAY", display)
        .env("LD_LIBRARY_PATH", tools.join("usr/lib"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "xdotool: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
#[ignore = "requires isolated Xvfb, Deskflow, xev and xdotool under MONOSWITCH_INPUT_TEST_TOOLS"]
fn real_tls_pairing_keyboard_mouse_hotkeys_and_disconnect() {
    let tools = PathBuf::from(
        std::env::var_os("MONOSWITCH_INPUT_TEST_TOOLS").expect("test tools directory"),
    );
    let mut sandbox = Sandbox {
        root: std::env::temp_dir().join(format!("monoswitch-real-sharing-{}", std::process::id())),
        children: vec![],
    };
    directory(&sandbox.root).unwrap();
    let a = sandbox.root.join("sender");
    let b = sandbox.root.join("receiver");
    let id_a = create_identity(&a).unwrap();
    let id_b = create_identity(&b).unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    // Loopback is only used in this isolated test. The public API rejects it.
    let config_a = Config {
        role: Role::Server,
        peer: id_b.clone(),
        address: String::new(),
        port,
        follow_display: false,
        display_id: String::new(),
        input: 0,
    };
    let config_b = Config {
        role: Role::Client,
        peer: id_a.clone(),
        address: "127.0.0.1".into(),
        ..config_a.clone()
    };
    prepare_files(&a, &load_secret(&a).unwrap().unwrap(), &config_a).unwrap();
    prepare_files(&b, &load_secret(&b).unwrap().unwrap(), &config_b).unwrap();
    let display_a = xvfb(&tools, &mut sandbox);
    let display_b = xvfb(&tools, &mut sandbox);
    let log_a = sandbox.root.join("sender.log");
    let log_b = sandbox.root.join("receiver.log");
    sandbox
        .children
        .push(core(&tools, &a, &display_a, Role::Server, &log_a));
    wait_log(&log_a, "waiting for clients");
    // An untrusted certificate must never produce a connected session.
    write_private(
        &b.join("tls/trusted-servers"),
        format!("v2:sha256:{}\n", "0".repeat(64)).as_bytes(),
    )
    .unwrap();
    sandbox
        .children
        .push(core(&tools, &b, &display_b, Role::Client, &log_b));
    wait_log(&log_b, "failed to verify server certificate fingerprint");
    assert!(
        !fs::read_to_string(&log_b)
            .unwrap()
            .contains("connected to server")
    );
    let mut rejected = sandbox.children.pop().unwrap();
    rejected.kill().unwrap();
    rejected.wait().unwrap();
    prepare_files(&b, &load_secret(&b).unwrap().unwrap(), &config_b).unwrap();
    sandbox
        .children
        .push(core(&tools, &b, &display_b, Role::Client, &log_b));
    wait_log(&log_b, "connected to server");
    wait_log(&log_a, &format!("client \"{}\" has connected", id_b.id));
    let log_events = sandbox.root.join("events.log");
    let events = File::create(&log_events).unwrap();
    sandbox.children.push(
        Command::new(tools.join("usr/bin/xev"))
            .args([
                "-name",
                "MonoSwitch Input Test",
                "-geometry",
                "1024x768+0+0",
            ])
            .env("DISPLAY", &display_b)
            .stdout(events)
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut window = String::new();
    for _ in 0..30 {
        let output = Command::new(tools.join("usr/bin/xdotool"))
            .args(["search", "--name", "MonoSwitch Input Test"])
            .env("DISPLAY", &display_b)
            .output()
            .unwrap();
        if output.status.success() {
            window = String::from_utf8_lossy(&output.stdout).trim().to_string();
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(!window.is_empty());
    xdo(&tools, &display_b, &["windowfocus", &window]);
    xdo(&tools, &display_a, &["key", "ctrl+shift+F9"]);
    wait_log(&log_b, "entering screen");
    xdo(&tools, &display_a, &["key", "a"]);
    wait_log(&log_events, "keysym 0x61, a");
    xdo(
        &tools,
        &display_a,
        &["mousemove_relative", "--", "20", "20"],
    );
    wait_log(&log_events, "MotionNotify");
    xdo(&tools, &display_a, &["key", "ctrl+shift+F8"]);
    wait_log(&log_b, "leaving screen");
    // Disconnect receiver and observe sender returning to a disconnected state.
    let mut events = sandbox.children.pop().unwrap();
    events.kill().unwrap();
    events.wait().unwrap();
    let mut client = sandbox.children.pop().unwrap();
    client.kill().unwrap();
    client.wait().unwrap();
    wait_log(&log_a, &format!("client \"{}\" has disconnected", id_b.id));
}
