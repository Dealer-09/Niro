// main.rs — Tauri v2 app entry point: plugins, tray, window management
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod browser;
mod commands;
mod store;
mod tools;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    Manager, WebviewUrl, WindowEvent,
};

fn main() {
    tauri::Builder::default()
        // ── Plugins ──────────────────────────────────────────────────────
        // Single-instance guard — focus existing window if already running
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("panel") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // ── Managed state ────────────────────────────────────────────────
        .manage(commands::AppState::new())
        // ── Commands ──────────────────────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            commands::run_agent,
            commands::stop_agent,
            commands::get_provider_config_cmd,
            commands::set_provider_config_cmd,
            commands::get_tasks_cmd,
            commands::save_task_cmd,
            commands::delete_task_cmd,
            commands::get_chat_history_cmd,
            commands::clear_chat_history_cmd,
            commands::append_chat_history_cmd,
            commands::transcribe_audio,
            commands::quit_app,
            commands::sensor_hover,
            commands::panel_mouse_leave,
            commands::panel_mouse_enter,
        ])
        // ── Setup ─────────────────────────────────────────────────────────
        .setup(|app| {
            // Tray menu
            let show_item = MenuItem::with_id(app, "show", "Show Niro", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Niro", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Build tray icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Niro — AI Assistant")
                .icon(app.default_window_icon().unwrap().clone())
                // Left-click → toggle panel visibility
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("panel") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                // Menu item events
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("panel") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // ── Sensor Window (invisible hover zone, matches Electron) ────────
            // 6px tall, centered at top of screen, transparent, always on top
            let panel_width = 380.0;
            let sensor_height = 6.0;
            let monitor = app.primary_monitor()?.unwrap_or_else(|| {
                app.available_monitors()
                    .unwrap()
                    .into_iter()
                    .next()
                    .unwrap()
            });
            let screen_width = monitor.size().width as f64 / monitor.scale_factor();
            let sensor_x = ((screen_width - panel_width) / 2.0).round();

            let _sensor =
                WebviewWindowBuilder::new(app, "sensor", WebviewUrl::App("sensor.html".into()))
                    .title("Niro Sensor")
                    .inner_size(panel_width, sensor_height)
                    .position(sensor_x, 0.0)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false)
                    .resizable(false)
                    .shadow(false)
                    .visible(true)
                    .build()?;

            // Reposition the panel window to top-center (matches Electron: x=panelX, y=0)
            if let Some(panel) = app.get_webview_window("panel") {
                use tauri::LogicalPosition;
                let panel_x = sensor_x; // same center as sensor
                let _ = panel.set_position(LogicalPosition::new(panel_x, 0.0));
            }

            Ok(())
        })
        // ── Window events — hide instead of close (panel only) ────────────
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "panel" {
                    window.hide().unwrap();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Niro");
}
