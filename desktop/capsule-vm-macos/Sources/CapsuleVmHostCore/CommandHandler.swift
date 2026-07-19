import Foundation
import Virtualization

public struct CapsuleVmCommandError: Error, Equatable, CustomStringConvertible, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }
}

/// Stateful command boundary between Electron and the entitlement-bearing VZ
/// helper. Request identity occupies the low stream-ID half; Guest byte streams
/// occupy the high half and are delegated to the active VM session.
public final class CapsuleVmCommandService: @unchecked Sendable {
    private let session: CapsuleVmSessionControlling
    private let emitter: CapsuleVmFrameEmitter
    private let onFatalError: @Sendable (Error) -> Void
    private let lock = NSLock()
    private var pendingRequestIDs = Set<UInt32>()
    private var shuttingDown = false

    public init(
        session: CapsuleVmSessionControlling,
        emitter: CapsuleVmFrameEmitter,
        onFatalError: @escaping @Sendable (Error) -> Void = { _ in }
    ) {
        self.session = session
        self.emitter = emitter
        self.onFatalError = onFatalError
    }

    public func accept(_ frame: CapsuleVmFrame) throws {
        lock.lock()
        let isShuttingDown = shuttingDown
        lock.unlock()
        guard !isShuttingDown else {
            throw CapsuleVmCommandError(code: "helper_shutting_down", message: "VM helper is shutting down")
        }

        switch frame.kind {
        case .request:
            try acceptRequest(frame)
        case .streamData, .streamEnd:
            guard CapsuleVmProtocol.isHelperStreamID(frame.streamID) else {
                throw CapsuleVmProtocolError(
                    code: "invalid_stream_id",
                    message: "Host stream frame did not use a helper-originated stream ID"
                )
            }
            if frame.kind == .streamData,
               frame.payload.count > CapsuleVmProtocol.streamChunkByteCount {
                throw CapsuleVmStreamMuxError.chunkTooLarge(frame.payload.count)
            }
            if frame.kind == .streamEnd, frame.payload.count > 4 * 1_024 {
                throw CapsuleVmProtocolError(
                    code: "invalid_stream_end",
                    message: "Host stream end payload exceeds its bounded limit"
                )
            }
            try session.acceptHostStreamFrame(frame)
        case .response, .event:
            throw CapsuleVmProtocolError(
                code: "unexpected_frame_kind",
                message: "Host may send request, streamData, or streamEnd frames only"
            )
        }
    }

    public func shutdown(completion: @escaping @Sendable () -> Void) {
        lock.lock()
        if shuttingDown {
            lock.unlock()
            completion()
            return
        }
        shuttingDown = true
        pendingRequestIDs.removeAll()
        lock.unlock()

        session.stop { _ in completion() }
    }

    private func acceptRequest(_ frame: CapsuleVmFrame) throws {
        guard CapsuleVmProtocol.isRequestStreamID(frame.streamID) else {
            throw CapsuleVmProtocolError(
                code: "invalid_stream_id",
                message: "Request did not use a Host request stream ID"
            )
        }
        try beginRequest(frame.streamID)

        do {
            let request = try parseRequest(frame.payload)
            switch request.method {
            case "probe":
                guard request.params == nil else {
                    throw CapsuleVmCommandError(
                        code: "invalid_request",
                        message: "probe does not accept params"
                    )
                }
                respondSuccess(
                    streamID: frame.streamID,
                    result: [
                        "protocolVersion": Int(CapsuleVmProtocol.version),
                        "hostArchitecture": hostArchitecture,
                        "virtualizationSupported": VZVirtualMachine.isSupported,
                    ]
                )

            case "start":
                guard let params = request.params else {
                    throw CapsuleVmCommandError(
                        code: "guest_image_required",
                        message: "Starting the Capsule VM requires a complete signed Guest descriptor"
                    )
                }
                let descriptor = try parseStartDescriptor(params)
                session.start(descriptor: descriptor) { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success(let guest):
                        self.respondSuccess(
                            streamID: frame.streamID,
                            result: [
                                "protocolVersion": Int(CapsuleVmProtocol.version),
                                "state": "running",
                                "imageDigest": guest.imageDigest,
                                "architecture": guest.architecture == .arm64 ? "arm64" : "x86_64",
                            ]
                        )
                    case .failure(let error):
                        self.respondFailure(streamID: frame.streamID, error: error)
                    }
                }

            case "stop":
                guard request.params == nil else {
                    throw CapsuleVmCommandError(
                        code: "invalid_request",
                        message: "stop does not accept params"
                    )
                }
                session.stop { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.respondSuccess(
                            streamID: frame.streamID,
                            result: ["state": "stopped"]
                        )
                    case .failure(let error):
                        self.respondFailure(streamID: frame.streamID, error: error)
                    }
                }

            default:
                throw CapsuleVmCommandError(
                    code: "unsupported_method",
                    message: "Unsupported helper method \(request.method)"
                )
            }
        } catch {
            respondFailure(streamID: frame.streamID, error: error)
        }
    }

    private func beginRequest(_ streamID: UInt32) throws {
        lock.lock()
        defer { lock.unlock() }
        guard pendingRequestIDs.insert(streamID).inserted else {
            throw CapsuleVmProtocolError(
                code: "duplicate_stream_id",
                message: "Request reused pending stream ID \(streamID)"
            )
        }
    }

    private func respondSuccess(streamID: UInt32, result: Any) {
        respond(
            streamID: streamID,
            object: ["ok": true, "result": result]
        )
    }

    private func respondFailure(streamID: UInt32, error: Error) {
        let commandError = mapError(error)
        respond(
            streamID: streamID,
            object: [
                "ok": false,
                "error": ["code": commandError.code, "message": commandError.message],
            ]
        )
    }

    private func respond(streamID: UInt32, object: [String: Any]) {
        lock.lock()
        let shouldRespond = !shuttingDown && pendingRequestIDs.remove(streamID) != nil
        lock.unlock()
        guard shouldRespond else { return }

        do {
            let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            emitter.emit(
                CapsuleVmFrame(kind: .response, streamID: streamID, payload: payload)
            ) { [onFatalError] result in
                if case .failure(let error) = result { onFatalError(error) }
            }
        } catch {
            onFatalError(error)
        }
    }

    private func parseRequest(_ payload: Data) throws -> (method: String, params: [String: Any]?) {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: payload)
        } catch {
            throw CapsuleVmCommandError(code: "invalid_request", message: "Request is not valid JSON")
        }
        guard let object = value as? [String: Any] else {
            throw CapsuleVmCommandError(code: "invalid_request", message: "Request must be an object")
        }
        let keys = Set(object.keys)
        guard keys == ["method"] || keys == ["method", "params"] else {
            throw CapsuleVmCommandError(
                code: "invalid_request",
                message: "Request contains unknown or missing fields"
            )
        }
        guard let method = object["method"] as? String,
              !method.isEmpty,
              method.utf8.count <= 64 else {
            throw CapsuleVmCommandError(
                code: "invalid_request",
                message: "Request method must be a bounded nonempty string"
            )
        }
        if keys.contains("params") {
            guard let params = object["params"] as? [String: Any] else {
                throw CapsuleVmCommandError(code: "invalid_request", message: "params must be an object")
            }
            return (method, params)
        }
        return (method, nil)
    }

    private func parseStartDescriptor(_ params: [String: Any]) throws -> CapsuleVmStartDescriptor {
        let expectedKeys: Set<String> = [
            "imageBundlePath",
            "stateDirectory",
            "expectedManifestDigest",
            "manifestPublicKey",
            "cpuCount",
            "memorySizeBytes",
        ]
        guard Set(params.keys) == expectedKeys else {
            throw CapsuleVmCommandError(
                code: "guest_image_required",
                message: "Signed Guest descriptor contains unknown or missing fields"
            )
        }
        guard let imagePath = absolutePath(params["imageBundlePath"]),
              let statePath = absolutePath(params["stateDirectory"]) else {
            throw CapsuleVmCommandError(
                code: "guest_image_required",
                message: "Guest image and state paths must be absolute"
            )
        }
        guard let digest = params["expectedManifestDigest"] as? String,
              isLowercaseSHA256(digest) else {
            throw CapsuleVmCommandError(
                code: "guest_image_required",
                message: "Expected manifest digest must be lowercase sha256"
            )
        }
        guard let encodedKey = params["manifestPublicKey"] as? String,
              let publicKey = Data(base64Encoded: encodedKey),
              publicKey.count == 32,
              publicKey.base64EncodedString() == encodedKey else {
            throw CapsuleVmCommandError(
                code: "guest_image_required",
                message: "Manifest public key must be canonical base64 Ed25519"
            )
        }
        guard let cpuCount = exactInt(params["cpuCount"]),
              let memorySize = exactUInt64(params["memorySizeBytes"]) else {
            throw CapsuleVmCommandError(
                code: "guest_image_required",
                message: "VM resources must be exact integers"
            )
        }

        return CapsuleVmStartDescriptor(
            trustedImage: TrustedGuestImageDescriptor(
                imageDirectoryURL: URL(fileURLWithPath: imagePath, isDirectory: true),
                expectedManifestDigest: digest,
                expectedArchitecture: .currentHost,
                pinnedPublicKey: publicKey
            ),
            stateDirectoryURL: URL(fileURLWithPath: statePath, isDirectory: true),
            cpuCount: cpuCount,
            memorySize: memorySize
        )
    }

    private var hostArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }
}

private func mapError(_ error: Error) -> CapsuleVmCommandError {
    if let error = error as? CapsuleVmCommandError { return error }
    if let error = error as? GuestImageVerificationError {
        return CapsuleVmCommandError(
            code: "guest_image_verification_failed",
            message: error.description
        )
    }
    if let error = error as? CapsuleVmConfigurationError {
        return CapsuleVmCommandError(code: "invalid_vm_configuration", message: error.description)
    }
    if let error = error as? CapsuleVmStateDiskError {
        return CapsuleVmCommandError(code: "state_disk_unavailable", message: error.description)
    }
    if let error = error as? CapsuleVmLifecycleError {
        let code: String
        switch error {
        case .virtualizationUnavailable:
            code = "virtualization_unavailable"
        case .startCancelled:
            code = "start_cancelled"
        default:
            code = "invalid_vm_state"
        }
        return CapsuleVmCommandError(code: code, message: error.description)
    }
    if let error = error as? CapsuleVmStreamMuxError {
        return CapsuleVmCommandError(code: "stream_protocol_error", message: error.description)
    }
    return CapsuleVmCommandError(code: "vm_operation_failed", message: String(describing: error))
}

private func absolutePath(_ value: Any?) -> String? {
    guard let path = value as? String,
          path.hasPrefix("/"),
          !path.contains("\0"),
          path.utf8.count <= 4 * 1_024 else { return nil }
    return path
}

private func isLowercaseSHA256(_ value: String) -> Bool {
    guard value.utf8.count == 71, value.hasPrefix("sha256:") else { return false }
    return value.dropFirst(7).allSatisfy { character in
        character.isNumber || ("a"..."f").contains(character)
    }
}

private func exactInt(_ value: Any?) -> Int? {
    guard !(value is Bool), let number = value as? NSNumber else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded(.towardZero) == double,
          double >= Double(Int.min), double <= Double(Int.max) else { return nil }
    return Int(double)
}

private func exactUInt64(_ value: Any?) -> UInt64? {
    guard !(value is Bool), let number = value as? NSNumber else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded(.towardZero) == double,
          double >= 0, double <= Double(UInt64.max) else { return nil }
    return UInt64(double)
}
