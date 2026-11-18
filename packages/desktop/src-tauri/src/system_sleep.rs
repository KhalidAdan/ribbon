//! The computer going to sleep and waking: a laptop's lid closed and opened.
//!
//! macOS pauses a playing book for the sleep by itself, and the moment the
//! lid opens it asks for the book to play again, as it would after a phone
//! call: out loud, wherever the laptop now is. Nothing in Tauri says when
//! the computer sleeps or wakes, so Ribbon listens for both here and tells
//! the page, which says no to a play the system asks for around a sleep
//! (`AppController.installLifecycle`). A book started by its listener plays
//! as ever.
//!
//! A display that sleeps or a screen that locks is not this: the computer is
//! still up, and the book plays on.

use tauri::{AppHandle, Emitter, Runtime};

/// What the page hears just before the computer sleeps.
pub const GOING_TO_SLEEP: &str = "ribbon://going-to-sleep";
/// What the page hears once the computer is awake again.
pub const WOKE: &str = "ribbon://woke";

/// Tell the page each time the computer is about to sleep and each time it has woken, for as long as Ribbon runs.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let sleeping = app.clone();
    platform::before_sleep(move || tell(&sleeping, GOING_TO_SLEEP, "the computer is going to sleep"));
    let waking = app.clone();
    platform::after_wake(move || tell(&waking, WOKE, "the computer woke"));
}

fn tell<R: Runtime>(app: &AppHandle<R>, event: &str, said: &str) {
    log::info!("{said}");
    if let Err(e) = app.emit(event, ()) {
        log::warn!("could not tell the page that {said}: {e}");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
    use objc2_foundation::{NSNotification, NSNotificationName};
    use std::ptr::NonNull;

    /// Run `heard` each time macOS says it is about to sleep. macOS waits for it to return.
    pub fn before_sleep(heard: impl Fn() + Send + Sync + 'static) {
        // SAFETY: the name is one of AppKit's own, there for as long as the app runs.
        on_workspace(unsafe { NSWorkspaceWillSleepNotification }, heard);
    }

    /// Run `heard` each time macOS says it has woken.
    pub fn after_wake(heard: impl Fn() + Send + Sync + 'static) {
        // SAFETY: as above.
        on_workspace(unsafe { NSWorkspaceDidWakeNotification }, heard);
    }

    fn on_workspace(name: &NSNotificationName, heard: impl Fn() + Send + Sync + 'static) {
        // Sleep and wake are announced on the workspace's own notification centre, not the default one.
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| heard());
        // SAFETY: the notification is watched for from any object, which needs none of a given type; with
        // no queue the block runs on the thread that posts, and `heard` may run on any thread.
        let watching = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
        // Watched for as long as Ribbon runs: never removed.
        std::mem::forget(watching);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        #[test]
        fn hears_each_sleep_and_each_wake_macos_announces() {
            let slept = Arc::new(AtomicUsize::new(0));
            let woke = Arc::new(AtomicUsize::new(0));
            let (s, w) = (slept.clone(), woke.clone());
            before_sleep(move || {
                s.fetch_add(1, Ordering::SeqCst);
            });
            after_wake(move || {
                w.fetch_add(1, Ordering::SeqCst);
            });
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            // SAFETY: posted from no object, as they are watched for.
            unsafe {
                center.postNotificationName_object(NSWorkspaceWillSleepNotification, None);
                center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
                center.postNotificationName_object(NSWorkspaceWillSleepNotification, None);
            }
            assert_eq!(slept.load(Ordering::SeqCst), 2);
            assert_eq!(woke.load(Ordering::SeqCst), 1);
        }
    }
}

/// Only a Mac is known to start a book as it wakes. Windows has its own word for sleep (a power broadcast), not listened for.
#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn before_sleep(_heard: impl Fn() + Send + Sync + 'static) {}
    pub fn after_wake(_heard: impl Fn() + Send + Sync + 'static) {}
}
