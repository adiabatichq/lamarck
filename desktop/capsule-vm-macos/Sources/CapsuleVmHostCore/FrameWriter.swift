import Foundation

public protocol CapsuleVmFrameEmitter: AnyObject, Sendable {
    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    )
}

/// A local scheduling hint. It is never serialized onto the LCVM wire.
public enum CapsuleVmFrameSchedulingClass: Sendable {
    case automatic
    case controlData
}

public protocol CapsuleVmPrioritizedFrameEmitter: CapsuleVmFrameEmitter {
    func emit(
        _ frame: CapsuleVmFrame,
        schedulingClass: CapsuleVmFrameSchedulingClass,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    )
}

public extension CapsuleVmFrameEmitter {
    func emit(
        _ frame: CapsuleVmFrame,
        schedulingClass: CapsuleVmFrameSchedulingClass,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        if let prioritized = self as? any CapsuleVmPrioritizedFrameEmitter {
            prioritized.emit(frame, schedulingClass: schedulingClass, completion: completion)
        } else {
            emit(frame, completion: completion)
        }
    }
}

/// Serializes helper frames onto stdout through three bounded scheduling lanes:
/// protocol frames first, CONTROL-channel DATA second, and round-robin ordinary
/// DATA last. At most the single DATA frame already being written can precede a
/// newly queued command response, WINDOW_UPDATE, FIN, RESET, or RESET_ACK.
public final class CapsuleVmFrameWriter: CapsuleVmPrioritizedFrameEmitter, @unchecked Sendable {
    public static let defaultMaximumPendingByteCount = 8 * 1024 * 1024

    private struct PendingFrame: Sendable {
        let frame: CapsuleVmFrame
        let encoded: Data
        let completion: @Sendable (Result<Void, Error>) -> Void
    }

    private let output: FileHandle
    private let outputQueue: DispatchQueue
    private let lock = NSLock()
    private let pendingGroup = DispatchGroup()
    private let maximumPendingByteCount: Int

    private var protocolFrames: [PendingFrame] = []
    private var controlDataFrames: [PendingFrame] = []
    private var dataFramesByStream: [UInt32: [PendingFrame]] = [:]
    private var finFramesByStream: [UInt32: PendingFrame] = [:]
    private var dataStreamOrder: [UInt32] = []
    private var lastDataStreamID: UInt32?
    private var inFlightDataStreamID: UInt32?
    private var pendingByteCount = 0
    private var writeInFlight = false
    private var terminalError: Error?

    public init(
        output: FileHandle,
        maximumPendingByteCount: Int = CapsuleVmFrameWriter.defaultMaximumPendingByteCount,
        queue: DispatchQueue = DispatchQueue(label: "app.lamarck.capsule-vm.frame-output")
    ) {
        precondition(maximumPendingByteCount > CapsuleVmProtocol.headerByteCount)
        self.output = output
        self.maximumPendingByteCount = maximumPendingByteCount
        self.outputQueue = queue
    }

    public func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        emit(frame, schedulingClass: .automatic, completion: completion)
    }

    public func emit(
        _ frame: CapsuleVmFrame,
        schedulingClass: CapsuleVmFrameSchedulingClass,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        let encoded: Data
        do {
            encoded = try CapsuleVmFrameCodec.encode(frame)
        } catch {
            completion(.failure(error))
            return
        }

        let pending = PendingFrame(frame: frame, encoded: encoded, completion: completion)
        var next: PendingFrame?
        var superseded: [PendingFrame] = []

        lock.lock()
        if let terminalError {
            lock.unlock()
            completion(.failure(terminalError))
            return
        }
        guard encoded.count <= maximumPendingByteCount - pendingByteCount else {
            let error = CapsuleVmProtocolError(
                code: "output_backpressure_limit",
                message: "VM helper output exceeded its bounded pending-byte limit"
            )
            lock.unlock()
            completion(.failure(error))
            return
        }

        pendingGroup.enter()
        pendingByteCount += encoded.count
        superseded = enqueueLocked(pending, schedulingClass: schedulingClass)
        if !writeInFlight {
            next = dequeueNextLocked()
        }
        lock.unlock()

        if !superseded.isEmpty {
            let error = CapsuleVmProtocolError(
                code: "stream_reset",
                message: "Queued stream output was superseded by RESET"
            )
            for frame in superseded {
                frame.completion(.failure(error))
                pendingGroup.leave()
            }
        }

        if let next { write(next) }
    }

    public func finish() {
        pendingGroup.wait()
        outputQueue.sync {}
    }

    private func enqueueLocked(
        _ pending: PendingFrame,
        schedulingClass: CapsuleVmFrameSchedulingClass
    ) -> [PendingFrame] {
        if pending.frame.kind == .streamReset
            || pending.frame.kind == .streamResetAck {
            let superseded = removeQueuedStreamPayloadLocked(streamID: pending.frame.streamID)
            pendingByteCount -= superseded.reduce(0) { $0 + $1.encoded.count }
            protocolFrames.append(pending)
            return superseded
        }
        if pending.frame.kind == .streamFin {
            if hasQueuedOrInFlightDataLocked(streamID: pending.frame.streamID) {
                finFramesByStream[pending.frame.streamID] = pending
            } else {
                protocolFrames.append(pending)
            }
            return []
        }
        if pending.frame.kind != .streamData {
            protocolFrames.append(pending)
            return []
        }
        if schedulingClass == .controlData {
            controlDataFrames.append(pending)
            return []
        }

        let streamID = pending.frame.streamID
        if dataFramesByStream[streamID] == nil {
            dataFramesByStream[streamID] = []
            dataStreamOrder.append(streamID)
        }
        dataFramesByStream[streamID]?.append(pending)
        return []
    }

    private func dequeueNextLocked() -> PendingFrame? {
        precondition(!writeInFlight)

        let selected: PendingFrame?
        if !protocolFrames.isEmpty {
            selected = protocolFrames.removeFirst()
        } else if !controlDataFrames.isEmpty {
            selected = controlDataFrames.removeFirst()
        } else {
            selected = dequeueRoundRobinDataLocked()
        }

        if selected != nil { writeInFlight = true }
        inFlightDataStreamID = selected?.frame.kind == .streamData
            ? selected?.frame.streamID
            : nil
        return selected
    }

    private func dequeueRoundRobinDataLocked() -> PendingFrame? {
        guard !dataStreamOrder.isEmpty else { return nil }

        let selectedIndex: Int
        if let lastDataStreamID,
           let lastIndex = dataStreamOrder.firstIndex(of: lastDataStreamID),
           dataStreamOrder.count > 1 {
            selectedIndex = (lastIndex + 1) % dataStreamOrder.count
        } else {
            selectedIndex = 0
        }

        let streamID = dataStreamOrder[selectedIndex]
        guard var queue = dataFramesByStream[streamID], !queue.isEmpty else {
            preconditionFailure("DATA scheduler referenced an empty stream queue")
        }

        let selected = queue.removeFirst()
        lastDataStreamID = streamID
        if queue.isEmpty {
            dataFramesByStream.removeValue(forKey: streamID)
            dataStreamOrder.remove(at: selectedIndex)
        } else {
            dataFramesByStream[streamID] = queue
        }
        return selected
    }

    private func write(_ pending: PendingFrame) {
        outputQueue.async { [self] in
            let result: Result<Void, Error>
            do {
                try output.write(contentsOf: pending.encoded)
                result = .success(())
            } catch {
                result = .failure(error)
            }

            var next: PendingFrame?
            var dropped: [PendingFrame] = []

            lock.lock()
            switch result {
            case .success:
                pendingByteCount -= pending.encoded.count
                inFlightDataStreamID = nil
                writeInFlight = false
                if pending.frame.kind == .streamData {
                    promoteFinIfReadyLocked(streamID: pending.frame.streamID)
                }
                next = dequeueNextLocked()
            case .failure(let error):
                if terminalError == nil { terminalError = error }
                dropped = drainQueuedFramesLocked()
                pendingByteCount = 0
                writeInFlight = false
            }
            lock.unlock()

            pending.completion(result)
            pendingGroup.leave()

            if case .failure(let error) = result {
                for frame in dropped {
                    frame.completion(.failure(error))
                    pendingGroup.leave()
                }
            }

            if let next { write(next) }
        }
    }

    private func drainQueuedFramesLocked() -> [PendingFrame] {
        var result = protocolFrames
        result.append(contentsOf: controlDataFrames)
        for streamID in dataStreamOrder {
            result.append(contentsOf: dataFramesByStream[streamID] ?? [])
        }
        result.append(contentsOf: finFramesByStream.values)
        protocolFrames.removeAll()
        controlDataFrames.removeAll()
        dataFramesByStream.removeAll()
        finFramesByStream.removeAll()
        dataStreamOrder.removeAll()
        return result
    }

    private func hasQueuedOrInFlightDataLocked(streamID: UInt32) -> Bool {
        if inFlightDataStreamID == streamID { return true }
        if dataFramesByStream[streamID]?.isEmpty == false { return true }
        return controlDataFrames.contains {
            $0.frame.kind == .streamData && $0.frame.streamID == streamID
        }
    }

    private func promoteFinIfReadyLocked(streamID: UInt32) {
        guard !hasQueuedOrInFlightDataLocked(streamID: streamID),
              let fin = finFramesByStream.removeValue(forKey: streamID) else { return }
        protocolFrames.append(fin)
    }

    private func removeQueuedStreamPayloadLocked(streamID: UInt32) -> [PendingFrame] {
        var removed: [PendingFrame] = []
        var retainedProtocol: [PendingFrame] = []
        for frame in protocolFrames {
            if frame.frame.kind == .streamFin && frame.frame.streamID == streamID {
                removed.append(frame)
            } else {
                retainedProtocol.append(frame)
            }
        }
        protocolFrames = retainedProtocol

        if let frames = dataFramesByStream.removeValue(forKey: streamID) {
            removed.append(contentsOf: frames)
            dataStreamOrder.removeAll { $0 == streamID }
        }

        var retainedControl: [PendingFrame] = []
        for frame in controlDataFrames {
            if frame.frame.streamID == streamID {
                removed.append(frame)
            } else {
                retainedControl.append(frame)
            }
        }
        controlDataFrames = retainedControl

        if let fin = finFramesByStream.removeValue(forKey: streamID) {
            removed.append(fin)
        }
        return removed
    }
}

/// Deterministic sink used by state-machine and stream-policy tests.
public final class RecordingCapsuleVmFrameEmitter: CapsuleVmFrameEmitter, @unchecked Sendable {
    private let lock = NSLock()
    private var storedFrames: [CapsuleVmFrame] = []
    public var error: Error?

    public init() {}

    public var frames: [CapsuleVmFrame] {
        lock.lock()
        defer { lock.unlock() }
        return storedFrames
    }

    public func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        lock.lock()
        let currentError = error
        if currentError == nil { storedFrames.append(frame) }
        lock.unlock()
        if let currentError {
            completion(.failure(currentError))
        } else {
            completion(.success(()))
        }
    }
}
