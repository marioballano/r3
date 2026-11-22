import Foundation
import Darwin

@main enum PipeTest {
    static func main() throws {
        signal(SIGPIPE, SIG_IGN)
        let pipe = try PipeBackend(file: URL(fileURLWithPath: "/bin/ls"))
        defer { pipe.stop() }
        func command(_ text: String) throws -> String {
            var done = false
            var output = ""
            var failure: String?
            pipe.command(text, timeout: 10) { value, error in
                output = value as? String ?? ""; failure = error; done = true
            }
            let deadline = Date().addingTimeInterval(12)
            while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
            guard done && failure == nil else {
                throw NSError(domain: "PipeTest", code: 1, userInfo: [NSLocalizedDescriptionKey: failure ?? "r2pipe timed out"])
            }
            return output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard try command("?v 1+2") == "0x3" else { fatalError("Bad r2pipe response") }
        let info = try JSONSerialization.jsonObject(with: Data(command("ij").utf8)) as! [String: Any]
        guard info["bin"] != nil else { fatalError("Missing binary metadata") }
        _ = try command("aa")
        guard Int(try command("aflc")) ?? 0 > 10 else { fatalError("Missing functions") }
        pipe.stop()
        print("PASS: native r2pipe handshake, commands, headers, analysis, process shutdown")
    }
}
