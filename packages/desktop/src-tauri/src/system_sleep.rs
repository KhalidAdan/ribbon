//! The computer going to sleep: a laptop's lid closed, or Sleep chosen. Nothing
//! pauses a book for that. The webview is frozen mid-sentence with everything
//! else, and goes on from the same word the moment the lid opens, out loud,
//! wherever the laptop now is. So Ribbon says when sleep is coming, and the
//! page pauses the book (`AppController.installLifecycle`), as someone
//! closing a book would.
//!
//! A display that sleeps or a screen that locks is not this: the computer is
//! still up, and the book plays on.

use tauri::{AppHandle, Emitter, Runtime};

/// What the page hears just before the computer sleeps.
pub const GOING_TO_SLEEP: &str = "ribbon://going-to-sleep";

/// Tell the page each time the computer is about to sleep, for as long as Ribbon runs.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    platform::before_sleep(move || {
        log::info!("the computer is going to sleep");
        if let Err(e) = app.emit(GOING_TO_SLEEP, ()) {
            log::warn!("could not tell the page the computer is going to sleep: {e}");
        }
    });
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillSleepNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    /// Run `heard` each time macOS says it is about to sleep. macOS waits for it to return.
    pub fn before_sleep(heard: impl Fn() + Send + Sync + 'static) {
        // Sleep and wake are announced on the workspace's own notification centre, not the default one.
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| heard());
        // SAFETY: the notification is watched for from any object, which needs none of a given type; with
        // no queue the block runs on the thread that posts, and `heard` may run on any thread.
        let watching = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillSleepNotification), None, None, &block) };
        // Watched for as long as Ribbon runs: never removed.
        std::mem::forget(watching);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        #[test]
        fn hears_each_time_macos_says_it_is_going_to_sleep() {
            let heard = Arc::new(AtomicUsize::new(0));
            let count = heard.clone();
            before_sleep(move || {
                count.fetch_add(1, Ordering::SeqCst);
            });
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            // SAFETY: posted from no object, as it is watched for.
            unsafe { center.postNotificationName_object(NSWorkspaceWillSleepNotification, None) };
            unsafe { center.postNotificationName_object(NSWorkspaceWillSleepNotification, None) };
            assert_eq!(heard.load(Ordering::SeqCst), 2);
        }
    }
}

/// Only measured on a Mac so far. Windows has its own word for it (a power broadcast), not yet listened for.
#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn before_sleep(_heard: impl Fn() + Send + Sync + 'static) {}
}
