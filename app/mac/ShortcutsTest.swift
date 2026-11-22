import Cocoa

final class ShortcutChecks {
    var enterObserver: NSObjectProtocol?
    var exitObserver: NSObjectProtocol?
    var deadline: Timer?
    func key(_ text: String) {
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0,
            windowNumber: NSApp.keyWindow?.windowNumber ?? 0, context: nil, characters: text,
            charactersIgnoringModifiers: text, isARepeat: false, keyCode: 0)!
        require(NSApp.mainMenu!.performKeyEquivalent(with: event), "Cmd+\(text) did not dispatch")
    }
    func require(_ success: Bool, _ message: String) {
        if !success { fputs("FAIL: \(message)\n", stderr); exit(1) }
    }
    func run() {
        guard let first = NSApp.keyWindow else { require(false, "No startup window"); return }
        key("t")
        guard let tabs = first.tabbedWindows else { require(false, "Cmd+T did not create a tab"); return }
        require(tabs.count == 2, "Cmd+T must create a blank tab without a file dialog")
        key("1"); require(first.tabGroup?.selectedWindow === tabs[0], "Cmd+1 did not focus first tab")
        key("2"); require(first.tabGroup?.selectedWindow === tabs[1], "Cmd+2 did not focus second tab")
        key("t")
        require(first.tabbedWindows?.count == 3, "Second Cmd+T did not create a third tab")
        key("3"); require(first.tabGroup?.selectedWindow === first.tabbedWindows?[2], "Cmd+3 did not focus third tab")
        key("n")
        guard let separate = NSApp.keyWindow else { require(false, "Cmd+N did not create a window"); return }
        require(!first.tabbedWindows!.contains(separate), "Cmd+N added a tab instead of a window")
        key("w"); require(!separate.isVisible, "Cmd+W did not close the new window")
        first.makeKeyAndOrderFront(nil)
        key("2"); key("w")
        require(first.tabbedWindows?.count == 2, "Cmd+W did not close only the current tab")
        let current = NSApp.keyWindow!
        deadline = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { _ in self.require(false, "Full screen timed out") }
        exitObserver = NotificationCenter.default.addObserver(forName: NSWindow.didExitFullScreenNotification, object: current, queue: .main) { _ in
            self.deadline?.invalidate()
            print("PASS: Cmd+1/2/3 focus tabs, Cmd+T creates tabs, Cmd+W closes current tab, Cmd+N creates windows, Cmd+F enters/exits full screen")
            NSApp.terminate(nil)
        }
        enterObserver = NotificationCenter.default.addObserver(forName: NSWindow.didEnterFullScreenNotification, object: current, queue: .main) { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.key("f") }
        }
        key("f")
    }
}
@main enum ShortcutsTest {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        let delegate = AppDelegate(root: URL(fileURLWithPath: "build/r3.app/Contents/Resources/webui"))
        let checks = ShortcutChecks()
        app.setActivationPolicy(.regular); app.delegate = delegate
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { _ in checks.run() }
        withExtendedLifetime((delegate, checks)) { app.run() }
    }
}
