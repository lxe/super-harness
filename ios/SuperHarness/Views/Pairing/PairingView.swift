import SwiftUI
#if canImport(VisionKit)
import VisionKit
#endif

/// First screen of a fresh install: pair this phone with a desktop by scanning its QR code,
/// picking it from the desktops found nearby, or typing its address and 6-digit code.
public struct PairingView: View {
    @Bindable var store: AppStore

    @State private var browser = DesktopBrowser()
    @State private var isScannerPresented = false
    @State private var isManualEntryPresented = false
    @State private var codeEntryDesktop: NearbyDesktop?
    @State private var isWorking = false
    @State private var workingLabel = ""
    @State private var errorMessage: String?

    /// True when the screen is shown as a sheet to pair one more machine: it gets a Cancel
    /// button and leaves out the first-run extras (the demo and the developer options).
    private let isAdditional: Bool
    @Environment(\.dismiss) private var dismiss

    public init(store: AppStore, isAdditional: Bool = false) {
        self.store = store
        self.isAdditional = isAdditional
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: SHSpacing.xl) {
                header

                if !isAdditional, let notice = store.pairingNotice {
                    banner(notice, icon: "info.circle.fill", tint: SHColor.statusWarning)
                        .accessibilityIdentifier("pairing.notice")
                }
                if let errorMessage {
                    banner(errorMessage, icon: "exclamationmark.triangle.fill", tint: SHColor.statusDanger)
                        .accessibilityIdentifier("pairing.error")
                }

                scanButton
                nearbySection
                manualButton

                Text("Both devices need to be on the same network. Tailscale on both works best: it connects them from anywhere and encrypts the link.")
                    .font(SHTypography.caption)
                    .foregroundStyle(SHColor.inkMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, SHSpacing.md)

                // A way in without a desktop: sample chats, nothing sent anywhere. Settings →
                // Developer turns it off again.
                if !isAdditional {
                Button {
                    Task { await store.setDemoMode(true) }
                } label: {
                    Text("See a demo")
                        .font(SHTypography.label)
                        .foregroundStyle(SHColor.inkSecondary)
                        .padding(.horizontal, 18)
                        .frame(height: 40)
                        .shRaisedSurface(SHColor.surfaceSubtle, cornerRadius: 20, elevation: .tile)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the app with sample chats. No desktop needed.")
                .accessibilityIdentifier("pairing.demo")

                Button("Developer options") {
                    store.isHostSettingsSheetPresented = true
                }
                .font(SHTypography.micro)
                .foregroundStyle(SHColor.inkFaint)
                .accessibilityIdentifier("pairing.developer")
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, 36)
            .padding(.bottom, 28)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(SHColor.surfaceCanvas.ignoresSafeArea())
        .overlay(alignment: .topLeading) {
            if isAdditional {
                Button("Cancel") { dismiss() }
                    .font(SHTypography.label)
                    .foregroundStyle(SHColor.inkSecondary)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 16)
                    .accessibilityIdentifier("pairing.cancel")
            }
        }
        .overlay {
            if isWorking {
                ZStack {
                    Color.black.opacity(0.45).ignoresSafeArea()
                    VStack(spacing: 14) {
                        SHActivityPulse(tint: SHColor.porcelain, size: 34)
                        Text(workingLabel)
                            .font(SHTypography.label)
                            .foregroundStyle(SHColor.inkPrimary)
                    }
                    .padding(26)
                    .background(SHColor.surfacePopover, in: RoundedRectangle(cornerRadius: SHRadius.xl, style: .continuous))
                }
                .transition(.opacity)
                .accessibilityIdentifier("pairing.working")
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isWorking)
        .onAppear { browser.start() }
        .onDisappear { browser.stop() }
        .sheet(isPresented: $isScannerPresented) {
            PairingScannerSheet { scanned in
                isScannerPresented = false
                handleScanned(scanned)
            }
        }
        .sheet(isPresented: $isManualEntryPresented) {
            PairingCodeSheet(
                title: "Enter Manually",
                desktopName: nil,
                asksForAddress: true,
                lookUpName: { url in await store.pairingInfo(at: url)?.hostName }
            ) { address, code in
                isManualEntryPresented = false
                guard let url = PairingAddress.baseURL(from: address) else {
                    errorMessage = PairingError.invalidAddress.errorDescription
                    return
                }
                startPairing(candidates: [url], expectedHostId: "", code: code)
            }
            .presentationDetents([.medium])
        }
        .sheet(item: $codeEntryDesktop) { desktop in
            PairingCodeSheet(
                title: "Pair with \(desktop.name)",
                desktopName: desktop.name,
                asksForAddress: false,
                lookUpName: nil
            ) { _, code in
                codeEntryDesktop = nil
                pair(with: desktop, code: code)
            }
            .presentationDetents([.medium])
        }
    }

    // MARK: Pieces

    private var header: some View {
        VStack(spacing: 14) {
            SHToolbarLogo()
                .scaleEffect(2.3)
                .frame(width: 72, height: 72)
            Text(isAdditional ? "Pair another machine" : "Pair with your desktop")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(SHColor.inkPrimary)
            Text("In Superharness on your desktop, open Settings → Mobile and choose Pair a phone.")
                .font(SHTypography.body)
                .foregroundStyle(SHColor.inkSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var scanButton: some View {
        Button {
            errorMessage = nil
            isScannerPresented = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 18, weight: .semibold))
                Text("Scan QR Code")
                    .font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(SHColor.surfaceRail)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(SHColor.inkPrimary, in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("pairing.scan")
    }

    private var nearbySection: some View {
        VStack(alignment: .leading, spacing: SHSpacing.sm) {
            Text("Nearby desktops")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(SHColor.inkMuted)
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                if browser.desktops.isEmpty {
                    HStack(spacing: 10) {
                        if browser.problem == nil {
                            SHActivityPulse(tint: SHColor.inkMuted, size: 16)
                        } else {
                            Image(systemName: "wifi.slash")
                                .foregroundStyle(SHColor.inkMuted)
                        }
                        Text(browser.problem ?? "Looking for desktops on this network…")
                            .font(SHTypography.caption)
                            .foregroundStyle(SHColor.inkMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(14)
                } else {
                    ForEach(Array(browser.desktops.enumerated()), id: \.element.id) { index, desktop in
                        if index > 0 {
                            Rectangle().fill(SHColor.lineHairline).frame(height: 1).padding(.leading, 48)
                        }
                        Button {
                            errorMessage = nil
                            codeEntryDesktop = desktop
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "desktopcomputer")
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundStyle(SHColor.inkSecondary)
                                    .frame(width: 22)
                                Text(desktop.name)
                                    .font(SHTypography.label)
                                    .foregroundStyle(SHColor.inkPrimary)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(SHColor.inkFaint)
                            }
                            .padding(.horizontal, 14)
                            .frame(height: 50)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("pairing.nearby.\(desktop.name)")
                    }
                }
            }
            .background(SHColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
        }
    }

    private var manualButton: some View {
        Button {
            errorMessage = nil
            isManualEntryPresented = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "keyboard")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(SHColor.inkSecondary)
                    .frame(width: 22)
                Text("Enter manually")
                    .font(SHTypography.label)
                    .foregroundStyle(SHColor.inkPrimary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SHColor.inkFaint)
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(SHColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: SHRadius.lg, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("pairing.manual")
    }

    private func banner(_ text: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(tint)
                .padding(.top, 1)
            Text(text)
                .font(SHTypography.caption)
                .foregroundStyle(SHColor.inkPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: SHRadius.md, style: .continuous))
    }

    // MARK: Actions

    private func handleScanned(_ raw: String) {
        switch PairingLink.parse(raw) {
        case .success(let link):
            startPairing(candidates: link.candidateBaseURLs, expectedHostId: link.hostId, code: link.code)
        case .failure(let error):
            errorMessage = error.errorDescription
        }
    }

    private func pair(with desktop: NearbyDesktop, code: String) {
        isWorking = true
        workingLabel = "Finding \(desktop.name)…"
        errorMessage = nil
        Task {
            let urls = await browser.baseURLs(for: desktop)
            guard !urls.isEmpty else {
                isWorking = false
                errorMessage = PairingError.unreachable.errorDescription
                return
            }
            await runPairing(candidates: urls, expectedHostId: desktop.hostId, code: code)
        }
    }

    private func startPairing(candidates: [URL], expectedHostId: String, code: String) {
        isWorking = true
        errorMessage = nil
        Task { await runPairing(candidates: candidates, expectedHostId: expectedHostId, code: code) }
    }

    private func runPairing(candidates: [URL], expectedHostId: String, code: String) async {
        isWorking = true
        workingLabel = "Pairing…"
        do {
            try await store.pair(candidates: candidates, expectedHostId: expectedHostId, code: code)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isWorking = false
    }
}

// MARK: - Code (and address) entry

/// Asks for the desktop's 6-digit code, and for its address when pairing by hand.
private struct PairingCodeSheet: View {
    let title: String
    let desktopName: String?
    let asksForAddress: Bool
    /// Asks the desktop at a typed address for its name, so the prompt can say what is being
    /// paired with. Nil when the name is already known.
    let lookUpName: ((URL) async -> String?)?
    let onSubmit: (_ address: String, _ code: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var foundName: String?
    @State private var isLookingUp = false
    @FocusState private var focus: Field?

    private enum Field { case address, code }

    private var normalizedCode: String { PairingLink.normalizedCode(code) }
    private var canSubmit: Bool {
        PairingLink.isValidCode(normalizedCode) && (!asksForAddress || PairingAddress.baseURL(from: address) != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                if asksForAddress {
                    Section {
                        TextField("mydesktop or 100.64.0.3", text: $address)
                            .font(SHTypography.mono)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .address)
                            .submitLabel(.next)
                            .onSubmit { focus = .code }
                            .accessibilityIdentifier("pairing.address")
                        if isLookingUp || foundName != nil {
                            HStack(spacing: 8) {
                                if let foundName {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(SHColor.statusSuccess)
                                    Text("Found \(foundName)")
                                        .font(SHTypography.caption)
                                        .foregroundStyle(SHColor.inkPrimary)
                                } else {
                                    SHActivityPulse(tint: SHColor.inkMuted, size: 16)
                                    Text("Looking for a desktop at this address…")
                                        .font(SHTypography.caption)
                                        .foregroundStyle(SHColor.inkMuted)
                                }
                            }
                            .accessibilityIdentifier("pairing.foundName")
                        }
                    } header: {
                        Text("Desktop address")
                    } footer: {
                        Text("The name or IP shown under Settings → Mobile on the desktop. The port is added for you.")
                            .foregroundStyle(SHColor.inkFaint)
                    }
                    .listRowBackground(SHColor.surfaceSubtle)
                    // Look the desktop up once typing pauses, so the prompt can name it.
                    .task(id: address) {
                        foundName = nil
                        guard let lookUpName, let url = PairingAddress.baseURL(from: address) else {
                            isLookingUp = false
                            return
                        }
                        try? await Task.sleep(nanoseconds: 600_000_000)
                        guard !Task.isCancelled else { return }
                        isLookingUp = true
                        let name = await lookUpName(url)
                        guard !Task.isCancelled else { return }
                        isLookingUp = false
                        foundName = (name?.isEmpty == false) ? name : nil
                    }
                }

                Section {
                    TextField("000000", text: $code)
                        .font(.system(size: 26, weight: .semibold, design: .monospaced))
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .multilineTextAlignment(.center)
                        .focused($focus, equals: .code)
                        .onChange(of: code) { _, newValue in
                            let digits = String(PairingLink.normalizedCode(newValue).prefix(6))
                            if digits != newValue { code = digits }
                        }
                        .accessibilityIdentifier("pairing.code")
                } header: {
                    Text((desktopName ?? foundName).map { "Code shown on \($0)" } ?? "6-digit code")
                } footer: {
                    Text("Shown under the QR code on the desktop. It works once and expires after 10 minutes.")
                        .foregroundStyle(SHColor.inkFaint)
                }
                .listRowBackground(SHColor.surfaceSubtle)
            }
            .scrollContentBackground(.hidden)
            .background(SHColor.surfaceCanvas)
            .tint(SHColor.inkPrimary)
            // Once the desktop at a typed address answers, the title names it.
            .navigationTitle(foundName.map { "Pair with \($0)" } ?? title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") { onSubmit(address, normalizedCode) }
                        .fontWeight(.semibold)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("pairing.submit")
                }
            }
            .onAppear { focus = asksForAddress ? .address : .code }
        }
    }
}

// MARK: - QR scanner

/// Camera sheet that reports the first QR code it reads.
private struct PairingScannerSheet: View {
    let onScanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if PairingScanner.isAvailable {
                    PairingScanner(onScanned: onScanned)
                        .ignoresSafeArea(edges: .bottom)
                        .overlay(alignment: .bottom) {
                            Text("Point the camera at the QR code on your desktop.")
                                .font(SHTypography.caption)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(.black.opacity(0.55), in: Capsule())
                                .padding(.bottom, 28)
                        }
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(SHColor.inkMuted)
                        Text("The camera isn’t available")
                            .font(SHTypography.heading)
                            .foregroundStyle(SHColor.inkPrimary)
                        Text("Allow camera access for Superharness in the Settings app, or go back and enter the code by hand.")
                            .font(SHTypography.caption)
                            .foregroundStyle(SHColor.inkMuted)
                            .multilineTextAlignment(.center)
                    }
                    .padding(32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(SHColor.surfaceCanvas)
                    .accessibilityIdentifier("pairing.scanner.unavailable")
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

#if canImport(VisionKit) && canImport(UIKit)
private struct PairingScanner: UIViewControllerRepresentable {
    let onScanned: (String) -> Void

    @MainActor static var isAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScanned: onScanned) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScanned: (String) -> Void
        private var hasReported = false

        init(onScanned: @escaping (String) -> Void) {
            self.onScanned = onScanned
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(addedItems, from: dataScanner)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(updatedItems, from: dataScanner)
        }

        private func report(_ items: [RecognizedItem], from scanner: DataScannerViewController) {
            guard !hasReported else { return }
            for item in items {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue, !payload.isEmpty {
                    hasReported = true
                    scanner.stopScanning()
                    onScanned(payload)
                    return
                }
            }
        }
    }
}
#else
private struct PairingScanner: View {
    let onScanned: (String) -> Void
    static var isAvailable: Bool { false }
    var body: some View { EmptyView() }
}
#endif
