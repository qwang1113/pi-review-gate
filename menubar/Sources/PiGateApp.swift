// THE MENU BAR APP — `MenuBarExtra` (macOS 13+), one small .app built by
// `swiftc` (see menubar/build.sh; no Xcode project, no Electron, no Rust).
//
// WHAT IT IS: a resident menu bar icon that shows what the daemon knows —
// online/offline, the summary line, one row per active session, the pending
// questions — opens the web panel on a session's page, raises the system
// banners (the only sender while it runs, can post, and the daemon answers —
// see Notifications.swift), and can start/stop the daemon.
//
// WHAT IT IS NOT: a second source of truth. Every row is a value out of the
// daemon's HTTP API; when the daemon cannot be reached the menu says 「未运行」
// and offers to start it — it never shows a stale list as if it were live.
//
// THE DATA LOOP IS DELIBERATELY BORING: `/api/sessions` + `/api/questions`
// every five seconds (cheap, local, and it is what keeps the menu correct
// after a missed event), plus ONE long-lived SSE subscription that exists for
// one reason — notification events. Those are events, not states: a
// `done`/`exited` transition cannot be reconstructed from a later snapshot,
// and the key the daemon computed is what makes the dedup ledger work for both
// senders. Everything else tolerates a five-second delay.

import AppKit
import SwiftUI
import UserNotifications

@main
struct PiGateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = GateModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(systemName: "shield.lefthalf.filled")
            if model.pending > 0 {
                Text("\(model.pending)")
            }
        }
        .menuBarExtraStyle(.menu)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // The notification bridge is armed once, at launch: permission is asked
        // for here and never again — a refusal degrades silently.
        UserNotifier.shared.setUp()
    }
}

// MARK: - The one piece of state

@MainActor
final class GateModel: ObservableObject {
    @Published private(set) var online = false
    @Published private(set) var port = 0
    @Published private(set) var detail = "正在探测…"
    @Published private(set) var sessions: [Session] = []
    @Published private(set) var questions: [Question] = []
    @Published private(set) var busy = false
    @Published private(set) var busyNote = ""

    private var poller: Timer?
    private var streamer: Task<Void, Never>?

    init() {
        Task { await self.refresh() }
        self.poller = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor in await self.refresh() }
        }
        self.poller?.tolerance = 1
        self.streamNotifications()
    }

    // MARK: What the menu shows

    var pending: Int { questions.count }
    var abnormal: Int { sessions.filter(\.isAbnormal).count }

    var summary: String {
        "\(sessions.count) 个会话 · \(questions.count) 个待答 · \(abnormal) 个异常"
    }

    /// The rows the menu lists: whoever is waiting on a human first, then the
    /// live ones, then the rest — capped, because a menu is not a dashboard.
    var visibleSessions: [Session] {
        let ranked = sessions.sorted { left, right in
            rank(left) == rank(right) ? left.label < right.label : rank(left) < rank(right)
        }
        return Array(ranked.prefix(12))
    }

    private func rank(_ session: Session) -> Int {
        if session.state == "waiting-input" { return 0 }
        if session.state == "working" || session.state == "waiting-judge" { return 1 }
        if session.isAbnormal { return 3 }
        return 2
    }

    // MARK: Polling

    func refresh() async {
        // THE HEARTBEAT GOES OUT FIRST, and unconditionally: it says "this app
        // is running", which is the fact the terminal's `terminal-notifier`
        // checks before suppressing itself (`lib/daemon-presence.ts`). It does
        // NOT depend on the daemon answering — an app that is up while the
        // daemon is down must still be able to claim the banners it will raise
        // once the daemon is back.
        touchPresence()
        guard let address = DaemonDiscovery.load() else {
            online = false
            detail = "找不到 \(DaemonPaths.stateFile) —— daemon 没在跑"
            sessions = []
            questions = []
            return
        }
        let client = DaemonClient(address: address)
        do {
            let health: HealthResponse = try await client.get("/api/health")
            let list: SessionList = try await client.get("/api/sessions")
            let pending: QuestionList = try await client.get("/api/questions")
            online = health.ok
            port = health.port
            detail = health.version ?? ""
            sessions = list.sessions
            questions = pending.questions
        } catch {
            // HONEST OFFLINE: a daemon that stopped answering is not "the last
            // list, still" — the menu must not show a healthy-looking summary
            // for a daemon that is gone.
            online = false
            port = address.port
            detail = error.localizedDescription
            sessions = []
            questions = []
        }
    }

    /// One small file, rewritten in place: pid + when + whether this app can
    /// actually deliver. Failures are silent on purpose — a heartbeat that
    /// cannot be written costs a duplicate banner (the terminal falls back to
    /// sending), never a lost one.
    ///
    /// `canPost` COMES FROM THE SYSTEM, ASKED EVERY TICK (reviewer Nit,
    /// 2026-10-01): `getNotificationSettings` is the authoritative answer to
    /// "may this app post", and asking it here is also what notices a
    /// permission granted or revoked in System Settings without a relaunch.
    /// Inferring it from an `add` result would rest on an unpinned assumption
    /// (that `add` reports an error while unauthorized) and could flip the
    /// claim back on for an app that delivers nothing — which is the exact
    /// silence the terminal's suppression must never cause (reviewer P1).
    private func touchPresence() {
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let payload: [String: Any] = [
                "schema": 1,
                "pid": pid,
                "at": ISO8601DateFormatter().string(from: Date()),
                // `.authorized` is the only status under which a banner reaches
                // the screen; `.provisional` never applies (it is requested
                // nowhere in this app) and everything else means "do not claim
                // it" — the terminal then sends.
                "canPost": settings.authorizationStatus == .authorized,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
            let directory = (DaemonPaths.presenceFile as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: DaemonPaths.presenceFile), options: .atomic)
        }
    }

    // MARK: Notifications (the one long-lived subscription)

    private func streamNotifications() {
        streamer = Task { [weak self] in
            var backoffSeconds: UInt64 = 3
            while !Task.isCancelled {
                guard let self else { return }
                guard let address = DaemonDiscovery.load(),
                      let url = DaemonClient(address: address).eventStreamURL() else {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    continue
                }
                do {
                    try await self.consume(url: url, address: address)
                    backoffSeconds = 3
                } catch {
                    // The daemon restarted, went away, or the socket broke: back
                    // off and resubscribe. Never crash, never stop polling.
                    try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
                    backoffSeconds = min(backoffSeconds * 2, 30)
                }
            }
        }
    }

    private func consume(url: URL, address: DaemonAddress) async throws {
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw DaemonError.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        var name = ""
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                name = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:"), name == "notification" {
                let payload = String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces)
                await self.handleNotification(payload, address: address)
            }
        }
    }

    private func handleNotification(_ payload: String, address: DaemonAddress) async {
        guard let data = payload.data(using: .utf8),
              let event = try? JSONDecoder().decode(NotificationEvent.self, from: data) else { return }
        // THE CLAIM IS THE DECISION: `duplicate` means this exact fact is
        // already on the user's screen (the terminal side, or an earlier
        // banner), `throttled` means the rate limit says not now. Only
        // `claimed` sends — and a ledger that cannot be read is fail-open, so a
        // broken store costs a duplicate banner, never silence.
        guard let claim = try? await DaemonClient(address: address).claim(event) else { return }
        guard claim.claimed else { return }
        UserNotifier.shared.post(title: event.title, body: event.body, sessionId: event.sessionId)
    }

    // MARK: Start / stop

    func startDaemon() { control("start") }
    func stopDaemon() { control("stop") }

    private func control(_ verb: String) {
        guard !busy else { return }
        busy = true
        busyNote = "正在 \(verb) daemon…"
        Task.detached { [weak self] in
            let outcome = await DaemonControl.run(verb: verb)
            let message = outcome.message.isEmpty
                ? (outcome.ok ? "\(verb) 完成" : "\(verb) 失败")
                : outcome.message
            await self?.finishControl(message)
        }
    }

    private func finishControl(_ message: String) {
        busy = false
        busyNote = message
        Task { await self.refresh() }
    }
}

// MARK: - The menu

struct MenuContent: View {
    @ObservedObject var model: GateModel

    var body: some View {
        Group {
            if model.online {
                Text("daemon：在线 · 端口 \(model.port)")
                Text(model.summary)
                Divider()
                if model.visibleSessions.isEmpty {
                    Text("没有活跃会话")
                } else {
                    ForEach(model.visibleSessions) { session in
                        Button(row(session)) { Panel.open(sessionId: session.sessionId) }
                    }
                }
                if !model.questions.isEmpty {
                    Divider()
                    ForEach(model.questions.prefix(5)) { question in
                        Button("⏳ \(question.who)：\(short(question.title))") {
                            Panel.open(sessionId: question.sessionId)
                        }
                    }
                }
                Divider()
                Button("打开面板") { Panel.open() }
                if model.busy {
                    Text(model.busyNote)
                } else {
                    Button("停止 daemon") { model.stopDaemon() }
                }
            } else {
                // NEVER PRETEND HEALTHY: offline is stated as such, with the
                // reason, and the one action that can fix it.
                Text("daemon：未运行")
                Text(short(model.detail))
                Button("启动 daemon") { model.startDaemon() }
                if model.busy { Text(model.busyNote) }
            }
        }
        Divider()
        Button("退出 pi-gate") { NSApp.terminate(nil) }
    }

    private func row(_ session: Session) -> String {
        "\(mark(session.state)) \(session.label) · \(session.repoName) · \(session.state)"
    }

    /// A leading glyph per state — the one thing a menu row can say at a glance.
    private func mark(_ state: String) -> String {
        switch state {
        case "waiting-input": return "⏳"
        case "working": return "▶"
        case "waiting-judge": return "⚖"
        case "done": return "✓"
        case "idle": return "·"
        case "stalled": return "⚠"
        case "dead": return "✗"
        default: return "·"
        }
    }

    /// Menu rows are one line: a long question title must not push the row off
    /// the screen — the panel is where the full text lives.
    private func short(_ text: String, limit: Int = 48) -> String {
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
        return oneLine.count <= limit ? oneLine : String(oneLine.prefix(limit - 1)) + "…"
    }
}
