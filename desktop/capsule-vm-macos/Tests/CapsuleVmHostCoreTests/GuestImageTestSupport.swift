import CryptoKit
import Foundation
@testable import CapsuleVmHostCore

final class SignedGuestImageFixture {
    let directoryURL: URL
    let privateKey: Curve25519.Signing.PrivateKey

    init() throws {
        directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        privateKey = Curve25519.Signing.PrivateKey()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
    }

    deinit {
        try? FileManager.default.removeItem(at: directoryURL)
    }

    func writeArtifact(path: String, data: Data) throws -> CapsuleGuestArtifactManifest {
        let url = directoryURL.appendingPathComponent(path, isDirectory: false)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: url)
        return CapsuleGuestArtifactManifest(
            role: .kernel,
            path: path,
            size: UInt64(data.count),
            sha256: capsuleSHA256Digest(data)
        )
    }

    func standardManifest(includeInitialRamdisk: Bool = true) throws -> CapsuleGuestImageManifest {
        var kernel = try writeArtifact(path: "boot/kernel", data: Data("kernel".utf8))
        kernel = CapsuleGuestArtifactManifest(
            role: .kernel,
            path: kernel.path,
            size: kernel.size,
            sha256: kernel.sha256
        )
        var rootfs = try writeArtifact(
            path: "rootfs.raw",
            data: Data(repeating: 0x52, count: 4_096)
        )
        rootfs = CapsuleGuestArtifactManifest(
            role: .rootfs,
            path: rootfs.path,
            size: rootfs.size,
            sha256: rootfs.sha256
        )
        var artifacts = [kernel, rootfs]
        if includeInitialRamdisk {
            var ramdisk = try writeArtifact(
                path: "boot/initramfs",
                data: Data("ramdisk".utf8)
            )
            ramdisk = CapsuleGuestArtifactManifest(
                role: .initialRamdisk,
                path: ramdisk.path,
                size: ramdisk.size,
                sha256: ramdisk.sha256
            )
            artifacts.append(ramdisk)
        }
        return CapsuleGuestImageManifest(
            schemaVersion: 1,
            imageVersion: "2026.07.14-test",
            architecture: .currentHost,
            supervisorVersion: "0.1.0",
            artifacts: artifacts
        )
    }

    func install(
        _ manifest: CapsuleGuestImageManifest,
        signingKey: Curve25519.Signing.PrivateKey? = nil
    ) throws -> TrustedGuestImageDescriptor {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let manifestData = try encoder.encode(manifest)
        return try installRawManifest(manifestData, signingKey: signingKey)
    }

    func installRawManifest(
        _ manifestData: Data,
        signingKey: Curve25519.Signing.PrivateKey? = nil
    ) throws -> TrustedGuestImageDescriptor {
        let key = signingKey ?? privateKey
        try manifestData.write(
            to: directoryURL.appendingPathComponent(GuestImageVerifier.manifestFileName)
        )
        try key.signature(for: manifestData).write(
            to: directoryURL.appendingPathComponent(GuestImageVerifier.signatureFileName)
        )
        return descriptor(manifestData: manifestData)
    }

    func descriptor(
        manifestData: Data,
        publicKey: Data? = nil,
        expectedDigest: String? = nil,
        expectedArchitecture: CapsuleGuestArchitecture = .currentHost
    ) -> TrustedGuestImageDescriptor {
        TrustedGuestImageDescriptor(
            imageDirectoryURL: directoryURL,
            expectedManifestDigest: expectedDigest ?? capsuleSHA256Digest(manifestData),
            expectedArchitecture: expectedArchitecture,
            pinnedPublicKey: publicKey ?? privateKey.publicKey.rawRepresentation
        )
    }
}

func oppositeArchitecture() -> CapsuleGuestArchitecture {
    CapsuleGuestArchitecture.currentHost == .arm64 ? .x64 : .arm64
}
