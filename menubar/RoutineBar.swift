import AppKit

struct Inbox: Decodable {
    let count: Int
    let entries: [Entry]
}

struct Entry: Decodable {
    enum State: String, Decodable {
        case needs_input, failed, done

        var glyph: String {
            switch self {
            case .needs_input: return "?"
            case .failed: return "✕"
            case .done: return "✓"
            }
        }
    }

    let routineName: String
    let state: State
    let summary: String
}

enum Status {
    case unreachable
    case loaded(Inbox)
}

func truncate(_ s: String, _ max: Int = 60) -> String {
    s.count <= max ? s : String(s.prefix(max - 1)) + "…"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let base = "http://127.0.0.1:\(ProcessInfo.processInfo.environment["ROUTINEBAR_PORT"] ?? "4141")"
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.delegate = self
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(showMenu)
        render(.loaded(Inbox(count: 0, entries: [])))
        refresh()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { @MainActor in self.refresh() }
        }
    }

    // Menu bar managers like Thaw park hidden items off screen and forward clicks to them,
    // so anchoring to the button would pin the menu to a screen corner.
    @objc func showMenu() {
        let frame = item.button?.window?.frame ?? .zero
        FileHandle.standardError.write("showMenu frame=\(frame) screens=\(NSScreen.screens.map(\.frame)) mouse=\(NSEvent.mouseLocation)\n".data(using: .utf8)!)
        if NSScreen.screens.contains(where: { $0.frame.contains(frame) }) {
            item.menu = menu
            item.button?.performClick(nil)
            item.menu = nil
        } else {
            menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    func refresh() {
        let url = URL(string: base + "/api/inbox")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let inbox = ok ? data.flatMap { try? JSONDecoder().decode(Inbox.self, from: $0) } : nil
            Task { @MainActor in self.render(inbox.map(Status.loaded) ?? .unreachable) }
        }.resume()
    }

    func render(_ status: Status) {
        menu.removeAllItems()
        switch status {
        case .unreachable:
            setButton(symbol: "tray", title: "!")
            let down = NSMenuItem(title: "Server not running", action: nil, keyEquivalent: "")
            down.isEnabled = false
            menu.addItem(down)
        case .loaded(let inbox):
            setButton(symbol: inbox.count > 0 ? "tray.full" : "tray", title: inbox.count > 0 ? "\(inbox.count)" : "")
            for entry in inbox.entries {
                let row = NSMenuItem(title: "\(entry.state.glyph)  " + truncate("\(entry.routineName): \(entry.summary)"), action: #selector(openInbox), keyEquivalent: "")
                row.target = self
                menu.addItem(row)
            }
        }
        menu.addItem(.separator())
        let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        dashboard.target = self
        menu.addItem(dashboard)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    func setButton(symbol: String, title: String) {
        item.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "RoutineBar")
        item.button?.title = title
    }

    @objc func openInbox() {
        NSWorkspace.shared.open(URL(string: base + "/#inbox")!)
    }

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: base + "/")!)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
