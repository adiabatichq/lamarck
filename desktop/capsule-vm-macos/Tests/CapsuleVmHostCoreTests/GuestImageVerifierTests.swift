import CryptoKit
import Foundation
import Testing
@testable import CapsuleVmHostCore

@Test func verifiesSignedGuestImageWithOptionalRamdisk() throws {
    let fixture = try SignedGuestImageFixture()
    let descriptor = try fixture.install(fixture.standardManifest())

    let verified = try GuestImageVerifier.verify(descriptor)

    #expect(verified.architecture == .currentHost)
    #expect(verified.imageDigest == descriptor.expectedManifestDigest)
    #expect(verified.kernelURL.lastPathComponent == "kernel")
    #expect(verified.initialRamdiskURL?.lastPathComponent == "initramfs")
    #expect(verified.rootfsURL.lastPathComponent == "rootfs.raw")

    let withoutRamdisk = try SignedGuestImageFixture()
    let noRamdiskDescriptor = try withoutRamdisk.install(
        withoutRamdisk.standardManifest(includeInitialRamdisk: false)
    )
    #expect(try GuestImageVerifier.verify(noRamdiskDescriptor).initialRamdiskURL == nil)
}

@Test func requiresExactManifestDigestAndPinnedSignature() throws {
    let fixture = try SignedGuestImageFixture()
    let descriptor = try fixture.install(fixture.standardManifest())
    let manifestData = try Data(
        contentsOf: fixture.directoryURL.appendingPathComponent(GuestImageVerifier.manifestFileName)
    )

    expectVerificationError(.manifestDigestMismatch) {
        try GuestImageVerifier.verify(fixture.descriptor(
            manifestData: manifestData,
            expectedDigest: "sha256:" + String(repeating: "0", count: 64)
        ))
    }

    let anotherKey = Curve25519.Signing.PrivateKey()
    expectVerificationError(.invalidSignature) {
        try GuestImageVerifier.verify(fixture.descriptor(
            manifestData: manifestData,
            publicKey: anotherKey.publicKey.rawRepresentation
        ))
    }

    try FileManager.default.removeItem(
        at: fixture.directoryURL.appendingPathComponent(GuestImageVerifier.signatureFileName)
    )
    expectVerificationError(.signatureUnavailable) {
        try GuestImageVerifier.verify(descriptor)
    }
}

@Test func rejectsUnknownManifestFieldsAndWrongArchitecture() throws {
    let fixture = try SignedGuestImageFixture()
    let manifest = try fixture.standardManifest()
    let encoder = JSONEncoder()
    let encoded = try encoder.encode(manifest)
    var object = try #require(
        JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    object["unsignedExtension"] = true
    let withUnknownField = try JSONSerialization.data(
        withJSONObject: object,
        options: [.sortedKeys]
    )
    let unknownDescriptor = try fixture.installRawManifest(withUnknownField)
    expectVerificationError(
        .invalidManifest("$ has unknown: unsignedExtension")
    ) {
        try GuestImageVerifier.verify(unknownDescriptor)
    }

    let wrongFixture = try SignedGuestImageFixture()
    let wrongManifest = CapsuleGuestImageManifest(
        schemaVersion: manifest.schemaVersion,
        imageVersion: manifest.imageVersion,
        architecture: oppositeArchitecture(),
        supervisorVersion: manifest.supervisorVersion,
        artifacts: try wrongFixture.standardManifest().artifacts
    )
    let wrongDescriptor = try wrongFixture.install(wrongManifest)
    expectVerificationError(
        .architectureMismatch(expected: .currentHost, actual: oppositeArchitecture())
    ) {
        try GuestImageVerifier.verify(wrongDescriptor)
    }
}

@Test func rejectsDuplicateAndMissingArtifactRoles() throws {
    let fixture = try SignedGuestImageFixture()
    let manifest = try fixture.standardManifest(includeInitialRamdisk: false)
    let kernel = try #require(manifest.artifacts.first { $0.role == .kernel })
    let duplicateManifest = CapsuleGuestImageManifest(
        schemaVersion: manifest.schemaVersion,
        imageVersion: manifest.imageVersion,
        architecture: manifest.architecture,
        supervisorVersion: manifest.supervisorVersion,
        artifacts: manifest.artifacts + [kernel]
    )
    let duplicateDescriptor = try fixture.install(duplicateManifest)
    expectVerificationError(.duplicateArtifactRole(.kernel)) {
        try GuestImageVerifier.verify(duplicateDescriptor)
    }

    let missingFixture = try SignedGuestImageFixture()
    let complete = try missingFixture.standardManifest(includeInitialRamdisk: true)
    let missingRoot = CapsuleGuestImageManifest(
        schemaVersion: complete.schemaVersion,
        imageVersion: complete.imageVersion,
        architecture: complete.architecture,
        supervisorVersion: complete.supervisorVersion,
        artifacts: complete.artifacts.filter { $0.role != .rootfs }
    )
    let missingDescriptor = try missingFixture.install(missingRoot)
    expectVerificationError(.missingArtifact(.rootfs)) {
        try GuestImageVerifier.verify(missingDescriptor)
    }
}

@Test func rejectsTraversalSymlinksAndNonRegularArtifacts() throws {
    let traversalFixture = try SignedGuestImageFixture()
    let standard = try traversalFixture.standardManifest(includeInitialRamdisk: false)
    let kernel = try #require(standard.artifacts.first { $0.role == .kernel })
    let rootfs = try #require(standard.artifacts.first { $0.role == .rootfs })
    let traversalManifest = CapsuleGuestImageManifest(
        schemaVersion: 1,
        imageVersion: standard.imageVersion,
        architecture: .currentHost,
        supervisorVersion: standard.supervisorVersion,
        artifacts: [
            CapsuleGuestArtifactManifest(
                role: .kernel,
                path: "../kernel",
                size: kernel.size,
                sha256: kernel.sha256
            ),
            rootfs,
        ]
    )
    let traversalDescriptor = try traversalFixture.install(traversalManifest)
    expectVerificationError(.invalidArtifactPath("../kernel")) {
        try GuestImageVerifier.verify(traversalDescriptor)
    }

    let symlinkFixture = try SignedGuestImageFixture()
    let symlinkStandard = try symlinkFixture.standardManifest(includeInitialRamdisk: false)
    let symlinkRoot = try #require(symlinkStandard.artifacts.first { $0.role == .rootfs })
    let targetData = Data("linked-kernel".utf8)
    let targetURL = symlinkFixture.directoryURL.appendingPathComponent("target-kernel")
    try targetData.write(to: targetURL)
    let linkURL = symlinkFixture.directoryURL.appendingPathComponent("kernel-link")
    try FileManager.default.createSymbolicLink(at: linkURL, withDestinationURL: targetURL)
    let symlinkManifest = CapsuleGuestImageManifest(
        schemaVersion: 1,
        imageVersion: symlinkStandard.imageVersion,
        architecture: .currentHost,
        supervisorVersion: symlinkStandard.supervisorVersion,
        artifacts: [
            CapsuleGuestArtifactManifest(
                role: .kernel,
                path: "kernel-link",
                size: UInt64(targetData.count),
                sha256: capsuleSHA256Digest(targetData)
            ),
            symlinkRoot,
        ]
    )
    let symlinkDescriptor = try symlinkFixture.install(symlinkManifest)
    expectVerificationError(.artifactUnavailable("kernel-link")) {
        try GuestImageVerifier.verify(symlinkDescriptor)
    }

    let directoryFixture = try SignedGuestImageFixture()
    let directoryStandard = try directoryFixture.standardManifest(includeInitialRamdisk: false)
    let directoryRoot = try #require(directoryStandard.artifacts.first { $0.role == .rootfs })
    try FileManager.default.createDirectory(
        at: directoryFixture.directoryURL.appendingPathComponent("kernel-directory"),
        withIntermediateDirectories: false
    )
    let directoryManifest = CapsuleGuestImageManifest(
        schemaVersion: 1,
        imageVersion: directoryStandard.imageVersion,
        architecture: .currentHost,
        supervisorVersion: directoryStandard.supervisorVersion,
        artifacts: [
            CapsuleGuestArtifactManifest(
                role: .kernel,
                path: "kernel-directory",
                size: 1,
                sha256: capsuleSHA256Digest(Data([0]))
            ),
            directoryRoot,
        ]
    )
    let directoryDescriptor = try directoryFixture.install(directoryManifest)
    expectVerificationError(.artifactNotRegular("kernel-directory")) {
        try GuestImageVerifier.verify(directoryDescriptor)
    }
}

@Test func rejectsArtifactSizeAndHashMismatches() throws {
    let sizeFixture = try SignedGuestImageFixture()
    let standard = try sizeFixture.standardManifest(includeInitialRamdisk: false)
    let kernel = try #require(standard.artifacts.first { $0.role == .kernel })
    let rootfs = try #require(standard.artifacts.first { $0.role == .rootfs })
    let wrongSize = CapsuleGuestImageManifest(
        schemaVersion: 1,
        imageVersion: standard.imageVersion,
        architecture: .currentHost,
        supervisorVersion: standard.supervisorVersion,
        artifacts: [
            CapsuleGuestArtifactManifest(
                role: .kernel,
                path: kernel.path,
                size: kernel.size + 1,
                sha256: kernel.sha256
            ),
            rootfs,
        ]
    )
    expectVerificationError(.artifactSizeMismatch(kernel.path)) {
        try GuestImageVerifier.verify(try sizeFixture.install(wrongSize))
    }

    let hashFixture = try SignedGuestImageFixture()
    let hashStandard = try hashFixture.standardManifest(includeInitialRamdisk: false)
    let hashKernel = try #require(hashStandard.artifacts.first { $0.role == .kernel })
    let hashRoot = try #require(hashStandard.artifacts.first { $0.role == .rootfs })
    let wrongHash = CapsuleGuestImageManifest(
        schemaVersion: 1,
        imageVersion: hashStandard.imageVersion,
        architecture: .currentHost,
        supervisorVersion: hashStandard.supervisorVersion,
        artifacts: [
            CapsuleGuestArtifactManifest(
                role: .kernel,
                path: hashKernel.path,
                size: hashKernel.size,
                sha256: "sha256:" + String(repeating: "0", count: 64)
            ),
            hashRoot,
        ]
    )
    expectVerificationError(.artifactHashMismatch(hashKernel.path)) {
        try GuestImageVerifier.verify(try hashFixture.install(wrongHash))
    }
}

private func expectVerificationError(
    _ expected: GuestImageVerificationError,
    operation: () throws -> VerifiedGuestImage
) {
    do {
        _ = try operation()
        Issue.record("Expected GuestImageVerificationError \(expected)")
    } catch let error as GuestImageVerificationError {
        #expect(error == expected)
    } catch {
        Issue.record("Unexpected error: \(error)")
    }
}
