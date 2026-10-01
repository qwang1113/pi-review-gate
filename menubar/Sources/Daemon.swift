// THE DAEMON'S HTTP SURFACE, FROM THE MENU BAR APP'S SIDE.
//
// Everything the app DISPLAYS comes from the daemon's HTTP API
// (`docs/daemon/api.md` is the contract): sessions, questions, health,
// notifications. The app never reads a session transcript, never parses tmux,
// and never touches the gate's sidecars — the one file it does read is the
// daemon's own DISCOVERY record, for the two things no HTTP call can supply
// before you know where to call: the port and the token. Those are read the
// same way `docs/daemon/api.md` §3 says everybody reads them (`schema == 1`,
// `pid` alive, port + `127.0.0.1` — never the file's `baseUrl`, because that
// request carries the token).
//
// NO CRASH ON A BAD DAEMON: every call either returns a value or throws a
// `DaemonError`; the model above turns that into the "未运行" state.

import AppKit
import Foundation

struct DaemonAddress {
    let port: Int
    let token: String
}

enum DaemonPaths {
    /// `RG_DAEMON_HOME` beats `$HOME` — the same override the CLI honours.
    static var home: String {
        if let override = ProcessInfo.processInfo.environment["RG_DAEMON_HOME"], !override.isEmpty {
            return override
        }
        return FileManager.default.homeDirectoryForCurrentUser.path
    }
    static var stateFile: String { home + "/.pi/agent/rg-daemon.json" }
    static var tokenFile: String { home + "/.pi/agent/rg-daemon.token" }
}

enum DaemonDiscovery {
    /// The port and the token, or nil when there is nothing to talk to.
    static func load() -> DaemonAddress? {
        guard let data = FileManager.default.contents(atPath: DaemonPaths.stateFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let schema = object["schema"] as? Int, schema == 1,
              let port = object["port"] as? Int, port > 0, port < 65536
        else { return nil }
        guard let tokenData = FileManager.default.contents(atPath: DaemonPaths.tokenFile),
              let token = String(data: tokenData, encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else { return nil }
        return DaemonAddress(port: port, token: token)
    }
}

enum DaemonError: LocalizedError {
    case noAddress
    case http(Int)
    case transport(String)
    case decode(String)

    var errorDescription: String? {
        switch self {
        case .noAddress: return "找不到 daemon 的 state 文件或 token"
        case .http(let code): return "daemon 返回 HTTP \(code)"
        case .transport(let message): return message
        case .decode(let message): return "应答解析失败：\(message)"
        }
    }
}

// MARK: - The payloads (field names are the contract's)

struct HealthResponse: Decodable {
    let ok: Bool
    let port: Int
    let version: String?
    let pid: Int?
}

struct SessionList: Decodable {
    let sessions: [Session]
    let tmuxReadable: Bool?
    let problems: [String]?
}

struct Session: Decodable, Identifiable {
    let sessionId: String
    let name: String?
    let kind: String?
    let repo: String
    let cwd: String?
    let branch: String?
    let mode: String?
    let state: String
    let alive: Bool?
    let lastActivityAt: String?
    /// True when the daemon actually found the gate state in the transcript.
    /// False means the rounds/unmet fields are placeholders, not conclusions.
    let gateStateFound: Bool?
    let unmet: [String]?
    let rounds: Rounds?

    struct Rounds: Decodable {
        let sent: Int?
        let recorded: Int?
        let lastVerdict: String?
    }

    var id: String { sessionId }
    var label: String { name ?? String(sessionId.prefix(8)) }
    var repoName: String { (repo as NSString).lastPathComponent }
    var isAlive: Bool { alive ?? false }

    /// The two words from `CHILD_STATES` that mean something is wrong.
    var isAbnormal: Bool { state == "stalled" || state == "dead" }
}

struct QuestionList: Decodable {
    let questions: [Question]
}

struct Question: Decodable, Identifiable {
    let requestId: String
    let sessionId: String
    let sessionName: String?
    let title: String
    let options: [String]?
    let multiple: Bool?
    let createdAt: String?

    var id: String { requestId }
    var who: String { sessionName.map { "@\($0)" } ?? String(sessionId.prefix(8)) }
}

struct NotificationEvent: Decodable {
    let key: String
    let kind: String
    let sessionId: String
    let name: String?
    let repo: String?
    let title: String
    let body: String
}

struct ClaimResponse: Decodable {
    let claimed: Bool
    let status: String
    let reason: String?
}

// MARK: - The client

struct DaemonClient {
    let address: DaemonAddress

    private func url(_ path: String) -> URL? {
        URL(string: "http://127.0.0.1:\(address.port)\(path)")
    }

    private func request(_ path: String, method: String) -> URLRequest? {
        guard let url = url(path) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(address.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        return request
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        guard let request = request(path, method: "GET") else { throw DaemonError.noAddress }
        let data = try await send(request)
        return try decode(data)
    }

    func post<T: Decodable>(_ path: String, json: [String: Any]) async throws -> T {
        guard var request = request(path, method: "POST") else { throw DaemonError.noAddress }
        request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        let data = try await send(request)
        return try decode(data)
    }

    private func send(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw DaemonError.transport("应答不是 HTTP") }
            guard (200..<300).contains(http.statusCode) else { throw DaemonError.http(http.statusCode) }
            return data
        } catch let error as DaemonError {
            throw error
        } catch {
            throw DaemonError.transport(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DaemonError.decode(error.localizedDescription)
        }
    }

    /// The SSE stream (`?token=` is the ONE endpoint where the token may ride
    /// the URL — `EventSource` cannot set a header, and this client is the same
    /// kind of caller).
    func eventStreamURL(replay: Int = 0) -> URL? {
        guard var components = URLComponents(string: "http://127.0.0.1:\(address.port)/api/events") else { return nil }
        components.queryItems = [
            URLQueryItem(name: "token", value: address.token),
            URLQueryItem(name: "replay", value: String(replay)),
        ]
        return components.url
    }

    func claim(_ event: NotificationEvent) async throws -> ClaimResponse {
        var json: [String: Any] = [
            "key": event.key,
            "kind": event.kind,
            "sessionId": event.sessionId,
            "title": event.title,
            "body": event.body,
        ]
        if let name = event.name { json["name"] = name }
        return try await post("/api/notifications/claim", json: json)
    }
}

// MARK: - Opening the panel

enum Panel {
    /// `/sessions/<id>` is the panel's own route (the SPA fallback serves it).
    static func open(sessionId: String? = nil) {
        guard let address = DaemonDiscovery.load() else { return }
        var text = "http://127.0.0.1:\(address.port)/"
        if let id = sessionId, !id.isEmpty,
           let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) {
            text = "http://127.0.0.1:\(address.port)/sessions/\(encoded)"
        }
        if let url = URL(string: text) { NSWorkspace.shared.open(url) }
    }
}

// MARK: - Start / stop, from the menu

/// The daemon has no "start yourself" endpoint (it cannot be its own launcher),
/// so the app drives the same CLI a human would — `pi-gate daemon start|stop` —
/// and reports what it printed. The checkout is found from the app's OWN
/// location (`<repo>/menubar/build/PiGate.app`), which is why the app has to
/// live inside the repository it drives.
enum DaemonControl {
    struct Outcome {
        let ok: Bool
        let message: String
    }

    static var repoRoot: String? {
        // …/menubar/build/PiGate.app → …/menubar/build → …/menubar → repo
        let bundle = Bundle.main.bundleURL
        let root = bundle.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let entry = root.appendingPathComponent("scripts/pi-gate.mjs")
        return FileManager.default.fileExists(atPath: entry.path) ? root.path : nil
    }

    /// The node the app was BUILT against, then the usual install locations.
    static var nodePath: String? {
        var candidates: [String] = []
        if let baked = Bundle.main.object(forInfoDictionaryKey: "PiGateNodePath") as? String, !baked.isEmpty {
            candidates.append(baked)
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                candidates.append("\(dir)/node")
            }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func run(verb: String) async -> Outcome {
        guard let root = repoRoot else {
            return Outcome(ok: false, message: "找不到本仓库的 scripts/pi-gate.mjs —— 菜单栏 app 必须放在仓库的 menubar/build/ 下")
        }
        guard let node = nodePath else {
            return Outcome(ok: false, message: "找不到 node —— 重新构建 app（build.sh 会把 node 的绝对路径写进 Info.plist），或把 node 装到 Homebrew 默认位置")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [root + "/scripts/pi-gate.mjs", "daemon", verb]
        var environment = ProcessInfo.processInfo.environment
        environment["RG_DAEMON_HOME"] = DaemonPaths.home
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return Outcome(ok: false, message: "跑不起来 \(node)：\(error.localizedDescription)")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Outcome(ok: process.terminationStatus == 0, message: output)
    }
}
