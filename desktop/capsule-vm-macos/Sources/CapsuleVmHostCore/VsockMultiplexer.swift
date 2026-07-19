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
    case duplicateStreamEnd(UInt32)
    case dataAfterEnd(UInt32)
    case chunkTooLarge(Int)
    case pendingWriteLimit(UInt32)
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
        case .duplicateStreamEnd(let streamID):
            return "Host ended stream \(streamID) more than once"
        case .dataAfterEnd(let streamID):
            return "Host sent data after ending stream \(streamID)"
        case .chunkTooLarge(let byteCount):
            return "Stream chunk exceeds the \(CapsuleVmProtocol.streamChunkByteCount)-byte limit: \(byteCount)"
        case .pendingWriteLimit(let streamID):
            return "Stream \(streamID) exceeded its bounded pending-write limit"
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

/// Guest→Host virtio-vsock relay. Swift owns the VZ connection file descriptors;
/// Electron sees only bounded LCVM byte-stream frames over helper stdio.
public final class CapsuleVmVsockMultiplexer: NSObject, VZVirtioSocketListenerDelegate, @unchecked Sendable {
    public static let maximumPendingWriteBytesPerStream = 1 * 1_024 * 1_024

    private struct ActiveStream {
        let connection: VZVirtioSocketConnection
        let relay: CapsuleVmVsockRelay
    }

    private let vmQueue: DispatchQueue
    private let emitter: CapsuleVmFrameEmitter
    private let registry: CapsuleVmStreamRegistry
    private let listener = VZVirtioSocketListener()
    private var socketDevice: VZVirtioSocketDevice?
    private var streams: [UInt32: ActiveStream] = [:]
    private var installed = false

    public init(
        vmQueue: DispatchQueue,
        emitter: CapsuleVmFrameEmitter,
        registry: CapsuleVmStreamRegistry = CapsuleVmStreamRegistry()
    ) {
        self.vmQueue = vmQueue
        self.emitter = emitter
        self.registry = registry
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
            maximumPendingWriteBytes: Self.maximumPendingWriteBytesPerStream,
            onFullyClosed: { [weak self] streamID in
                self?.vmQueue.async { [weak self] in
                    self?.finishStream(streamID)
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
        guard CapsuleVmProtocol.isHelperStreamID(frame.streamID) else {
            throw CapsuleVmStreamMuxError.invalidStreamID(frame.streamID)
        }
        var result: Result<Void, Error> = .success(())
        vmQueue.sync {
            do {
                guard let relay = streams[frame.streamID]?.relay else {
                    throw CapsuleVmStreamMuxError.unknownStream(frame.streamID)
                }
                switch frame.kind {
                case .streamData:
                    try relay.enqueueWrite(frame.payload)
                case .streamEnd:
                    guard frame.payload.count <= 4 * 1_024 else {
                        throw CapsuleVmStreamMuxError.chunkTooLarge(frame.payload.count)
                    }
                    if frame.payload.isEmpty {
                        try relay.endWriting()
                    } else {
                        try validateAbortPayload(frame.payload)
                        abortStream(frame.streamID)
                    }
                default:
                    throw CapsuleVmProtocolError(
                        code: "unexpected_frame_kind",
                        message: "vsock mux accepts streamData and streamEnd only"
                    )
                }
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
    }

    public func closeAll(code: String, message: String) {
        if installed, let socketDevice {
            socketDevice.removeSocketListener(forPort: CapsuleVmProtocol.controlVsockPort)
            socketDevice.removeSocketListener(forPort: CapsuleVmProtocol.dataVsockPort)
        }
        installed = false
        self.socketDevice = nil

        let payload = (try? JSONSerialization.data(
            withJSONObject: ["code": code, "message": message],
            options: [.sortedKeys]
        )) ?? Data()
        for (streamID, active) in streams {
            // A relay can remain registered briefly after it has enqueued its
            // clean read-side StreamEnd. Closing the VM in that window must not
            // enqueue a second terminal End for the same direction: the Host may
            // already have completed both halves and retired the stream ID.
            // Synchronizing on the relay queue also prevents a pending read
            // callback from racing a new End behind this boundary close.
            if active.relay.closeForBoundary() {
                emitter.emit(
                    CapsuleVmFrame(kind: .streamEnd, streamID: streamID, payload: payload)
                ) { _ in }
            }
            active.connection.close()
            registry.remove(streamID: streamID)
        }
        streams.removeAll()
        registry.removeAll()
    }

    private func finishStream(_ streamID: UInt32) {
        guard let active = streams.removeValue(forKey: streamID) else { return }
        active.relay.forceClose()
        active.connection.close()
        registry.remove(streamID: streamID)
    }

    private func abortStream(_ streamID: UInt32) {
        guard let active = streams.removeValue(forKey: streamID) else { return }
        registry.remove(streamID: streamID)
        active.relay.forceClose()
        active.connection.close()
        emitter.emit(
            CapsuleVmFrame(kind: .streamEnd, streamID: streamID, payload: Data())
        ) { _ in }
    }
}

private func validateAbortPayload(_ data: Data) throws {
    let value: Any
    do {
        value = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw CapsuleVmProtocolError(
            code: "invalid_stream_end",
            message: "Host stream abort payload is not valid JSON"
        )
    }
    guard let object = value as? [String: Any],
          Set(object.keys) == ["code", "message"],
          let code = object["code"] as? String,
          !code.isEmpty,
          let message = object["message"] as? String,
          !message.isEmpty else {
        throw CapsuleVmProtocolError(
            code: "invalid_stream_end",
            message: "Host stream abort payload is invalid"
        )
    }
}

final class CapsuleVmVsockRelay: @unchecked Sendable {
    private let registration: CapsuleVmStreamRegistration
    private let fileDescriptor: Int32
    private let emitter: CapsuleVmFrameEmitter
    private let maximumPendingWriteBytes: Int
    private let onFullyClosed: @Sendable (UInt32) -> Void
    private let ioQueue: DispatchQueue
    private let io: DispatchIO

    private var pendingWrites: [DispatchData] = []
    private var pendingWriteBytes = 0
    private var writeInFlight = false
    private var localEnded = false
    private var remoteEnded = false
    private var readStarted = false
    private var ioSuspended = false
    private var terminalEndPending = false
    private var closed = false

    init(
        registration: CapsuleVmStreamRegistration,
        fileDescriptor: Int32,
        emitter: CapsuleVmFrameEmitter,
        maximumPendingWriteBytes: Int,
        onFullyClosed: @escaping @Sendable (UInt32) -> Void
    ) {
        self.registration = registration
        self.fileDescriptor = fileDescriptor
        self.emitter = emitter
        self.maximumPendingWriteBytes = maximumPendingWriteBytes
        self.onFullyClosed = onFullyClosed
        self.ioQueue = DispatchQueue(
            label: "app.lamarck.capsule-vm.vsock.\(registration.streamID)"
        )
        self.io = DispatchIO(
            type: .stream,
            fileDescriptor: fileDescriptor,
            queue: ioQueue
        ) { _ in }
        io.setLimit(highWater: CapsuleVmProtocol.streamChunkByteCount)
        io.setLimit(lowWater: 1)
    }

    func startReading() {
        ioQueue.async { [self] in
            guard !closed, !readStarted else { return }
            readStarted = true
            scheduleRead()
        }
    }

    func enqueueWrite(_ data: Data) throws {
        guard data.count <= CapsuleVmProtocol.streamChunkByteCount else {
            throw CapsuleVmStreamMuxError.chunkTooLarge(data.count)
        }
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            do {
                guard !closed else {
                    throw CapsuleVmStreamMuxError.unknownStream(registration.streamID)
                }
                guard !terminalEndPending else {
                    throw CapsuleVmStreamMuxError.socketUnavailable("stream is closing")
                }
                guard !localEnded else {
                    throw CapsuleVmStreamMuxError.dataAfterEnd(registration.streamID)
                }
                guard data.count <= maximumPendingWriteBytes - pendingWriteBytes else {
                    throw CapsuleVmStreamMuxError.pendingWriteLimit(registration.streamID)
                }
                let dispatchData = data.withUnsafeBytes { DispatchData(bytes: $0) }
                pendingWrites.append(dispatchData)
                pendingWriteBytes += data.count
                startNextWriteIfNeeded()
            } catch {
                result = .failure(error)
            }
        }
        try result.get()
    }

    func endWriting() throws {
        var result: Result<Void, Error> = .success(())
        ioQueue.sync { [self] in
            if closed {
                result = .failure(CapsuleVmStreamMuxError.unknownStream(registration.streamID))
            } else if terminalEndPending {
                result = .failure(CapsuleVmStreamMuxError.socketUnavailable("stream is closing"))
            } else if localEnded {
                result = .failure(CapsuleVmStreamMuxError.duplicateStreamEnd(registration.streamID))
            } else {
                localEnded = true
                finishLocalEndIfReady()
            }
        }
        try result.get()
    }

    func forceClose() {
        ioQueue.async { [self] in closeInternal(notifyOwner: false) }
    }

    /// Atomically closes the relay for a VM boundary transition and reports
    /// whether the mux still owes the Host its one read-side StreamEnd.
    func closeForBoundary() -> Bool {
        var shouldEmitEnd = false
        ioQueue.sync { [self] in
            guard !closed else { return }
            shouldEmitEnd = !remoteEnded && !terminalEndPending
            closeInternal(notifyOwner: false)
        }
        return shouldEmitEnd
    }

    /// Test-only barrier for deterministically observing callbacks already
    /// submitted to the relay's serial I/O queue.
    func synchronizeIOQueueForTesting() {
        ioQueue.sync {}
    }

    private func scheduleRead() {
        guard !closed, !remoteEnded, !terminalEndPending else { return }
        io.read(
            offset: 0,
            length: CapsuleVmProtocol.streamChunkByteCount,
            queue: ioQueue
        ) { [weak self] done, dispatchData, errorCode in
            guard let self, !closed, !terminalEndPending else { return }
            if errorCode != 0 {
                failRemote(code: "vsock_read_failed", message: String(cString: strerror(errorCode)))
                return
            }

            let data = dispatchData.map { Data($0) } ?? Data()
            if !data.isEmpty {
                guard data.count <= CapsuleVmProtocol.streamChunkByteCount else {
                    failRemote(code: "vsock_chunk_too_large", message: "Guest stream chunk exceeded limit")
                    return
                }
                io.suspend()
                ioSuspended = true
                emitter.emit(
                    CapsuleVmFrame(
                        kind: .streamData,
                        streamID: registration.streamID,
                        payload: data
                    )
                ) { [weak self] result in
                    self?.ioQueue.async { [weak self] in
                        guard let self, !self.closed else { return }
                        switch result {
                        case .success:
                            self.io.resume()
                            self.ioSuspended = false
                            if done { self.scheduleRead() }
                        case .failure:
                            self.closeInternal(notifyOwner: true)
                        }
                    }
                }
                return
            }

            if done {
                remoteEnded = true
                emitter.emit(
                    CapsuleVmFrame(
                        kind: .streamEnd,
                        streamID: registration.streamID,
                        payload: Data()
                    )
                ) { [weak self] result in
                    self?.ioQueue.async { [weak self] in
                        guard let self, !self.closed else { return }
                        if case .failure = result {
                            self.closeInternal(notifyOwner: true)
                        } else if self.localEnded {
                            self.closeInternal(notifyOwner: true)
                        }
                    }
                }
            }
        }
    }

    private func startNextWriteIfNeeded() {
        guard !closed, !terminalEndPending, !writeInFlight else { return }
        guard let data = pendingWrites.first else {
            finishLocalEndIfReady()
            return
        }
        writeInFlight = true
        io.write(offset: 0, data: data, queue: ioQueue) { [weak self] done, _, errorCode in
            guard let self, !closed else { return }
            if errorCode != 0 {
                failRemote(code: "vsock_write_failed", message: String(cString: strerror(errorCode)))
                return
            }
            guard done else { return }
            let completed = pendingWrites.removeFirst()
            pendingWriteBytes -= completed.count
            writeInFlight = false
            startNextWriteIfNeeded()
        }
    }

    private func finishLocalEndIfReady() {
        guard localEnded, !writeInFlight, pendingWrites.isEmpty else { return }
        Darwin.shutdown(fileDescriptor, SHUT_WR)
        if remoteEnded { closeInternal(notifyOwner: true) }
    }

    private func failRemote(code: String, message: String) {
        guard !closed, !terminalEndPending else { return }
        terminalEndPending = true
        let payload = (try? JSONSerialization.data(
            withJSONObject: ["code": code, "message": message],
            options: [.sortedKeys]
        )) ?? Data()
        emitter.emit(
            CapsuleVmFrame(
                kind: .streamEnd,
                streamID: registration.streamID,
                payload: payload
            )
        ) { [weak self] _ in
            self?.ioQueue.async { [weak self] in self?.closeInternal(notifyOwner: true) }
        }
    }

    private func closeInternal(notifyOwner: Bool) {
        guard !closed else { return }
        closed = true
        if ioSuspended {
            io.resume()
            ioSuspended = false
        }
        Darwin.shutdown(fileDescriptor, SHUT_RDWR)
        io.close(flags: .stop)
        pendingWrites.removeAll()
        pendingWriteBytes = 0
        if notifyOwner { onFullyClosed(registration.streamID) }
    }
}
