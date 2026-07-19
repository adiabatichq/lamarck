import Foundation

public protocol CapsuleVmFrameEmitter: AnyObject, Sendable {
    func emit(
        _ frame: CapsuleVmFrame,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    )
}

/// Serializes every helper frame onto stdout and applies a hard memory bound
/// before touching the blocking pipe. stdout must never carry console text.
public final class CapsuleVmFrameWriter: CapsuleVmFrameEmitter, @unchecked Sendable {
    public static let defaultMaximumPendingByteCount = 8 * 1024 * 1024

    private let output: FileHandle
    private let outputQueue: DispatchQueue
    private let lock = NSLock()
    private let maximumPendingByteCount: Int
    private var pendingByteCount = 0
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
        let encoded: Data
        do {
            encoded = try CapsuleVmFrameCodec.encode(frame)
        } catch {
            completion(.failure(error))
            return
        }

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
            terminalError = error
            lock.unlock()
            completion(.failure(error))
            return
        }
        pendingByteCount += encoded.count
        lock.unlock()

        outputQueue.async { [self] in
            let result: Result<Void, Error>
            do {
                try output.write(contentsOf: encoded)
                result = .success(())
            } catch {
                lock.lock()
                if terminalError == nil { terminalError = error }
                lock.unlock()
                result = .failure(error)
            }

            lock.lock()
            pendingByteCount -= encoded.count
            lock.unlock()
            completion(result)
        }
    }

    public func finish() {
        outputQueue.sync {}
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
