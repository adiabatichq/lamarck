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
        "4c43564d000100010000002a000000027b7d")
}

@Test func decoderRejectsUnknownVersionAndOversizedPayload() throws {
    let frame = CapsuleVmFrame(kind: .request, streamID: 1, payload: Data())
    var wrongVersion = try CapsuleVmFrameCodec.encode(frame)
    wrongVersion[5] = 2

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
