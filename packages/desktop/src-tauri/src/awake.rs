//! The computer kept awake while Ribbon transcribes (#158). A Mac or PC left to
//! transcribe the server's books overnight would otherwise go to sleep once
//! nobody touched it, and everything would stop until someone woke it. Only
//! the computer stays up, and only while transcribing: the display still sleeps.

/// Keep the computer from going to sleep while `on`; let it sleep again when not.
#[tauri::command]
pub fn stay_awake(on: bool) {
    platform::stay_awake(on);
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{ns_string, NSActivityOptions, NSObjectProtocol, NSProcessInfo};
    use std::cell::RefCell;

    thread_local! {
        // The activity macOS knows Ribbon is busy with. A command that isn't async runs on
        // the main thread, so the activity is begun, kept and ended there.
        static ACTIVITY: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
    }

    pub fn stay_awake(on: bool) {
        ACTIVITY.with(|activity| {
            let mut activity = activity.borrow_mut();
            let process = NSProcessInfo::processInfo();
            if on && activity.is_none() {
                // Begun by the person: no sleeping when idle, and no App Nap. The display may still sleep.
                *activity = Some(process.beginActivityWithOptions_reason(NSActivityOptions::UserInitiated, ns_string!("Transcribing a book's narration")));
            } else if !on {
                if let Some(begun) = activity.take() {
                    // SAFETY: `begun` is the object beginActivityWithOptions:reason: returned, as endActivity: expects.
                    unsafe { process.endActivity(&begun) };
                }
            }
        });
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Mutex;
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

    // Windows ties the request to the thread that makes it, so a thread of its own makes it and
    // holds it until told to stop: dropping this ends it.
    static HOLDER: Mutex<Option<Sender<()>>> = Mutex::new(None);

    pub fn stay_awake(on: bool) {
        let mut holder = HOLDER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if on && holder.is_none() {
            let (stop, stopped) = channel::<()>();
            std::thread::spawn(move || {
                // SAFETY: changes only this thread's request to keep the system up.
                unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                let _ = stopped.recv();
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            });
            *holder = Some(stop);
        } else if !on {
            holder.take();
        }
    }
}

/// Phones never transcribe, and Linux has no one way to ask yet.
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn stay_awake(_on: bool) {}
}
