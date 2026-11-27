import Foundation

/// A desktop this phone is paired with. The phone can hold several and shows one at a time.
/// The token for each machine is kept in the Keychain, never in this record.
public struct PairedMachine: Codable, Identifiable, Equatable, Sendable {
    /// The desktop's own id from pairing, or a generated one for a connection set up before
    /// pairing existed.
    public var id: String
    public var name: String
    public var urlString: String

    public init(id: String, name: String, urlString: String) {
        self.id = id
        self.name = name
        self.urlString = urlString
    }

    /// The address without the scheme, e.g. "100.64.0.3:47890".
    public var address: String {
        guard let url = URL(string: urlString), let host = url.host else { return urlString }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// The name to show: the desktop's name, or its address when it has none.
    public var displayName: String {
        name.isEmpty ? address : name
    }

    /// Keychain account that holds this machine's token.
    public var tokenAccount: String { Self.tokenAccount(for: id) }

    public static func tokenAccount(for id: String) -> String { "desktop:\(id)" }
}

/// List operations on paired machines, kept free of storage so they can be tested directly.
public enum PairedMachines {
    /// Adds `machine`, or replaces the entry with the same id in place, so pairing again with
    /// a desktop updates it instead of listing it twice.
    public static func upserting(_ machine: PairedMachine, into list: [PairedMachine]) -> [PairedMachine] {
        var next = list
        if let index = next.firstIndex(where: { $0.id == machine.id }) {
            next[index] = machine
        } else {
            next.append(machine)
        }
        return next
    }

    /// The machine `offset` places after `id` in the list, wrapping around at both ends.
    /// Nil when there is nothing to switch to.
    public static func neighbor(of id: String, in list: [PairedMachine], offset: Int) -> PairedMachine? {
        guard list.count > 1, let index = list.firstIndex(where: { $0.id == id }) else { return nil }
        let count = list.count
        let target = ((index + offset) % count + count) % count
        return target == index ? nil : list[target]
    }

    public static func decode(_ data: Data?) -> [PairedMachine] {
        guard let data else { return [] }
        return (try? JSONDecoder().decode([PairedMachine].self, from: data)) ?? []
    }

    public static func encode(_ list: [PairedMachine]) -> Data? {
        try? JSONEncoder().encode(list)
    }
}
