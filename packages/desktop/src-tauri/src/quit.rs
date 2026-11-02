//! Quitting asks first while Ribbon transcribes (#158). Closing the window
//! already asks the page, which can keep it open; quitting a Mac app goes
//! straight to `terminate:`, which can't be refused. So on a Mac, Ribbon's
//! menu has its own Quit (Cmd-Q) that asks the page, and the page quits
//! (`quit`) once it has asked, or at once when there's nothing to ask. A page
//! that doesn't say it heard (`quit_heard`) within a few seconds is quit
//! regardless: Cmd-Q always quits. Elsewhere only the window closes, and
//! these go unused.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// Whether the page has heard the last Quit.
static HEARD: AtomicBool = AtomicBool::new(false);

/// How long the page has to say it heard a Quit before Ribbon quits anyway.
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

/// The menu id of Ribbon's own Quit.
pub const QUIT: &str = "quit";

/// The default menu with its Quit replaced by Ribbon's own, which asks first.
#[cfg(target_os = "macos")]
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    // The app's own submenu comes first, and Quit is in it.
    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
        for (at, item) in first.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(predefined) = &item {
                if predefined.text()?.starts_with("Quit") {
                    first.remove(predefined)?;
                    first.insert(&MenuItem::with_id(app, QUIT, predefined.text()?, true, Some("CmdOrCtrl+Q"))?, at)?;
                    break;
                }
            }
        }
    }
    Ok(menu)
}

/// Ribbon's Quit was chosen: ask the page, and quit anyway if it doesn't answer.
pub fn asked<R: Runtime>(app: &AppHandle<R>) {
    HEARD.store(false, Ordering::SeqCst);
    if app.emit("ribbon://quit", ()).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ANSWER_WITHIN);
        if !HEARD.load(Ordering::SeqCst) {
            log::warn!("the page didn't answer Quit; quitting");
            app.exit(0);
        }
    });
}

/// The page heard Quit, and is asking.
#[tauri::command]
pub fn quit_heard() {
    HEARD.store(true, Ordering::SeqCst);
}

/// The page has asked, and Ribbon quits.
#[tauri::command]
pub fn quit<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
