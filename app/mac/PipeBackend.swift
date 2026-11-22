import Foundation

// Optional native r2pipe over stdio. No HTTP listener or Node runtime is needed.
final class PipeBackend {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let queue = DispatchQueue(label: "org.radare.r3.r2pipe")
    private var pending = Data()
    private var ready = false

    init(file: URL) throws {
        let environment = ProcessInfo.processInfo.environment
        let binary = environment["R2"] ?? "r2"
        let paths = (environment["PATH"] ?? "").components(separatedBy: ":")
            + ["/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.local/bin", "/usr/bin"]
        let candidates = binary.contains("/") ? [binary] : paths.map { $0 + "/" + binary }
        guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw NSError(domain: "r3", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot find radare2. Install r2 or set R2 to its executable path, or choose the bundled WASM backend."])
        }
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-N", "-q0", "-2", "-e", "bin.relocs.apply=true", "-e", "scr.interactive=false", file.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
    }
    private func readReply() throws -> String {
        while true {
            if let end = pending.firstIndex(of: 0) {
                let text = String(decoding: pending[..<end], as: UTF8.self)
                pending.removeSubrange(...end)
                return text
            }
            let data = output.fileHandleForReading.availableData
            guard !data.isEmpty else {
                throw NSError(domain: "r3", code: 2, userInfo: [NSLocalizedDescriptionKey: "radare2 exited or the r2pipe session closed."])
            }
            pending.append(data)
            if pending.count > 32 * 1024 * 1024 {
                throw NSError(domain: "r3", code: 3, userInfo: [NSLocalizedDescriptionKey: "r2pipe output exceeded 32 MiB."])
            }
        }
    }
    func command(_ command: String, timeout: TimeInterval, completion: @escaping (Any?, String?) -> Void) {
        queue.async { [self] in
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler { [weak self] in self?.stop() }
            timer.resume()
            defer { timer.cancel() }
            do {
                if !self.ready { _ = try self.readReply(); self.ready = true }
                let clean = command.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
                try self.input.fileHandleForWriting.write(contentsOf: Data((clean + "\n").utf8))
                let result = try self.readReply()
                DispatchQueue.main.async { completion(result, nil) }
            } catch {
                self.stop()
                DispatchQueue.main.async { completion(nil, error.localizedDescription) }
            }
        }
    }
    func stop() { if process.isRunning { process.terminate() } }
    deinit { stop() }
}
