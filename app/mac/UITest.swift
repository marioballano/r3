import Cocoa
import WebKit

final class UITestDelegate: NSObject, NSApplicationDelegate {
    var windows: [BrowserWindow] = []
    var timer: Timer?
    var deadline = Date().addingTimeInterval(90)
    var checking = false
    var started = Set<Int>()
    var stableSince: Date?
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let root = URL(fileURLWithPath: CommandLine.arguments[1])
            NSWindow.allowsAutomaticWindowTabbing = false
            var targets = ["/bin/ls", "/bin/cat"].map { LaunchTarget(file: URL(fileURLWithPath: $0), analysis: "aaa") }
            if CommandLine.arguments.count > 2 {
                targets.append(LaunchTarget(file: URL(fileURLWithPath: "/bin/ls"), analysis: "aa", backend: "pipe"))
                targets.append(try LaunchTarget.remote(CommandLine.arguments[2]))
            }
            for target in targets {
                let controller = try BrowserWindow(target: target, root: root)
                controller.web.configuration.userContentController.addUserScript(WKUserScript(source:
                    "window.__errors=[];addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));",
                    injectionTime: .atDocumentStart, forMainFrameOnly: true))
                windows.append(controller)
            }
            for controller in windows.dropFirst() { windows[0].window!.addTabbedWindow(controller.window!, ordered: .above) }
            windows[1].showWindow(nil)
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.check() }
        } catch { finish(error.localizedDescription) }
    }
    func check() {
        if Date() > deadline {
            windows[0].web.evaluateJavaScript("JSON.stringify({text:document.body.innerText,errors:window.__errors})") { value, error in
                self.finish("WebKit timeout: \(value ?? "nil") \(String(describing: error))")
            }; timer?.invalidate(); return
        }
        guard !checking else { return }
        checking = true
        var remaining = windows.count
        var ready = 0
        for (i, controller) in windows.enumerated() {
            controller.web.evaluateJavaScript("JSON.stringify({boot:!!document.querySelector('.jack'),ready:document.querySelector('.prog .pct')?.textContent==='100%' && document.querySelector('.stats')?.textContent.includes('functions '),errors:[...(window.__errors??[]), ...(document.querySelector('.log')?.textContent.includes('✖')?[document.querySelector('.log').textContent]:[])]})") { value, error in
                if let text = value as? String, let data = text.data(using: .utf8), let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if state["boot"] as? Bool == true, !self.started.contains(i) {
                        self.started.insert(i)
                        controller.web.evaluateJavaScript("document.querySelector('.jack').click()")
                    }
                    if state["ready"] as? Bool == true { ready += 1 }
                    if let errors = state["errors"] as? [String], !errors.isEmpty { self.finish(errors.joined(separator: "; ")); return }
                }
                remaining -= 1
                if remaining == 0 {
                    self.checking = false
                    if ready == self.windows.count {
                        if self.stableSince == nil { self.stableSince = Date() }
                        guard Date().timeIntervalSince(self.stableSince!) > 2 else { return }
                        guard self.windows[0].window!.tabbedWindows?.count == self.windows.count else { self.finish("Native tabs missing"); return }
                        self.timer?.invalidate()
                        self.windows[1].web.takeSnapshot(with: nil) { image, _ in
                            if let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) {
                                try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "build/ui-test.png"))
                            }
                            self.finish(nil)
                        }
                    }
                }
            }
        }
    }
    func finish(_ error: String?) {
        timer?.invalidate()
        windows.forEach { $0.stop(); $0.close() }
        if let error = error { fputs("FAIL: \(error)\n", stderr); exit(1) }
        print("PASS: native tabs, bundled modules/fonts, WebGL, isolated WASM workers, real binary analysis and optional remote POST backend")
        NSApp.terminate(nil)
    }
}
@main enum UITest {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        let delegate = UITestDelegate()
        app.setActivationPolicy(.regular); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
