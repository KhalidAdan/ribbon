//! The folders a listener chooses on iOS. Ribbon's library is always a folder
//! you choose, never one it makes. On iOS that needs two things the dialog
//! plugin does not give: a folder picker (it has none on mobile), and access
//! that lasts, since iOS lets an app read a folder it did not make only while
//! it holds what the picker granted. The Swift side (ios/) opens the picker on
//! the folder itself, never a copy, keeps a bookmark for each folder chosen,
//! and opens them all again at launch. On other systems there is nothing to
//! do: the commands say so, and the app never calls them there.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

/// A remembered folder that is somewhere else since it was chosen (`now`), or that cannot be reached (`now` empty).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Moved {
    pub was: String,
    pub now: Option<String>,
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_folders);

#[cfg(target_os = "ios")]
mod ios {
    use super::Moved;
    use serde::{Deserialize, Serialize};

    pub struct Folders<R: tauri::Runtime>(pub tauri::plugin::PluginHandle<R>);

    #[derive(Deserialize)]
    pub struct Picked {
        pub path: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct Restored {
        pub moved: Vec<Moved>,
    }

    #[derive(Serialize)]
    pub struct Keep {
        pub paths: Vec<String>,
    }
}

/// Runs a Swift command off the main thread: the picker needs the main thread while the listener chooses.
#[cfg(target_os = "ios")]
async fn on_ios<R: Runtime, T: serde::de::DeserializeOwned + Send + 'static>(app: &AppHandle<R>, command: &'static str, payload: impl Serialize + Send + 'static) -> Result<T, String> {
    use tauri::Manager;
    let handle = app.state::<ios::Folders<R>>().0.clone();
    tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<T>(command, payload))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
const NOT_HERE: &str = "the folders plugin is for iOS; other systems use the folder dialog";

/// Choose a folder, opened in place and remembered; nothing when the picker is cancelled.
#[tauri::command]
async fn pick<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    return on_ios::<R, ios::Picked>(&app, "pick", ()).await.map(|p| p.path);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(NOT_HERE.into())
    }
}

/// Open every remembered folder again, before anything reads them: the ones that moved, or are out of reach.
#[tauri::command]
async fn restore<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Moved>, String> {
    #[cfg(target_os = "ios")]
    return on_ios::<R, ios::Restored>(&app, "restore", ()).await.map(|r| r.moved);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err(NOT_HERE.into())
    }
}

/// The folders still in the library; the others are let go.
#[tauri::command]
async fn keep<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    return on_ios::<R, serde::de::IgnoredAny>(&app, "keep", ios::Keep { paths }).await.map(|_| ());
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, paths);
        Err(NOT_HERE.into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folders")
        .invoke_handler(tauri::generate_handler![pick, restore, keep])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_folders)?;
                _app.manage(ios::Folders(handle));
            }
            Ok(())
        })
        .build()
}
