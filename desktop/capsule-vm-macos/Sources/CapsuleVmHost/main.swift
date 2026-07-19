import CapsuleVmHostCore
import Darwin
import Foundation

private final class CapsuleVmHostProcess: @unchecked Sendable {
    private let writer = CapsuleVmFrameWriter(output: .standardOutput)
    private let inputQueue = DispatchQueue(
        label: "app.lamarck.capsule-vm.frame-input",
        qos: .userInitiated
    )
    private let finishLock = NSLock()
    private var finishing = false
    private var signalSources: [DispatchSourceSignal] = []

    private lazy var session = CapsuleVmVirtualMachineSession(
        emitter: writer,
        consoleOutput: .standardError,
        onFatalError: { [weak self] error in self?.requestShutdown(error: error) }
    )

    private lazy var service = CapsuleVmCommandService(
        session: session,
        emitter: writer,
        onFatalError: { [weak self] error in self?.requestShutdown(error: error) }
    )

    func run() -> Never {
        _ = service
        installSignalHandlers()
        inputQueue.async { [self] in readInput() }
        dispatchMain()
    }

    private func readInput() {
        let reader = CapsuleVmFrameReader(input: .standardInput)
        do {
            while let frame = try reader.nextFrame() {
                try service.accept(frame)
            }
            requestShutdown(error: nil)
        } catch {
            requestShutdown(error: error)
        }
    }

    private func installSignalHandlers() {
        Darwin.signal(SIGPIPE, SIG_IGN)
        for signalNumber in [SIGTERM, SIGINT] {
            Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: DispatchQueue.global(qos: .userInitiated)
            )
            source.setEventHandler { [weak self] in
                self?.requestShutdown(error: nil)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func requestShutdown(error: Error?) {
        finishLock.lock()
        guard !finishing else {
            finishLock.unlock()
            return
        }
        finishing = true
        finishLock.unlock()

        if let error {
            let message = "[capsule-vm-host] fatal error: \(error)\n"
            try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
        }

        let exitCode: Int32 = error == nil ? EXIT_SUCCESS : EXIT_FAILURE
        service.shutdown { [weak self] in
            self?.finishAndExit(exitCode)
        }

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 5) {
            // A blocked stdout pipe must not defeat the hard VM teardown
            // deadline. The graceful path above flushes framed output.
            Darwin.exit(exitCode)
        }
    }

    private func finishAndExit(_ code: Int32) -> Never {
        writer.finish()
        Darwin.exit(code)
    }
}

CapsuleVmHostProcess().run()
