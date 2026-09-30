//! Native notifications via `UNUserNotificationCenter`. A click calls the handler
//! given to `init` with the `focusHostSessionId` of that notification.
//!
//! UNUserNotificationCenter only works inside an app bundle (it throws for a bare
//! binary), so outside one `show` reports `false` — the protocol's `shown:false`,
//! which prg reports as "not delivered". `scripts/bundle.sh` builds the bundle.

use crate::protocol::NotifyParams;

#[cfg(target_os = "macos")]
pub use mac::{init, show};

#[cfg(not(target_os = "macos"))]
pub fn init(_on_click: impl Fn(String) + Send + Sync + 'static) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_p: &NotifyParams) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use super::NotifyParams;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AnyThread, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock, mpsc};
    use std::time::Duration;

    type ClickHandler = Box<dyn Fn(String) + Send + Sync>;
    static CLICK: OnceLock<ClickHandler> = OnceLock::new();
    static AVAILABLE: AtomicBool = AtomicBool::new(false);
    static AUTHORIZED: AtomicBool = AtomicBool::new(false);
    static SEQ: AtomicU64 = AtomicU64::new(0);
    /// Notification identifier → session to focus on click.
    static TARGETS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; no Drop impl.
        #[unsafe(super(NSObject))]
        #[name = "PiDesktopNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Show banners even while the app is frontmost.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let ident = response.notification().request().identifier().to_string();
                let target = TARGETS.lock().unwrap().as_ref().and_then(|m| m.get(&ident).cloned());
                if let (Some(target), Some(click)) = (target, CLICK.get()) {
                    click(target);
                }
                handler.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Call once on the main thread at startup.
    pub fn init(on_click: impl Fn(String) + Send + Sync + 'static) {
        let _ = CLICK.set(Box::new(on_click));
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            eprintln!("notify: not running from an app bundle; notifications are off (see desktop/scripts/bundle.sh)");
            return;
        }
        AVAILABLE.store(true, Ordering::SeqCst);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        // The center holds its delegate weakly; this one lives as long as the app.
        let delegate: &'static Retained<Delegate> = Box::leak(Box::new(Delegate::new()));
        center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
        let done = RcBlock::new(|granted: Bool, _err: *mut NSError| AUTHORIZED.store(granted.as_bool(), Ordering::SeqCst));
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &done,
        );
    }

    /// Posts the notification and reports whether the system accepted it.
    pub fn show(p: &NotifyParams) -> bool {
        if !AVAILABLE.load(Ordering::SeqCst) || !AUTHORIZED.load(Ordering::SeqCst) {
            return false;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&p.title));
        content.setBody(&NSString::from_str(&p.body));
        // Same identifier = the newer notification replaces the older one (`-group`).
        let ident = match &p.group {
            Some(g) => {
                content.setThreadIdentifier(&NSString::from_str(g));
                format!("group-{g}")
            }
            None => format!("n-{}", SEQ.fetch_add(1, Ordering::SeqCst)),
        };
        if let Some(target) = &p.focus_host_session_id {
            TARGETS.lock().unwrap().get_or_insert_default().insert(ident.clone(), target.clone());
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&ident), &content, None);
        let (tx, rx) = mpsc::channel();
        let done = RcBlock::new(move |err: *mut NSError| {
            let _ = tx.send(err.is_null());
        });
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
        // Inside prg's 5 s request timeout.
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
    }
}
