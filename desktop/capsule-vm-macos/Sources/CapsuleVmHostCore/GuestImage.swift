import Foundation

public enum CapsuleGuestArchitecture: String, Codable, CaseIterable, Sendable {
    case arm64
    case x64

    public static var currentHost: CapsuleGuestArchitecture {
        #if arch(arm64)
        return .arm64
        #elseif arch(x86_64)
        return .x64
        #else
        fatalError("Unsupported Capsule VM host architecture")
        #endif
    }
}

public enum CapsuleGuestArtifactRole: String, Codable, CaseIterable, Sendable {
    case kernel
    case initialRamdisk
    case rootfs
}

/// The exact signed JSON payload stored as `manifest.json` in a Guest image bundle.
///
/// Unknown JSON fields are rejected by `GuestImageVerifier`. The detached Ed25519
/// signature in `manifest.ed25519` covers the exact bytes of this JSON file.
public struct CapsuleGuestImageManifest: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let imageVersion: String
    public let architecture: CapsuleGuestArchitecture
    public let supervisorVersion: String
    public let artifacts: [CapsuleGuestArtifactManifest]
}

public struct CapsuleGuestArtifactManifest: Codable, Equatable, Sendable {
    public let role: CapsuleGuestArtifactRole
    public let path: String
    public let size: UInt64
    public let sha256: String
}

/// Host-owned inputs needed to authenticate one Guest image bundle.
///
/// There is deliberately no unsigned mode. The caller must supply both the
/// release-pinned Ed25519 public key and the exact expected manifest digest from
/// trusted Host release metadata.
public struct TrustedGuestImageDescriptor: Sendable {
    public let imageDirectoryURL: URL
    public let expectedManifestDigest: String
    public let expectedArchitecture: CapsuleGuestArchitecture
    public let pinnedPublicKey: Data

    public init(
        imageDirectoryURL: URL,
        expectedManifestDigest: String,
        expectedArchitecture: CapsuleGuestArchitecture,
        pinnedPublicKey: Data
    ) {
        self.imageDirectoryURL = imageDirectoryURL
        self.expectedManifestDigest = expectedManifestDigest
        self.expectedArchitecture = expectedArchitecture
        self.pinnedPublicKey = pinnedPublicKey
    }
}
