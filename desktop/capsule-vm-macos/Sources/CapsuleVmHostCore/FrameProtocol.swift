import Darwin
import Foundation

public enum CapsuleVmProtocol {
    public static let magic = Data([0x4c, 0x43, 0x56, 0x4d]) // LCVM
    public static let version: UInt16 = 2
    public static let headerByteCount = 16
    public static let maximumPayloadByteCount = 1_048_576
    public static let streamChunkByteCount = 64 * 1024
    public static let initialStreamWindowByteCount = 256 * 1024
    public static let maximumWindowUpdateByteCount = initialStreamWindowByteCount
    public static let maximumResetPayloadByteCount = 4 * 1024
    public static let maximumOpenStreamCount = 64

    public static let minimumRequestStreamID: UInt32 = 1
    public static let maximumRequestStreamID: UInt32 = 0x7fff_ffff
    public static let minimumHelperStreamID: UInt32 = 0x8000_0000
    public static let maximumHelperStreamID: UInt32 = 0xffff_fffe

    public static let controlVsockPort: UInt32 = 40_001
    public static let dataVsockPort: UInt32 = 40_002

    public static func isRequestStreamID(_ value: UInt32) -> Bool {
        value >= minimumRequestStreamID && value <= maximumRequestStreamID
    }

    public static func isHelperStreamID(_ value: UInt32) -> Bool {
        value >= minimumHelperStreamID && value <= maximumHelperStreamID
    }
}

public enum CapsuleVmFrameKind: UInt16, CaseIterable, Sendable {
    case request = 1
    case response = 2
    case event = 3
    case streamData = 4
    case streamFin = 5
    case streamWindowUpdate = 6
    case streamReset = 7
    case streamResetAck = 8
}

public struct CapsuleVmFrame: Equatable, Sendable {
    public let kind: CapsuleVmFrameKind
    public let streamID: UInt32
    public let payload: Data

    public init(kind: CapsuleVmFrameKind, streamID: UInt32, payload: Data) {
        self.kind = kind
        self.streamID = streamID
        self.payload = payload
    }
}

public struct CapsuleVmProtocolError: Error, Equatable, CustomStringConvertible, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

public enum CapsuleVmFrameCodec {
    public static func windowUpdatePayload(byteCount: Int) throws -> Data {
        guard byteCount > 0,
              byteCount <= CapsuleVmProtocol.maximumWindowUpdateByteCount,
              let value = UInt32(exactly: byteCount) else {
            throw CapsuleVmProtocolError(
                code: "invalid_window_update",
                message: "WINDOW_UPDATE credit must be between 1 and \(CapsuleVmProtocol.maximumWindowUpdateByteCount) bytes"
            )
        }
        var payload = Data(capacity: MemoryLayout<UInt32>.size)
        append(value, to: &payload)
        return payload
    }

    public static func windowUpdateByteCount(from payload: Data) throws -> Int {
        guard payload.count == MemoryLayout<UInt32>.size else {
            throw CapsuleVmProtocolError(
                code: "invalid_window_update",
                message: "WINDOW_UPDATE payload must be exactly four bytes"
            )
        }
        let value = readUInt32(payload, offset: 0)
        guard value > 0,
              value <= UInt32(CapsuleVmProtocol.maximumWindowUpdateByteCount) else {
            throw CapsuleVmProtocolError(
                code: "invalid_window_update",
                message: "WINDOW_UPDATE credit must be between 1 and \(CapsuleVmProtocol.maximumWindowUpdateByteCount) bytes"
            )
        }
        return Int(value)
    }

    public static func validate(_ frame: CapsuleVmFrame) throws {
        guard frame.payload.count <= CapsuleVmProtocol.maximumPayloadByteCount else {
            throw CapsuleVmProtocolError(
                code: "payload_too_large",
                message: "Frame payload exceeds \(CapsuleVmProtocol.maximumPayloadByteCount) bytes"
            )
        }

        switch frame.kind {
        case .request, .response, .event:
            break
        case .streamData:
            guard !frame.payload.isEmpty,
                  frame.payload.count <= CapsuleVmProtocol.streamChunkByteCount else {
                throw CapsuleVmProtocolError(
                    code: "invalid_stream_data",
                    message: "DATA payload must be between 1 and \(CapsuleVmProtocol.streamChunkByteCount) bytes"
                )
            }
        case .streamWindowUpdate:
            _ = try windowUpdateByteCount(from: frame.payload)
        case .streamFin, .streamResetAck:
            guard frame.payload.isEmpty else {
                throw CapsuleVmProtocolError(
                    code: "invalid_stream_terminal",
                    message: "\(frame.kind) payload must be empty"
                )
            }
        case .streamReset:
            guard !frame.payload.isEmpty,
                  frame.payload.count <= CapsuleVmProtocol.maximumResetPayloadByteCount else {
                throw CapsuleVmProtocolError(
                    code: "invalid_stream_reset",
                    message: "RESET payload must be between 1 and \(CapsuleVmProtocol.maximumResetPayloadByteCount) bytes"
                )
            }
        }
    }

    public static func encode(_ frame: CapsuleVmFrame) throws -> Data {
        try validate(frame)

        var encoded = Data(capacity: CapsuleVmProtocol.headerByteCount + frame.payload.count)
        encoded.append(CapsuleVmProtocol.magic)
        append(CapsuleVmProtocol.version, to: &encoded)
        append(frame.kind.rawValue, to: &encoded)
        append(frame.streamID, to: &encoded)
        append(UInt32(frame.payload.count), to: &encoded)
        encoded.append(frame.payload)
        return encoded
    }

    public static func decodeOne(from data: Data) throws -> (frame: CapsuleVmFrame, consumed: Int)? {
        guard data.count >= CapsuleVmProtocol.headerByteCount else {
            return nil
        }

        guard data.prefix(CapsuleVmProtocol.magic.count) == CapsuleVmProtocol.magic else {
            throw CapsuleVmProtocolError(code: "invalid_magic", message: "Frame magic is not LCVM")
        }

        let version = readUInt16(data, offset: 4)
        guard version == CapsuleVmProtocol.version else {
            throw CapsuleVmProtocolError(
                code: "unsupported_version",
                message: "Unsupported protocol version \(version)"
            )
        }

        let rawKind = readUInt16(data, offset: 6)
        guard let kind = CapsuleVmFrameKind(rawValue: rawKind) else {
            throw CapsuleVmProtocolError(code: "invalid_kind", message: "Unknown frame kind \(rawKind)")
        }

        let streamID = readUInt32(data, offset: 8)
        let payloadByteCount = Int(readUInt32(data, offset: 12))
        guard payloadByteCount <= CapsuleVmProtocol.maximumPayloadByteCount else {
            throw CapsuleVmProtocolError(
                code: "payload_too_large",
                message: "Frame payload exceeds \(CapsuleVmProtocol.maximumPayloadByteCount) bytes"
            )
        }

        let frameByteCount = CapsuleVmProtocol.headerByteCount + payloadByteCount
        guard data.count >= frameByteCount else {
            return nil
        }

        let payload = data.subdata(
            in: CapsuleVmProtocol.headerByteCount..<frameByteCount
        )
        let frame = CapsuleVmFrame(kind: kind, streamID: streamID, payload: payload)
        try validate(frame)
        return (
            frame,
            frameByteCount
        )
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

public final class CapsuleVmFrameReader {
    private let input: FileHandle
    private var buffer = Data()

    public init(input: FileHandle) {
        self.input = input
    }

    public func nextFrame() throws -> CapsuleVmFrame? {
        while true {
            if let decoded = try CapsuleVmFrameCodec.decodeOne(from: buffer) {
                buffer.removeSubrange(0..<decoded.consumed)
                return decoded.frame
            }

            let chunk = try readPipeChunk()
            guard !chunk.isEmpty else {
                if buffer.isEmpty {
                    return nil
                }
                throw CapsuleVmProtocolError(
                    code: "truncated_frame",
                    message: "Input ended in the middle of a frame"
                )
            }
            buffer.append(chunk)
        }
    }

    /// `FileHandle.read(upToCount:)` may wait for the requested byte count or
    /// EOF on a pipe. The helper's stdin remains open for the VM lifetime, so
    /// use POSIX `read(2)`, whose pipe semantics return as soon as any bytes are
    /// available.
    private func readPipeChunk() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        let count = bytes.withUnsafeMutableBytes { storage -> Int in
            var result: Int
            repeat {
                result = Darwin.read(input.fileDescriptor, storage.baseAddress, storage.count)
            } while result < 0 && errno == EINTR
            return result
        }
        guard count >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return Data(bytes.prefix(count))
    }
}
