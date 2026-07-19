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
    #expect(result["protocolVersion"] as? Int == 1)
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
    #expect(throws: CapsuleVmStreamMuxError.self) {
        try service.accept(CapsuleVmFrame(
            kind: .streamData,
            streamID: CapsuleVmProtocol.minimumHelperStreamID,
            payload: Data(repeating: 0, count: CapsuleVmProtocol.streamChunkByteCount + 1)
        ))
    }
}

private final class FakeCapsuleVmSession: CapsuleVmSessionControlling, @unchecked Sendable {
    var state: CapsuleVmLifecycleState = .idle
    var startDescriptors: [CapsuleVmStartDescriptor] = []
    var streamFrames: [CapsuleVmFrame] = []
    var stopCount = 0
    var holdStart = false
    private var heldStart: CapsuleVmStartCompletion?

    func currentState() -> CapsuleVmLifecycleState { state }

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
        "stateDirectory": "/Users/test/Library/Application Support/Lamarck/capsule-vm",
        "expectedManifestDigest": "sha256:\(String(repeating: "a", count: 64))",
        "manifestPublicKey": Data(repeating: 7, count: 32).base64EncodedString(),
        "cpuCount": 2,
        "memorySizeBytes": 1_073_741_824,
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
