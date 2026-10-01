// THE BANNER, AND THE CLICK THAT COMES BACK TO THE PANEL.
//
// The app is the ONLY sender while the daemon is online (user decision,
// `docs/daemon/api.md` §8.1): the terminal's `terminal-notifier` suppresses
// itself in exactly that window (`lib/daemon-presence.ts`). Two consequences
// follow from that, and both are this file's job:
//
//   1. WHETHER TO SEND IS NOT DECIDED HERE. The daemon watches the sessions and
//      emits a `notification` SSE event carrying the key, the title and the body
//      it computed with the gate's own helpers; the app asks
//      `POST /api/notifications/claim` about that key and sends ONLY when the
//      answer is `claimed: true` (duplicate / throttled ⇒ somebody already told
//      the user, or the rate limit says not now). The throttle therefore lives
//      in one place for both senders and cannot drift.
//   2. A CLICK LANDS ON THE SESSION'S PAGE. The notification carries the
//      sessionId, and clicking opens `http://127.0.0.1:<port>/sessions/<id>` —
//      the same deep link the menu's session rows use.
//
// NOTHING HERE MAY BREAK THE MENU: when the user has denied notification
// permission, `add` fails, this file ignores the failure, and every other
// feature keeps working — "权限被关掉时静默降级，不影响菜单栏其他功能".

import AppKit
import Foundation
import UserNotifications

final class UserNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = UserNotifier()

    /// Ask once, at launch. A refused permission is a `false` here and nothing
    /// else in the app ever mentions it again.
    private(set) var authorized = false

    func setUp() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            self.authorized = granted
        }
    }

    /// Post one banner. Called only after the daemon CLAIMED the key.
    func post(title: String, body: String, sessionId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["sessionId": sessionId]
        content.sound = nil
        let request = UNNotificationRequest(
            identifier: "pi-gate-\(sessionId)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { _ in
            // Silent by design: a denied permission, a full Notification Center
            // or a missing bundle id are all "no banner", never "no app".
        }
    }

    /// The banner must also appear while the menu is open — otherwise the app
    /// being frontmost would swallow the notification it just decided to send.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// The click: open the panel on the session the banner was about.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        DispatchQueue.main.async {
            Panel.open(sessionId: sessionId)
            completionHandler()
        }
    }
}
