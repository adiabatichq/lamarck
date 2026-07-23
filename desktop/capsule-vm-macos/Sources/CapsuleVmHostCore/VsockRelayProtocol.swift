import Foundation

/// Private framing for one Guest relay connection over virtio-vsock.
///
/// LCVM remains the multiplexed Electron↔Swift protocol and the only layer
/// with explicit flow-control credit. LVRM records make directional
/// termination unambiguous on the VZ socket without carrying any caller-
/// selected stream or App identity.
enum CapsuleVmRelayProtocol {
    static let magic = Data([0x4c, 0x56, 0x52, 0x4d]) // LVRM
    static let version: UInt16 = 2
    static let headerByteCount = 12
    static let maximumDataByteCount = CapsuleVmProtocol.streamChunkByteCount
    static let maximumFrameByteCount = headerByteCount + maximumDataByteCount
}

enum CapsuleVmRelayFrameKind: UInt16, Sendable {
    case data = 1
    case fin = 2
    case reset = 3
    case close = 4
}

struct CapsuleVmRelayFrame: Equatable, Sendable {
    let kind: CapsuleVmRelayFrameKind
    let payload: Data

    init(kind: CapsuleVmRelayFrameKind, payload: Data = Data()) {
        self.kind = kind
        self.payload = payload
    }
}

enum CapsuleVmRelayFrameCodec {
    static func decodeHeader(
        from data: Data
    ) throws -> (kind: CapsuleVmRelayFrameKind, payloadByteCount: Int) {
        guard data.count >= CapsuleVmRelayProtocol.headerByteCount else {
            throw CapsuleVmProtocolError(
                code: "truncated_vsock_relay_header",
                message: "Virtio-vsock relay record header is incomplete"
            )
        }
        guard data.prefix(CapsuleVmRelayProtocol.magic.count)
                == CapsuleVmRelayProtocol.magic else {
            throw CapsuleVmProtocolError(
                code: "invalid_vsock_relay_magic",
                message: "Virtio-vsock relay record magic is not LVRM"
            )
        }

        let version = readUInt16(data, offset: 4)
        guard version == CapsuleVmRelayProtocol.version else {
            throw CapsuleVmProtocolError(
                code: "unsupported_vsock_relay_version",
                message: "Unsupported virtio-vsock relay version \(version)"
            )
        }
        let rawKind = readUInt16(data, offset: 6)
        guard let kind = CapsuleVmRelayFrameKind(rawValue: rawKind) else {
            throw CapsuleVmProtocolError(
                code: "invalid_vsock_relay_kind",
                message: "Unknown virtio-vsock relay record kind \(rawKind)"
            )
        }

        let payloadByteCount = Int(readUInt32(data, offset: 8))
        switch kind {
        case .data:
            guard payloadByteCount > 0,
                  payloadByteCount <= CapsuleVmRelayProtocol.maximumDataByteCount else {
                throw CapsuleVmProtocolError(
                    code: "invalid_vsock_relay_data",
                    message: "LVRM DATA payload length is outside policy"
                )
            }
        case .fin, .reset, .close:
            guard payloadByteCount == 0 else {
                throw CapsuleVmProtocolError(
                    code: "invalid_vsock_relay_terminal",
                    message: "LVRM terminal records must have an empty payload"
                )
            }
        }
        return (kind, payloadByteCount)
    }

    static func validate(_ frame: CapsuleVmRelayFrame) throws {
        switch frame.kind {
        case .data:
            guard !frame.payload.isEmpty,
                  frame.payload.count <= CapsuleVmRelayProtocol.maximumDataByteCount else {
                throw CapsuleVmProtocolError(
                    code: "invalid_vsock_relay_data",
                    message: "LVRM DATA payload must be between 1 and \(CapsuleVmRelayProtocol.maximumDataByteCount) bytes"
                )
            }
        case .fin, .reset, .close:
            guard frame.payload.isEmpty else {
                throw CapsuleVmProtocolError(
                    code: "invalid_vsock_relay_terminal",
                    message: "LVRM \(frame.kind) payload must be empty"
                )
            }
        }
    }

    static func encode(_ frame: CapsuleVmRelayFrame) throws -> Data {
        try validate(frame)
        var encoded = Data(
            capacity: CapsuleVmRelayProtocol.headerByteCount + frame.payload.count
        )
        encoded.append(CapsuleVmRelayProtocol.magic)
        append(CapsuleVmRelayProtocol.version, to: &encoded)
        append(frame.kind.rawValue, to: &encoded)
        append(UInt32(frame.payload.count), to: &encoded)
        encoded.append(frame.payload)
        return encoded
    }

    static func decodeOne(
        from data: Data
    ) throws -> (frame: CapsuleVmRelayFrame, consumed: Int)? {
        guard data.count >= CapsuleVmRelayProtocol.headerByteCount else {
            return nil
        }
        let header = try decodeHeader(from: data)

        let frameByteCount =
            CapsuleVmRelayProtocol.headerByteCount + header.payloadByteCount
        guard data.count >= frameByteCount else { return nil }
        let payload = data.subdata(
            in: CapsuleVmRelayProtocol.headerByteCount..<frameByteCount
        )
        let frame = CapsuleVmRelayFrame(kind: header.kind, payload: payload)
        try validate(frame)
        return (frame, frameByteCount)
    }

    private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var bigEndian = value.bigEndian
        withUnsafeBytes(of: &bigEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }

    private static func readUInt16(_ data: Data, offset: Int) -> UInt16 {
        let first = UInt16(data[data.startIndex + offset])
        let second = UInt16(data[data.startIndex + offset + 1])
        return (first << 8) | second
    }

    private static func readUInt32(_ data: Data, offset: Int) -> UInt32 {
        let first = UInt32(data[data.startIndex + offset])
        let second = UInt32(data[data.startIndex + offset + 1])
        let third = UInt32(data[data.startIndex + offset + 2])
        let fourth = UInt32(data[data.startIndex + offset + 3])
        return (first << 24) | (second << 16) | (third << 8) | fourth
    }
}
