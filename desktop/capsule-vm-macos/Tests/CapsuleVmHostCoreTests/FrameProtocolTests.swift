import Foundation
import Testing
@testable import CapsuleVmHostCore

@Test func frameRoundTrip() throws {
    let original = CapsuleVmFrame(
        kind: .request,
        streamID: 42,
        payload: Data(#"{"method":"probe"}"#.utf8)
    )

    let encoded = try CapsuleVmFrameCodec.encode(original)
    let decodedValue = try CapsuleVmFrameCodec.decodeOne(from: encoded)
    let decoded = try #require(decodedValue)

    #expect(decoded.frame == original)
    #expect(decoded.consumed == encoded.count)
}

@Test func decoderWaitsForCompleteFrame() throws {
    let frame = CapsuleVmFrame(kind: .request, streamID: 1, payload: Data("{}".utf8))
    let encoded = try CapsuleVmFrameCodec.encode(frame)

    #expect(try CapsuleVmFrameCodec.decodeOne(from: Data(encoded.dropLast())) == nil)
}

@Test func encoderUsesFixedCrossLanguageWireHeader() throws {
    let frame = CapsuleVmFrame(
        kind: .request,
        streamID: 42,
        payload: Data([0x7b, 0x7d])
    )

    let encoded = try CapsuleVmFrameCodec.encode(frame)

    #expect(encoded.map { String(format: "%02x", $0) }.joined() ==
        "4c43564d000200010000002a000000027b7d")
}

@Test func decoderRejectsUnknownVersionAndOversizedPayload() throws {
    let frame = CapsuleVmFrame(kind: .request, streamID: 1, payload: Data())
    var wrongVersion = try CapsuleVmFrameCodec.encode(frame)
    wrongVersion[5] = 1

    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.decodeOne(from: wrongVersion)
    }

    var oversizedHeader = try CapsuleVmFrameCodec.encode(frame)
    let oversized = UInt32(CapsuleVmProtocol.maximumPayloadByteCount + 1).bigEndian
    withUnsafeBytes(of: oversized) { bytes in
        oversizedHeader.replaceSubrange(12..<16, with: bytes)
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.decodeOne(from: oversizedHeader)
    }
}

@Test func v2StreamKindsUseFixedCrossLanguageWireValues() throws {
    let window = try CapsuleVmFrameCodec.windowUpdatePayload(byteCount: 1)
    let reset = Data(#"{"code":"test","message":"reset"}"#.utf8)
    let fixtures: [(CapsuleVmFrameKind, Data, UInt8)] = [
        (.streamData, Data([0xa5]), 4),
        (.streamFin, Data(), 5),
        (.streamWindowUpdate, window, 6),
        (.streamReset, reset, 7),
        (.streamResetAck, Data(), 8),
    ]

    for (kind, payload, literalKind) in fixtures {
        let encoded = try CapsuleVmFrameCodec.encode(CapsuleVmFrame(
            kind: kind,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: payload
        ))
        #expect(encoded[6] == 0)
        #expect(encoded[7] == literalKind)
        #expect(encoded[4] == 0)
        #expect(encoded[5] == 2)
    }
}

@Test func v2StreamPayloadShapesAndWindowBoundsAreStrict() throws {
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.encode(CapsuleVmFrame(
            kind: .streamData,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: Data()
        ))
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.encode(CapsuleVmFrame(
            kind: .streamFin,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: Data([1])
        ))
    }
    #expect(try CapsuleVmFrameCodec.windowUpdateByteCount(
        from: CapsuleVmFrameCodec.windowUpdatePayload(
            byteCount: CapsuleVmProtocol.initialStreamWindowByteCount
        )
    ) == CapsuleVmProtocol.initialStreamWindowByteCount)
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.windowUpdatePayload(byteCount: 0)
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmFrameCodec.windowUpdatePayload(
            byteCount: CapsuleVmProtocol.initialStreamWindowByteCount + 1
        )
    }
}

@Test func streamIDRangesAreDisjointAndReserveZero() {
    #expect(!CapsuleVmProtocol.isRequestStreamID(0))
    #expect(CapsuleVmProtocol.isRequestStreamID(1))
    #expect(CapsuleVmProtocol.isRequestStreamID(0x7fff_ffff))
    #expect(!CapsuleVmProtocol.isRequestStreamID(0x8000_0000))
    #expect(CapsuleVmProtocol.isHelperStreamID(0x8000_0000))
    #expect(CapsuleVmProtocol.isHelperStreamID(0xffff_fffe))
    #expect(!CapsuleVmProtocol.isHelperStreamID(0xffff_ffff))
}

@Test func frameReaderDoesNotWaitForPipeEOF() throws {
    let pipe = Pipe()
    let frame = CapsuleVmFrame(
        kind: .request,
        streamID: 7,
        payload: Data(#"{"method":"probe"}"#.utf8)
    )
    try pipe.fileHandleForWriting.write(contentsOf: CapsuleVmFrameCodec.encode(frame))

    // Keep the writer open long enough to expose Foundation reads that wait
    // for EOF instead of returning the bytes already available in the pipe.
    let delayedClose = DispatchWorkItem {
        try? pipe.fileHandleForWriting.close()
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: delayedClose)
    let started = ContinuousClock.now
    let decoded = try CapsuleVmFrameReader(input: pipe.fileHandleForReading).nextFrame()
    let elapsed = started.duration(to: .now)

    delayedClose.cancel()
    try? pipe.fileHandleForWriting.close()
    try? pipe.fileHandleForReading.close()
    #expect(decoded == frame)
    #expect(elapsed < .milliseconds(500))
}

@Test func vsockRelayV2UsesLiteralHeadersAndExactTerminalShapes() throws {
    let data = try CapsuleVmRelayFrameCodec.encode(
        CapsuleVmRelayFrame(kind: .data, payload: Data([0xaa, 0xbb]))
    )
    #expect(data == Data([
        0x4c, 0x56, 0x52, 0x4d, // LVRM
        0x00, 0x02,             // v2
        0x00, 0x01,             // DATA
        0x00, 0x00, 0x00, 0x02,
        0xaa, 0xbb,
    ]))

    let fin = try CapsuleVmRelayFrameCodec.encode(
        CapsuleVmRelayFrame(kind: .fin)
    )
    #expect(fin == Data([
        0x4c, 0x56, 0x52, 0x4d,
        0x00, 0x02,
        0x00, 0x02,
        0x00, 0x00, 0x00, 0x00,
    ]))
    let reset = try CapsuleVmRelayFrameCodec.encode(
        CapsuleVmRelayFrame(kind: .reset)
    )
    #expect(reset[6] == 0)
    #expect(reset[7] == 3)
    #expect(reset.count == CapsuleVmRelayProtocol.headerByteCount)
    let close = try CapsuleVmRelayFrameCodec.encode(
        CapsuleVmRelayFrame(kind: .close)
    )
    #expect(close == Data([
        0x4c, 0x56, 0x52, 0x4d,
        0x00, 0x02,
        0x00, 0x04,
        0x00, 0x00, 0x00, 0x00,
    ]))
}

@Test func vsockRelayV2DecoderIsFragmentSafeAndFailClosed() throws {
    let frame = CapsuleVmRelayFrame(
        kind: .data,
        payload: Data(repeating: 0x5a, count: 137)
    )
    let encoded = try CapsuleVmRelayFrameCodec.encode(frame)
    for prefixByteCount in 0..<encoded.count {
        #expect(try CapsuleVmRelayFrameCodec.decodeOne(
            from: encoded.prefix(prefixByteCount)
        ) == nil)
    }
    let decoded = try #require(
        try CapsuleVmRelayFrameCodec.decodeOne(from: encoded)
    )
    #expect(decoded.frame == frame)
    #expect(decoded.consumed == encoded.count)

    var badMagic = encoded
    badMagic[0] = 0
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.decodeOne(from: badMagic)
    }
    var badVersion = encoded
    badVersion[5] = 1
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.decodeOne(from: badVersion)
    }
    var badKind = encoded
    badKind[7] = 9
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.decodeOne(from: badKind)
    }
    var emptyData = encoded.prefix(CapsuleVmRelayProtocol.headerByteCount)
    emptyData[8] = 0
    emptyData[9] = 0
    emptyData[10] = 0
    emptyData[11] = 0
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.decodeOne(from: emptyData)
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.encode(
            CapsuleVmRelayFrame(kind: .fin, payload: Data([1]))
        )
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try CapsuleVmRelayFrameCodec.encode(
            CapsuleVmRelayFrame(kind: .close, payload: Data([1]))
        )
    }
}
