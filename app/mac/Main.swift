import Cocoa

@main
enum Main {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        if let url = Bundle.main.url(forResource: "r3", withExtension: "icns"),
           let icon = NSImage(contentsOf: url) {
            app.applicationIconImage = icon
        }
        let delegate = AppDelegate()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
