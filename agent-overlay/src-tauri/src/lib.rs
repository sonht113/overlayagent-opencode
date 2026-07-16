mod event_server;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};
use tauri_plugin_autostart::MacosLauncher;
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // Second launch → show settings instead of a second process
                let _ = app.emit("overlay://open_settings", ());
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_always_on_top(true);
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec![]),
            ));
    }

    let app = builder
        .setup(|app| {
            let port = event_server::resolve_port();
            event_server::spawn(app.handle().clone(), port);

            // Best-effort: enable login autostart (user can disable in OS settings)
            #[cfg(desktop)]
            {
                if let Ok(launcher) = app.autolaunch().is_enabled() {
                    if !launcher {
                        let _ = app.autolaunch().enable();
                        eprintln!("[autostart] enabled for Agent Overlay");
                    }
                }
            }

            let show_i =
                MenuItem::with_id(app, "show_settings", "Show settings", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide overlay", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("missing window icon"),
                )
                .menu(&menu)
                .tooltip("Agent Overlay — listening")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_settings" => {
                        let _ = app.emit("overlay://open_settings", ());
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_always_on_top(true);
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        let _ = app.emit("overlay://hide", ());
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let _ = app.emit("overlay://open_settings", ());
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_always_on_top(true);
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
