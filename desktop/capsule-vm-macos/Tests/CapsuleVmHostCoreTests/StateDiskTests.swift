import Darwin
import Foundation
import Testing
@testable import CapsuleVmHostCore

// Keep GiB-sized lifecycle tests sparse; physical reservation itself is
// covered below with a small real file. Production calls never use this shim.
private enum SparseStateDiskManager {
    static let fileName = CapsuleVmHostCore.CapsuleVmStateDiskManager.fileName
    static let leaseFileName = CapsuleVmHostCore.CapsuleVmStateDiskManager.leaseFileName
    static let defaultSize = CapsuleVmHostCore.CapsuleVmStateDiskManager.defaultSize
    static let minimumSize = CapsuleVmHostCore.CapsuleVmStateDiskManager.minimumSize
    static let maximumSize = CapsuleVmHostCore.CapsuleVmStateDiskManager.maximumSize
    static let sizeAlignment = CapsuleVmHostCore.CapsuleVmStateDiskManager.sizeAlignment

    static func acquire(
        in directoryURL: URL,
        size: UInt64 = defaultSize
    ) throws -> CapsuleVmStateDiskLease {
        try CapsuleVmHostCore.CapsuleVmStateDiskManager.acquireForTesting(
            in: directoryURL,
            size: size
        )
    }
}

private typealias CapsuleVmStateDiskManager = SparseStateDiskManager

@Test func createsAndReopensFixedPrivateSparseStateDisk() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }

    let lease = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    let disk = lease.disk
    #expect(disk.url.lastPathComponent == CapsuleVmStateDiskManager.fileName)
    #expect(disk.size == CapsuleVmStateDiskManager.minimumSize)

    var metadata = stat()
    #expect(Darwin.lstat(disk.url.path, &metadata) == 0)
    #expect((metadata.st_mode & S_IFMT) == S_IFREG)
    #expect((metadata.st_mode & 0o077) == 0)
    #expect(UInt64(metadata.st_size) == CapsuleVmStateDiskManager.minimumSize)
    #expect(UInt64(metadata.st_blocks) * 512 < CapsuleVmStateDiskManager.minimumSize)
    try lease.validateForAttachment()
    try lease.release()

    let reopened = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    #expect(reopened.disk.url == disk.url)
    try reopened.release()
}

@Test func productionPolicyPhysicallyReservesBackingBlocksAndPreservesHostReserve() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("physical.raw")
    let descriptor = Darwin.open(
        path.path,
        O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        S_IRUSR | S_IWUSR
    )
    #expect(descriptor >= 0)
    guard descriptor >= 0 else { return }
    defer { _ = Darwin.close(descriptor) }

    let bytes: UInt64 = 8 * 1_024 * 1_024
    let policy = CapsuleVmStateDiskAllocationPolicy(
        hostReserveBytes: 0,
        requiresPhysicalAllocation: true
    )
    try policy.prepareNewFile(descriptor: descriptor, size: bytes)
    try policy.validateFile(descriptor: descriptor, size: bytes)

    var metadata = stat()
    #expect(Darwin.fstat(descriptor, &metadata) == 0)
    #expect(UInt64(metadata.st_size) == bytes)
    #expect(metadata.st_blocks >= 0)
    #expect(UInt64(metadata.st_blocks) * 512 >= bytes)

    let impossible = CapsuleVmStateDiskAllocationPolicy(
        hostReserveBytes: UInt64.max,
        requiresPhysicalAllocation: true
    )
    #expect(throws: CapsuleVmStateDiskError.insufficientHostCapacity) {
        try impossible.prepareNewFile(descriptor: descriptor, size: bytes)
    }
}

@Test func productionAcquireRejectsLegacySparseStateBeforeAttachment() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sparse = try SparseStateDiskManager.acquire(
        in: directory,
        size: SparseStateDiskManager.minimumSize
    )
    try sparse.release()

    #expect(throws: CapsuleVmStateDiskError.allocationFailed) {
        try CapsuleVmHostCore.CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: SparseStateDiskManager.minimumSize
        )
    }
}

@Test func rejectsUnboundedOrUnalignedStateDiskSizes() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }

    for size in [
        CapsuleVmStateDiskManager.minimumSize - 1,
        CapsuleVmStateDiskManager.minimumSize + 1,
        CapsuleVmStateDiskManager.maximumSize + CapsuleVmStateDiskManager.sizeAlignment,
    ] {
        #expect(throws: CapsuleVmStateDiskError.invalidSize) {
            try CapsuleVmStateDiskManager.acquire(in: directory, size: size)
        }
    }
    #expect(CapsuleVmStateDiskManager.defaultSize == 16 * 1_024 * 1_024 * 1_024)
}

@Test func exclusiveLeaseRejectsConcurrentOwnerAndKeepsStableSidecar() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }

    let first = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    #expect(throws: CapsuleVmStateDiskError.leaseUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
    try first.release()

    let sidecar = directory.appendingPathComponent(CapsuleVmStateDiskManager.leaseFileName)
    #expect(FileManager.default.fileExists(atPath: sidecar.path))
    let second = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    try second.release()
    #expect(FileManager.default.fileExists(atPath: sidecar.path))
}

@Test func leaseDoesNotLockStateImageNeededByVirtualizationFramework() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let lease = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    defer { try? lease.release() }

    // VZDiskImageStorageDeviceAttachment takes its own exclusive advisory lock
    // when the VM starts. Host ownership therefore lives on the stable sidecar,
    // while the image itself must remain available for VZ to lock.
    let vzLockProbe = Darwin.open(
        lease.disk.url.path,
        O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK
    )
    #expect(vzLockProbe >= 0)
    if vzLockProbe >= 0 { #expect(Darwin.close(vzLockProbe) == 0) }

    // The sidecar still prevents a second Host owner while VZ is using the
    // image; making the image attachable does not weaken lifecycle ownership.
    #expect(throws: CapsuleVmStateDiskError.leaseUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
}

@Test func sigkillDropsKernelLeaseWithoutDeletingPersistentSidecar() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let bootstrap = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    try bootstrap.release()

    let lockPath = directory
        .appendingPathComponent(CapsuleVmStateDiskManager.leaseFileName)
        .path
    let child = Process()
    let output = Pipe()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    child.arguments = [
        "-c",
        """
        import fcntl, os, signal, sys
        fd = os.open(sys.argv[1], os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.write(1, b"1")
        signal.pause()
        """,
        lockPath,
    ]
    child.standardOutput = output
    child.standardError = Pipe()
    try child.run()
    defer {
        if child.isRunning {
            _ = Darwin.kill(child.processIdentifier, SIGKILL)
            child.waitUntilExit()
        }
    }
    let ready = try output.fileHandleForReading.read(upToCount: 1)
    #expect(ready == Data("1".utf8))
    guard ready == Data("1".utf8) else { return }

    #expect(throws: CapsuleVmStateDiskError.leaseUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
    #expect(Darwin.kill(child.processIdentifier, SIGKILL) == 0)
    child.waitUntilExit()

    let recovered = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    try recovered.release()
    #expect(FileManager.default.fileExists(atPath: lockPath))
}

@Test func stopFailurePoisonsLeaseUntilOwnerTeardown() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    var lease: CapsuleVmStateDiskLease? = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    var holder: CapsuleVmStateDiskLeaseHolder? = CapsuleVmStateDiskLeaseHolder()
    try holder?.install(lease!)
    lease = nil

    try holder?.complete(.stopFailed)
    #expect(holder?.mustRetainUntilProcessExit == true)
    #expect(throws: CapsuleVmStateDiskError.leaseUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    // Even a later normal completion cannot make the uncertain stop path
    // release authority. Only holder/helper teardown drops the raw fds.
    try holder?.complete(.confirmedStopped)
    #expect(throws: CapsuleVmStateDiskError.leaseUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: directory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
    holder = nil

    let recovered = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    try recovered.release()
}

@Test func rejectsSymlinkedDirectoryStateAndLeaseFiles() throws {
    let container = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: container) }
    let realDirectory = container.appendingPathComponent("real", isDirectory: true)
    let linkedDirectory = container.appendingPathComponent("linked", isDirectory: true)
    try FileManager.default.createDirectory(at: realDirectory, withIntermediateDirectories: false)
    #expect(Darwin.chmod(realDirectory.path, 0o700) == 0)
    try FileManager.default.createSymbolicLink(at: linkedDirectory, withDestinationURL: realDirectory)

    #expect(throws: CapsuleVmStateDiskError.directoryUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: linkedDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let target = container.appendingPathComponent("target.raw")
    #expect(FileManager.default.createFile(atPath: target.path, contents: Data()))
    #expect(Darwin.chmod(target.path, 0o600) == 0)
    let handle = try FileHandle(forWritingTo: target)
    try handle.truncate(atOffset: CapsuleVmStateDiskManager.minimumSize)
    try handle.close()
    try FileManager.default.createSymbolicLink(
        at: realDirectory.appendingPathComponent(CapsuleVmStateDiskManager.fileName),
        withDestinationURL: target
    )
    #expect(throws: CapsuleVmStateDiskError.fileUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: realDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let leaseDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: leaseDirectory) }
    try FileManager.default.createSymbolicLink(
        at: leaseDirectory.appendingPathComponent(CapsuleVmStateDiskManager.leaseFileName),
        withDestinationURL: target
    )
    #expect(throws: CapsuleVmStateDiskError.leaseFileUnavailable) {
        try CapsuleVmStateDiskManager.acquire(
            in: leaseDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
}

@Test func rejectsBroadPermissionsHardLinksAndUnexpectedExistingSize() throws {
    let broadDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: broadDirectory) }
    #expect(Darwin.chmod(broadDirectory.path, 0o755) == 0)
    #expect(throws: CapsuleVmStateDiskError.directoryPermissions) {
        try CapsuleVmStateDiskManager.acquire(
            in: broadDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let permissionsDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: permissionsDirectory) }
    let permissionsLease = try CapsuleVmStateDiskManager.acquire(
        in: permissionsDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    let permissionsDisk = permissionsLease.disk
    try permissionsLease.release()
    #expect(Darwin.chmod(permissionsDisk.url.path, 0o644) == 0)
    #expect(throws: CapsuleVmStateDiskError.filePermissions) {
        try CapsuleVmStateDiskManager.acquire(
            in: permissionsDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let linkDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: linkDirectory) }
    let linkLease = try CapsuleVmStateDiskManager.acquire(
        in: linkDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    let linkedDisk = linkLease.disk
    try linkLease.release()
    let secondLink = linkDirectory.appendingPathComponent("second-link.raw")
    #expect(Darwin.link(linkedDisk.url.path, secondLink.path) == 0)
    #expect(throws: CapsuleVmStateDiskError.fileHasMultipleLinks) {
        try CapsuleVmStateDiskManager.acquire(
            in: linkDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let sizeDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: sizeDirectory) }
    let sizeLease = try CapsuleVmStateDiskManager.acquire(
        in: sizeDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    let sizedDisk = sizeLease.disk
    try sizeLease.release()
    let sizeHandle = try FileHandle(forWritingTo: sizedDisk.url)
    try sizeHandle.truncate(
        atOffset: CapsuleVmStateDiskManager.minimumSize
            + CapsuleVmStateDiskManager.sizeAlignment
    )
    try sizeHandle.close()
    #expect(throws: CapsuleVmStateDiskError.fileSizeMismatch) {
        try CapsuleVmStateDiskManager.acquire(
            in: sizeDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }
}

@Test func rejectsInvalidLeaseMetadataAndDetectsStatePathSwap() throws {
    let hardLinkDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: hardLinkDirectory) }
    let bootstrap = try CapsuleVmStateDiskManager.acquire(
        in: hardLinkDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    try bootstrap.release()
    let sidecar = hardLinkDirectory
        .appendingPathComponent(CapsuleVmStateDiskManager.leaseFileName)
    #expect(Darwin.link(
        sidecar.path,
        hardLinkDirectory.appendingPathComponent("lease-hardlink").path
    ) == 0)
    #expect(throws: CapsuleVmStateDiskError.leaseFileInvalid) {
        try CapsuleVmStateDiskManager.acquire(
            in: hardLinkDirectory,
            size: CapsuleVmStateDiskManager.minimumSize
        )
    }

    let swapDirectory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: swapDirectory) }
    let lease = try CapsuleVmStateDiskManager.acquire(
        in: swapDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    defer { try? lease.release() }
    let displaced = swapDirectory.appendingPathComponent("displaced.raw")
    #expect(Darwin.rename(lease.disk.url.path, displaced.path) == 0)
    #expect(FileManager.default.createFile(atPath: lease.disk.url.path, contents: Data()))
    #expect(Darwin.chmod(lease.disk.url.path, 0o600) == 0)
    let replacement = try FileHandle(forWritingTo: lease.disk.url)
    try replacement.truncate(atOffset: CapsuleVmStateDiskManager.minimumSize)
    try replacement.close()
    #expect(throws: CapsuleVmStateDiskError.pathChanged) {
        try lease.validateForAttachment()
    }
}

@Test func recoversPrivateCreatingFileLeftByCrash() throws {
    let directory = try temporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pending = directory.appendingPathComponent(".state.raw.creating")
    #expect(FileManager.default.createFile(atPath: pending.path, contents: Data("partial".utf8)))
    #expect(Darwin.chmod(pending.path, 0o600) == 0)

    let lease = try CapsuleVmStateDiskManager.acquire(
        in: directory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    #expect(!FileManager.default.fileExists(atPath: pending.path))
    try lease.release()
}

private func temporaryStateDirectory() throws -> URL {
    guard let resolvedTemporaryPath = Darwin.realpath(
        FileManager.default.temporaryDirectory.path,
        nil
    ) else {
        throw CapsuleVmStateDiskError.directoryUnavailable
    }
    defer { free(resolvedTemporaryPath) }
    let url = URL(fileURLWithPath: String(cString: resolvedTemporaryPath), isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    guard Darwin.chmod(url.path, 0o700) == 0 else {
        throw CapsuleVmStateDiskError.directoryUnavailable
    }
    return url
}
