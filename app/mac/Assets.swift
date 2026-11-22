import Cocoa
import WebKit

// Bundle resources and the selected file are served in-process, without a listening socket.
final class BundleAssets: NSObject, WKURLSchemeHandler {
    let root: URL
    let input: URL?
    init(root: URL, input: URL?) { self.root = root.standardizedFileURL; self.input = input }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "r3", url.host == "app" else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL)); return
        }
        let file: URL
        if url.path == "/input", let input = input { file = input }
        else {
            file = root.appendingPathComponent(url.path == "/" ? "index.html" : String(url.path.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(root.path + "/"), !url.path.contains("..") else {
                task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorNoPermissionsToReadFile)); return
            }
        }
        do {
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "wasm": "application/wasm",
                         "json": "application/json", "woff2": "font/woff2", "woff": "font/woff", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg"]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": types[file.pathExtension] ?? "application/octet-stream",
                "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*",
                "Content-Security-Policy": "default-src 'self' r3: blob: data:; script-src 'self' r3: blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src blob: r3:; connect-src r3:; img-src 'self' r3: blob: data:",
            ])!
            task.didReceive(response); task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

struct LaunchTarget {
    var file: URL? = nil
    var endpoint: URL? = nil
    var analysis = "auto"
    var backend = "wasm"
    var config: [String: Any] {
        var values: [String: Any] = ["mode": endpoint == nil ? backend : "http", "analysis": analysis]
        if let file = file {
            values["path"] = file.path
            values["size"] = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
        if let endpoint = endpoint { values["endpoint"] = endpoint.absoluteString }
        return values
    }
    static func remote(_ text: String, analysis: String = "none") throws -> LaunchTarget {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              let host = parts.host, !host.isEmpty else {
            throw NSError(domain: "r3", code: 1, userInfo: [NSLocalizedDescriptionKey: "Enter an http:// or https:// radare2 server URL."])
        }
        parts.query = nil; parts.fragment = nil
        var path = parts.path
        if path.hasSuffix("/cmd/") { path = String(path.dropLast(5)) }
        else if path.hasSuffix("/cmd") { path = String(path.dropLast(4)) }
        while path.hasSuffix("/") { path.removeLast() }
        parts.path = path + "/cmd/"
        guard let url = parts.url else { throw NSError(domain: "r3", code: 1) }
        return LaunchTarget(endpoint: url, analysis: analysis)
    }
}
