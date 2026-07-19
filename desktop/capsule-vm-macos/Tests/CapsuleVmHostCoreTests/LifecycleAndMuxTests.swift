import Darwin
import Foundation
import Testing
@testable import CapsuleVmHostCore

@Test func lifecycleAllowsOnlyClosedStateTransitions() throws {
    var lifecycle = CapsuleVmLifecycle()
    #expect(lifecycle.state == .idle)

    try lifecycle.beginStart()
    #expect(lifecycle.state == .starting)
    #expect(throws: CapsuleVmLifecycleError.self) {
        try lifecycle.beginStart()
    }

    try lifecycle.didStart()
    #expect(lifecycle.state == .running)
    try lifecycle.beginStop()
    #expect(lifecycle.state == .stopping)
    try lifecycle.beginStop()
    try lifecycle.didStop()
    #expect(lifecycle.state == .stopped)

    try lifecycle.beginStart()
    lifecycle.didFail()
    #expect(lifecycle.state == .failed)
    try lifecycle.beginStop()
    #expect(lifecycle.state == .stopping)
    try lifecycle.didStop()
    #expect(lifecycle.state == .stopped)
}

@Test func streamRegistryUsesOnlyHelperIDSpaceAndOneControlPerBoot() throws {
    let registry = CapsuleVmStreamRegistry()
    let control = try registry.register(
        sourcePort: 9_001,
        destinationPort: CapsuleVmProtocol.controlVsockPort
    )
    #expect(control.channel == .control)
    #expect(CapsuleVmProtocol.isHelperStreamID(control.streamID))
    #expect(registry.count == 1)

    registry.remove(streamID: control.streamID)
    #expect(registry.count == 0)
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try registry.register(
            sourcePort: 9_002,
            destinationPort: CapsuleVmProtocol.controlVsockPort
        )
    }
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try registry.register(sourcePort: 9_003, destinationPort: 80)
    }
}

@Test func streamRegistryAppliesGlobalOpenStreamBound() throws {
    let registry = CapsuleVmStreamRegistry()
    var ids = Set<UInt32>()
    for index in 0..<CapsuleVmProtocol.maximumOpenStreamCount {
        let registration = try registry.register(
            sourcePort: UInt32(10_000 + index),
            destinationPort: CapsuleVmProtocol.dataVsockPort
        )
        #expect(ids.insert(registration.streamID).inserted)
        #expect(CapsuleVmProtocol.isHelperStreamID(registration.streamID))
    }
    #expect(registry.count == CapsuleVmProtocol.maximumOpenStreamCount)
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try registry.register(
            sourcePort: 20_000,
            destinationPort: CapsuleVmProtocol.dataVsockPort
        )
    }
}

@Test func recordingEmitterPreservesFrameOrderAndFailureBoundary() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let first = CapsuleVmFrame(kind: .event, streamID: 0, payload: Data("one".utf8))
    let second = CapsuleVmFrame(kind: .streamData, streamID: 0x8000_0000, payload: Data("two".utf8))
    let completions = LockedBooleanArray()
    emitter.emit(first) { completions.append((try? $0.get()) != nil) }
    emitter.emit(second) { completions.append((try? $0.get()) != nil) }

    #expect(emitter.frames == [first, second])
    #expect(completions.values == [true, true])

    emitter.error = CapsuleVmProtocolError(code: "closed", message: "closed")
    emitter.emit(first) { completions.append((try? $0.get()) != nil) }
    #expect(emitter.frames == [first, second])
    #expect(completions.values.last == false)
}

@Test func boundaryCloseDoesNotDuplicateAnAlreadyEmittedRemoteEnd() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = CapsuleVmVsockRelay(
        registration: CapsuleVmStreamRegistration(
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            channel: .data,
            sourcePort: 9_001,
            destinationPort: CapsuleVmProtocol.dataVsockPort
        ),
        fileDescriptor: sockets.relay,
        emitter: emitter,
        maximumPendingWriteBytes: CapsuleVmVsockMultiplexer.maximumPendingWriteBytesPerStream,
        onFullyClosed: { _ in }
    )
    relay.startReading()

    #expect(Darwin.shutdown(sockets.peer, SHUT_WR) == 0)
    let cleanEnd = emitter.waitForFrame()
    #expect(cleanEnd?.kind == .streamEnd)
    #expect(cleanEnd?.payload.isEmpty == true)

    let shouldEmitBoundaryEnd = relay.closeForBoundary()
    #expect(shouldEmitBoundaryEnd == false)
    if shouldEmitBoundaryEnd {
        emitter.emit(
            CapsuleVmFrame(
                kind: .streamEnd,
                streamID: CapsuleVmProtocol.minimumHelperStreamID,
                payload: Data("vm_stopping".utf8)
            )
        ) { _ in }
    }
    #expect(emitter.frames.count == 1)
}

@Test func boundaryCloseWinsAtomicallyAgainstAStillOpenRelay() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = CapsuleVmVsockRelay(
        registration: CapsuleVmStreamRegistration(
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            channel: .data,
            sourcePort: 9_002,
            destinationPort: CapsuleVmProtocol.dataVsockPort
        ),
        fileDescriptor: sockets.relay,
        emitter: emitter,
        maximumPendingWriteBytes: CapsuleVmVsockMultiplexer.maximumPendingWriteBytesPerStream,
        onFullyClosed: { _ in }
    )
    relay.startReading()

    #expect(relay.closeForBoundary())
    emitter.emit(
        CapsuleVmFrame(
            kind: .streamEnd,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: Data("vm_stopping".utf8)
        )
    ) { _ in }
    #expect(emitter.waitForFrame()?.payload == Data("vm_stopping".utf8))

    // A read callback already queued by DispatchIO cannot emit behind the
    // boundary End after closeForBoundary has returned.
    _ = Darwin.shutdown(sockets.peer, SHUT_WR)
    relay.synchronizeIOQueueForTesting()
    #expect(emitter.frames.count == 1)
}

private func makeSocketPair() throws -> (relay: Int32, peer: Int32) {
    var descriptors = [Int32](repeating: -1, count: 2)
    guard Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        throw POSIXError(.ENOTSOCK)
    }
    return (descriptors[0], descriptors[1])
}

private final class SignallingFrameEmitter: CapsuleVmFrameEmitter, @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var storedFrames: [CapsuleVmFrame] = []

    var frames: [CapsuleVmFrame] {
        lock.lock()
        defer { lock.unlock() }
        return storedFrames
    }

    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        lock.lock()
        storedFrames.append(frame)
        lock.unlock()
        available.signal()
        completion(.success(()))
    }

    func waitForFrame() -> CapsuleVmFrame? {
        guard available.wait(timeout: .now() + .seconds(2)) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return storedFrames.first
    }
}

private final class LockedBooleanArray: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Bool] = []

    var values: [Bool] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(_ value: Bool) {
        lock.lock()
        stored.append(value)
        lock.unlock()
    }
}
