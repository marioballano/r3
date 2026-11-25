import Darwin
import Foundation

func command(_ arguments: [String]) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = arguments
    return process
}

func developerTeam(in identities: String, matching requestedIdentity: String) -> String? {
    let matchingTeams = Set(identities.split(separator: "\n").compactMap { line -> String? in
        let fields = line.split(separator: "\"")
        guard fields.count >= 2, fields[1].hasPrefix("Developer ID Application: ") else { return nil }
        let name = fields[1]
        let fingerprint = fields[0].split(whereSeparator: \.isWhitespace).last ?? ""
        guard requestedIdentity.isEmpty || requestedIdentity == "-" ||
                name == requestedIdentity || fingerprint == requestedIdentity.uppercased() else { return nil }
        guard let range = name.range(of: #"\([A-Z0-9]{10}\)$"#, options: .regularExpression) else { return nil }
        return String(name[range].dropFirst().dropLast())
    })
    return matchingTeams.count == 1 ? matchingTeams.first : nil
}

func appleAccount(for team: String, in preferences: [String: Any]) -> String? {
    typealias AccountTeams = [String: [[String: Any]]]
    func includesTeam(_ teams: [[String: Any]]?) -> Bool {
        teams?.contains { $0["teamID"] as? String == team } ?? false
    }

    // Xcode preferences are optional. Fall back to Apple's prompts if their format changes.
    let teamsByUsername = preferences["IDEProvisioningTeams"] as? AccountTeams ?? [:]
    var matchingAccounts = Set(teamsByUsername.keys.filter {
        $0.contains("@") && includesTeam(teamsByUsername[$0])
    })
    let teamsByIdentifier = preferences["IDEProvisioningTeamByIdentifier"] as? AccountTeams ?? [:]
    let accountLists = preferences["DVTDeveloperAccountManagerAppleIDLists"] as? [String: Any] ?? [:]
    let accounts = accountLists["IDE.Prod"] as? [[String: Any]] ?? []
    let identifiers = accountLists["IDE.Identifiers.Prod"] as? [[String: Any]] ?? []
    if accounts.count == identifiers.count {
        for (account, entry) in zip(accounts, identifiers) {
            guard let username = account["username"] as? String, username.contains("@"),
                  let identifier = entry["identifier"] as? String,
                  includesTeam(teamsByIdentifier[identifier]) else { continue }
            matchingAccounts.insert(username)
        }
    }
    return matchingAccounts.count == 1 ? matchingAccounts.first : nil
}

let profile = CommandLine.arguments[1]
let requestedIdentity = CommandLine.arguments[2]
let security = command(["security", "find-identity", "-v", "-p", "codesigning"])
let pipe = Pipe()
security.standardOutput = pipe
try security.run()
let identities = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
security.waitUntilExit()

var arguments = ["xcrun", "notarytool", "store-credentials", profile]
if let team = developerTeam(in: identities, matching: requestedIdentity) {
    arguments += ["--team-id", team]
    let preferences = UserDefaults.standard.persistentDomain(forName: "com.apple.dt.Xcode") ?? [:]
    if let account = appleAccount(for: team, in: preferences) {
        print("Using the Apple Account and Team ID from Xcode and your Developer ID certificate.")
        arguments += ["--apple-id", account]
    } else {
        print("Using the Team ID from your Developer ID Application certificate.")
    }
} else {
    print("Press Enter at the API private key prompt to use your Apple ID.")
}
print("Generate an app-specific password at https://account.apple.com/ under Sign-In and Security → App-Specific Passwords.")
// Keep the foreground terminal so notarytool can securely prompt for a password.
fflush(nil)
var argv = arguments.map { strdup($0) }
argv.append(nil)
execvp("xcrun", &argv)
perror("xcrun")
exit(EXIT_FAILURE)
