import Foundation
@preconcurrency import Virtualization

public enum CapsuleVmLifecycleState: String, Equatable, Sendable {
    case idle
    case starting
    case running
    case stopping
    case stopped
    case failed

    var acceptsHostStreamFrames: Bool {
        self == .starting || self == .running || self == .stopping
    }
}

public enum CapsuleVmLifecycleError: Error, Equatable, CustomStringConvertible, Sendable {
    case invalidTransition(from: CapsuleVmLifecycleState, operation: String)
    case startCancelled
    case virtualizationUnavailable
    case missingSocketDevice
    case virtualMachineFailed(String)
    case sessionUnavailable
    case statePreparationUnavailable

    public var description: String {
        switch self {
        case .invalidTransition(let state, let operation):
            return "Cannot \(operation) Capsule VM while state is \(state.rawValue)"
        case .startCancelled:
            return "Capsule VM start was cancelled"
        case .virtualizationUnavailable:
            return "Virtualization.framework is unavailable on this Host"
        case .missingSocketDevice:
            return "Capsule VM did not expose its required virtio socket device"
        case .virtualMachineFailed(let message):
            return "Capsule VM failed: \(message)"
        case .sessionUnavailable:
            return "Capsule VM stream session is not running"
        case .statePreparationUnavailable:
            return "Capsule VM state preparation is unavailable, expired, or already consumed"
        }
    }
}

/// Small deterministic state reducer. VZ callbacks and commands all pass
/// through this reducer so duplicate or stale transitions fail closed.
public struct CapsuleVmLifecycle: Equatable, Sendable {
    public private(set) var state: CapsuleVmLifecycleState = .idle

    public init() {}

    public mutating func beginStart() throws {
        guard state == .idle || state == .stopped || state == .failed else {
            throw CapsuleVmLifecycleError.invalidTransition(from: state, operation: "start")
        }
        state = .starting
    }

    public mutating func didStart() throws {
        guard state == .starting else {
            throw CapsuleVmLifecycleError.invalidTransition(from: state, operation: "complete start")
        }
        state = .running
    }

    public mutating func beginStop() throws {
        switch state {
        case .starting, .running:
            state = .stopping
        case .stopping:
            return
        case .idle, .stopped:
            state = .stopped
        case .failed:
            state = .stopping
        }
    }

    public mutating func didStop() throws {
        guard state == .stopping || state == .running || state == .starting else {
            if state == .stopped { return }
            throw CapsuleVmLifecycleError.invalidTransition(from: state, operation: "complete stop")
        }
        state = .stopped
    }

    public mutating func didFail() {
        state = .failed
    }
}

public struct CapsuleVmStartDescriptor: Sendable {
    public let trustedImage: TrustedGuestImageDescriptor
    public let workspaceFilesURL: URL
    public let statePreparationID: String
    public let cpuCount: Int
    public let memorySize: UInt64

    public init(
        trustedImage: TrustedGuestImageDescriptor,
        workspaceFilesURL: URL,
        statePreparationID: String,
        cpuCount: Int,
        memorySize: UInt64
    ) {
        self.trustedImage = trustedImage
        self.workspaceFilesURL = workspaceFilesURL
        self.statePreparationID = statePreparationID
        self.cpuCount = cpuCount
        self.memorySize = memorySize
    }
}

public struct CapsuleVmStatePreparationDescriptor: Sendable {
    public let stateDirectoryURL: URL
    public let stateDiskBytes: UInt64

    public init(stateDirectoryURL: URL, stateDiskBytes: UInt64) {
        self.stateDirectoryURL = stateDirectoryURL
        self.stateDiskBytes = stateDiskBytes
    }
}

public struct CapsuleVmPreparedState: Equatable, Sendable {
    public let preparationID: String
    public let requirements: CapsuleVmStateDiskPreparationRequirements
}

public struct CapsuleVmStartedGuest: Equatable, Sendable {
    public let imageDigest: String
    public let architecture: CapsuleGuestArchitecture
}

public typealias CapsuleVmStartCompletion = @Sendable (Result<CapsuleVmStartedGuest, Error>) -> Void
public typealias CapsuleVmStopCompletion = @Sendable (Result<Void, Error>) -> Void
public typealias CapsuleVmPrepareStateCompletion = @Sendable (
    Result<CapsuleVmPreparedState, Error>
) -> Void
public typealias CapsuleVmCancelStateCompletion = @Sendable (Result<Void, Error>) -> Void

private struct CapsuleVmPreparedStart: @unchecked Sendable {
    let image: VerifiedGuestImage
    let stateDiskLease: CapsuleVmStateDiskLease
}

private struct CapsuleVmPendingStatePreparation: @unchecked Sendable {
    let id: String
    let preparation: CapsuleVmStateDiskPreparation
}

public protocol CapsuleVmSessionControlling: AnyObject, Sendable {
    func currentState() -> CapsuleVmLifecycleState
    func prepareState(
        descriptor: CapsuleVmStatePreparationDescriptor,
        completion: @escaping CapsuleVmPrepareStateCompletion
    )
    func cancelStatePreparation(
        id: String,
        completion: @escaping CapsuleVmCancelStateCompletion
    )
    func start(
        descriptor: CapsuleVmStartDescriptor,
        completion: @escaping CapsuleVmStartCompletion
    )
    func stop(completion: @escaping CapsuleVmStopCompletion)
    func acceptHostStreamFrame(_ frame: CapsuleVmFrame) throws
}

public final class CapsuleVmVirtualMachineSession: NSObject, CapsuleVmSessionControlling,
    VZVirtualMachineDelegate, @unchecked Sendable {

    private let vmQueue: DispatchQueue
    private let verificationQueue: DispatchQueue
    private let emitter: CapsuleVmFrameEmitter
    private let consoleOutput: FileHandle
    private let onFatalError: @Sendable (Error) -> Void
    private let statePreparationTTL: TimeInterval

    private var lifecycle = CapsuleVmLifecycle()
    private var bootGeneration: UInt64 = 0
    private var virtualMachine: VZVirtualMachine?
    private var multiplexer: CapsuleVmVsockMultiplexer?
    private var consoleRelay: CapsuleVmConsoleRelay?
    private var activeImage: VerifiedGuestImage?
    private let stateDiskLeaseHolder = CapsuleVmStateDiskLeaseHolder()
    private var pendingStatePreparation: CapsuleVmPendingStatePreparation?
    private var statePreparationInFlight = false
    private var statePreparationGeneration: UInt64 = 0
    private var pendingStart: CapsuleVmStartCompletion?
    private var pendingStops: [CapsuleVmStopCompletion] = []
    private var confirmedStopStreamDrainInFlight = false

    public init(
        emitter: CapsuleVmFrameEmitter,
        consoleOutput: FileHandle = .standardError,
        vmQueue: DispatchQueue = DispatchQueue(label: "app.lamarck.capsule-vm.machine"),
        verificationQueue: DispatchQueue = DispatchQueue(
            label: "app.lamarck.capsule-vm.image-verification",
            qos: .userInitiated
        ),
        statePreparationTTL: TimeInterval = 120,
        onFatalError: @escaping @Sendable (Error) -> Void = { _ in }
    ) {
        precondition(statePreparationTTL.isFinite && statePreparationTTL > 0)
        self.emitter = emitter
        self.consoleOutput = consoleOutput
        self.vmQueue = vmQueue
        self.verificationQueue = verificationQueue
        self.statePreparationTTL = statePreparationTTL
        self.onFatalError = onFatalError
        super.init()
    }

    public func currentState() -> CapsuleVmLifecycleState {
        vmQueue.sync { lifecycle.state }
    }

    public func prepareState(
        descriptor: CapsuleVmStatePreparationDescriptor,
        completion: @escaping CapsuleVmPrepareStateCompletion
    ) {
        vmQueue.async { [self] in
            guard !statePreparationInFlight,
                  pendingStatePreparation == nil,
                  !stateDiskLeaseHolder.hasLease,
                  virtualMachine == nil,
                  (lifecycle.state == .idle
                    || lifecycle.state == .stopped
                    || lifecycle.state == .failed) else {
                completion(.failure(CapsuleVmLifecycleError.invalidTransition(
                    from: lifecycle.state,
                    operation: "prepare state disk"
                )))
                return
            }

            statePreparationGeneration &+= 1
            let generation = statePreparationGeneration
            statePreparationInFlight = true
            verificationQueue.async { [weak self] in
                guard let self else { return }
                let result: Result<CapsuleVmStateDiskPreparation, Error>
                do {
                    result = .success(try CapsuleVmStateDiskManager.prepare(
                        in: descriptor.stateDirectoryURL,
                        size: descriptor.stateDiskBytes
                    ))
                } catch {
                    result = .failure(error)
                }
                self.vmQueue.async { [weak self] in
                    self?.finishStatePreparation(
                        result,
                        generation: generation,
                        completion: completion
                    )
                }
            }
        }
    }

    public func cancelStatePreparation(
        id: String,
        completion: @escaping CapsuleVmCancelStateCompletion
    ) {
        vmQueue.async { [self] in
            guard let pendingStatePreparation,
                  pendingStatePreparation.id == id else {
                completion(.failure(CapsuleVmLifecycleError.statePreparationUnavailable))
                return
            }
            self.pendingStatePreparation = nil
            statePreparationGeneration &+= 1
            do {
                try pendingStatePreparation.preparation.cancel()
                completion(.success(()))
            } catch {
                completion(.failure(error))
                onFatalError(error)
            }
        }
    }

    public func start(
        descriptor: CapsuleVmStartDescriptor,
        completion: @escaping CapsuleVmStartCompletion
    ) {
        vmQueue.async { [self] in
            guard let pendingStatePreparation,
                  pendingStatePreparation.id == descriptor.statePreparationID else {
                completion(.failure(CapsuleVmLifecycleError.statePreparationUnavailable))
                return
            }
            self.pendingStatePreparation = nil
            statePreparationGeneration &+= 1
            guard !stateDiskLeaseHolder.hasLease, virtualMachine == nil else {
                do {
                    try pendingStatePreparation.preparation.cancel()
                } catch {
                    onFatalError(error)
                }
                completion(.failure(CapsuleVmLifecycleError.invalidTransition(
                    from: lifecycle.state,
                    operation: "start while a prior VM state lease is retained"
                )))
                return
            }
            do {
                try lifecycle.beginStart()
            } catch {
                do {
                    try pendingStatePreparation.preparation.cancel()
                } catch let releaseError {
                    onFatalError(releaseError)
                }
                completion(.failure(error))
                return
            }
            guard VZVirtualMachine.isSupported else {
                do {
                    try pendingStatePreparation.preparation.cancel()
                } catch {
                    onFatalError(error)
                }
                lifecycle.didFail()
                emitState(.failed)
                completion(.failure(CapsuleVmLifecycleError.virtualizationUnavailable))
                return
            }

            bootGeneration &+= 1
            let generation = bootGeneration
            pendingStart = completion
            emitState(.starting)

            verificationQueue.async { [weak self] in
                guard let self else { return }
                let result: Result<CapsuleVmPreparedStart, Error>
                do {
                    let lease = try pendingStatePreparation.preparation.consume()
                    do {
                        let image = try GuestImageVerifier.verify(descriptor.trustedImage)
                        result = .success(CapsuleVmPreparedStart(
                            image: image,
                            stateDiskLease: lease
                        ))
                    } catch {
                        do {
                            try lease.release()
                            result = .failure(error)
                        } catch let releaseError {
                            result = .failure(releaseError)
                        }
                    }
                } catch {
                    result = .failure(error)
                }

                self.vmQueue.async { [weak self] in
                    self?.finishPreparation(
                        result,
                        descriptor: descriptor,
                        generation: generation
                    )
                }
            }
        }
    }

    public func stop(completion: @escaping CapsuleVmStopCompletion) {
        vmQueue.async { [self] in
            cancelPendingStatePreparation()
            switch lifecycle.state {
            case .idle, .stopped:
                try? lifecycle.beginStop()
                emitState(.stopped)
                completion(.success(()))

            case .failed:
                guard !stateDiskLeaseHolder.mustRetainUntilProcessExit else {
                    completion(.failure(CapsuleVmLifecycleError.sessionUnavailable))
                    return
                }
                pendingStops.append(completion)
                try? lifecycle.beginStop()
                emitState(.stopping)
                if let virtualMachine {
                    virtualMachine.stop { [weak self] error in
                        guard let self else { return }
                        guard self.virtualMachine === virtualMachine else { return }
                        if let error {
                            self.finishFailed(error, leaseOutcome: .stopFailed)
                        } else {
                            self.finishStopped()
                        }
                    }
                } else {
                    finishStopped()
                }

            case .starting:
                pendingStops.append(completion)
                try? lifecycle.beginStop()
                emitState(.stopping)
                pendingStart?(.failure(CapsuleVmLifecycleError.startCancelled))
                pendingStart = nil
                if virtualMachine == nil {
                    bootGeneration &+= 1
                    finishStopped()
                }

            case .running:
                pendingStops.append(completion)
                try? lifecycle.beginStop()
                emitState(.stopping)
                guard let virtualMachine else {
                    finishStopped()
                    return
                }
                virtualMachine.stop { [weak self] error in
                    guard let self else { return }
                    guard self.virtualMachine === virtualMachine else { return }
                    if let error {
                        finishFailed(error, leaseOutcome: .stopFailed)
                    } else {
                        finishStopped()
                    }
                }

            case .stopping:
                pendingStops.append(completion)
            }
        }
    }

    public func acceptHostStreamFrame(_ frame: CapsuleVmFrame) throws {
        var mux: CapsuleVmVsockMultiplexer?
        var state: CapsuleVmLifecycleState = .idle
        vmQueue.sync {
            state = lifecycle.state
            mux = multiplexer
        }
        // The listener belongs to the current verified VZ device and is
        // installed before `machine.start`. A fast Guest may therefore open
        // CONTROL and begin its authenticated handshake before VZ schedules the
        // start completion which advances this reducer to `.running`. The same
        // current mux remains authoritative while `.stopping` drains frames
        // already ordered around the asynchronous stop request; finishStopped
        // removes it before the lifecycle becomes inactive.
        guard state.acceptsHostStreamFrames, let mux else {
            throw CapsuleVmLifecycleError.sessionUnavailable
        }
        try mux.acceptHostFrame(frame)
    }

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        guard self.virtualMachine === virtualMachine,
              !stateDiskLeaseHolder.mustRetainUntilProcessExit else { return }
        if lifecycle.state == .stopping {
            finishStopped()
        } else {
            finishFailed(
                CapsuleVmLifecycleError.virtualMachineFailed("Guest stopped unexpectedly"),
                leaseOutcome: .confirmedStopped
            )
        }
    }

    public func virtualMachine(
        _ virtualMachine: VZVirtualMachine,
        didStopWithError error: any Error
    ) {
        guard self.virtualMachine === virtualMachine,
              !stateDiskLeaseHolder.mustRetainUntilProcessExit else { return }
        // This delegate callback confirms that VZ no longer owns the VM even
        // when it reports a stop diagnostic. During an explicit stop that is
        // sufficient to release the disk lease and complete teardown; treating
        // it as an unconfirmed stop would unnecessarily quarantine the Host.
        if lifecycle.state == .stopping {
            finishStopped()
        } else {
            finishFailed(error, leaseOutcome: .confirmedStopped)
        }
    }

    private func finishStatePreparation(
        _ result: Result<CapsuleVmStateDiskPreparation, Error>,
        generation: UInt64,
        completion: @escaping CapsuleVmPrepareStateCompletion
    ) {
        guard statePreparationInFlight else {
            if case .success(let preparation) = result {
                do {
                    try preparation.cancel()
                } catch {
                    onFatalError(error)
                }
            }
            completion(.failure(CapsuleVmLifecycleError.startCancelled))
            return
        }
        statePreparationInFlight = false
        guard generation == statePreparationGeneration else {
            if case .success(let preparation) = result {
                do {
                    try preparation.cancel()
                } catch {
                    onFatalError(error)
                }
            }
            completion(.failure(CapsuleVmLifecycleError.startCancelled))
            return
        }

        switch result {
        case .failure(let error):
            completion(.failure(error))

        case .success(let preparation):
            let id = UUID().uuidString.lowercased()
            pendingStatePreparation = CapsuleVmPendingStatePreparation(
                id: id,
                preparation: preparation
            )
            completion(.success(CapsuleVmPreparedState(
                preparationID: id,
                requirements: preparation.requirements
            )))
            vmQueue.asyncAfter(deadline: .now() + statePreparationTTL) { [weak self] in
                guard let self,
                      self.statePreparationGeneration == generation,
                      let pending = self.pendingStatePreparation,
                      pending.id == id else { return }
                self.pendingStatePreparation = nil
                self.statePreparationGeneration &+= 1
                do {
                    try pending.preparation.cancel()
                } catch {
                    self.onFatalError(error)
                }
            }
        }
    }

    private func cancelPendingStatePreparation() {
        statePreparationGeneration &+= 1
        // A preparation already executing on verificationQueue still owns its
        // in-flight slot until its completion releases any acquired lease.
        // Reject a replacement preparation during that interval instead of
        // racing it against the old worker on state.raw.lock.
        guard let pendingStatePreparation else { return }
        self.pendingStatePreparation = nil
        do {
            try pendingStatePreparation.preparation.cancel()
        } catch {
            onFatalError(error)
        }
    }

    private func finishPreparation(
        _ result: Result<CapsuleVmPreparedStart, Error>,
        descriptor: CapsuleVmStartDescriptor,
        generation: UInt64
    ) {
        guard generation == bootGeneration, lifecycle.state == .starting else {
            if case .success(let prepared) = result {
                do {
                    try prepared.stateDiskLease.release()
                } catch {
                    onFatalError(error)
                }
            }
            return
        }
        switch result {
        case .failure(let error):
            finishFailed(error, leaseOutcome: nil)

        case .success(let prepared):
            let image = prepared.image
            let console = CapsuleVmConsoleRelay(output: consoleOutput)
            let configuration: VZVirtualMachineConfiguration
            var installedLease = false
            do {
                try stateDiskLeaseHolder.install(prepared.stateDiskLease)
                installedLease = true
                configuration = try CapsuleVmConfigurationBuilder.build(
                    image: image,
                    workspaceFilesURL: descriptor.workspaceFilesURL,
                    stateDiskLease: prepared.stateDiskLease,
                    cpuCount: descriptor.cpuCount,
                    memorySize: descriptor.memorySize,
                    serialConsole: CapsuleVmSerialConsole(
                        input: nil,
                        output: console.guestWriteHandle
                    )
                )
            } catch {
                console.close()
                if installedLease {
                    finishFailed(error, leaseOutcome: .neverStarted)
                } else {
                    do {
                        try prepared.stateDiskLease.release()
                        finishFailed(error, leaseOutcome: nil)
                    } catch let releaseError {
                        finishFailed(releaseError, leaseOutcome: nil)
                    }
                }
                return
            }
            let machine = VZVirtualMachine(configuration: configuration, queue: vmQueue)
            machine.delegate = self
            guard let socketDevice = machine.socketDevices.first as? VZVirtioSocketDevice,
                  machine.socketDevices.count == 1 else {
                console.close()
                finishFailed(
                    CapsuleVmLifecycleError.missingSocketDevice,
                    leaseOutcome: .neverStarted
                )
                return
            }

            let mux = CapsuleVmVsockMultiplexer(
                vmQueue: vmQueue,
                emitter: emitter,
                onFatalError: onFatalError
            )
            mux.install(on: socketDevice)
            virtualMachine = machine
            multiplexer = mux
            consoleRelay = console
            activeImage = image
            console.start()

            machine.start { [weak self] result in
                guard let self else { return }
                guard generation == self.bootGeneration,
                      self.virtualMachine === machine else { return }
                if self.lifecycle.state == .stopping {
                    switch result {
                    case .success:
                        machine.stop { [weak self] error in
                            guard let self else { return }
                            guard generation == self.bootGeneration,
                                  self.virtualMachine === machine else { return }
                            if let error {
                                self.finishFailed(error, leaseOutcome: .stopFailed)
                            } else {
                                self.finishStopped()
                            }
                        }
                    case .failure:
                        self.finishStopped()
                    }
                    return
                }
                switch result {
                case .success:
                    do {
                        try lifecycle.didStart()
                        emitState(.running)
                        let completion = pendingStart
                        pendingStart = nil
                        completion?(.success(CapsuleVmStartedGuest(
                            imageDigest: image.imageDigest,
                            architecture: image.architecture
                        )))
                    } catch {
                        finishFailed(error, leaseOutcome: .stopFailed)
                    }
                case .failure(let error):
                    finishFailed(error, leaseOutcome: .startFailed)
                }
            }
        }
    }

    private func finishStopped() {
        if confirmedStopStreamDrainInFlight { return }
        if lifecycle.state == .stopped,
           virtualMachine == nil,
           multiplexer == nil,
           consoleRelay == nil,
           !stateDiskLeaseHolder.hasLease {
            return
        }
        do {
            try stateDiskLeaseHolder.complete(.confirmedStopped)
        } catch {
            finishFailed(error, leaseOutcome: .stopFailed)
            return
        }
        virtualMachine?.delegate = nil
        virtualMachine = nil
        consoleRelay?.close()
        consoleRelay = nil
        activeImage = nil

        if let multiplexer {
            confirmedStopStreamDrainInFlight = true
            multiplexer.drainForConfirmedStop(
                code: "vm_stopped",
                message: "Capsule VM stopped"
            ) { [weak self] in
                self?.finishStoppedAfterStreamDrain()
            }
            return
        }
        finishStoppedAfterStreamDrain()
    }

    private func finishStoppedAfterStreamDrain() {
        confirmedStopStreamDrainInFlight = false
        multiplexer = nil
        try? lifecycle.didStop()
        emitState(.stopped)
        let completions = pendingStops
        pendingStops.removeAll()
        for completion in completions { completion(.success(())) }
    }

    private func finishFailed(
        _ error: Error,
        leaseOutcome: CapsuleVmStateDiskLeaseHolder.Outcome? = .neverStarted
    ) {
        var reportedError = error
        if let leaseOutcome {
            do {
                try stateDiskLeaseHolder.complete(leaseOutcome)
            } catch {
                reportedError = error
                try? stateDiskLeaseHolder.complete(.stopFailed)
            }
        }
        let retainResources = stateDiskLeaseHolder.mustRetainUntilProcessExit
        confirmedStopStreamDrainInFlight = false
        lifecycle.didFail()
        multiplexer?.closeAll(code: "vm_failed", message: String(describing: reportedError))
        multiplexer = nil
        if !retainResources {
            virtualMachine?.delegate = nil
            virtualMachine = nil
        }
        consoleRelay?.close()
        consoleRelay = nil
        if !retainResources { activeImage = nil }

        emitFailure(reportedError)
        emitState(.failed)
        let start = pendingStart
        pendingStart = nil
        start?(.failure(reportedError))
        let stops = pendingStops
        pendingStops.removeAll()
        for completion in stops { completion(.failure(reportedError)) }
        if retainResources
            || reportedError as? CapsuleVmStateDiskError == .leaseReleaseFailed {
            onFatalError(reportedError)
        }
    }

    private func emitState(_ state: CapsuleVmLifecycleState) {
        guard state != .idle else { return }
        emitJson(
            kind: .event,
            streamID: 0,
            object: ["type": "vm.state", "state": state.rawValue]
        )
    }

    private func emitFailure(_ error: Error) {
        emitJson(
            kind: .event,
            streamID: 0,
            object: [
                "type": "vm.failure",
                "code": "virtual_machine_failed",
                "message": String(describing: error),
            ]
        )
    }

    private func emitJson(
        kind: CapsuleVmFrameKind,
        streamID: UInt32,
        object: [String: Any]
    ) {
        do {
            let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            emitter.emit(CapsuleVmFrame(kind: kind, streamID: streamID, payload: payload)) {
                [onFatalError] result in
                if case .failure(let error) = result { onFatalError(error) }
            }
        } catch {
            onFatalError(error)
        }
    }
}

/// Drains arbitrary Guest console output while rate-limiting what reaches
/// helper stderr. It never writes to LCVM stdout.
public final class CapsuleVmConsoleRelay: @unchecked Sendable {
    public static let maximumBytesPerWindow = 256 * 1_024
    public static let windowSeconds: TimeInterval = 1

    private let pipe = Pipe()
    private let output: FileHandle
    private let queue = DispatchQueue(label: "app.lamarck.capsule-vm.console")
    private var windowStarted = Date()
    private var emittedBytes = 0
    private var reportedDrop = false
    private var started = false

    public init(output: FileHandle) {
        self.output = output
    }

    public var guestWriteHandle: FileHandle { pipe.fileHandleForWriting }

    public func start() {
        queue.async { [self] in
            guard !started else { return }
            started = true
            pipe.fileHandleForReading.readabilityHandler = { @Sendable [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                self?.queue.sync { [weak self] in self?.accept(data) }
            }
        }
    }

    public func close() {
        queue.async { [self] in
            pipe.fileHandleForReading.readabilityHandler = nil
            try? pipe.fileHandleForWriting.close()
            try? pipe.fileHandleForReading.close()
        }
    }

    private func accept(_ data: Data) {
        let now = Date()
        if now.timeIntervalSince(windowStarted) >= Self.windowSeconds {
            windowStarted = now
            emittedBytes = 0
            reportedDrop = false
        }
        let remaining = max(0, Self.maximumBytesPerWindow - emittedBytes)
        if remaining > 0 {
            let accepted = data.prefix(remaining)
            try? output.write(contentsOf: accepted)
            emittedBytes += accepted.count
        }
        if data.count > remaining && !reportedDrop {
            reportedDrop = true
            try? output.write(contentsOf: Data(
                "\n[capsule-vm-host] Guest console rate limit exceeded; output dropped\n".utf8
            ))
        }
    }
}
