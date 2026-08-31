import Foundation
import Testing
@testable import CapsuleVmHostCore

@Test func commandServiceProbesWithStrictResponseEnvelope() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)

    try service.accept(requestFrame(streamID: 1, object: ["method": "probe"]))

    let response = try #require(emitter.frames.last)
    #expect(response.kind == .response)
    #expect(response.streamID == 1)
    let object = try responseObject(response)
    #expect(object["ok"] as? Bool == true)
    let result = try #require(object["result"] as? [String: Any])
    #expect(result["protocolVersion"] as? Int == 2)
    #expect(result["virtualizationSupported"] is Bool)
}

@Test func commandServiceRequiresExactSignedGuestDescriptor() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)

    try service.accept(requestFrame(streamID: 2, object: ["method": "start"]))
    var error = try responseError(try #require(emitter.frames.last))
    #expect(error["code"] as? String == "guest_image_required")
    #expect(session.startDescriptors.isEmpty)

    var params = validStartParams()
    params["callerSelectedImage"] = true
    try service.accept(requestFrame(
        streamID: 3,
        object: ["method": "start", "params": params]
    ))
    error = try responseError(try #require(emitter.frames.last))
    #expect(error["code"] as? String == "guest_image_required")
    #expect(session.startDescriptors.isEmpty)
}

@Test func commandServicePreparesAndCancelsOneUseStateLease() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)

    try service.accept(requestFrame(
        streamID: 30,
        object: ["method": "prepareState", "params": validStatePreparationParams()]
    ))
    let descriptor = try #require(session.statePreparationDescriptors.first)
    #expect(descriptor.stateDiskBytes == 8 * 1_024 * 1_024 * 1_024)
    let prepared = try responseObject(try #require(emitter.frames.last))
    let result = try #require(prepared["result"] as? [String: Any])
    #expect(result["preparationId"] as? String == session.preparationID)
    #expect(result["existingPhysicalBytes"] as? UInt64 == 1_024)
    #expect(result["additionalPhysicalBytes"] as? UInt64 == 2_048)
    #expect(result["peakPhysicalBytes"] as? UInt64 == 3_072)

    try service.accept(requestFrame(
        streamID: 31,
        object: [
            "method": "cancelStatePreparation",
            "params": ["preparationId": session.preparationID],
        ]
    ))
    #expect(session.cancelledPreparationIDs == [session.preparationID])
    let cancelled = try responseObject(try #require(emitter.frames.last))
    let cancelledResult = try #require(cancelled["result"] as? [String: Any])
    #expect(cancelledResult["state"] as? String == "cancelled")
}

@Test func commandServiceStartsAndStopsThroughStatefulSession() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)
    let params = validStartParams()

    try service.accept(requestFrame(
        streamID: 4,
        object: ["method": "start", "params": params]
    ))

    let descriptor = try #require(session.startDescriptors.first)
    #expect(descriptor.trustedImage.expectedManifestDigest == params["expectedManifestDigest"] as? String)
    #expect(descriptor.trustedImage.pinnedPublicKey == Data(repeating: 7, count: 32))
    #expect(descriptor.statePreparationID == "01234567-89ab-4def-8123-456789abcdef")
    #expect(descriptor.cpuCount == 2)
    #expect(descriptor.memorySize == 1_073_741_824)

    var response = try responseObject(try #require(emitter.frames.last))
    let startResult = try #require(response["result"] as? [String: Any])
    #expect(startResult["state"] as? String == "running")
    #expect(startResult["imageDigest"] as? String == params["expectedManifestDigest"] as? String)

    try service.accept(requestFrame(streamID: 5, object: ["method": "stop"]))
    response = try responseObject(try #require(emitter.frames.last))
    let stopResult = try #require(response["result"] as? [String: Any])
    #expect(stopResult["state"] as? String == "stopped")
    #expect(session.stopCount == 1)
}

@Test func commandServiceAcceptsExactResourceIntegerBounds() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)
    var params = validStartParams()
    params["cpuCount"] = Int.max
    params["memorySizeBytes"] = UInt64.max

    try service.accept(requestFrame(
        streamID: 6,
        object: ["method": "start", "params": params]
    ))

    let descriptor = try #require(session.startDescriptors.first)
    #expect(descriptor.cpuCount == Int.max)
    #expect(descriptor.memorySize == UInt64.max)
}

@Test func commandServiceRejectsResourceIntegersOutsideMachineBounds() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)
    let cases: [(field: String, value: NSDecimalNumber)] = [
        ("cpuCount", NSDecimalNumber(string: "9223372036854775808")),
        ("cpuCount", NSDecimalNumber(string: "-9223372036854775809")),
        ("memorySizeBytes", NSDecimalNumber(string: "18446744073709551616")),
    ]

    for (offset, testCase) in cases.enumerated() {
        var params = validStartParams()
        params[testCase.field] = testCase.value
        try service.accept(requestFrame(
            streamID: UInt32(7 + offset),
            object: ["method": "start", "params": params]
        ))

        let error = try responseError(try #require(emitter.frames.last))
        #expect(error["code"] as? String == "guest_image_required")
    }

    #expect(session.startDescriptors.isEmpty)
}

@Test func commandServiceRequiresBoundedAlignedStateDiskBytes() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    let service = CapsuleVmCommandService(session: session, emitter: emitter)
    let invalidValues: [UInt64] = [
        CapsuleVmStateDiskManager.minimumSize - 1,
        CapsuleVmStateDiskManager.minimumSize + 1,
        CapsuleVmStateDiskManager.maximumSize + CapsuleVmStateDiskManager.sizeAlignment,
    ]

    for (index, value) in invalidValues.enumerated() {
        var params = validStatePreparationParams()
        params["stateDiskBytes"] = value
        try service.accept(requestFrame(
            streamID: UInt32(20 + index),
            object: ["method": "prepareState", "params": params]
        ))
        let error = try responseError(try #require(emitter.frames.last))
        #expect(error["code"] as? String == "state_preparation_required")
    }
    #expect(session.statePreparationDescriptors.isEmpty)
}

@Test func commandServiceRejectsDuplicatePendingRequestAndSuppressesAfterShutdown() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    session.holdStart = true
    let service = CapsuleVmCommandService(session: session, emitter: emitter)
    let start = requestFrame(
        streamID: 6,
        object: ["method": "start", "params": validStartParams()]
    )

    try service.accept(start)
    #expect(throws: CapsuleVmProtocolError.self) {
        try service.accept(start)
    }
    #expect(emitter.frames.isEmpty)

    let didShutdown = LockedTestValue(false)
    service.shutdown { didShutdown.set(true) }
    #expect(didShutdown.value)
    session.completeHeldStart()
    #expect(emitter.frames.isEmpty)
}

@Test func commandServiceValidatesAndDelegatesOnlyBoundedHelperStreams() throws {
    let emitter = RecordingCapsuleVmFrameEmitter()
    let session = FakeCapsuleVmSession()
    session.state = .running
    let service = CapsuleVmCommandService(session: session, emitter: emitter)

    let valid = CapsuleVmFrame(
        kind: .streamData,
        streamID: CapsuleVmProtocol.minimumHelperStreamID,
        payload: Data([1, 2, 3])
    )
    try service.accept(valid)
    #expect(session.streamFrames == [valid])

    #expect(throws: CapsuleVmProtocolError.self) {
        try service.accept(CapsuleVmFrame(
            kind: .streamData,
            streamID: 7,
            payload: Data()
        ))
    }
    #expect(throws: CapsuleVmProtocolError.self) {
        try service.accept(CapsuleVmFrame(
            kind: .streamData,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: Data(repeating: 0, count: CapsuleVmProtocol.streamChunkByteCount + 1)
        ))
    }
}

private final class FakeCapsuleVmSession: CapsuleVmSessionControlling, @unchecked Sendable {
    var state: CapsuleVmLifecycleState = .idle
    let preparationID = "01234567-89ab-4def-8123-456789abcdef"
    var statePreparationDescriptors: [CapsuleVmStatePreparationDescriptor] = []
    var cancelledPreparationIDs: [String] = []
    var startDescriptors: [CapsuleVmStartDescriptor] = []
    var streamFrames: [CapsuleVmFrame] = []
    var stopCount = 0
    var holdStart = false
    private var heldStart: CapsuleVmStartCompletion?

    func currentState() -> CapsuleVmLifecycleState { state }

    func prepareState(
        descriptor: CapsuleVmStatePreparationDescriptor,
        completion: @escaping CapsuleVmPrepareStateCompletion
    ) {
        statePreparationDescriptors.append(descriptor)
        completion(.success(CapsuleVmPreparedState(
            preparationID: preparationID,
            requirements: CapsuleVmStateDiskPreparationRequirements(
                stateDiskBytes: descriptor.stateDiskBytes,
                existingPhysicalBytes: 1_024,
                additionalPhysicalBytes: 2_048,
                peakPhysicalBytes: 3_072
            )
        )))
    }

    func cancelStatePreparation(
        id: String,
        completion: @escaping CapsuleVmCancelStateCompletion
    ) {
        cancelledPreparationIDs.append(id)
        completion(.success(()))
    }

    func start(
        descriptor: CapsuleVmStartDescriptor,
        completion: @escaping CapsuleVmStartCompletion
    ) {
        startDescriptors.append(descriptor)
        state = .starting
        if holdStart {
            heldStart = completion
        } else {
            state = .running
            completion(.success(CapsuleVmStartedGuest(
                imageDigest: descriptor.trustedImage.expectedManifestDigest,
                architecture: descriptor.trustedImage.expectedArchitecture
            )))
        }
    }

    func completeHeldStart() {
        guard let completion = heldStart,
              let descriptor = startDescriptors.last else { return }
        heldStart = nil
        state = .running
        completion(.success(CapsuleVmStartedGuest(
            imageDigest: descriptor.trustedImage.expectedManifestDigest,
            architecture: descriptor.trustedImage.expectedArchitecture
        )))
    }

    func stop(completion: @escaping CapsuleVmStopCompletion) {
        stopCount += 1
        state = .stopped
        completion(.success(()))
    }

    func acceptHostStreamFrame(_ frame: CapsuleVmFrame) throws {
        streamFrames.append(frame)
    }
}

private func requestFrame(streamID: UInt32, object: [String: Any]) -> CapsuleVmFrame {
    CapsuleVmFrame(
        kind: .request,
        streamID: streamID,
        payload: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    )
}

private func validStartParams() -> [String: Any] {
    [
        "imageBundlePath": "/Applications/Lamarck.app/Contents/Resources/capsule-guest",
        "workspaceFilesPath": "/Users/test/Documents/Lamarck/files",
        "appVersionsPath": "/Users/test/Documents/Lamarck/.lamarck/cache/app-versions",
        "statePreparationId": "01234567-89ab-4def-8123-456789abcdef",
        "expectedManifestDigest": "sha256:\(String(repeating: "a", count: 64))",
        "manifestPublicKey": Data(repeating: 7, count: 32).base64EncodedString(),
        "cpuCount": 2,
        "memorySizeBytes": 1_073_741_824,
    ]
}

private func validStatePreparationParams() -> [String: Any] {
    [
        "stateDirectory": "/Users/test/Library/Application Support/Lamarck/capsule-vm",
        "stateDiskBytes": 8 * 1_024 * 1_024 * 1_024,
    ]
}

private func responseObject(_ frame: CapsuleVmFrame) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: frame.payload) as? [String: Any])
}

private func responseError(_ frame: CapsuleVmFrame) throws -> [String: Any] {
    let object = try responseObject(frame)
    #expect(object["ok"] as? Bool == false)
    return try #require(object["error"] as? [String: Any])
}

private final class LockedTestValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func set(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }
}
