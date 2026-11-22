import Cocoa
import WebKit
import CryptoKit

final class FileDropWebView: WKWebView {
    var onFileDrop: ((URL) -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown,
              event.modifierFlags.intersection([.command, .control, .option]) == [.command] else {
            return super.performKeyEquivalent(with: event)
        }
        let action: Selector
        switch event.charactersIgnoringModifiers {
        case "+", "=": action = #selector(AppDelegate.zoomIn)
        case "-": action = #selector(AppDelegate.zoomOut)
        case "0": action = #selector(AppDelegate.resetZoom)
        default: return super.performKeyEquivalent(with: event)
        }
        return NSApp.sendAction(action, to: nil, from: self)
    }

    private func fileURL(from sender: NSDraggingInfo) -> URL? {
        (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL])?.first
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURL(from: sender) == nil ? super.draggingEntered(sender) : .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURL(from: sender) == nil ? super.draggingUpdated(sender) : .copy
    }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        fileURL(from: sender) != nil || super.prepareForDragOperation(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let url = fileURL(from: sender) else { return super.performDragOperation(sender) }
        DispatchQueue.main.async { [weak self] in self?.onFileDrop?(url) }
        return true
    }
}

final class BrowserWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private(set) var target: LaunchTarget
    let web: FileDropWebView
    private let client: URLSession
    private var pipe: PipeBackend?
    var onClose: (() -> Void)?

    init(target: LaunchTarget, root: URL? = nil) throws {
        self.target = target
        let resources = root ?? Bundle.main.resourceURL!.appendingPathComponent("webui")
        guard FileManager.default.fileExists(atPath: resources.appendingPathComponent("index.html").path) else {
            throw NSError(domain: "r3", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing bundled web UI. Run make in app/mac."])
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BundleAssets(root: resources, input: target.file), forURLScheme: "r3")
        let json = String(data: try JSONSerialization.data(withJSONObject: target.config), encoding: .utf8)!
        configuration.userContentController.addUserScript(WKUserScript(source: "window.__R3_NATIVE__=\(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.mediaTypesRequiringUserActionForPlayback = []
        web = FileDropWebView(frame: .zero, configuration: configuration)
        let networking = URLSessionConfiguration.ephemeral
        networking.timeoutIntervalForResource = 600
        client = URLSession(configuration: networking)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = (target.file?.lastPathComponent ?? target.endpoint?.host ?? "r3") + " — r3"
        window.delegate = self
        window.center()
        window.isReleasedWhenClosed = false
        window.tabbingIdentifier = "org.radare.r3"
        window.tabbingMode = .preferred
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = web
        web.registerForDraggedTypes([.fileURL])
        web.onFileDrop = { [weak window] url in
            (NSApp.delegate as? AppDelegate)?.showOpenDialog(initialURL: url, parent: window)
        }
        web.navigationDelegate = self
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "r3")
        web.load(URLRequest(url: URL(string: "r3://app/index.html")!))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    var isEmpty: Bool { target.file == nil && target.endpoint == nil }
    func setBackend(_ backend: String) {
        guard isEmpty else { return }
        target.backend = backend
        let json = String(data: try! JSONSerialization.data(withJSONObject: target.config), encoding: .utf8)!
        web.configuration.userContentController.removeAllUserScripts()
        web.configuration.userContentController.addUserScript(WKUserScript(source: "window.__R3_NATIVE__=\(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web.reload()
    }
    func reloadPage() { client.getAllTasks { $0.forEach { $0.cancel() } }; pipe?.stop(); pipe = nil; web.reload() }
    func changeZoom(_ factor: Double) { web.pageZoom = min(5, max(0.25, web.pageZoom * factor)) }
    func resetZoom() { web.pageZoom = 1 }
    func windowWillClose(_ notification: Notification) { stop(); onClose?() }
    func stop() {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "r3", contentWorld: .page)
        pipe?.stop(); pipe = nil
        web.stopLoading(); client.invalidateAndCancel()
        web.loadHTMLString("", baseURL: nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.scheme == "r3" && action.request.url?.host == "app" ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let alert = NSAlert(); alert.messageText = "The r3 tab stopped"
        alert.informativeText = "Reload this tab to restart its analysis engine."
        alert.addButton(withTitle: "Reload"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window!) { [weak self] response in if response == .alertFirstButtonReturn { self?.reloadPage() } }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "r3",
              message.frameInfo.request.url?.host == "app", let body = message.body as? [String: Any],
              let action = body["action"] as? String else { replyHandler(nil, "Invalid native request"); return }
        switch action {
        case "pick":
            (NSApp.delegate as? AppDelegate)?.showOpenDialog(parent: window); replyHandler(true, nil)
        case "backend":
            guard let mode = body["mode"] as? String, ["wasm", "pipe", "http"].contains(mode) else { replyHandler(nil, "Invalid backend"); return }
            (NSApp.delegate as? AppDelegate)?.chooseBackend(mode)
            replyHandler(true, nil)
        case "pipe":
            guard target.backend == "pipe", let file = target.file, let command = body["command"] as? String else {
                replyHandler(nil, "No local r2pipe session configured"); return
            }
            do {
                if pipe == nil { pipe = try PipeBackend(file: file) }
                pipe!.command(command, timeout: min(600, max(1, (body["timeoutMs"] as? Double ?? 60000) / 1000)), completion: replyHandler)
            } catch { replyHandler(nil, error.localizedDescription) }
        case "connect":
            (NSApp.delegate as? AppDelegate)?.connectRemote(nil); replyHandler(true, nil)
        case "hash":
            guard let file = target.file else { replyHandler(nil, "No local binary selected"); return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let data = try Data(contentsOf: file, options: .mappedIfSafe)
                    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                    DispatchQueue.main.async { replyHandler(hash, nil) }
                } catch { DispatchQueue.main.async { replyHandler(nil, error.localizedDescription) } }
            }
        case "cancel": client.getAllTasks { $0.forEach { $0.cancel() } }; pipe?.stop(); pipe = nil; replyHandler(true, nil)
        case "cmd":
            guard let endpoint = target.endpoint, body["endpoint"] as? String == endpoint.absoluteString,
                  let command = body["command"] as? String else { replyHandler(nil, "No remote session configured"); return }
            var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
            let user = parts.user; let password = parts.password
            parts.user = nil; parts.password = nil
            var request = URLRequest(url: parts.url!)
            request.httpMethod = "POST"
            request.httpBody = command.data(using: .utf8)
            request.timeoutInterval = min(600, max(1, (body["timeoutMs"] as? Double ?? 60000) / 1000))
            request.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
            parts.path = String(parts.path.dropLast(5)) + "/"
            request.setValue(parts.url!.absoluteString, forHTTPHeaderField: "Referer")
            if let user = user {
                let token = Data((user + ":" + (password ?? "")).utf8).base64EncodedString()
                request.setValue("Basic " + token, forHTTPHeaderField: "Authorization")
            }
            client.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    if let error = error { replyHandler(nil, error.localizedDescription); return }
                    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                        replyHandler(nil, "r2 server returned HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"); return
                    }
                    replyHandler(String(decoding: data ?? Data(), as: UTF8.self), nil)
                }
            }.resume()
        default: replyHandler(nil, "Unknown native action")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var windows: [BrowserWindow] = []
    private var preferredBackend = "wasm"
    private let root: URL?
    init(root: URL? = nil) { self.root = root; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit r3", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; menu.addItem(appItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
        fileMenu.addItem(withTitle: "Open…", action: #selector(openFile(_:)), keyEquivalent: "o")
        fileMenu.addItem(withTitle: "New Tab", action: #selector(newTab(_:)), keyEquivalent: "t")
        fileMenu.addItem(withTitle: "Connect to r2 Server…", action: #selector(connectRemote(_:)), keyEquivalent: "l")
        fileMenu.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w")
        let fileItem = NSMenuItem(); fileItem.submenu = fileMenu; menu.addItem(fileItem)
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"),
                                     ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(); editItem.submenu = editMenu; menu.addItem(editItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(toggleFullScreen), keyEquivalent: "f")
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        let zoomInAlternate = viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        zoomInAlternate.isHidden = true
        zoomInAlternate.allowsKeyEquivalentWhenHidden = true
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(resetZoom), keyEquivalent: "0")
        let viewItem = NSMenuItem(); viewItem.submenu = viewMenu; menu.addItem(viewItem)
        let backendMenu = NSMenu(title: "Backend")
        for (title, mode) in [("WebAssembly (bundled)", "wasm"), ("r2pipe (spawn local r2)", "pipe"), ("Remote HTTP server", "http")] {
            let item = backendMenu.addItem(withTitle: title, action: #selector(selectBackend(_:)), keyEquivalent: "")
            item.representedObject = mode; item.target = self
        }
        let backendItem = NSMenuItem(); backendItem.submenu = backendMenu; menu.addItem(backendItem)
        let windowMenu = NSMenu(title: "Window")
        for number in 1...9 {
            let item = windowMenu.addItem(withTitle: "Select Tab \(number)", action: #selector(selectTab(_:)), keyEquivalent: String(number))
            item.keyEquivalentModifierMask = [.command]
            item.tag = number - 1
            item.target = self
        }
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSWindow.allowsAutomaticWindowTabbing = false
        NSApp.activate(ignoringOtherApps: true)
        let files = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
        if files.isEmpty { if windows.isEmpty { newWindow(nil) } } else {
            files.forEach { configureFile(URL(fileURLWithPath: $0), parent: selected?.window) }
        }
    }

    @objc func newWindow(_ sender: Any?) { open(nil) }
    @objc func newTab(_ sender: Any?) { open(nil, inTabOf: selected?.window) }
    @objc func closeTab(_ sender: Any?) { selected?.window?.performClose(sender) }
    @objc func selectBackend(_ sender: NSMenuItem) {
        if let mode = sender.representedObject as? String { chooseBackend(mode) }
    }
    func chooseBackend(_ mode: String) { preferredBackend = mode; selected?.setBackend(mode) }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(selectBackend(_:)) { item.state = item.representedObject as? String == preferredBackend ? .on : .off }
        return true
    }

    @objc func openFile(_ sender: Any?) {
        showOpenDialog(parent: selected?.window, openInTab: false)
    }

    func showOpenDialog(initialURL: URL? = nil, parent: NSWindow?, openInTab: Bool = true) {
        guard parent?.attachedSheet == nil else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        if let url = initialURL {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            panel.directoryURL = isDirectory ? url : url.deletingLastPathComponent()
            if !isDirectory { panel.nameFieldStringValue = url.lastPathComponent }
        }
        let openSelection: () -> Void = { [weak self] in
            guard let self = self else { return }
            var target = parent
            for url in panel.urls {
                self.configureFile(url, parent: openInTab ? target : nil)
                if openInTab && target == nil { target = self.selected?.window }
            }
        }
        if let parent = parent {
            parent.makeKeyAndOrderFront(nil)
            panel.beginSheetModal(for: parent) { response in
                if response == .OK { openSelection() }
            }
        } else if panel.runModal() == .OK {
            openSelection()
        }
    }

    func configureFile(_ url: URL, parent: NSWindow?) {
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            let alert = NSAlert(); alert.messageText = "Select a regular binary file"; alert.runModal(); return
        }
        let alert = NSAlert()
        alert.messageText = "Open \(url.lastPathComponent)"
        alert.informativeText = "Choose the analysis engine and depth for this file."
        let options = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 64))
        let backend = NSPopUpButton(frame: NSRect(x: 0, y: 36, width: 400, height: 28))
        backend.addItems(withTitles: ["WebAssembly (bundled)", "r2pipe (spawn local r2)"])
        backend.selectItem(at: preferredBackend == "pipe" ? 1 : 0)
        let analysis = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 400, height: 28))
        analysis.addItems(withTitles: ["Automatic analysis (aaa up to 4 MiB, else aa)", "Open only — no analysis", "Basic analysis — aa", "Deep analysis — aaa"])
        options.addSubview(backend); options.addSubview(analysis); alert.accessoryView = options
        alert.addButton(withTitle: "Open"); alert.addButton(withTitle: "Cancel")
        // File selection's sheet has finished before this dialog is shown.
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        preferredBackend = backend.indexOfSelectedItem == 1 ? "pipe" : "wasm"
        open(url.path, inTabOf: parent, analysis: ["auto", "none", "aa", "aaa"][analysis.indexOfSelectedItem])
    }

    @objc func connectRemote(_ sender: Any?) {
        guard selected?.window?.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Connect to a radare2 server"
        alert.informativeText = "Use the binary already open on an r2 HTTP server (r2 -c '=h' binary). Commands are sent with POST /cmd/."
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 64))
        let input = NSTextField(frame: NSRect(x: 0, y: 36, width: 460, height: 24))
        input.stringValue = "http://127.0.0.1:9090"
        let analysis = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 460, height: 28))
        analysis.addItems(withTitles: ["Keep existing analysis", "Basic analysis — aa", "Deep analysis — aaa"])
        box.addSubview(input); box.addSubview(analysis); alert.accessoryView = box
        alert.addButton(withTitle: "Connect"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { openTarget(try LaunchTarget.remote(input.stringValue, analysis: ["none", "aa", "aaa"][analysis.indexOfSelectedItem]), inTabOf: selected?.window) }
        catch { NSAlert(error: error).runModal() }
    }

    private var selected: BrowserWindow? {
        windows.first { $0.window === NSApp.keyWindow } ?? windows.last
    }
    @objc func reloadPage() { selected?.reloadPage() }
    @objc func zoomIn() { selected?.changeZoom(1.1) }
    @objc func zoomOut() { selected?.changeZoom(1 / 1.1) }
    @objc func resetZoom() { selected?.resetZoom() }
    @objc func toggleFullScreen() {
        guard let window = selected?.window, window.attachedSheet == nil else { return }
        window.toggleFullScreen(nil)
    }
    @objc func selectTab(_ sender: NSMenuItem) {
        guard let window = selected?.window, window.attachedSheet == nil else { return }
        let tabs = window.tabbedWindows ?? [window]
        guard tabs.indices.contains(sender.tag) else { return }
        window.tabGroup?.selectedWindow = tabs[sender.tag]
        tabs[sender.tag].makeKeyAndOrderFront(nil)
    }
    private func open(_ path: String?, inTabOf parent: NSWindow? = nil, analysis: String = "auto") {
        openTarget(LaunchTarget(file: path.map { URL(fileURLWithPath: $0).standardizedFileURL }, analysis: analysis, backend: preferredBackend), inTabOf: parent)
    }

    private func openTarget(_ target: LaunchTarget, inTabOf parent: NSWindow? = nil) {
        do {
            let previous = selected?.window
            let controller = try BrowserWindow(target: target, root: root)
            controller.onClose = { [weak self, weak controller] in self?.windows.removeAll { $0 === controller } }
            windows.append(controller)
            if let parent = parent, windows.contains(where: { $0.window === parent }) {
                parent.addTabbedWindow(controller.window!, ordered: .above)
            } else if let previous = previous {
                controller.window?.setFrameTopLeftPoint(NSPoint(x: previous.frame.minX + 24, y: previous.frame.maxY - 24))
            }
            controller.showWindow(nil)
            if !controller.isEmpty, let parent = parent,
               let empty = windows.first(where: { $0.window === parent && $0.isEmpty }) { empty.close() }
        } catch {
            let alert = NSAlert(error: error); alert.runModal()
        }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        filenames.forEach { configureFile(URL(fileURLWithPath: $0), parent: selected?.window) }; sender.reply(toOpenOrPrint: .success)
    }
    func applicationWillTerminate(_ notification: Notification) { windows.forEach { $0.stop() } }
}
