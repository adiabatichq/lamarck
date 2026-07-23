import Darwin
import Foundation
import Testing
@testable import CapsuleVmHostCore

@Test func lifecycleAllowsOnlyClosedStateTransitions() throws {
    var lifecycle = CapsuleVmLifecycle()
    #expect(lifecycle.state == .idle)

    try lifecycle.beginStart()
    #expect(lifecycle.state == .starting)
    #expect(throws: CapsuleVmLifecycleError.self) { try lifecycle.beginStart() }

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

@Test func lifecycleAdmitsFramesWhileCurrentBootMuxMayExist() {
    #expect(!CapsuleVmLifecycleState.idle.acceptsHostStreamFrames)
    #expect(CapsuleVmLifecycleState.starting.acceptsHostStreamFrames)
    #expect(CapsuleVmLifecycleState.running.acceptsHostStreamFrames)
    #expect(CapsuleVmLifecycleState.stopping.acceptsHostStreamFrames)
    #expect(!CapsuleVmLifecycleState.stopped.acceptsHostStreamFrames)
    #expect(!CapsuleVmLifecycleState.failed.acceptsHostStreamFrames)
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
    let second = CapsuleVmFrame(
        kind: .streamData,
        streamID: CapsuleVmProtocol.minimumHelperStreamID,
        payload: Data("two".utf8)
    )
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

@Test func frameWriterPrioritizesProtocolThenControlAndRoundRobinsData() throws {
    let pipe = Pipe()
    let queue = DispatchQueue(label: "test.frame-writer.priority")
    queue.suspend()
    let writer = CapsuleVmFrameWriter(output: pipe.fileHandleForWriting, queue: queue)
    let streamA = CapsuleVmProtocol.minimumHelperStreamID
    let streamB = streamA + 1
    let control = streamA + 2
    let frames = [
        CapsuleVmFrame(kind: .streamData, streamID: streamA, payload: Data("a1".utf8)),
        CapsuleVmFrame(kind: .streamData, streamID: streamA, payload: Data("a2".utf8)),
        CapsuleVmFrame(kind: .streamData, streamID: streamB, payload: Data("b1".utf8)),
        CapsuleVmFrame(kind: .streamData, streamID: streamB, payload: Data("b2".utf8)),
    ]
    for frame in frames { writer.emit(frame) { _ in } }
    writer.emit(
        CapsuleVmFrame(kind: .streamData, streamID: control, payload: Data("control".utf8)),
        schedulingClass: .controlData
    ) { _ in }
    writer.emit(CapsuleVmFrame(kind: .response, streamID: 1, payload: Data("{}".utf8))) { _ in }
    writer.emit(CapsuleVmFrame(kind: .streamFin, streamID: streamA, payload: Data())) { _ in }

    queue.resume()
    writer.finish()

    let reader = CapsuleVmFrameReader(input: pipe.fileHandleForReading)
    var decoded: [CapsuleVmFrame] = []
    for _ in 0..<7 { decoded.append(try #require(try reader.nextFrame())) }
    #expect(decoded.map(\.kind) == [
        .streamData, .response, .streamData, .streamData,
        .streamData, .streamFin, .streamData,
    ])
    #expect(decoded.map(\.streamID) == [streamA, 1, control, streamB, streamA, streamA, streamB])
}

@Test func frameWriterResetPurgesQueuedDataAndFinButNotTheInFlightFrame() throws {
    let pipe = Pipe()
    let queue = DispatchQueue(label: "test.frame-writer.reset")
    queue.suspend()
    let writer = CapsuleVmFrameWriter(output: pipe.fileHandleForWriting, queue: queue)
    let streamID = CapsuleVmProtocol.minimumHelperStreamID
    let completions = LockedBooleanArray()

    writer.emit(CapsuleVmFrame(kind: .streamData, streamID: streamID, payload: Data([1]))) {
        completions.append((try? $0.get()) != nil)
    }
    writer.emit(CapsuleVmFrame(kind: .streamData, streamID: streamID, payload: Data([2]))) {
        completions.append((try? $0.get()) != nil)
    }
    writer.emit(CapsuleVmFrame(kind: .streamFin, streamID: streamID, payload: Data())) {
        completions.append((try? $0.get()) != nil)
    }
    writer.emit(CapsuleVmFrame(kind: .streamReset, streamID: streamID, payload: resetPayload())) {
        completions.append((try? $0.get()) != nil)
    }

    queue.resume()
    writer.finish()
    let reader = CapsuleVmFrameReader(input: pipe.fileHandleForReading)
    let first = try #require(try reader.nextFrame())
    let second = try #require(try reader.nextFrame())
    #expect(first.kind == .streamData)
    #expect(second.kind == .streamReset)
    #expect(completions.values.filter { $0 }.count == 2)
    #expect(completions.values.filter { !$0 }.count == 2)
}

@Test func frameWriterResetAckPurgesQueuedDataAndFinButKeepsPriorWindowUpdate() throws {
    let pipe = Pipe()
    let queue = DispatchQueue(label: "test.frame-writer.reset-ack-purge")
    queue.suspend()
    let writer = CapsuleVmFrameWriter(output: pipe.fileHandleForWriting, queue: queue)
    let streamID = CapsuleVmProtocol.minimumHelperStreamID
    let superseded = LockedErrorDescriptions()

    writer.emit(
        CapsuleVmFrame(kind: .response, streamID: 1, payload: Data("{}".utf8))
    ) { _ in }
    writer.emit(
        CapsuleVmFrame(kind: .streamData, streamID: streamID, payload: Data([1]))
    ) {
        if case .failure(let error) = $0 { superseded.append(error) }
    }
    writer.emit(
        CapsuleVmFrame(kind: .streamFin, streamID: streamID, payload: Data())
    ) {
        if case .failure(let error) = $0 { superseded.append(error) }
    }
    writer.emit(
        CapsuleVmFrame(
            kind: .streamWindowUpdate,
            streamID: streamID,
            payload: try CapsuleVmFrameCodec.windowUpdatePayload(byteCount: 1)
        )
    ) { _ in }
    writer.emit(
        CapsuleVmFrame(kind: .streamResetAck, streamID: streamID, payload: Data())
    ) { _ in }

    queue.resume()
    writer.finish()

    let reader = CapsuleVmFrameReader(input: pipe.fileHandleForReading)
    let decoded = try (0..<3).map { _ in
        try #require(try reader.nextFrame())
    }
    #expect(decoded.map(\.kind) == [.response, .streamWindowUpdate, .streamResetAck])
    #expect(superseded.waitForCount(2))
    #expect(superseded.values.allSatisfy { $0.hasPrefix("stream_reset:") })
}

@Test func frameWriterResetAckFollowsOneInFlightDataAndPurgesTheRest() throws {
    let pipe = Pipe()
    let queue = DispatchQueue(label: "test.frame-writer.reset-ack-in-flight")
    queue.suspend()
    let writer = CapsuleVmFrameWriter(output: pipe.fileHandleForWriting, queue: queue)
    let streamID = CapsuleVmProtocol.minimumHelperStreamID
    let completions = LockedBooleanArray()

    writer.emit(
        CapsuleVmFrame(kind: .streamData, streamID: streamID, payload: Data([1]))
    ) {
        completions.append((try? $0.get()) != nil)
    }
    writer.emit(
        CapsuleVmFrame(kind: .streamData, streamID: streamID, payload: Data([2]))
    ) {
        completions.append((try? $0.get()) != nil)
    }
    writer.emit(
        CapsuleVmFrame(kind: .streamResetAck, streamID: streamID, payload: Data())
    ) {
        completions.append((try? $0.get()) != nil)
    }

    queue.resume()
    writer.finish()

    let reader = CapsuleVmFrameReader(input: pipe.fileHandleForReading)
    let first = try #require(try reader.nextFrame())
    let second = try #require(try reader.nextFrame())
    #expect(first.kind == .streamData)
    #expect(first.payload == Data([1]))
    #expect(second.kind == .streamResetAck)
    #expect(completions.values.filter { $0 }.count == 2)
    #expect(completions.values.filter { !$0 }.count == 1)
}

@Test func frameWriterBackpressureRejectionDoesNotPoisonOrDeadlockAcceptedFrames() throws {
    let pipe = Pipe()
    let queue = DispatchQueue(label: "test.frame-writer.bound")
    queue.suspend()
    let writer = CapsuleVmFrameWriter(
        output: pipe.fileHandleForWriting,
        maximumPendingByteCount: CapsuleVmProtocol.headerByteCount + 1,
        queue: queue
    )
    let results = LockedBooleanArray()
    let frame = CapsuleVmFrame(
        kind: .streamData,
        streamID: CapsuleVmProtocol.minimumHelperStreamID,
        payload: Data([1])
    )
    writer.emit(frame) { results.append((try? $0.get()) != nil) }
    writer.emit(frame) { results.append((try? $0.get()) != nil) }
    queue.resume()
    writer.finish()
    writer.emit(frame) { results.append((try? $0.get()) != nil) }
    writer.finish()

    #expect(results.values.filter { $0 }.count == 2)
    #expect(results.values.filter { !$0 }.count == 1)
}

@Test func boundaryCloseEmitsResetWithoutDuplicatingGuestFin() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    relay.startReading()

    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .fin))
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)

    let shouldReset = relay.closeForBoundary()
    #expect(shouldReset)
    if shouldReset {
        emitter.emit(CapsuleVmFrame(
            kind: .streamReset,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: resetPayload()
        )) { _ in }
    }
    relay.synchronizeIOQueueForTesting()
    #expect(emitter.frames.filter { $0.kind == .streamFin }.count == 1)
    #expect(emitter.frames.filter { $0.kind == .streamReset }.count == 1)
}

@Test func boundaryCloseWinsAtomicallyAgainstAStillOpenRelay() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    relay.startReading()

    #expect(relay.closeForBoundary())
    emitter.emit(CapsuleVmFrame(
        kind: .streamReset,
        streamID: CapsuleVmProtocol.minimumHelperStreamID,
        payload: resetPayload()
    )) { _ in }
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)

    relay.synchronizeIOQueueForTesting()
    #expect(emitter.frames.count == 1)
}

@Test func confirmedStopResetKeepsStreamAuthorityUntilHostAck() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    relay.initiateLocalReset(code: "vm_stopped", message: "Capsule VM stopped")
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)
    #expect(!closed.waitForCount(1, timeout: .now() + .milliseconds(100)))

    try relay.acceptHostResetAck()
    relay.synchronizeIOQueueForTesting()
    #expect(closed.waitForCount(1))
    #expect(closed.values.first?.streamID == CapsuleVmProtocol.minimumHelperStreamID)
    #expect(closed.values.first?.tombstone == true)
}

@Test func hostDataAdmissionUsesInitialCreditWithoutBlockingTheFrameReader() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    try useSmallSocketBuffers(sockets)
    let relay = makeRelay(sockets.relay, emitter: SignallingFrameEmitter())
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    let payload = Data(repeating: 0x5a, count: CapsuleVmProtocol.streamChunkByteCount)
    let started = ContinuousClock.now
    for _ in 0..<(CapsuleVmProtocol.initialStreamWindowByteCount / payload.count) {
        try relay.acceptHostData(payload)
    }
    #expect(started.duration(to: .now) < .milliseconds(500))
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try relay.acceptHostData(Data([1]))
    }
}

@Test func hostCreditReturnsOnlyAfterBytesReachTheGuestSocket() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    let payload = Data(repeating: 0xa5, count: CapsuleVmProtocol.streamChunkByteCount)
    try relay.acceptHostData(payload)
    #expect(try readRelayFrame(sockets.peer) == CapsuleVmRelayFrame(
        kind: .data,
        payload: payload
    ))
    let update = try #require(emitter.waitForFrame(at: 0))
    #expect(update.kind == .streamWindowUpdate)
    #expect(try CapsuleVmFrameCodec.windowUpdateByteCount(from: update.payload) == payload.count)
}

@Test func finalWindowUpdateEmitterRejectionFailsTheHelperBoundary() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let rejection = CapsuleVmProtocolError(
        code: "test_output_rejected",
        message: "test output rejected"
    )
    let emitter = SelectiveFailingFrameEmitter(
        failingKind: .streamWindowUpdate,
        error: rejection
    )
    let failures = LockedErrorDescriptions()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    let payload = Data([0xa5])
    try relay.acceptHostData(payload)
    #expect(try readRelayFrame(sockets.peer) == CapsuleVmRelayFrame(
        kind: .data,
        payload: payload
    ))
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamWindowUpdate)
    #expect(failures.waitForCount(1))
    #expect(failures.values == [String(describing: rejection)])
    #expect(closed.waitForCount(1))
    #expect(closed.values.first?.tombstone == false)
}

@Test func hostFinDoesNotSuppressCreditForDataAppliedAfterGuestFin() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    try useSmallSocketBuffers(sockets)
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    // The Guest direction may finish independently while Host DATA is still
    // live. Deliver that FIN first to reproduce the cross-direction ordering
    // which exposed a final WINDOW_UPDATE after Electron's former retirement.
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)

    let chunk = Data(
        repeating: 0xa6,
        count: CapsuleVmProtocol.streamChunkByteCount
    )
    let chunkCount =
        CapsuleVmProtocol.initialStreamWindowByteCount / chunk.count
    for _ in 0..<chunkCount {
        try relay.acceptHostData(chunk)
    }
    try relay.acceptHostFin()

    var deliveredByteCount = 0
    var rawKinds: [CapsuleVmRelayFrameKind] = []
    while rawKinds.last != .close {
        let frame = try readRelayFrame(sockets.peer)
        rawKinds.append(frame.kind)
        if frame.kind == .data {
            deliveredByteCount += frame.payload.count
        }
    }

    #expect(deliveredByteCount == CapsuleVmProtocol.initialStreamWindowByteCount)
    #expect(rawKinds == Array(repeating: .data, count: chunkCount) + [.fin, .close])

    #expect(emitter.waitForFrame(at: chunkCount) != nil)
    let frames = emitter.frames
    let updates = frames.filter { $0.kind == .streamWindowUpdate }
    let returnedCredit = try updates.reduce(into: 0) { total, frame in
        total += try CapsuleVmFrameCodec.windowUpdateByteCount(
            from: frame.payload
        )
    }
    #expect(frames.first?.kind == .streamFin)
    #expect(updates.count == chunkCount)
    #expect(returnedCredit == CapsuleVmProtocol.initialStreamWindowByteCount)
    #expect(frames.allSatisfy { $0.kind != .streamReset })
}

@Test func guestDataStopsAtItsInitialWindowUntilHostReturnsCredit() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    #expect(throws: CapsuleVmStreamMuxError.self) {
        try relay.acceptHostWindowUpdate(1)
    }

    let initial = Data(repeating: 0x3c, count: CapsuleVmProtocol.initialStreamWindowByteCount)
    try writeRelayPayload(sockets.peer, data: initial)
    #expect(emitter.waitForDataBytes(initial.count))

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .data, payload: Data([0x7e]))
    )
    #expect(!emitter.waitForDataBytes(initial.count + 1, timeout: .milliseconds(100)))
    try relay.acceptHostWindowUpdate(1)
    #expect(emitter.waitForDataBytes(initial.count + 1))
}

@Test func guestDataCrossesMultipleWindowsAndDeliversExactBytesBeforeFin() throws {
    let guestSockets = try makeSocketPair()
    let wireSockets = try makeSocketPair()
    try useReceiveTimeout(wireSockets.relay)
    try useReceiveTimeout(wireSockets.peer)

    let helperWire = FileHandle(
        fileDescriptor: wireSockets.relay,
        closeOnDealloc: false
    )
    let hostWire = FileHandle(
        fileDescriptor: wireSockets.peer,
        closeOnDealloc: false
    )
    let helperWriter = CapsuleVmFrameWriter(
        output: helperWire,
        queue: DispatchQueue(label: "test.frame-writer.guest-to-host")
    )
    let helperReader = CapsuleVmFrameReader(input: helperWire)
    let hostWriter = CapsuleVmFrameWriter(
        output: hostWire,
        queue: DispatchQueue(label: "test.frame-writer.host-to-guest")
    )
    let hostReader = CapsuleVmFrameReader(input: hostWire)
    let relay = makeRelay(guestSockets.relay, emitter: helperWriter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
        _ = Darwin.shutdown(guestSockets.peer, SHUT_RDWR)
        Darwin.close(guestSockets.peer)
        _ = Darwin.shutdown(wireSockets.relay, SHUT_RDWR)
        _ = Darwin.shutdown(wireSockets.peer, SHUT_RDWR)
        Darwin.close(wireSockets.relay)
        Darwin.close(wireSockets.peer)
    }

    let payloadByteCount =
        (3 * CapsuleVmProtocol.initialStreamWindowByteCount)
        + CapsuleVmProtocol.streamChunkByteCount
        + 137
    let payload = Data((0..<payloadByteCount).map {
        UInt8(truncatingIfNeeded: ($0 &* 31) &+ 7)
    })
    let producer = LockedAsyncOperation()

    relay.startReading()
    DispatchQueue.global(qos: .userInitiated).async {
        producer.run {
            try writeRelayPayload(guestSockets.peer, data: payload)
            try writeRelayFrame(
                guestSockets.peer,
                frame: CapsuleVmRelayFrame(kind: .fin)
            )
        }
    }

    var received = Data()
    received.reserveCapacity(payload.count)
    var dataFrameCount = 0
    var returnedCredit = 0
    while true {
        let frame = try #require(try hostReader.nextFrame())
        #expect(frame.streamID == CapsuleVmProtocol.minimumHelperStreamID)

        if frame.kind == .streamFin {
            break
        }
        #expect(frame.kind == .streamData)
        guard frame.kind == .streamData else { continue }

        received.append(frame.payload)
        dataFrameCount += 1

        let updateByteCount = frame.payload.count
        let update = CapsuleVmFrame(
            kind: .streamWindowUpdate,
            streamID: frame.streamID,
            payload: try CapsuleVmFrameCodec.windowUpdatePayload(
                byteCount: updateByteCount
            )
        )
        hostWriter.emit(update) { _ in }
        hostWriter.finish()

        let returned = try #require(try helperReader.nextFrame())
        #expect(returned.kind == .streamWindowUpdate)
        #expect(returned.streamID == frame.streamID)
        let decodedCredit = try CapsuleVmFrameCodec.windowUpdateByteCount(
            from: returned.payload
        )
        #expect(decodedCredit == updateByteCount)
        try relay.acceptHostWindowUpdate(decodedCredit)
        returnedCredit += decodedCredit
    }

    helperWriter.finish()
    hostWriter.finish()
    #expect(producer.wait())
    #expect(producer.errorDescription == nil)
    #expect(payload.count > 3 * CapsuleVmProtocol.initialStreamWindowByteCount)
    #expect(dataFrameCount > 3)
    #expect(returnedCredit == payload.count)
    #expect(received == payload)
}

@Test func hostFinIsDirectionalAndDuplicateOrDataAfterFinFailsClosed() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let relay = makeRelay(sockets.relay, emitter: SignallingFrameEmitter())
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    #expect(throws: CapsuleVmStreamMuxError.self) { try relay.acceptHostFin() }
    #expect(throws: CapsuleVmStreamMuxError.self) { try relay.acceptHostData(Data([1])) }
}

@Test func dualDirectionalFinRequiresDualCloseBeforeNormalRetirement() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)

    let response = Data("still-open".utf8)
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .data, payload: response)
    )
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    #expect(emitter.waitForDataBytes(response.count))
    #expect(emitter.waitForFrame(at: 1)?.kind == .streamFin)
    #expect(try readRelayFrame(sockets.peer).kind == .close)
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .close)
    )
    #expect(closed.waitForCount(1))

    #expect(emitter.frames.filter { $0.kind == .streamData }.map(\.payload) == [response])
    #expect(closed.values.count == 1)
    #expect(closed.values.first?.tombstone == false)
}

@Test func guestCloseAlreadyOnTheWireWaitsForAsyncFinDelivery() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    try useReceiveTimeout(sockets.peer)
    let emitter = DelayedFinFrameEmitter()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        emitter.completeFin()
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .fin))
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)

    // The native relay can already have the valid Guest CLOSE buffered while
    // stdout is still applying the preceding LCVM FIN completion.
    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .close))
    relay.synchronizeIOQueueForTesting()
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(!closed.waitForCount(1, timeout: .now() + .milliseconds(100)))

    emitter.completeFin()
    #expect(try readRelayFrame(sockets.peer).kind == .close)
    #expect(closed.waitForCount(1))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(closed.values.first?.tombstone == false)
}

@Test func physicalEofMayPrecedeCommittedLocalCloseCallback() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    try useReceiveTimeout(sockets.peer)
    let emitter = SignallingFrameEmitter()
    let closeCompletion = DelayedCloseWriteCompletion()
    let closed = LockedResetClosures()
    let failures = LockedErrorDescriptions()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        closeWriteCompletionScheduler: { completion in
            closeCompletion.hold(completion)
        },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        closeCompletion.complete()
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .fin))
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(try readRelayFrame(sockets.peer).kind == .close)
    #expect(closeCompletion.waitUntilHeld())

    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .close))
    #expect(Darwin.shutdown(sockets.peer, SHUT_WR) == 0)
    #expect(waitForDeferredPhysicalTermination(relay))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(failures.values.isEmpty)
    #expect(!closed.waitForCount(1, timeout: .now() + .milliseconds(100)))

    closeCompletion.complete()
    #expect(closed.waitForCount(1))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(failures.values.isEmpty)
    #expect(closed.values.first?.tombstone == false)
}

@Test func protocolFailureAfterLocalCloseCommitDoesNotSynthesizeReset() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    try useReceiveTimeout(sockets.peer)
    let emitter = SignallingFrameEmitter()
    let closeCompletion = DelayedCloseWriteCompletion()
    let closed = LockedResetClosures()
    let failures = LockedErrorDescriptions()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        closeWriteCompletionScheduler: { completion in
            closeCompletion.hold(completion)
        },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        closeCompletion.complete()
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    try writeRelayFrame(sockets.peer, frame: CapsuleVmRelayFrame(kind: .fin))
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(try readRelayFrame(sockets.peer).kind == .close)
    #expect(closeCompletion.waitUntilHeld())

    // CLOSE is already ordered on the transport, so a later protocol fault
    // must fail the helper boundary instead of inventing RESET after CLOSE.
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .data, payload: Data([1]))
    )
    #expect(failures.waitForCount(1))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(closed.waitForCount(1))
    #expect(closed.values.first?.tombstone == false)

    closeCompletion.complete()
    relay.synchronizeIOQueueForTesting()
    #expect(closed.values.count == 1)
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
}

@Test func hostFinFollowedByHostResetDeliversExplicitResetInsteadOfClose() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }

    try relay.acceptHostFin()
    try relay.acceptHostReset(resetPayload())

    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    #expect(try readRelayFrame(sockets.peer).kind == .reset)
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamResetAck)
}

@Test func guestResetAfterLocalCloseCommitFailsBoundaryWithoutReset() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let failures = LockedErrorDescriptions()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(try readRelayFrame(sockets.peer).kind == .close)

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .reset)
    )
    #expect(failures.waitForCount(1))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(closed.waitForCount(1))
    #expect(closed.values.first?.tombstone == false)
}

@Test func dualFinWithoutGuestCloseFailsOnPhysicalEof() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let closed = LockedResetClosures()
    let failures = LockedErrorDescriptions()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try relay.acceptHostFin()
    #expect(try readRelayFrame(sockets.peer).kind == .fin)
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(try readRelayFrame(sockets.peer).kind == .close)
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try relay.acceptHostReset(resetPayload())
    }

    #expect(Darwin.shutdown(sockets.peer, SHUT_WR) == 0)
    #expect(failures.waitForCount(1))
    #expect(emitter.frames.allSatisfy { $0.kind != .streamReset })
    #expect(closed.waitForCount(1))
    #expect(closed.values.first?.tombstone == false)
}

@Test func earlyGuestCloseFailsClosed() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .close)
    )

    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)
}

@Test func malformedGuestCloseFailsClosed() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    var malformed = try CapsuleVmRelayFrameCodec.encode(
        CapsuleVmRelayFrame(kind: .close)
    )
    malformed[11] = 1
    malformed.append(0xff)
    try writeExactly(sockets.peer, data: malformed)

    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)
}

@Test func guestDataAfterFinFailsClosedInsteadOfRetiringNormally() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .data, payload: Data([1]))
    )

    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(emitter.waitForFrame(at: 1)?.kind == .streamReset)
}

@Test func duplicateGuestFinFailsClosedInsteadOfRetiringNormally() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    defer {
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )
    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .fin)
    )

    #expect(emitter.waitForFrame(at: 0)?.kind == .streamFin)
    #expect(emitter.waitForFrame(at: 1)?.kind == .streamReset)
}

@Test func physicalVsockEofWithoutAnExplicitTerminalBecomesResetNotFin() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let relay = makeRelay(sockets.relay, emitter: emitter)
    relay.startReading()

    #expect(Darwin.shutdown(sockets.peer, SHUT_WR) == 0)
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)
    #expect(emitter.frames.allSatisfy { $0.kind != .streamFin })
}

@Test func crossedResetAcceptsOnlyPreviouslyCreditedDataAndCompletesBothAcks() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = SignallingFrameEmitter()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )

    relay.initiateLocalReset(code: "test_reset", message: "test")
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamReset)

    let chunk = Data(repeating: 1, count: CapsuleVmProtocol.streamChunkByteCount)
    for _ in 0..<(CapsuleVmProtocol.initialStreamWindowByteCount / chunk.count) {
        try relay.acceptHostData(chunk)
    }
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try relay.acceptHostData(Data([1]))
    }
    try relay.acceptHostFin()
    try relay.acceptHostReset(resetPayload())
    #expect(emitter.waitForFrame(at: 1)?.kind == .streamResetAck)
    try relay.acceptHostResetAck()
    relay.synchronizeIOQueueForTesting()

    #expect(closed.values.count == 1)
    #expect(closed.values.first?.streamID == CapsuleVmProtocol.minimumHelperStreamID)
    #expect(closed.values.first?.tombstone == true)
}

@Test func resetSupersessionOfQueuedDataDoesNotFailTheHelperBoundary() throws {
    let sockets = try makeSocketPair()
    defer { Darwin.close(sockets.peer) }
    let emitter = DelayedDataFrameEmitter()
    let failures = LockedErrorDescriptions()
    let closed = LockedResetClosures()
    let relay = makeRelay(
        sockets.relay,
        emitter: emitter,
        onProtocolFailure: { failures.append($0) },
        onFullyClosed: { streamID, tombstone in
            closed.append(streamID: streamID, tombstone: tombstone)
        }
    )
    defer {
        emitter.completeData(.failure(CapsuleVmProtocolError(
            code: "stream_reset",
            message: "Queued stream output was superseded by RESET"
        )))
        relay.forceClose()
        relay.synchronizeIOQueueForTesting()
    }
    relay.startReading()

    try writeRelayFrame(
        sockets.peer,
        frame: CapsuleVmRelayFrame(kind: .data, payload: Data([1]))
    )
    #expect(emitter.waitForFrame(at: 0)?.kind == .streamData)

    try relay.acceptHostReset(resetPayload())
    #expect(try readRelayFrame(sockets.peer).kind == .reset)
    #expect(emitter.waitForFrame(at: 1)?.kind == .streamResetAck)
    #expect(closed.waitForCount(1))

    emitter.completeData(.failure(CapsuleVmProtocolError(
        code: "stream_reset",
        message: "Queued stream output was superseded by RESET"
    )))
    relay.synchronizeIOQueueForTesting()
    #expect(failures.values.isEmpty)
    #expect(closed.values.count == 1)
    #expect(closed.values.first?.tombstone == true)
}

@Test func resetTombstonesAreBoundedAndNeverEvictedForReplay() throws {
    var tombstones = CapsuleVmResetTombstoneSet(maximumCount: 2)
    try tombstones.insert(10)
    try tombstones.insert(11)
    try tombstones.insert(10)
    #expect(tombstones.contains(10))
    #expect(tombstones.contains(11))
    #expect(throws: CapsuleVmProtocolError.self) { try tombstones.insert(12) }
}

private func makeRelay(
    _ fileDescriptor: Int32,
    emitter: CapsuleVmFrameEmitter,
    onProtocolFailure: @escaping @Sendable (Error) -> Void = { _ in },
    closeWriteCompletionScheduler: @escaping CapsuleVmVsockRelay.CloseWriteCompletionScheduler = {
        completion in completion()
    },
    onFullyClosed: @escaping @Sendable (UInt32, Bool) -> Void = { _, _ in }
) -> CapsuleVmVsockRelay {
    CapsuleVmVsockRelay(
        registration: CapsuleVmStreamRegistration(
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            channel: .data,
            sourcePort: 9_001,
            destinationPort: CapsuleVmProtocol.dataVsockPort
        ),
        fileDescriptor: fileDescriptor,
        emitter: emitter,
        onProtocolFailure: onProtocolFailure,
        onFullyClosed: onFullyClosed,
        closeWriteCompletionScheduler: closeWriteCompletionScheduler
    )
}

private func resetPayload() -> Data {
    Data(#"{"code":"test_reset","message":"test reset"}"#.utf8)
}

private func makeSocketPair() throws -> (relay: Int32, peer: Int32) {
    var descriptors = [Int32](repeating: -1, count: 2)
    guard Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        throw POSIXError(.ENOTSOCK)
    }
    return (descriptors[0], descriptors[1])
}

private func useSmallSocketBuffers(_ sockets: (relay: Int32, peer: Int32)) throws {
    var bytes: Int32 = 4 * 1_024
    let sendResult = withUnsafePointer(to: &bytes) {
        Darwin.setsockopt(sockets.relay, SOL_SOCKET, SO_SNDBUF, $0, socklen_t(MemoryLayout<Int32>.size))
    }
    guard sendResult == 0 else { throw POSIXError(.EINVAL) }
    let receiveResult = withUnsafePointer(to: &bytes) {
        Darwin.setsockopt(sockets.peer, SOL_SOCKET, SO_RCVBUF, $0, socklen_t(MemoryLayout<Int32>.size))
    }
    guard receiveResult == 0 else { throw POSIXError(.EINVAL) }
}

private func useReceiveTimeout(_ descriptor: Int32) throws {
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    let result = withUnsafePointer(to: &timeout) {
        Darwin.setsockopt(
            descriptor,
            SOL_SOCKET,
            SO_RCVTIMEO,
            $0,
            socklen_t(MemoryLayout<timeval>.size)
        )
    }
    guard result == 0 else { throw POSIXError(.EINVAL) }
}

private func waitForDeferredPhysicalTermination(_ relay: CapsuleVmVsockRelay) -> Bool {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
        if relay.hasDeferredPhysicalTerminationForTesting() { return true }
        Thread.sleep(forTimeInterval: 0.001)
    }
    return relay.hasDeferredPhysicalTerminationForTesting()
}

private func readExactly(_ descriptor: Int32, byteCount: Int) throws -> Data {
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 8 * 1_024)
    while result.count < byteCount {
        let requested = min(buffer.count, byteCount - result.count)
        let count = buffer.withUnsafeMutableBytes {
            Darwin.read(descriptor, $0.baseAddress, requested)
        }
        if count > 0 {
            result.append(contentsOf: buffer.prefix(count))
        } else if count < 0, errno == EINTR {
            continue
        } else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
    return result
}

private func readRelayFrame(_ descriptor: Int32) throws -> CapsuleVmRelayFrame {
    let header = try readExactly(
        descriptor,
        byteCount: CapsuleVmRelayProtocol.headerByteCount
    )
    let decodedHeader = try CapsuleVmRelayFrameCodec.decodeHeader(from: header)
    let payload = try readExactly(
        descriptor,
        byteCount: decodedHeader.payloadByteCount
    )
    let encoded = header + payload
    return try #require(
        try CapsuleVmRelayFrameCodec.decodeOne(from: encoded)
    ).frame
}

private func writeRelayFrame(
    _ descriptor: Int32,
    frame: CapsuleVmRelayFrame
) throws {
    try writeExactly(
        descriptor,
        data: CapsuleVmRelayFrameCodec.encode(frame)
    )
}

private func writeRelayPayload(_ descriptor: Int32, data: Data) throws {
    var offset = 0
    while offset < data.count {
        let end = min(
            data.count,
            offset + CapsuleVmRelayProtocol.maximumDataByteCount
        )
        try writeRelayFrame(
            descriptor,
            frame: CapsuleVmRelayFrame(
                kind: .data,
                payload: data.subdata(in: offset..<end)
            )
        )
        offset = end
    }
}

private func writeExactly(_ descriptor: Int32, data: Data) throws {
    var offset = 0
    while offset < data.count {
        let count = data.withUnsafeBytes {
            Darwin.write(descriptor, $0.baseAddress?.advanced(by: offset), data.count - offset)
        }
        if count > 0 {
            offset += count
        } else if count < 0, errno == EINTR {
            continue
        } else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

private final class LockedAsyncOperation: @unchecked Sendable {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var storedErrorDescription: String?

    var errorDescription: String? {
        lock.lock()
        defer { lock.unlock() }
        return storedErrorDescription
    }

    func run(_ operation: () throws -> Void) {
        do {
            try operation()
        } catch {
            lock.lock()
            storedErrorDescription = String(describing: error)
            lock.unlock()
        }
        completed.signal()
    }

    func wait() -> Bool {
        completed.wait(timeout: .now() + .seconds(5)) == .success
    }
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

    func waitForFrame(at index: Int) -> CapsuleVmFrame? {
        let deadline = DispatchTime.now() + .seconds(2)
        while true {
            lock.lock()
            let frame = storedFrames.indices.contains(index) ? storedFrames[index] : nil
            lock.unlock()
            if let frame { return frame }
            if available.wait(timeout: deadline) == .timedOut { return nil }
        }
    }

    func waitForDataBytes(
        _ byteCount: Int,
        timeout: DispatchTimeInterval = .seconds(2)
    ) -> Bool {
        let deadline = DispatchTime.now() + timeout
        while true {
            lock.lock()
            let current = storedFrames
                .filter { $0.kind == .streamData }
                .reduce(0) { $0 + $1.payload.count }
            lock.unlock()
            if current >= byteCount { return true }
            if available.wait(timeout: deadline) == .timedOut { return false }
        }
    }
}

private final class SelectiveFailingFrameEmitter: CapsuleVmFrameEmitter, @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private let failingKind: CapsuleVmFrameKind
    private let error: Error
    private var storedFrames: [CapsuleVmFrame] = []

    init(failingKind: CapsuleVmFrameKind, error: Error) {
        self.failingKind = failingKind
        self.error = error
    }

    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        lock.lock()
        storedFrames.append(frame)
        lock.unlock()
        available.signal()
        if frame.kind == failingKind {
            completion(.failure(error))
        } else {
            completion(.success(()))
        }
    }

    func waitForFrame(at index: Int) -> CapsuleVmFrame? {
        let deadline = DispatchTime.now() + .seconds(2)
        while true {
            lock.lock()
            let frame = storedFrames.indices.contains(index) ? storedFrames[index] : nil
            lock.unlock()
            if let frame { return frame }
            if available.wait(timeout: deadline) == .timedOut { return nil }
        }
    }
}

private final class DelayedDataFrameEmitter: CapsuleVmFrameEmitter, @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var storedFrames: [CapsuleVmFrame] = []
    private var pendingDataCompletion: (@Sendable (Result<Void, Error>) -> Void)?

    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        var completeImmediately = true
        lock.lock()
        storedFrames.append(frame)
        if frame.kind == .streamData {
            precondition(pendingDataCompletion == nil)
            pendingDataCompletion = completion
            completeImmediately = false
        }
        lock.unlock()
        available.signal()
        if completeImmediately { completion(.success(())) }
    }

    func waitForFrame(at index: Int) -> CapsuleVmFrame? {
        let deadline = DispatchTime.now() + .seconds(2)
        while true {
            lock.lock()
            let frame = storedFrames.indices.contains(index) ? storedFrames[index] : nil
            lock.unlock()
            if let frame { return frame }
            if available.wait(timeout: deadline) == .timedOut { return nil }
        }
    }

    func completeData(_ result: Result<Void, Error>) {
        lock.lock()
        let completion = pendingDataCompletion
        pendingDataCompletion = nil
        lock.unlock()
        completion?(result)
    }
}

private final class DelayedFinFrameEmitter: CapsuleVmFrameEmitter, @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var storedFrames: [CapsuleVmFrame] = []
    private var pendingFinCompletion: (@Sendable (Result<Void, Error>) -> Void)?

    var frames: [CapsuleVmFrame] {
        lock.lock()
        defer { lock.unlock() }
        return storedFrames
    }

    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        var completeImmediately = true
        lock.lock()
        storedFrames.append(frame)
        if frame.kind == .streamFin {
            precondition(pendingFinCompletion == nil)
            pendingFinCompletion = completion
            completeImmediately = false
        }
        lock.unlock()
        available.signal()
        if completeImmediately { completion(.success(())) }
    }

    func waitForFrame(at index: Int) -> CapsuleVmFrame? {
        let deadline = DispatchTime.now() + .seconds(2)
        while true {
            lock.lock()
            let frame = storedFrames.indices.contains(index) ? storedFrames[index] : nil
            lock.unlock()
            if let frame { return frame }
            if available.wait(timeout: deadline) == .timedOut { return nil }
        }
    }

    func completeFin() {
        lock.lock()
        let completion = pendingFinCompletion
        pendingFinCompletion = nil
        lock.unlock()
        completion?(.success(()))
    }
}

private final class DelayedCloseWriteCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var pending: (@Sendable () -> Void)?

    func hold(_ completion: @escaping @Sendable () -> Void) {
        lock.lock()
        precondition(pending == nil)
        pending = completion
        lock.unlock()
        available.signal()
    }

    func waitUntilHeld() -> Bool {
        lock.lock()
        let alreadyHeld = pending != nil
        lock.unlock()
        return alreadyHeld || available.wait(timeout: .now() + .seconds(2)) == .success
    }

    func complete() {
        lock.lock()
        let completion = pending
        pending = nil
        lock.unlock()
        completion?()
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

private final class LockedErrorDescriptions: @unchecked Sendable {
    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var stored: [String] = []

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(_ error: Error) {
        lock.lock()
        stored.append(String(describing: error))
        lock.unlock()
        available.signal()
    }

    func waitForCount(
        _ count: Int,
        timeout: DispatchTime = .now() + 1
    ) -> Bool {
        while values.count < count {
            if available.wait(timeout: timeout) == .timedOut { return false }
        }
        return true
    }
}

private final class LockedResetClosures: @unchecked Sendable {
    struct Value: Sendable {
        let streamID: UInt32
        let tombstone: Bool
    }

    private let lock = NSLock()
    private let available = DispatchSemaphore(value: 0)
    private var stored: [Value] = []

    var values: [Value] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(streamID: UInt32, tombstone: Bool) {
        lock.lock()
        stored.append(Value(streamID: streamID, tombstone: tombstone))
        lock.unlock()
        available.signal()
    }

    func waitForCount(
        _ count: Int,
        timeout: DispatchTime = .now() + 1
    ) -> Bool {
        while values.count < count {
            if available.wait(timeout: timeout) == .timedOut { return false }
        }
        return true
    }
}
