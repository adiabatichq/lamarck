import Darwin
import Dispatch
import Foundation
import Virtualization

public enum CapsuleVmStreamChannel: String, Sendable {
    case control
    case data
}

public struct CapsuleVmStreamRegistration: Equatable, Sendable {
    public let streamID: UInt32
    public let channel: CapsuleVmStreamChannel
    public let sourcePort: UInt32
    public let destinationPort: UInt32
}

public enum CapsuleVmStreamMuxError: Error, Equatable, CustomStringConvertible, Sendable {
    case unsupportedPort(UInt32)
    case duplicateControlStream
    case tooManyStreams
    case streamIDExhausted
    case invalidStreamID(UInt32)
    case unknownStream(UInt32)
    case duplicateFin(UInt32)
    case dataAfterFin(UInt32)
    case frameAfterReset(UInt32)
    case frameAfterClose(UInt32)
    case unexpectedResetAck(UInt32)
    case chunkTooLarge(Int)
    case creditExceeded(streamID: UInt32, attempted: Int, available: Int)
    case creditOverflow(streamID: UInt32, attempted: Int, available: Int)
    case socketUnavailable(String)

    public var description: String {
        switch self {
        case .unsupportedPort(let port):
            return "Guest connected to unsupported Host vsock port \(port)"
        case .duplicateControlStream:
            return "Guest attempted more than one control stream in one boot"
        case .tooManyStreams:
            return "Guest exceeded the bounded open-stream limit"
        case .streamIDExhausted:
            return "Helper-originated stream IDs are exhausted"
        case .invalidStreamID(let streamID):
            return "Invalid helper stream ID \(streamID)"
        case .unknownStream(let streamID):
            return "Unknown helper stream ID \(streamID)"
        case .duplicateFin(let streamID):
            return "Stream \(streamID) received FIN more than once in one direction"
        case .dataAfterFin(let streamID):
            return "Stream \(streamID) received DATA after FIN"
        case .frameAfterReset(let streamID):
            return "Stream \(streamID) received a frame after RESET"
        case .frameAfterClose(let streamID):
            return "Stream \(streamID) received a Host frame after its LVRM CLOSE commit"
        case .unexpectedResetAck(let streamID):
            return "Stream \(streamID) received RESET_ACK without an outstanding RESET"
        case .chunkTooLarge(let byteCount):
            return "Stream chunk exceeds the \(CapsuleVmProtocol.streamChunkByteCount)-byte limit: \(byteCount)"
        case .creditExceeded(let streamID, let attempted, let available):
            return "Stream \(streamID) sent \(attempted) DATA bytes with only \(available) bytes of credit"
        case .creditOverflow(let streamID, let attempted, let available):
            return "Stream \(streamID) returned \(attempted) credit bytes with only \(available) bytes available in its fixed window"
        case .socketUnavailable(let message):
            return "Virtio socket stream unavailable: \(message)"
        }
    }
}

/// Pure allocation and admission policy shared by the real mux and tests.
public final class CapsuleVmStreamRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var registrations: [UInt32: CapsuleVmStreamRegistration] = [:]
    private var nextStreamID = CapsuleVmProtocol.minimumHelperStreamID
    private var acceptedControlStream = false

    public init() {}

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return registrations.count
    }

    public func register(
        sourcePort: UInt32,
        destinationPort: UInt32
    ) throws -> CapsuleVmStreamRegistration {
        let channel: CapsuleVmStreamChannel
        switch destinationPort {
        case CapsuleVmProtocol.controlVsockPort:
            channel = .control
        case CapsuleVmProtocol.dataVsockPort:
            channel = .data
        default:
            throw CapsuleVmStreamMuxError.unsupportedPort(destinationPort)
        }

        lock.lock()
        defer { lock.unlock() }
        if channel == .control && acceptedControlStream {
            throw CapsuleVmStreamMuxError.duplicateControlStream
        }
        guard registrations.count < CapsuleVmProtocol.maximumOpenStreamCount else {
            throw CapsuleVmStreamMuxError.tooManyStreams
        }

        let rangeCount = UInt64(CapsuleVmProtocol.maximumHelperStreamID)
            - UInt64(CapsuleVmProtocol.minimumHelperStreamID) + 1
        var attempts: UInt64 = 0
        var selected: UInt32?
        while attempts < rangeCount {
            let candidate = nextStreamID
            nextStreamID = candidate == CapsuleVmProtocol.maximumHelperStreamID
                ? CapsuleVmProtocol.minimumHelperStreamID
                : candidate + 1
            if registrations[candidate] == nil {
                selected = candidate
                break
            }
            attempts += 1
        }
        guard let streamID = selected else {
            throw CapsuleVmStreamMuxError.streamIDExhausted
        }

        let registration = CapsuleVmStreamRegistration(
            streamID: streamID,
            channel: channel,
            sourcePort: sourcePort,
            destinationPort: destinationPort
        )
        registrations[streamID] = registration
        if channel == .control { acceptedControlStream = true }
        return registration
    }

    public func registration(for streamID: UInt32) -> CapsuleVmStreamRegistration? {
        lock.lock()
        defer { lock.unlock() }
        return registrations[streamID]
    }

    @discardableResult
    public func remove(streamID: UInt32) -> CapsuleVmStreamRegistration? {
        lock.lock()
        defer { lock.unlock() }
        return registrations.removeValue(forKey: streamID)
    }

    public func removeAll() {
        lock.lock()
        registrations.removeAll()
        lock.unlock()
    }
}

struct CapsuleVmResetTombstoneSet {
    let maximumCount: Int
    private(set) var streamIDs = Set<UInt32>()

    init(maximumCount: Int) {
        precondition(maximumCount > 0)
        self.maximumCount = maximumCount
    }

    func contains(_ streamID: UInt32) -> Bool {
        streamIDs.contains(streamID)
    }

    mutating func insert(_ streamID: UInt32) throws {
        if streamIDs.contains(streamID) { return }
        guard streamIDs.count < maximumCount else {
            throw CapsuleVmProtocolError(
                code: "reset_tombstone_limit",
                message: "LCVM reset tombstones exceeded the bounded session limit"
            )
        }
        streamIDs.insert(streamID)
    }

    mutating func removeAll() {
        streamIDs.removeAll()
    }
}

/// Guest→Host virtio-vsock relay. Swift owns the VZ connection file descriptors;
/// Electron sees only bounded LCVM v2 byte-stream frames over helper stdio.
public final class CapsuleVmVsockMultiplexer: NSObject, VZVirtioSocketListenerDelegate, @unchecked Sendable {
    public static let maximumPendingWriteBytesPerStream = CapsuleVmProtocol.initialStreamWindowByteCount
    public static let maximumResetTombstoneCount = 1_024

    private struct ActiveStream {
        let connection: VZVirtioSocketConnection
        let relay: CapsuleVmVsockRelay
    }

    private let vmQueue: DispatchQueue
    private let emitter: CapsuleVmFrameEmitter
    private let onFatalError: @Sendable (Error) -> Void
    private let registry: CapsuleVmStreamRegistry
    private let listener = VZVirtioSocketListener()
    private var socketDevice: VZVirtioSocketDevice?
    private var streams: [UInt32: ActiveStream] = [:]
    private var resetTombstones = CapsuleVmResetTombstoneSet(
        maximumCount: CapsuleVmVsockMultiplexer.maximumResetTombstoneCount
    )
    private var terminalProtocolError: Error?
    private var confirmedStopDrainCompletion: (@Sendable () -> Void)?
    private var installed = false

    public init(
        vmQueue: DispatchQueue,
        emitter: CapsuleVmFrameEmitter,
        registry: CapsuleVmStreamRegistry = CapsuleVmStreamRegistry(),
        onFatalError: @escaping @Sendable (Error) -> Void = { _ in }
    ) {
        self.vmQueue = vmQueue
        self.emitter = emitter
        self.registry = registry
        self.onFatalError = onFatalError
        super.init()
        listener.delegate = self
    }

    public func install(on socketDevice: VZVirtioSocketDevice) {
        precondition(!installed, "vsock multiplexer may be installed only once")
        installed = true
        self.socketDevice = socketDevice
        socketDevice.setSocketListener(listener, forPort: CapsuleVmProtocol.controlVsockPort)
        socketDevice.setSocketListener(listener, forPort: CapsuleVmProtocol.dataVsockPort)
    }

    public func listener(
        _ listener: VZVirtioSocketListener,
        shouldAcceptNewConnection connection: VZVirtioSocketConnection,
        from socketDevice: VZVirtioSocketDevice
    ) -> Bool {
        guard terminalProtocolError == nil else { return false }
        let duplicatedDescriptor = Darwin.dup(connection.fileDescriptor)
        guard duplicatedDescriptor >= 0 else { return false }

        let registration: CapsuleVmStreamRegistration
        do {
            registration = try registry.register(
                sourcePort: connection.sourcePort,
                destinationPort: connection.destinationPort
            )
        } catch {
            Darwin.close(duplicatedDescriptor)
            return false
        }

        let relay = CapsuleVmVsockRelay(
            registration: registration,
            fileDescriptor: duplicatedDescriptor,
            emitter: emitter,
            onProtocolFailure: onFatalError,
            onFullyClosed: { [weak self] streamID, retainResetTombstone in
                self?.vmQueue.async { [weak self] in
                    self?.finishStream(
                        streamID,
                        retainResetTombstone: retainResetTombstone
                    )
                }
            }
        )
        streams[registration.streamID] = ActiveStream(connection: connection, relay: relay)

        do {
            let payload = try JSONSerialization.data(
                withJSONObject: [
                    "type": "stream.open",
                    "channel": registration.channel.rawValue,
                    "sourcePort": registration.sourcePort,
                    "destinationPort": registration.destinationPort,
                ],
                options: [.sortedKeys]
            )
            emitter.emit(
                CapsuleVmFrame(
                    kind: .event,
                    streamID: registration.streamID,
                    payload: payload
                )
            ) { [weak self] result in
                self?.vmQueue.async { [weak self] in
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.streams[registration.streamID]?.relay.startReading()
                    case .failure:
                        self.finishStream(registration.streamID)
                    }
                }
            }
            return true
        } catch {
            finishStream(registration.streamID)
            return false
        }
    }

    public func acceptHostFrame(_ frame: CapsuleVmFrame) throws {
        try CapsuleVmFrameCodec.validate(frame)
        guard CapsuleVmProtocol.isHelperStreamID(frame.streamID) else {
            throw CapsuleVmStreamMuxError.invalidStreamID(frame.streamID)
        }

        let relay = try activeRelay(for: frame.streamID)
        switch frame.kind {
        case .streamData:
            try relay.acceptHostData(frame.payload)
        case .streamWindowUpdate:
            try relay.acceptHostWindowUpdate(
                try CapsuleVmFrameCodec.windowUpdateByteCount(from: frame.payload)
            )
        case .streamFin:
            try relay.acceptHostFin()
        case .streamReset:
            try validateResetPayload(frame.payload)
            try relay.acceptHostReset(frame.payload)
        case .streamResetAck:
            try relay.acceptHostResetAck()
        case .request, .response, .event:
            throw CapsuleVmProtocolError(
                code: "unexpected_frame_kind",
                message: "vsock mux accepts DATA, WINDOW_UPDATE, FIN, RESET, and RESET_ACK only"
            )
        }
    }

    public func drainForConfirmedStop(
        code: String,
        message: String,
        completion: @escaping @Sendable () -> Void
    ) {
        precondition(
            confirmedStopDrainCompletion == nil,
            "confirmed VM stop stream drain may begin only once"
        )
        stopAcceptingConnections()
        confirmedStopDrainCompletion = completion

        // VZ has authoritatively stopped, but the LCVM boundary remains live
        // until Electron acknowledges one explicit RESET for every stream
        // which had not already completed its own terminal handshake. Keeping
        // each relay and its exact credit/reset state here also lets it consume
        // a DATA, FIN, or crossed RESET which was already physically in flight.
        for active in streams.values {
            active.relay.initiateLocalReset(code: code, message: message)
            active.connection.close()
        }
        finishConfirmedStopDrainIfReady()
    }

    public func closeAll(code: String, message: String) {
        stopAcceptingConnections()
        confirmedStopDrainCompletion = nil

        let payload = makeResetPayload(code: code, message: message)
        for (streamID, active) in streams {
            if active.relay.closeForBoundary() {
                emitter.emit(
                    CapsuleVmFrame(kind: .streamReset, streamID: streamID, payload: payload)
                ) { _ in }
            }
            active.connection.close()
            registry.remove(streamID: streamID)
        }
        streams.removeAll()
        resetTombstones.removeAll()
        registry.removeAll()
    }

    private func stopAcceptingConnections() {
        if installed, let socketDevice {
            socketDevice.removeSocketListener(forPort: CapsuleVmProtocol.controlVsockPort)
            socketDevice.removeSocketListener(forPort: CapsuleVmProtocol.dataVsockPort)
        }
        installed = false
        self.socketDevice = nil
    }

    private func finishStream(
        _ streamID: UInt32,
        retainResetTombstone: Bool = false
    ) {
        guard let active = streams.removeValue(forKey: streamID) else { return }
        active.relay.forceClose()
        active.connection.close()
        registry.remove(streamID: streamID)

        if retainResetTombstone {
            do {
                try resetTombstones.insert(streamID)
            } catch {
                terminalProtocolError = error
                onFatalError(error)
            }
        }
        finishConfirmedStopDrainIfReady()
    }

    private func finishConfirmedStopDrainIfReady() {
        guard streams.isEmpty, let completion = confirmedStopDrainCompletion else {
            return
        }
        confirmedStopDrainCompletion = nil
        resetTombstones.removeAll()
        registry.removeAll()
        completion()
    }

    private func activeRelay(for streamID: UInt32) throws -> CapsuleVmVsockRelay {
        var relay: CapsuleVmVsockRelay?
        var terminalError: Error?
        var isResetTombstone = false
        vmQueue.sync {
            terminalError = terminalProtocolError
            isResetTombstone = resetTombstones.contains(streamID)
            relay = streams[streamID]?.relay
        }
        if let terminalError { throw terminalError }
        if isResetTombstone {
            throw CapsuleVmStreamMuxError.frameAfterReset(streamID)
        }
        guard let relay else { throw CapsuleVmStreamMuxError.unknownStream(streamID) }
        return relay
    }
}

private func makeResetPayload(code: String, message: String) -> Data {
    (try? JSONSerialization.data(
        withJSONObject: ["code": code, "message": message],
        options: [.sortedKeys]
    )) ?? Data(#"{"code":"stream_reset","message":"Stream reset"}"#.utf8)
}

private func validateResetPayload(_ data: Data) throws {
    guard !data.isEmpty,
          data.count <= CapsuleVmProtocol.maximumResetPayloadByteCount else {
        throw CapsuleVmProtocolError(
            code: "invalid_stream_reset",
            message: "RESET payload exceeds its bounded limit"
        )
    }

    let value: Any
    do {
        value = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw CapsuleVmProtocolError(
            code: "invalid_stream_reset",
            message: "RESET payload is not valid JSON"
        )
    }
    guard let object = value as? [String: Any],
          Set(object.keys) == ["code", "message"],
          let code = object["code"] as? String,
          !code.isEmpty,
          let message = object["message"] as? String,
          !message.isEmpty else {
        throw CapsuleVmProtocolError(
            code: "invalid_stream_reset",
            message: "RESET payload must be exactly {code,message} with non-empty strings"
        )
    }
}

final class CapsuleVmVsockRelay: @unchecked Sendable {
    typealias CloseWriteCompletionScheduler = @Sendable (
        _ completion: @escaping @Sendable () -> Void
    ) -> Void

    private enum RelayWriteKind: Sendable {
        case data(payloadByteCount: Int)
        case fin
        case reset
        case close
    }

    private struct RelayWrite: @unchecked Sendable {
        let bytes: DispatchData
        let kind: RelayWriteKind
    }

    private let registration: CapsuleVmStreamRegistration
    private let fileDescriptor: Int32
    private let emitter: CapsuleVmFrameEmitter
    private let onProtocolFailure: @Sendable (Error) -> Void
    private let onFullyClosed: @Sendable (UInt32, Bool) -> Void
    private let closeWriteCompletionScheduler: CloseWriteCompletionScheduler
    private let ioQueue: DispatchQueue
    private let io: DispatchIO

    // Host→Guest. LCVM credit is consumed at frame admission and returned only
    // after DispatchIO confirms that the corresponding framed LVRM record
    // reached the virtio-vsock transport.
    private var hostToGuestCredit = CapsuleVmProtocol.initialStreamWindowByteCount
    private var pendingDataWrites: [Data] = []
    private var pendingWriteBytes = 0
    private var writeInFlight: RelayWrite?
    private var hostFinReceived = false
    private var hostFinApplied = false
    private var hostResetWriteStarted = false
    private var localCloseWriteStarted = false
    private var localCloseSent = false

    // Guest→Host. One complete LVRM record is assembled at a time. A DATA
    // record which arrived ahead of returned LCVM credit remains as that one
    // bounded record and is not emitted until the consumer returns credit.
    private var guestToHostCredit = CapsuleVmProtocol.initialStreamWindowByteCount
    private var guestFinSent = false
    private var guestFinDelivered = false
    private var guestCloseReceived = false
    private var readStarted = false
    private var readOperationActive = false
    private var readTargetByteCount = 0
    private var readBuffer = Data()
    private var inboundEmissionInFlight = false

    // RESET is terminal. A locally sent RESET retains this bounded tombstone
    // until the peer returns RESET_ACK.
    private var localResetSent = false
    private var localResetAcknowledged = false
    private var peerResetReceived = false
    private var peerResetAckDelivered = false
    private var transportClosed = false
    private var retired = false
    private var boundaryFailureReported = false
    private var physicalTerminationDeferredForClose = false

    init(
        registration: CapsuleVmStreamRegistration,
        fileDescriptor: Int32,
        emitter: CapsuleVmFrameEmitter,
        onProtocolFailure: @escaping @Sendable (Error) -> Void = { _ in },
        onFullyClosed: @escaping @Sendable (UInt32, Bool) -> Void,
        closeWriteCompletionScheduler: @escaping CloseWriteCompletionScheduler = {
            completion in completion()
        }
    ) {
        self.registration = registration
        self.fileDescriptor = fileDescriptor
        self.emitter = emitter
        self.onProtocolFailure = onProtocolFailure
        self.onFullyClosed = onFullyClosed
        self.closeWriteCompletionScheduler = closeWriteCompletionScheduler
        self.ioQueue = DispatchQueue(
            label: "app.lamarck.capsule-vm.vsock.\(registration.streamID)"
        )
        self.io = DispatchIO(
            type: .stream,
            fileDescriptor: fileDescriptor,
            queue: ioQueue
        ) { _ in }
        io.setLimit(highWater: CapsuleVmRelayProtocol.maximumFrameByteCount)
        io.setLimit(lowWater: 1)
    }

    func startReading() {
        ioQueue.async { [self] in
            guard !retired, !readStarted else { return }
            readStarted = true
            scheduleReadIfPossible()
        }
    }

    /// Admits one Host DATA frame without waiting for Guest socket progress.
    /// The fixed credit window is also the exact pending-write bound.
    func acceptHostData(_ data: Data) throws {
        guard !data.isEmpty,
              data.count <= CapsuleVmProtocol.streamChunkByteCount else {
            throw CapsuleVmStreamMuxError.chunkTooLarge(data.count)
        }
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            do {
                try requireNotRetired()
                guard !hostFinReceived else {
                    throw CapsuleVmStreamMuxError.dataAfterFin(registration.streamID)
                }
                guard data.count <= hostToGuestCredit else {
                    throw CapsuleVmStreamMuxError.creditExceeded(
                        streamID: registration.streamID,
                        attempted: data.count,
                        available: hostToGuestCredit
                    )
                }
                guard data.count <= CapsuleVmProtocol.initialStreamWindowByteCount - pendingWriteBytes else {
                    throw CapsuleVmStreamMuxError.creditExceeded(
                        streamID: registration.streamID,
                        attempted: data.count,
                        available: CapsuleVmProtocol.initialStreamWindowByteCount - pendingWriteBytes
                    )
                }

                hostToGuestCredit -= data.count
                // RESET may overtake already-admitted DATA in the peer's
                // priority scheduler. Validate that delayed DATA against the
                // remaining pre-RESET credit, then discard it at the closed
                // transport rather than turning a crossed reset into a fatal
                // helper-session error.
                if localResetSent || peerResetReceived { return }

                pendingWriteBytes += data.count
                if let last = pendingDataWrites.last,
                   last.count + data.count
                    <= CapsuleVmRelayProtocol.maximumDataByteCount {
                    pendingDataWrites[pendingDataWrites.count - 1].append(data)
                } else {
                    pendingDataWrites.append(data)
                }
                startNextWriteIfNeeded()
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
    }

    func acceptHostWindowUpdate(_ byteCount: Int) throws {
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            do {
                try requireNotRetired()
                let available = CapsuleVmProtocol.initialStreamWindowByteCount - guestToHostCredit
                guard byteCount <= available else {
                    throw CapsuleVmStreamMuxError.creditOverflow(
                        streamID: registration.streamID,
                        attempted: byteCount,
                        available: available
                    )
                }
                guestToHostCredit += byteCount
                if !localResetSent && !peerResetReceived {
                    advanceInbound()
                }
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
    }

    func acceptHostFin() throws {
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            do {
                try requireNotRetired()
                guard !hostFinReceived else {
                    throw CapsuleVmStreamMuxError.duplicateFin(registration.streamID)
                }
                hostFinReceived = true
                if !localResetSent && !peerResetReceived {
                    finishHostFinIfReady()
                }
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
    }

    func acceptHostReset(_ payload: Data) throws {
        var result: Result<Void, Error> = .success(())
        var shouldAcknowledgeImmediately = false
        ioQueue.sync { [self] in
            do {
                try requireNotRetired()
                guard !localCloseWriteStarted else {
                    throw CapsuleVmStreamMuxError.frameAfterClose(
                        registration.streamID
                    )
                }
                guard !peerResetReceived else {
                    throw CapsuleVmStreamMuxError.frameAfterReset(registration.streamID)
                }
                peerResetReceived = true
                // RESET may overtake queued DATA/FIN, but not a record already
                // being physically written. Purge the unsent queue and write
                // one explicit raw RESET before retiring the Guest leg.
                pendingDataWrites.removeAll()
                pendingWriteBytes = {
                    guard let writeInFlight else { return 0 }
                    if case .data(let payloadByteCount) = writeInFlight.kind {
                        return payloadByteCount
                    }
                    return 0
                }()
                if localResetSent || transportClosed {
                    closeTransport()
                    shouldAcknowledgeImmediately = true
                } else {
                    startNextWriteIfNeeded()
                }
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
        if shouldAcknowledgeImmediately {
            ioQueue.async { [weak self] in self?.emitPeerResetAck() }
        }
    }

    func acceptHostResetAck() throws {
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            if retired {
                result = .failure(CapsuleVmStreamMuxError.unknownStream(registration.streamID))
            } else if !localResetSent || localResetAcknowledged {
                result = .failure(CapsuleVmStreamMuxError.unexpectedResetAck(registration.streamID))
            } else {
                localResetAcknowledged = true
                if !peerResetReceived || peerResetAckDelivered {
                    retire(notifyOwner: true, retainResetTombstone: true)
                }
            }
        }
        try result.get()
    }

    /// Begins a protocol RESET without blocking the helper input reader. Used
    /// by relay failures and directly by state-machine tests.
    func initiateLocalReset(code: String, message: String) {
        ioQueue.sync { [self] in
            beginLocalReset(code: code, message: message)
        }
    }

    func forceClose() {
        ioQueue.async { [self] in retire(notifyOwner: false, retainResetTombstone: false) }
    }

    /// Atomically retires the relay for a VM boundary transition and reports
    /// whether the mux still owes the Host a RESET frame.
    func closeForBoundary() -> Bool {
        var shouldEmitReset = false
        ioQueue.sync { [self] in
            guard !retired else { return }
            shouldEmitReset = !localResetSent && !peerResetReceived
            if shouldEmitReset { localResetSent = true }
            retire(notifyOwner: false, retainResetTombstone: false)
        }
        return shouldEmitReset
    }

    /// Test-only barrier for deterministically observing callbacks already
    /// submitted to the relay's serial I/O queue.
    func synchronizeIOQueueForTesting() {
        ioQueue.sync {}
    }

    /// Test-only observation for the callback ordering where the native relay
    /// exits after forwarding both CLOSE records but before DispatchIO applies
    /// the already-started local CLOSE completion.
    func hasDeferredPhysicalTerminationForTesting() -> Bool {
        ioQueue.sync { physicalTerminationDeferredForClose }
    }

    private func requireNotRetired() throws {
        if retired {
            throw CapsuleVmStreamMuxError.unknownStream(registration.streamID)
        }
    }

    private func scheduleReadIfPossible() {
        guard readStarted,
              !retired,
              !transportClosed,
              !readOperationActive,
              !inboundEmissionInFlight else { return }

        if readBuffer.count < CapsuleVmRelayProtocol.headerByteCount {
            startExactRead(
                through: CapsuleVmRelayProtocol.headerByteCount
            )
            return
        }

        do {
            let header = try CapsuleVmRelayFrameCodec.decodeHeader(from: readBuffer)
            let frameByteCount =
                CapsuleVmRelayProtocol.headerByteCount + header.payloadByteCount
            if readBuffer.count < frameByteCount {
                startExactRead(through: frameByteCount)
                return
            }
            guard readBuffer.count == frameByteCount,
                  let decoded = try CapsuleVmRelayFrameCodec.decodeOne(from: readBuffer),
                  decoded.consumed == frameByteCount else {
                throw CapsuleVmProtocolError(
                    code: "invalid_vsock_relay_frame",
                    message: "Virtio-vsock relay record did not have one exact bounded frame"
                )
            }
            acceptGuestRelayFrame(decoded.frame)
        } catch {
            beginLocalReset(
                code: "vsock_relay_protocol_error",
                message: String(describing: error)
            )
        }
    }

    private func startExactRead(through targetByteCount: Int) {
        guard targetByteCount > readBuffer.count,
              targetByteCount <= CapsuleVmRelayProtocol.maximumFrameByteCount else {
            beginLocalReset(
                code: "vsock_relay_protocol_error",
                message: "Virtio-vsock relay read target is outside its fixed frame bound"
            )
            return
        }
        readOperationActive = true
        readTargetByteCount = targetByteCount
        io.read(
            offset: 0,
            length: targetByteCount - readBuffer.count,
            queue: ioQueue
        ) { [weak self] done, dispatchData, errorCode in
            guard let self, !self.retired, !self.transportClosed else { return }
            if errorCode != 0 {
                self.readOperationActive = false
                self.beginLocalReset(
                    code: "vsock_read_failed",
                    message: String(cString: strerror(errorCode))
                )
                return
            }

            if let dispatchData {
                let data = Data(dispatchData)
                if !data.isEmpty {
                    self.readBuffer.append(data)
                    if self.readBuffer.count > self.readTargetByteCount {
                        self.readOperationActive = false
                        self.beginLocalReset(
                            code: "vsock_relay_protocol_error",
                            message: "Virtio-vsock relay read crossed its exact frame bound"
                        )
                        return
                    }
                }
            }
            guard done else { return }
            self.readOperationActive = false
            if self.readBuffer.count != self.readTargetByteCount {
                if self.readBuffer.isEmpty,
                   self.localCloseWriteStarted,
                   self.guestCloseReceived {
                    if self.localCloseSent {
                        self.retire(
                            notifyOwner: true,
                            retainResetTombstone: false
                        )
                    } else {
                        // The native relay may forward both CLOSE records and
                        // exit before DispatchIO schedules the completion for
                        // our already-started CLOSE write. That callback, not
                        // physical EOF ordering, decides whether our commit
                        // completed.
                        self.physicalTerminationDeferredForClose = true
                    }
                    return
                }
                self.beginLocalReset(
                    code: "vsock_eof_before_close_commit",
                    message: "Virtio-vsock relay ended before both explicit CLOSE commits"
                )
                return
            }
            self.scheduleReadIfPossible()
        }
    }

    private func advanceInbound() {
        guard !retired, !transportClosed, !inboundEmissionInFlight else { return }
        scheduleReadIfPossible()
    }

    private func acceptGuestRelayFrame(_ frame: CapsuleVmRelayFrame) {
        switch frame.kind {
        case .data:
            guard !guestCloseReceived else {
                beginLocalReset(
                    code: "frame_after_guest_close",
                    message: "Guest sent LVRM DATA after its CLOSE commit"
                )
                return
            }
            guard !guestFinSent else {
                beginLocalReset(
                    code: "data_after_guest_fin",
                    message: "Guest sent LVRM DATA after its directional FIN"
                )
                return
            }
            guard frame.payload.count <= guestToHostCredit else {
                // One complete frame may wait here for LCVM consumer credit;
                // no second record is read into user space.
                return
            }
            readBuffer.removeAll(keepingCapacity: true)
            guestToHostCredit -= frame.payload.count
            inboundEmissionInFlight = true
            emit(
                CapsuleVmFrame(
                    kind: .streamData,
                    streamID: registration.streamID,
                    payload: frame.payload
                )
            ) { [weak self] result in
                self?.ioQueue.async { [weak self] in
                    guard let self else { return }
                    self.inboundEmissionInFlight = false
                    switch result {
                    case .success:
                        guard !self.retired else { return }
                        self.scheduleReadIfPossible()
                    case .failure(let error):
                        guard !self.isIntentionalResetSupersession(error) else {
                            return
                        }
                        self.failHelperBoundary(error)
                    }
                }
            }
        case .fin:
            guard !guestCloseReceived else {
                beginLocalReset(
                    code: "frame_after_guest_close",
                    message: "Guest sent LVRM FIN after its CLOSE commit"
                )
                return
            }
            guard !guestFinSent else {
                beginLocalReset(
                    code: "duplicate_guest_fin",
                    message: "Guest sent LVRM FIN more than once"
                )
                return
            }
            readBuffer.removeAll(keepingCapacity: true)
            guestFinSent = true
            inboundEmissionInFlight = true
            emit(
                CapsuleVmFrame(
                    kind: .streamFin,
                    streamID: registration.streamID,
                    payload: Data()
                )
            ) { [weak self] result in
                self?.ioQueue.async { [weak self] in
                    guard let self else { return }
                    self.inboundEmissionInFlight = false
                    switch result {
                    case .success:
                        guard !self.retired else { return }
                        self.guestFinDelivered = true
                        // FIN is directional. Keep reading until the Guest
                        // explicitly commits normal closure with CLOSE or
                        // reports RESET.
                        self.scheduleReadIfPossible()
                        self.finishNormalCloseIfReady()
                    case .failure(let error):
                        guard !self.isIntentionalResetSupersession(error) else {
                            return
                        }
                        self.failHelperBoundary(error)
                    }
                }
            }
        case .reset:
            readBuffer.removeAll(keepingCapacity: true)
            if guestCloseReceived {
                beginLocalReset(
                    code: "frame_after_guest_close",
                    message: "Guest sent LVRM RESET after its CLOSE commit"
                )
                return
            }
            beginLocalReset(
                code: "guest_vsock_relay_reset",
                message: "Guest terminated the private virtio-vsock relay"
            )
        case .close:
            readBuffer.removeAll(keepingCapacity: true)
            guard !guestCloseReceived else {
                beginLocalReset(
                    code: "duplicate_guest_close",
                    message: "Guest sent LVRM CLOSE more than once"
                )
                return
            }
            guard guestFinSent, hostFinApplied else {
                beginLocalReset(
                    code: "early_guest_close",
                    message: "Guest sent LVRM CLOSE before both directional FIN records completed"
                )
                return
            }
            guestCloseReceived = true
            finishNormalCloseIfReady()
            if !retired {
                // LCVM delivery of the Guest FIN may complete after this valid
                // LVRM CLOSE arrives. Record the peer's irrevocable commit and
                // keep reading while that callback advances local completion.
                scheduleReadIfPossible()
            }
        }
    }

    private func startNextWriteIfNeeded() {
        guard !retired, !transportClosed, writeInFlight == nil else { return }

        if peerResetReceived {
            guard !hostResetWriteStarted else { return }
            do {
                let encoded = try CapsuleVmRelayFrameCodec.encode(
                    CapsuleVmRelayFrame(kind: .reset)
                )
                hostResetWriteStarted = true
                startRelayWrite(RelayWrite(
                    bytes: encoded.withUnsafeBytes { DispatchData(bytes: $0) },
                    kind: .reset
                ))
            } catch {
                closeTransport()
                emitPeerResetAck()
            }
            return
        }

        if !pendingDataWrites.isEmpty {
            let payload = pendingDataWrites.removeFirst()
            do {
                let encoded = try CapsuleVmRelayFrameCodec.encode(
                    CapsuleVmRelayFrame(kind: .data, payload: payload)
                )
                startRelayWrite(RelayWrite(
                    bytes: encoded.withUnsafeBytes { DispatchData(bytes: $0) },
                    kind: .data(payloadByteCount: payload.count)
                ))
            } catch {
                beginLocalReset(
                    code: "vsock_relay_encode_failed",
                    message: String(describing: error)
                )
            }
            return
        }
        if hostFinReceived {
            finishHostFinIfReady()
            if hostFinApplied {
                finishNormalCloseIfReady()
            }
        }
    }

    private func startRelayWrite(_ write: RelayWrite) {
        writeInFlight = write
        io.write(offset: 0, data: write.bytes, queue: ioQueue) {
            [weak self] done, _, errorCode in
            guard let self, !self.retired, !self.transportClosed else { return }
            if errorCode != 0 {
                self.writeInFlight = nil
                if self.peerResetReceived {
                    self.closeTransport()
                    self.emitPeerResetAck()
                } else {
                    self.beginLocalReset(
                        code: "vsock_write_failed",
                        message: String(cString: strerror(errorCode))
                    )
                }
                return
            }
            guard done else { return }

            if case .close = write.kind {
                self.closeWriteCompletionScheduler { [weak self] in
                    self?.ioQueue.async { [weak self] in
                        guard let self, !self.retired, !self.transportClosed else { return }
                        self.applyCompletedRelayWrite(write)
                    }
                }
            } else {
                self.applyCompletedRelayWrite(write)
            }
        }
    }

    private func applyCompletedRelayWrite(_ write: RelayWrite) {
        writeInFlight = nil
        switch write.kind {
        case .data(let payloadByteCount):
            pendingWriteBytes -= payloadByteCount
            hostToGuestCredit += payloadByteCount
            guard hostToGuestCredit
                    <= CapsuleVmProtocol.initialStreamWindowByteCount else {
                beginLocalReset(
                    code: "host_credit_overflow",
                    message: "Host-to-Guest credit exceeded the fixed LCVM window"
                )
                return
            }

            // Return credit for every DATA record which physically reached the
            // Guest, including one whose completion races an already-admitted
            // Host FIN. Electron retains a normally finished LCVM stream until
            // this exact credit drain completes, so callback ordering cannot
            // turn the final WINDOW_UPDATE into a frame for a retired stream.
            // RESET remains terminal and never waits for or emits more credit.
            if !localResetSent, !peerResetReceived {
                do {
                    let payload = try CapsuleVmFrameCodec.windowUpdatePayload(
                        byteCount: payloadByteCount
                    )
                    emit(
                        CapsuleVmFrame(
                            kind: .streamWindowUpdate,
                            streamID: registration.streamID,
                            payload: payload
                        )
                    ) { [weak self] result in
                        if case .failure(let error) = result {
                            self?.ioQueue.async { [weak self] in
                                self?.failHelperBoundary(error)
                            }
                        }
                    }
                } catch {
                    beginLocalReset(
                        code: "vsock_credit_encode_failed",
                        message: String(describing: error)
                    )
                    return
                }
            }
            startNextWriteIfNeeded()
        case .fin:
            hostFinApplied = true
            if peerResetReceived {
                startNextWriteIfNeeded()
            } else {
                finishNormalCloseIfReady()
            }
        case .reset:
            closeTransport()
            emitPeerResetAck()
        case .close:
            physicalTerminationDeferredForClose = false
            localCloseSent = true
            finishNormalCloseIfReady()
            if !retired {
                scheduleReadIfPossible()
            }
        }
    }

    private func finishHostFinIfReady() {
        guard hostFinReceived,
              !hostFinApplied,
              writeInFlight == nil,
              pendingDataWrites.isEmpty,
              !peerResetReceived,
              !transportClosed else { return }
        do {
            let encoded = try CapsuleVmRelayFrameCodec.encode(
                CapsuleVmRelayFrame(kind: .fin)
            )
            startRelayWrite(RelayWrite(
                bytes: encoded.withUnsafeBytes { DispatchData(bytes: $0) },
                kind: .fin
            ))
        } catch {
            beginLocalReset(
                code: "vsock_fin_failed",
                message: String(describing: error)
            )
        }
    }

    private func finishNormalCloseIfReady() {
        guard !retired,
              !transportClosed,
              !localResetSent,
              !peerResetReceived else { return }

        if localCloseSent, guestCloseReceived {
            // Both endpoints have made their irrevocable normal-close commit.
            // Bytes ordered after peer CLOSE are outside the completed stream;
            // do not add a timing-sensitive raw-socket grace period here.
            retire(notifyOwner: true, retainResetTombstone: false)
            return
        }
        guard hostFinApplied,
              guestFinDelivered,
              !localCloseWriteStarted,
              writeInFlight == nil,
              pendingDataWrites.isEmpty else { return }

        do {
            let encoded = try CapsuleVmRelayFrameCodec.encode(
                CapsuleVmRelayFrame(kind: .close)
            )
            // Starting this write is Swift's irrevocable normal-close commit.
            // A later Host RESET cannot be represented without violating the
            // already-ordered CLOSE record and is therefore rejected.
            localCloseWriteStarted = true
            startRelayWrite(RelayWrite(
                bytes: encoded.withUnsafeBytes { DispatchData(bytes: $0) },
                kind: .close
            ))
        } catch {
            beginLocalReset(
                code: "vsock_close_failed",
                message: String(describing: error)
            )
        }
    }

    private func beginLocalReset(code: String, message: String) {
        guard !retired, !localResetSent, !peerResetReceived else { return }
        if localCloseWriteStarted {
            // CLOSE is an irrevocable normal-close commit. Once it has started,
            // a later relay fault cannot be represented by ordering RESET
            // behind it. Close the physical transport and fail the complete
            // helper boundary instead of synthesizing an impossible stream
            // history.
            let error = CapsuleVmProtocolError(code: code, message: message)
            retire(notifyOwner: true, retainResetTombstone: false)
            onProtocolFailure(error)
            return
        }
        localResetSent = true
        closeTransport()
        emit(
            CapsuleVmFrame(
                kind: .streamReset,
                streamID: registration.streamID,
                payload: makeResetPayload(code: code, message: message)
            )
        ) { [weak self] result in
            if case .failure(let error) = result {
                self?.ioQueue.async { [weak self] in
                    self?.failHelperBoundary(error)
                }
            }
        }
    }

    private func emitPeerResetAck() {
        guard peerResetReceived, !peerResetAckDelivered, !retired else { return }
        emit(
            CapsuleVmFrame(
                kind: .streamResetAck,
                streamID: registration.streamID,
                payload: Data()
            )
        ) { [weak self] emission in
            self?.ioQueue.async { [weak self] in
                guard let self else { return }
                switch emission {
                case .success:
                    guard !self.retired else { return }
                    self.peerResetAckDelivered = true
                    if !self.localResetSent || self.localResetAcknowledged {
                        self.retire(
                            notifyOwner: true,
                            retainResetTombstone: true
                        )
                    }
                case .failure(let error):
                    self.failHelperBoundary(error)
                }
            }
        }
    }

    private func isIntentionalResetSupersession(_ error: Error) -> Bool {
        guard localResetSent || peerResetReceived,
              let protocolError = error as? CapsuleVmProtocolError else {
            return false
        }
        return protocolError.code == "stream_reset"
    }

    private func failHelperBoundary(_ error: Error) {
        guard !boundaryFailureReported else { return }
        boundaryFailureReported = true
        retire(notifyOwner: true, retainResetTombstone: false)
        onProtocolFailure(error)
    }

    private func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        let schedulingClass: CapsuleVmFrameSchedulingClass =
            registration.channel == .control && frame.kind == .streamData
            ? .controlData
            : .automatic
        emitter.emit(frame, schedulingClass: schedulingClass, completion: completion)
    }

    private func closeTransport() {
        guard !transportClosed else { return }
        transportClosed = true
        Darwin.shutdown(fileDescriptor, SHUT_RDWR)
        io.close(flags: .stop)
        pendingDataWrites.removeAll()
        pendingWriteBytes = 0
        writeInFlight = nil
        readOperationActive = false
        inboundEmissionInFlight = false
        readBuffer.removeAll()
    }

    private func retire(notifyOwner: Bool, retainResetTombstone: Bool) {
        guard !retired else { return }
        retired = true
        closeTransport()
        if notifyOwner {
            onFullyClosed(registration.streamID, retainResetTombstone)
        }
    }
}
