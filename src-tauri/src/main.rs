//! drama-creator 桌面壳：Tauri webview + 本机 HTTP server。
//! 发布包优先启动内置 Node sidecar，开发模式才回退 `node server.mjs`。
//! 严格遵循 P3Q1=A：业务逻辑不迁移到 Rust，只做进程编排 + webview 容器。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env::current_exe;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::{ActivationPolicy, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// WebView 启动阶段对 localhost 的 IPv6/IPv4 回退不如 curl 稳定；
// 服务端固定监听 IPv4 loopback，因此桌面壳也显式加载 127.0.0.1，避免安装版白屏。
const APP_URL: &str = "http://127.0.0.1:5173/";

/// 包装 server 子进程句柄，借由 Tauri 的 state 体系跨闭包共享。
struct NodeServerHandle(Mutex<Option<ServerProcess>>);

/// sidecar 与开发态 Node 的进程句柄类型不同，用 enum 统一退出清理。
enum ServerProcess {
    Sidecar(CommandChild),
    DevNode(Child),
}

impl ServerProcess {
    fn stop(self) {
        match self {
            ServerProcess::Sidecar(child) => {
                let _ = child.kill();
            }
            ServerProcess::DevNode(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// 启动后台 HTTP server。发布包走内置 sidecar；开发态回退系统 Node。
fn spawn_backend_server(app: &tauri::AppHandle) -> Option<ServerProcess> {
    let bundled_static_root = bundled_static_root();
    if let Some(sidecar) = spawn_sidecar_server(app, bundled_static_root.as_deref()) {
        return Some(sidecar);
    }
    spawn_dev_node_server()
}

fn spawn_sidecar_server(
    app: &tauri::AppHandle,
    bundled_static_root: Option<&Path>,
) -> Option<ServerProcess> {
    let mut command = app
        .shell()
        .sidecar("drama-creator-server")
        .ok()?
        .env("PORT", "5173")
        .env("DRAMA_CREATOR_SERVER_MODE", "sidecar");
    if let Some(static_root) = bundled_static_root {
        command = command
            .env("DRAMA_CREATOR_STATIC_ROOT", static_root.as_os_str())
            .current_dir(runtime_working_dir(static_root));
    }

    let (mut rx, child) = command.spawn().ok()?;
    // 持续消费 sidecar 事件，避免 stdout/stderr 管道无人读取；stderr 进入系统日志方便调试。
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stderr(line) = event {
                eprintln!("drama-creator sidecar: {}", String::from_utf8_lossy(&line));
            }
        }
    });
    Some(ServerProcess::Sidecar(child))
}

/// 开发兜底：本地 `tauri dev` 不强制先生成 sidecar，仍能直接跑 repo 内 server。
fn spawn_dev_node_server() -> Option<ServerProcess> {
    let bundled_resources = bundled_legacy_resource_dir();
    let mut command = Command::new("node");
    if let Some(resource_dir) = bundled_resources {
        command.current_dir(&resource_dir);
        command.env("DRAMA_CREATOR_STATIC_ROOT", resource_dir.join("dist"));
    } else {
        command.current_dir("..");
    }

    command
        .arg("server.mjs")
        .env("PORT", "5173")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .map(ServerProcess::DevNode)
}

fn bundled_static_root() -> Option<PathBuf> {
    let resources = app_resources_dir()?;
    for candidate in [resources.join("dist"), resources.join("_up_").join("dist")] {
        if candidate.join("index.html").is_file() {
            return Some(candidate);
        }
    }
    None
}

fn bundled_legacy_resource_dir() -> Option<PathBuf> {
    let resources = app_resources_dir()?;
    for candidate in [resources.clone(), resources.join("_up_")] {
        if candidate.join("server.mjs").is_file() {
            return Some(candidate);
        }
    }
    None
}

fn app_resources_dir() -> Option<PathBuf> {
    let exe = current_exe().ok()?;
    let contents_dir = exe.parent()?.parent()?;
    Some(contents_dir.join("Resources"))
}

fn runtime_working_dir(static_root: &Path) -> &Path {
    static_root.parent().unwrap_or(static_root)
}

fn wait_for_node_server() {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", 5173)).is_ok() {
            return;
        }
        sleep(Duration::from_millis(100));
    }
}

/// macOS 上用户关闭最后一个窗口后，应用进程可能仍保留在 Dock；
/// 重新打开时必须恢复主窗口，否则会出现 sidecar 正常但桌面端不可目检。
fn ensure_main_window(app: &tauri::AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let _ = app.show();

    let url = match APP_URL.parse() {
        Ok(url) => url,
        Err(error) => {
            eprintln!("drama-creator window url parse failed: {error}");
            return;
        }
    };

    if let Some(window) = app.get_webview_window("main") {
        // Config-defined windows are created before the sidecar is ready. Navigate after
        // 5173 responds so a hidden startup window cannot stay on a failed provisional load.
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // 这里直接使用本地 HTTP 入口，避免发布包里 remote window config 解析失败时静默无窗口。
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Drama Creator")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .visible(true)
        .build()
    {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("drama-creator main window restore failed: {error}");
        }
    }
}

/// 只负责弹出系统目录选择器；目录是否可作为项目 workspace 仍交给 Node API 校验。
#[tauri::command]
fn pick_project_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择短剧项目工作空间")
        .pick_folder()
        .map(|path| path.display().to_string())
}

/// 只负责让用户选择一个外部生成的图片/视频文件；复制、类型校验和图谱写入仍由 Node API 完成。
#[tauri::command]
fn pick_asset_file(kind: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("选择外部生成资源");
    match kind.as_deref() {
        Some("video") => {
            dialog = dialog.add_filter("视频文件", &["mp4", "mov"]);
        }
        _ => {
            dialog = dialog.add_filter("图片文件", &["png", "jpg", "jpeg", "webp", "gif"]);
        }
    }
    dialog.pick_file().map(|path| path.display().to_string())
}

/// OAuth 登录页必须从桌面壳交给系统浏览器打开；只放行服务端签发的 OpenAI 授权入口。
fn is_allowed_oauth_authorize_url(url: &str) -> bool {
    url.starts_with("https://auth.openai.com/oauth/authorize?")
}

#[tauri::command]
#[allow(deprecated)]
fn open_oauth_authorize_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_oauth_authorize_url(&url) {
        return Err("只允许打开订阅登录页面".to_string());
    }

    app.shell()
        .open(url, None)
        .map_err(|error| format!("打开订阅登录页面失败：{error}"))
}

fn main() {
    let handle = NodeServerHandle(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(handle)
        .invoke_handler(tauri::generate_handler![
            pick_project_directory,
            pick_asset_file,
            open_oauth_authorize_url
        ])
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Regular);
            // Tauri context 可用后才能解析 sidecar；启动成功再等待 5173 就绪。
            let server = spawn_backend_server(app.handle());
            if server.is_some() {
                wait_for_node_server();
            }
            // server 就绪后立即确保主窗口存在；发布包下事件循环 Ready 不一定能补救无窗口状态。
            ensure_main_window(app.handle());
            let state: tauri::State<NodeServerHandle> = app.state();
            if let Ok(mut guard) = state.0.lock() {
                *guard = server;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 关闭最后一个窗口时也要带走 server 子进程，避免 5173 端口悬挂。
            match event {
                RunEvent::Ready => ensure_main_window(app),
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        ensure_main_window(app);
                    }
                }
                RunEvent::ExitRequested { .. } => {
                    // 先从 state 里取出 Child，再在锁外 kill/wait，避免退出回调持锁等待子进程。
                    let mut child_to_stop = None;
                    let state: tauri::State<NodeServerHandle> = app.state();
                    if let Ok(mut guard) = state.0.lock() {
                        child_to_stop = guard.take();
                    };
                    if let Some(child) = child_to_stop {
                        child.stop();
                    }
                }
                _ => {}
            }
        });
}
