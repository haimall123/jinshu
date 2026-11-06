#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, WindowEvent};

unsafe extern "C" {
    fn bridge_init(root: *const i8, user: *const i8, test: *const i8, window: usize, testing: i32) -> i32;
    fn bridge_create_cancellation() -> usize;
    fn bridge_cancel(handle: usize);
    fn bridge_close_cancellation(handle: usize);
    fn bridge_dispatch(request: *const i8, cancellation: usize) -> *mut i8;
    fn bridge_free(value: *mut i8);
}

#[derive(Default)]
struct Jobs {
    active: Option<(u64, usize)>,
    pending_cancellations: BTreeSet<u64>,
    finished: u64,
}

struct Shared {
    jobs: Mutex<Jobs>,
    closing: AtomicBool,
    testing: bool,
    test_dir: PathBuf,
}

struct AppState(Arc<Shared>);

fn c_string(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "请求包含无效字符".to_string())
}

fn invoke_native(message: Value, cancellation: usize) -> Result<Vec<Value>, String> {
    let request = c_string(&message.to_string())?;
    let pointer = unsafe { bridge_dispatch(request.as_ptr(), cancellation) };
    if pointer.is_null() {
        return Err("无法分配计算结果".into());
    }
    let result = unsafe { CStr::from_ptr(pointer) }.to_bytes().to_vec();
    unsafe { bridge_free(pointer) };
    serde_json::from_slice(&result).map_err(|error| format!("无法读取计算结果：{error}"))
}

#[tauri::command]
async fn dispatch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    message: Value,
    job_id: u64,
) -> Result<Vec<Value>, String> {
    let is_calculation = message.get("action").and_then(Value::as_str) == Some("calculate");
    let shared = state.0.clone();
    let cancellation = if is_calculation {
        let handle = unsafe { bridge_create_cancellation() };
        if handle == 0 {
            return Err("无法创建计算任务".into());
        }
        let mut jobs = match shared.jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => {
                unsafe { bridge_close_cancellation(handle) };
                return Err("计算状态不可用".into());
            }
        };
        if jobs.active.is_some() || job_id == 0 || job_id <= jobs.finished {
            unsafe { bridge_close_cancellation(handle) };
            return Err("计算任务状态无效".into());
        }
        if jobs.pending_cancellations.remove(&job_id) {
            unsafe { bridge_cancel(handle) };
        }
        jobs.active = Some((job_id, handle));
        handle
    } else {
        0
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || invoke_native(message, cancellation))
        .await
        .map_err(|error| format!("本地任务失败：{error}"))
        .and_then(|result| result);
    if is_calculation {
        let mut jobs = shared.jobs.lock().map_err(|_| "计算状态不可用")?;
        if jobs.active == Some((job_id, cancellation)) {
            jobs.active = None;
        }
        jobs.finished = jobs.finished.max(job_id);
        jobs.pending_cancellations.retain(|id| *id > job_id);
        unsafe { bridge_close_cancellation(cancellation) };
        drop(jobs);
        if shared.closing.swap(false, Ordering::SeqCst) {
            let _ = window.close();
        }
    }
    outcome
}

#[tauri::command]
fn cancel_job(state: tauri::State<'_, AppState>, job_id: u64) -> Result<(), String> {
    let mut jobs = state.0.jobs.lock().map_err(|_| "计算状态不可用")?;
    if job_id <= jobs.finished || job_id == 0 {
        return Ok(());
    }
    if let Some((active_id, handle)) = jobs.active {
        if active_id == job_id {
            unsafe { bridge_cancel(handle) };
            return Ok(());
        }
    }
    jobs.pending_cancellations.insert(job_id);
    Ok(())
}

#[tauri::command]
fn finish_test(app: tauri::AppHandle, state: tauri::State<'_, AppState>, report: Value) -> Result<(), String> {
    if !state.0.testing {
        return Err("该接口仅用于本地测试".into());
    }
    let output = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(state.0.test_dir.join("test-report.json"), output).map_err(|error| error.to_string())?;
    app.exit(if report.get("ok").and_then(Value::as_bool) == Some(true) { 0 } else { 90 });
    Ok(())
}

fn path_string(path: &Path) -> Result<CString, String> {
    c_string(&path.to_string_lossy())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let testing = args.iter().any(|arg| arg == "--ui-test" || arg == "--small-test" || arg == "--minimum-test");
    let test_root = std::env::var_os("MOIRA_TEST_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let test_dir = test_root.join(format!("tauri-test-{}", std::process::id()));
    let shared = Arc::new(Shared {
        jobs: Mutex::new(Jobs::default()),
        closing: AtomicBool::new(false),
        testing,
        test_dir,
    });
    let close_state = shared.clone();
    tauri::Builder::default()
        .manage(AppState(shared.clone()))
        .setup(move |app| {
            let window = app.get_webview_window("main").ok_or("缺少主窗口")?;
            let resource_raw = app.path().resource_dir()?.join("runtime");
            let resource = dunce::simplified(&resource_raw).to_path_buf();
            let resource_text = resource.to_str().ok_or("计算组件路径包含无效字符")?;
            if resource_text.starts_with(r"\\?\") || resource_text.encode_utf16().count() > 220 {
                return Err("计算组件路径过长或不受支持，请安装到较短的本地路径".into());
            }
            let user_dir = if testing { shared.test_dir.clone() } else { app.path().app_local_data_dir()? };
            std::fs::create_dir_all(&user_dir)?;
            if testing {
                let size = if args.iter().any(|arg| arg == "--minimum-test") {
                    Some((1000, 640))
                } else if args.iter().any(|arg| arg == "--small-test") {
                    Some((1060, 720))
                } else { None };
                if let Some((width, height)) = size {
                    window.set_size(tauri::PhysicalSize::new(width, height))?;
                }
            }
            let root = path_string(&resource)?;
            let user = path_string(&user_dir)?;
            let test = path_string(&shared.test_dir)?;
            let handle = window.hwnd()?.0 as usize;
            if unsafe { bridge_init(root.as_ptr(), user.as_ptr(), test.as_ptr(), handle, i32::from(testing)) } == 0 {
                return Err("无法初始化本地资料".into());
            }
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Ok(jobs) = close_state.jobs.lock() {
                    if let Some((_, handle)) = jobs.active {
                        close_state.closing.store(true, Ordering::SeqCst);
                        unsafe { bridge_cancel(handle) };
                        api.prevent_close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![dispatch, cancel_job, finish_test])
        .run(tauri::generate_context!())
        .expect("无法启动人生规划");
}
