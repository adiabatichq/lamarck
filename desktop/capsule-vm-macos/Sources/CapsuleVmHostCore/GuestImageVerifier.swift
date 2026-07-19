import CryptoKit
import Darwin
import Foundation

/// An immutable Guest image value whose initializer is confined to this
/// verifier file. VM configuration code accepts this type instead of raw paths.
public struct VerifiedGuestImage: Sendable {
    public let imageVersion: String
    public let supervisorVersion: String
    public let architecture: CapsuleGuestArchitecture
    public let imageDigest: String
    public let kernelURL: URL
    public let initialRamdiskURL: URL?
    public let rootfsURL: URL

    fileprivate init(
        imageVersion: String,
        supervisorVersion: String,
        architecture: CapsuleGuestArchitecture,
        imageDigest: String,
        kernelURL: URL,
        initialRamdiskURL: URL?,
        rootfsURL: URL
    ) {
        self.imageVersion = imageVersion
        self.supervisorVersion = supervisorVersion
        self.architecture = architecture
        self.imageDigest = imageDigest
        self.kernelURL = kernelURL
        self.initialRamdiskURL = initialRamdiskURL
        self.rootfsURL = rootfsURL
    }
}

public enum GuestImageVerificationError: Error, Equatable, CustomStringConvertible, Sendable {
    case invalidDescriptor(String)
    case manifestUnavailable
    case manifestTooLarge
    case manifestDigestMismatch
    case signatureUnavailable
    case invalidSignature
    case invalidManifest(String)
    case architectureMismatch(expected: CapsuleGuestArchitecture, actual: CapsuleGuestArchitecture)
    case duplicateArtifactRole(CapsuleGuestArtifactRole)
    case duplicateArtifactPath(String)
    case missingArtifact(CapsuleGuestArtifactRole)
    case invalidArtifactPath(String)
    case artifactUnavailable(String)
    case artifactNotRegular(String)
    case artifactSizeMismatch(String)
    case artifactHashMismatch(String)

    public var description: String {
        switch self {
        case .invalidDescriptor(let message):
            return "invalid Guest image descriptor: \(message)"
        case .manifestUnavailable:
            return "Guest image manifest is unavailable"
        case .manifestTooLarge:
            return "Guest image manifest exceeds the size limit"
        case .manifestDigestMismatch:
            return "Guest image manifest digest does not match trusted release metadata"
        case .signatureUnavailable:
            return "Guest image detached signature is unavailable"
        case .invalidSignature:
            return "Guest image manifest signature is invalid"
        case .invalidManifest(let message):
            return "invalid Guest image manifest: \(message)"
        case .architectureMismatch(let expected, let actual):
            return "Guest architecture \(actual.rawValue) does not match \(expected.rawValue)"
        case .duplicateArtifactRole(let role):
            return "Guest image contains duplicate \(role.rawValue) artifacts"
        case .duplicateArtifactPath(let path):
            return "Guest image contains duplicate artifact path \(path)"
        case .missingArtifact(let role):
            return "Guest image is missing required \(role.rawValue) artifact"
        case .invalidArtifactPath(let path):
            return "Guest image artifact path is invalid: \(path)"
        case .artifactUnavailable(let path):
            return "Guest image artifact is unavailable: \(path)"
        case .artifactNotRegular(let path):
            return "Guest image artifact is not a regular non-symlink file: \(path)"
        case .artifactSizeMismatch(let path):
            return "Guest image artifact size does not match its manifest: \(path)"
        case .artifactHashMismatch(let path):
            return "Guest image artifact hash does not match its manifest: \(path)"
        }
    }
}

public enum GuestImageVerifier {
    public static let manifestFileName = "manifest.json"
    public static let signatureFileName = "manifest.ed25519"

    private static let manifestSchemaVersion = 1
    private static let maximumManifestBytes = 1 * 1_024 * 1_024
    private static let maximumArtifactBytes: UInt64 = 128 * 1_024 * 1_024 * 1_024
    private static let hashChunkBytes = 1 * 1_024 * 1_024

    public static func verify(_ descriptor: TrustedGuestImageDescriptor) throws -> VerifiedGuestImage {
        guard descriptor.imageDirectoryURL.isFileURL,
              descriptor.imageDirectoryURL.path.hasPrefix("/") else {
            throw GuestImageVerificationError.invalidDescriptor(
                "image directory must be an absolute file URL"
            )
        }
        guard descriptor.expectedArchitecture == .currentHost else {
            throw GuestImageVerificationError.invalidDescriptor(
                "requested architecture does not match this Host"
            )
        }
        guard let expectedDigest = decodeSHA256(descriptor.expectedManifestDigest) else {
            throw GuestImageVerificationError.invalidDescriptor(
                "expected manifest digest must be lowercase sha256"
            )
        }
        guard descriptor.pinnedPublicKey.count == 32 else {
            throw GuestImageVerificationError.invalidDescriptor(
                "Ed25519 public key must contain 32 bytes"
            )
        }

        let rootURL = descriptor.imageDirectoryURL
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let rootDescriptor = try openRootDirectory(rootURL)
        defer { Darwin.close(rootDescriptor) }

        let manifestData: Data
        do {
            manifestData = try readRelativeRegularFile(
                rootDescriptor: rootDescriptor,
                relativePath: manifestFileName,
                maximumBytes: UInt64(maximumManifestBytes)
            )
        } catch let error as GuestImageVerificationError {
            switch error {
            case .artifactSizeMismatch:
                throw GuestImageVerificationError.manifestTooLarge
            default:
                throw GuestImageVerificationError.manifestUnavailable
            }
        } catch {
            throw GuestImageVerificationError.manifestUnavailable
        }

        let actualDigest = Data(SHA256.hash(data: manifestData))
        guard constantTimeEqual(actualDigest, expectedDigest) else {
            throw GuestImageVerificationError.manifestDigestMismatch
        }

        let signature: Data
        do {
            signature = try readRelativeRegularFile(
                rootDescriptor: rootDescriptor,
                relativePath: signatureFileName,
                maximumBytes: 64
            )
        } catch {
            throw GuestImageVerificationError.signatureUnavailable
        }
        guard signature.count == 64 else {
            throw GuestImageVerificationError.invalidSignature
        }

        let publicKey: Curve25519.Signing.PublicKey
        do {
            publicKey = try Curve25519.Signing.PublicKey(
                rawRepresentation: descriptor.pinnedPublicKey
            )
        } catch {
            throw GuestImageVerificationError.invalidDescriptor("invalid Ed25519 public key")
        }
        guard publicKey.isValidSignature(signature, for: manifestData) else {
            throw GuestImageVerificationError.invalidSignature
        }

        let manifest = try decodeExactManifest(manifestData)
        try validateManifestFields(manifest)
        guard manifest.architecture == descriptor.expectedArchitecture else {
            throw GuestImageVerificationError.architectureMismatch(
                expected: descriptor.expectedArchitecture,
                actual: manifest.architecture
            )
        }

        var artifactsByRole: [CapsuleGuestArtifactRole: URL] = [:]
        var artifactPaths = Set<String>()
        for artifact in manifest.artifacts {
            guard artifactsByRole[artifact.role] == nil else {
                throw GuestImageVerificationError.duplicateArtifactRole(artifact.role)
            }
            guard artifactPaths.insert(artifact.path).inserted else {
                throw GuestImageVerificationError.duplicateArtifactPath(artifact.path)
            }
            try validateRelativeArtifactPath(artifact.path)

            let file = try openRelativeFile(
                rootDescriptor: rootDescriptor,
                relativePath: artifact.path
            )
            defer { try? file.handle.close() }
            guard file.byteCount == artifact.size else {
                throw GuestImageVerificationError.artifactSizeMismatch(artifact.path)
            }
            let actualArtifactDigest = try hash(file.handle)
            guard let expectedArtifactDigest = decodeSHA256(artifact.sha256),
                  constantTimeEqual(actualArtifactDigest, expectedArtifactDigest) else {
                throw GuestImageVerificationError.artifactHashMismatch(artifact.path)
            }

            artifactsByRole[artifact.role] = rootURL.appendingPathComponent(
                artifact.path,
                isDirectory: false
            )
        }

        guard let kernelURL = artifactsByRole[.kernel] else {
            throw GuestImageVerificationError.missingArtifact(.kernel)
        }
        guard let rootfsURL = artifactsByRole[.rootfs] else {
            throw GuestImageVerificationError.missingArtifact(.rootfs)
        }

        return VerifiedGuestImage(
            imageVersion: manifest.imageVersion,
            supervisorVersion: manifest.supervisorVersion,
            architecture: manifest.architecture,
            imageDigest: descriptor.expectedManifestDigest,
            kernelURL: kernelURL,
            initialRamdiskURL: artifactsByRole[.initialRamdisk],
            rootfsURL: rootfsURL
        )
    }

    private static func decodeExactManifest(_ data: Data) throws -> CapsuleGuestImageManifest {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw GuestImageVerificationError.invalidManifest("manifest is not valid JSON")
        }
        guard let object = value as? [String: Any] else {
            throw GuestImageVerificationError.invalidManifest("top level must be an object")
        }
        try requireExactKeys(
            object,
            expected: [
                "schemaVersion",
                "imageVersion",
                "architecture",
                "supervisorVersion",
                "artifacts",
            ],
            path: "$"
        )
        guard let artifacts = object["artifacts"] as? [Any] else {
            throw GuestImageVerificationError.invalidManifest("$.artifacts must be an array")
        }
        for (index, value) in artifacts.enumerated() {
            guard let artifact = value as? [String: Any] else {
                throw GuestImageVerificationError.invalidManifest(
                    "$.artifacts[\(index)] must be an object"
                )
            }
            try requireExactKeys(
                artifact,
                expected: ["role", "path", "size", "sha256"],
                path: "$.artifacts[\(index)]"
            )
        }

        do {
            return try JSONDecoder().decode(CapsuleGuestImageManifest.self, from: data)
        } catch {
            throw GuestImageVerificationError.invalidManifest("manifest fields have invalid types")
        }
    }

    private static func validateManifestFields(_ manifest: CapsuleGuestImageManifest) throws {
        guard manifest.schemaVersion == manifestSchemaVersion else {
            throw GuestImageVerificationError.invalidManifest("unsupported schemaVersion")
        }
        guard isBoundedVersion(manifest.imageVersion) else {
            throw GuestImageVerificationError.invalidManifest("invalid imageVersion")
        }
        guard isBoundedVersion(manifest.supervisorVersion) else {
            throw GuestImageVerificationError.invalidManifest("invalid supervisorVersion")
        }
        guard (2...3).contains(manifest.artifacts.count) else {
            throw GuestImageVerificationError.invalidManifest(
                "artifacts must contain kernel, rootfs, and optionally initialRamdisk"
            )
        }
        for artifact in manifest.artifacts {
            guard artifact.size > 0, artifact.size <= maximumArtifactBytes else {
                throw GuestImageVerificationError.invalidManifest(
                    "artifact size is outside the supported range"
                )
            }
            guard decodeSHA256(artifact.sha256) != nil else {
                throw GuestImageVerificationError.invalidManifest(
                    "artifact sha256 must be lowercase"
                )
            }
        }
    }

    private static func requireExactKeys(
        _ object: [String: Any],
        expected: Set<String>,
        path: String
    ) throws {
        let actual = Set(object.keys)
        guard actual == expected else {
            let unknown = actual.subtracting(expected).sorted()
            let missing = expected.subtracting(actual).sorted()
            let detail = [
                unknown.isEmpty ? nil : "unknown: \(unknown.joined(separator: ","))",
                missing.isEmpty ? nil : "missing: \(missing.joined(separator: ","))",
            ].compactMap { $0 }.joined(separator: "; ")
            throw GuestImageVerificationError.invalidManifest("\(path) has \(detail)")
        }
    }

    private static func validateRelativeArtifactPath(_ path: String) throws {
        guard !path.isEmpty,
              path.utf8.count <= 1_024,
              !path.hasPrefix("/"),
              !path.contains("\\"),
              !path.contains("\0") else {
            throw GuestImageVerificationError.invalidArtifactPath(path)
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw GuestImageVerificationError.invalidArtifactPath(path)
        }
    }

    private static func openRootDirectory(_ url: URL) throws -> Int32 {
        let descriptor = Darwin.open(
            url.path,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
        )
        guard descriptor >= 0 else {
            throw GuestImageVerificationError.invalidDescriptor(
                "image directory is unavailable"
            )
        }
        return descriptor
    }

    private static func readRelativeRegularFile(
        rootDescriptor: Int32,
        relativePath: String,
        maximumBytes: UInt64
    ) throws -> Data {
        let file = try openRelativeFile(
            rootDescriptor: rootDescriptor,
            relativePath: relativePath
        )
        defer { try? file.handle.close() }
        guard file.byteCount <= maximumBytes else {
            throw GuestImageVerificationError.artifactSizeMismatch(relativePath)
        }
        let data = try file.handle.readToEnd() ?? Data()
        guard UInt64(data.count) == file.byteCount else {
            throw GuestImageVerificationError.artifactSizeMismatch(relativePath)
        }
        return data
    }

    private static func openRelativeFile(
        rootDescriptor: Int32,
        relativePath: String
    ) throws -> (handle: FileHandle, byteCount: UInt64) {
        try validateRelativeArtifactPath(relativePath)
        let components = relativePath.split(separator: "/").map(String.init)
        var directoryDescriptor = Darwin.dup(rootDescriptor)
        guard directoryDescriptor >= 0 else {
            throw GuestImageVerificationError.artifactUnavailable(relativePath)
        }
        defer {
            if directoryDescriptor >= 0 {
                Darwin.close(directoryDescriptor)
            }
        }

        for component in components.dropLast() {
            let nextDescriptor = component.withCString { name in
                Darwin.openat(
                    directoryDescriptor,
                    name,
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
                )
            }
            guard nextDescriptor >= 0 else {
                throw GuestImageVerificationError.artifactUnavailable(relativePath)
            }
            Darwin.close(directoryDescriptor)
            directoryDescriptor = nextDescriptor
        }

        guard let fileName = components.last else {
            throw GuestImageVerificationError.invalidArtifactPath(relativePath)
        }
        let fileDescriptor = fileName.withCString { name in
            Darwin.openat(
                directoryDescriptor,
                name,
                O_RDONLY | O_CLOEXEC | O_NOFOLLOW
            )
        }
        guard fileDescriptor >= 0 else {
            throw GuestImageVerificationError.artifactUnavailable(relativePath)
        }

        var metadata = stat()
        guard Darwin.fstat(fileDescriptor, &metadata) == 0 else {
            Darwin.close(fileDescriptor)
            throw GuestImageVerificationError.artifactUnavailable(relativePath)
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_size >= 0 else {
            Darwin.close(fileDescriptor)
            throw GuestImageVerificationError.artifactNotRegular(relativePath)
        }

        return (
            FileHandle(fileDescriptor: fileDescriptor, closeOnDealloc: true),
            UInt64(metadata.st_size)
        )
    }

    private static func hash(_ handle: FileHandle) throws -> Data {
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: hashChunkBytes), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return Data(hasher.finalize())
    }

    private static func decodeSHA256(_ value: String) -> Data? {
        guard value.count == 71, value.hasPrefix("sha256:") else { return nil }
        let hex = value.dropFirst(7)
        guard hex.allSatisfy({ $0.isNumber || ("a"..."f").contains(String($0)) }) else {
            return nil
        }
        var result = Data(capacity: 32)
        var index = hex.startIndex
        for _ in 0..<32 {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        return result
    }

    private static func constantTimeEqual(_ left: Data, _ right: Data) -> Bool {
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices {
            difference |= left[index] ^ right[index]
        }
        return difference == 0
    }

    private static func isBoundedVersion(_ value: String) -> Bool {
        guard (1...64).contains(value.utf8.count) else { return false }
        return value.allSatisfy {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "+")
        }
    }
}

func capsuleSHA256Digest(_ data: Data) -> String {
    "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
