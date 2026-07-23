import Darwin
import Foundation

public struct CapsuleVmStateDisk: Sendable {
    public let url: URL
    public let size: UInt64

    fileprivate init(url: URL, size: UInt64) {
        self.url = url
        self.size = size
    }
}

public enum CapsuleVmStateDiskError: Error, Equatable, CustomStringConvertible, Sendable {
    case invalidDirectory
    case directoryUnavailable
    case directoryNotOwned
    case directoryPermissions
    case invalidSize
    case leaseFileUnavailable
    case leaseFileInvalid
    case leaseUnavailable
    case leaseNotHeld
    case pathChanged
    case fileUnavailable
    case fileNotRegular
    case fileNotOwned
    case fileHasMultipleLinks
    case filePermissions
    case fileSizeMismatch
    case insufficientHostCapacity
    case allocationFailed
    case leaseReleaseFailed

    public var description: String {
        switch self {
        case .invalidDirectory:
            return "Capsule VM state directory must be an absolute file URL"
        case .directoryUnavailable:
            return "Capsule VM state directory is unavailable or contains a symlink"
        case .directoryNotOwned:
            return "Capsule VM state directory is not owned by the current Host user"
        case .directoryPermissions:
            return "Capsule VM state directory must be private to the Host user"
        case .invalidSize:
            return "Capsule VM state disk size is outside the fixed bounded policy"
        case .leaseFileUnavailable:
            return "Capsule VM state lease file cannot be opened safely"
        case .leaseFileInvalid:
            return "Capsule VM state lease file violates the fixed private-file policy"
        case .leaseUnavailable:
            return "Capsule VM state disk is already leased by another Host process"
        case .leaseNotHeld:
            return "Capsule VM state disk lease is not held"
        case .pathChanged:
            return "Capsule VM state path changed while its lease was held"
        case .fileUnavailable:
            return "Capsule VM state disk cannot be opened safely"
        case .fileNotRegular:
            return "Capsule VM state disk is not a regular file"
        case .fileNotOwned:
            return "Capsule VM state disk is not owned by the current Host user"
        case .fileHasMultipleLinks:
            return "Capsule VM state disk must not have multiple hard links"
        case .filePermissions:
            return "Capsule VM state disk must be private to the Host user"
        case .fileSizeMismatch:
            return "Existing Capsule VM state disk has an unexpected size"
        case .insufficientHostCapacity:
            return "Capsule VM state disk would consume the fixed Host filesystem reserve"
        case .allocationFailed:
            return "Capsule VM state disk physical allocation failed"
        case .leaseReleaseFailed:
            return "Capsule VM state disk lease could not be released cleanly"
        }
    }
}

private struct CapsuleVmFileIdentity: Equatable, Sendable {
    let device: dev_t
    let inode: ino_t

    init(_ metadata: stat) {
        device = metadata.st_dev
        inode = metadata.st_ino
    }
}

/// Physical backing policy for the writable Guest disk. Production reserves
/// every logical byte before VZ can attach the file, so Guest-side quotas can
/// never grow a sparse image into the Host filesystem's safety reserve.
struct CapsuleVmStateDiskAllocationPolicy: Sendable {
    private static let zeroFillChunkBytes = 1_024 * 1_024

    static let productionHostReserveBytes: UInt64 = 4 * 1_024 * 1_024 * 1_024
    static let production = CapsuleVmStateDiskAllocationPolicy(
        hostReserveBytes: productionHostReserveBytes,
        requiresPhysicalAllocation: true
    )
    static let sparseTesting = CapsuleVmStateDiskAllocationPolicy(
        hostReserveBytes: 0,
        requiresPhysicalAllocation: false
    )

    let hostReserveBytes: UInt64
    let requiresPhysicalAllocation: Bool

    init(hostReserveBytes: UInt64, requiresPhysicalAllocation: Bool) {
        self.hostReserveBytes = hostReserveBytes
        self.requiresPhysicalAllocation = requiresPhysicalAllocation
    }

    func prepareNewFile(descriptor: Int32, size: UInt64) throws {
        guard size <= UInt64(Int64.max) else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        if requiresPhysicalAllocation {
            try requireHostCapacity(
                descriptor: descriptor,
                allocationBytes: size,
                reserveBytes: hostReserveBytes
            )
            var allocation = fstore_t(
                fst_flags: UInt32(F_ALLOCATECONTIG | F_ALLOCATEALL | F_ALLOCATEPERSIST),
                fst_posmode: F_PEOFPOSMODE,
                fst_offset: 0,
                fst_length: off_t(size),
                fst_bytesalloc: 0
            )
            if Darwin.fcntl(descriptor, F_PREALLOCATE, &allocation) != 0 {
                allocation.fst_flags = UInt32(F_ALLOCATEALL | F_ALLOCATEPERSIST)
                allocation.fst_bytesalloc = 0
                guard Darwin.fcntl(descriptor, F_PREALLOCATE, &allocation) == 0 else {
                    throw CapsuleVmStateDiskError.allocationFailed
                }
            }
            guard allocation.fst_bytesalloc >= off_t(size) else {
                throw CapsuleVmStateDiskError.allocationFailed
            }
        }
        guard Darwin.ftruncate(descriptor, off_t(size)) == 0,
              Darwin.fsync(descriptor) == 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        try validateFile(descriptor: descriptor, size: size)
    }

    /// Restores zero-valued logical holes without changing the raw disk's
    /// contents. Virtual block zeroing may deallocate APFS extents even when
    /// ext4 discard is disabled; those holes must be materialized again before
    /// the next VZ attachment so Guest growth cannot consume the Host reserve.
    func prepareExistingFile(descriptor: Int32, size: UInt64) throws {
        guard requiresPhysicalAllocation else { return }
        let allocationBytes = try additionalAllocationBytes(
            descriptor: descriptor,
            size: size
        )
        guard allocationBytes > 0 else {
            try validateFile(descriptor: descriptor, size: size)
            return
        }

        try requireHostCapacity(
            descriptor: descriptor,
            allocationBytes: allocationBytes,
            reserveBytes: hostReserveBytes
        )
        var zeroes = [UInt8](repeating: 0, count: Self.zeroFillChunkBytes)
        try zeroes.withUnsafeMutableBytes { buffer in
            guard let baseAddress = buffer.baseAddress else {
                throw CapsuleVmStateDiskError.allocationFailed
            }
            try forEachLogicalHole(descriptor: descriptor, size: size) { offset, length in
                var cursor = offset
                let end = offset + length
                while cursor < end {
                    let count = min(Int(end - cursor), buffer.count)
                    let written = Darwin.pwrite(descriptor, baseAddress, count, cursor)
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else {
                        throw CapsuleVmStateDiskError.allocationFailed
                    }
                    cursor += off_t(written)
                }
            }
        }
        guard Darwin.fsync(descriptor) == 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        try validateFile(descriptor: descriptor, size: size)
    }

    func physicalBytes(descriptor: Int32) throws -> UInt64 {
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_blocks >= 0,
              UInt64(metadata.st_blocks) <= UInt64.max / 512 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        return UInt64(metadata.st_blocks) * 512
    }

    func additionalAllocationBytes(descriptor: Int32, size: UInt64) throws -> UInt64 {
        guard requiresPhysicalAllocation else { return 0 }
        let blockSize = try filesystemBlockSize(descriptor: descriptor)
        var allocationBytes: UInt64 = 0
        try forEachLogicalHole(descriptor: descriptor, size: size) { _, length in
            let bytes = UInt64(length)
            guard bytes <= UInt64.max - (blockSize - 1) else {
                throw CapsuleVmStateDiskError.allocationFailed
            }
            let rounded = ((bytes + blockSize - 1) / blockSize) * blockSize
            guard allocationBytes <= UInt64.max - rounded else {
                throw CapsuleVmStateDiskError.allocationFailed
            }
            allocationBytes += rounded
        }
        return allocationBytes
    }

    func validateFile(descriptor: Int32, size: UInt64) throws {
        guard requiresPhysicalAllocation else { return }
        var hasLogicalHole = false
        try forEachLogicalHole(descriptor: descriptor, size: size) { _, _ in
            hasLogicalHole = true
        }
        guard !hasLogicalHole else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_blocks >= 0,
              UInt64(metadata.st_blocks) <= UInt64.max / 512,
              UInt64(metadata.st_blocks) * 512 >= size else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        try requireHostCapacity(
            descriptor: descriptor,
            allocationBytes: 0,
            reserveBytes: hostReserveBytes
        )
    }

    private func forEachLogicalHole(
        descriptor: Int32,
        size: UInt64,
        _ body: (_ offset: off_t, _ length: off_t) throws -> Void
    ) throws {
        guard size <= UInt64(Int64.max) else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        let end = off_t(size)
        var cursor: off_t = 0
        while cursor < end {
            errno = 0
            let hole = Darwin.lseek(descriptor, cursor, SEEK_HOLE)
            if hole < 0 {
                if errno == ENXIO { return }
                throw CapsuleVmStateDiskError.allocationFailed
            }
            guard hole >= cursor, hole <= end else {
                throw CapsuleVmStateDiskError.allocationFailed
            }
            if hole == end { return }

            errno = 0
            let nextData = Darwin.lseek(descriptor, hole, SEEK_DATA)
            let data: off_t
            if nextData < 0, errno == ENXIO {
                data = end
            } else {
                guard nextData > hole, nextData <= end else {
                    throw CapsuleVmStateDiskError.allocationFailed
                }
                data = nextData
            }
            try body(hole, data - hole)
            cursor = data
        }
    }

    private func filesystemBlockSize(descriptor: Int32) throws -> UInt64 {
        var filesystem = statfs()
        guard Darwin.fstatfs(descriptor, &filesystem) == 0,
              filesystem.f_bsize > 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        return UInt64(filesystem.f_bsize)
    }

    private func requireHostCapacity(
        descriptor: Int32,
        allocationBytes: UInt64,
        reserveBytes: UInt64
    ) throws {
        var filesystem = statfs()
        guard Darwin.fstatfs(descriptor, &filesystem) == 0,
              filesystem.f_bsize > 0,
              filesystem.f_bavail >= 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        let blockSize = UInt64(filesystem.f_bsize)
        let availableBlocks = UInt64(filesystem.f_bavail)
        guard availableBlocks <= UInt64.max / blockSize else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        let availableBytes = availableBlocks * blockSize
        guard allocationBytes <= UInt64.max - reserveBytes,
              availableBytes >= allocationBytes + reserveBytes else {
            throw CapsuleVmStateDiskError.insufficientHostCapacity
        }
    }
}

/// Exact Host admission requirements measured while the helper owns the
/// stable state-disk lease. `additionalPhysicalBytes` is the maximum new
/// backing allocation required before publication, and `peakPhysicalBytes`
/// includes the existing disk that remains live until an atomic replacement
/// commits.
public struct CapsuleVmStateDiskPreparationRequirements: Equatable, Sendable {
    public let stateDiskBytes: UInt64
    public let existingPhysicalBytes: UInt64
    public let additionalPhysicalBytes: UInt64
    public let peakPhysicalBytes: UInt64
}

/// A one-use preparation lease. It retains `state.raw.lock` from inspection
/// through allocation/publication so Host admission and helper mutation refer
/// to one stable filesystem state. Cancellation releases the lease without
/// creating, resizing, or replacing the disk.
public final class CapsuleVmStateDiskPreparation: @unchecked Sendable {
    public let requirements: CapsuleVmStateDiskPreparationRequirements

    private let directoryURL: URL
    private let directoryIdentity: CapsuleVmFileIdentity
    private let leaseIdentity: CapsuleVmFileIdentity
    private let existingStateIdentity: CapsuleVmFileIdentity?
    private let existingStateSize: UInt64?
    private let allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    private let mutex = NSLock()
    private var directoryDescriptor: Int32
    private var leaseDescriptor: Int32
    private var existingStateDescriptor: Int32
    private var active = true

    fileprivate init(
        requirements: CapsuleVmStateDiskPreparationRequirements,
        directoryURL: URL,
        directoryDescriptor: Int32,
        leaseDescriptor: Int32,
        existingStateDescriptor: Int32,
        directoryIdentity: CapsuleVmFileIdentity,
        leaseIdentity: CapsuleVmFileIdentity,
        existingStateIdentity: CapsuleVmFileIdentity?,
        existingStateSize: UInt64?,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) {
        self.requirements = requirements
        self.directoryURL = directoryURL
        self.directoryDescriptor = directoryDescriptor
        self.leaseDescriptor = leaseDescriptor
        self.existingStateDescriptor = existingStateDescriptor
        self.directoryIdentity = directoryIdentity
        self.leaseIdentity = leaseIdentity
        self.existingStateIdentity = existingStateIdentity
        self.existingStateSize = existingStateSize
        self.allocationPolicy = allocationPolicy
    }

    deinit {
        try? cancel()
    }

    public var isActive: Bool {
        mutex.lock()
        defer { mutex.unlock() }
        return active
    }

    public func consume() throws -> CapsuleVmStateDiskLease {
        mutex.lock()
        defer { mutex.unlock() }
        guard active else { throw CapsuleVmStateDiskError.leaseNotHeld }

        do {
            try revalidateLocked()
            let stateDescriptor = try CapsuleVmStateDiskManager.materializePreparedStateDisk(
                directoryDescriptor: directoryDescriptor,
                existingDescriptor: existingStateDescriptor,
                existingSize: existingStateSize,
                requestedSize: requirements.stateDiskBytes,
                allocationPolicy: allocationPolicy
            )
            existingStateDescriptor = -1
            var transferStateDescriptor = false
            defer {
                if !transferStateDescriptor { _ = Darwin.close(stateDescriptor) }
            }

            var stateMetadata = stat()
            guard Darwin.fstat(stateDescriptor, &stateMetadata) == 0 else {
                throw CapsuleVmStateDiskError.fileUnavailable
            }
            try validateStateMetadata(
                stateMetadata,
                expectedSize: requirements.stateDiskBytes
            )
            let stateIdentity = CapsuleVmFileIdentity(stateMetadata)
            try validatePathEntry(
                directoryDescriptor: directoryDescriptor,
                name: CapsuleVmStateDiskManager.fileName,
                expected: stateIdentity
            )
            try allocationPolicy.validateFile(
                descriptor: stateDescriptor,
                size: requirements.stateDiskBytes
            )

            let lease = CapsuleVmStateDiskLease(
                disk: CapsuleVmStateDisk(
                    url: directoryURL.appendingPathComponent(
                        CapsuleVmStateDiskManager.fileName,
                        isDirectory: false
                    ),
                    size: requirements.stateDiskBytes
                ),
                directoryURL: directoryURL,
                directoryDescriptor: directoryDescriptor,
                leaseDescriptor: leaseDescriptor,
                stateDescriptor: stateDescriptor,
                directoryIdentity: directoryIdentity,
                leaseIdentity: leaseIdentity,
                stateIdentity: stateIdentity,
                allocationPolicy: allocationPolicy
            )
            directoryDescriptor = -1
            leaseDescriptor = -1
            active = false
            transferStateDescriptor = true
            return lease
        } catch {
            let releaseError = releaseLocked()
            if let releaseError { throw releaseError }
            throw error
        }
    }

    public func cancel() throws {
        mutex.lock()
        defer { mutex.unlock() }
        guard active else { return }
        if let error = releaseLocked() { throw error }
    }

    private func revalidateLocked() throws {
        var directoryMetadata = stat()
        guard Darwin.fstat(directoryDescriptor, &directoryMetadata) == 0,
              CapsuleVmFileIdentity(directoryMetadata) == directoryIdentity else {
            throw CapsuleVmStateDiskError.pathChanged
        }
        try validateDirectoryMetadata(directoryMetadata)

        let reopenedDirectory = Darwin.open(
            directoryURL.path,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY
        )
        guard reopenedDirectory >= 0 else {
            throw CapsuleVmStateDiskError.pathChanged
        }
        defer { _ = Darwin.close(reopenedDirectory) }
        var reopenedMetadata = stat()
        guard Darwin.fstat(reopenedDirectory, &reopenedMetadata) == 0,
              CapsuleVmFileIdentity(reopenedMetadata) == directoryIdentity else {
            throw CapsuleVmStateDiskError.pathChanged
        }

        var leaseMetadata = stat()
        guard Darwin.fstat(leaseDescriptor, &leaseMetadata) == 0,
              CapsuleVmFileIdentity(leaseMetadata) == leaseIdentity else {
            throw CapsuleVmStateDiskError.leaseNotHeld
        }
        try validateLeaseMetadata(leaseMetadata)
        try validatePathEntry(
            directoryDescriptor: directoryDescriptor,
            name: CapsuleVmStateDiskManager.leaseFileName,
            expected: leaseIdentity
        )

        if let existingStateIdentity, let existingStateSize {
            var metadata = stat()
            guard existingStateDescriptor >= 0,
                  Darwin.fstat(existingStateDescriptor, &metadata) == 0,
                  CapsuleVmFileIdentity(metadata) == existingStateIdentity else {
                throw CapsuleVmStateDiskError.pathChanged
            }
            try validateStateMetadata(metadata, expectedSize: existingStateSize)
            try validatePathEntry(
                directoryDescriptor: directoryDescriptor,
                name: CapsuleVmStateDiskManager.fileName,
                expected: existingStateIdentity
            )
        } else {
            var metadata = stat()
            let status = CapsuleVmStateDiskManager.fileName.withCString { name in
                Darwin.fstatat(directoryDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW)
            }
            guard status != 0, errno == ENOENT else {
                throw CapsuleVmStateDiskError.pathChanged
            }
        }

        var creatingMetadata = stat()
        let creatingStatus = CapsuleVmStateDiskManager.creatingFileName.withCString { name in
            Darwin.fstatat(directoryDescriptor, name, &creatingMetadata, AT_SYMLINK_NOFOLLOW)
        }
        guard creatingStatus != 0, errno == ENOENT else {
            throw CapsuleVmStateDiskError.pathChanged
        }
    }

    private func releaseLocked() -> CapsuleVmStateDiskError? {
        if existingStateDescriptor >= 0 {
            guard Darwin.close(existingStateDescriptor) == 0 else {
                existingStateDescriptor = -1
                active = false
                return .leaseReleaseFailed
            }
            existingStateDescriptor = -1
        }
        let leaseCloseResult = leaseDescriptor >= 0 ? Darwin.close(leaseDescriptor) : 0
        leaseDescriptor = -1
        let directoryCloseResult = directoryDescriptor >= 0
            ? Darwin.close(directoryDescriptor)
            : 0
        directoryDescriptor = -1
        active = false
        return leaseCloseResult == 0 && directoryCloseResult == 0
            ? nil
            : .leaseReleaseFailed
    }
}

/// An fd-owning, non-copyable-by-convention lease for the Guest's writable
/// state disk. The persistent sidecar file is only a stable inode on which the
/// kernel lock lives; its presence is never treated as ownership authority.
public final class CapsuleVmStateDiskLease: @unchecked Sendable {
    public let disk: CapsuleVmStateDisk

    private let directoryURL: URL
    private let directoryIdentity: CapsuleVmFileIdentity
    private let leaseIdentity: CapsuleVmFileIdentity
    private let stateIdentity: CapsuleVmFileIdentity
    private let allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    private let mutex = NSLock()
    private var directoryDescriptor: Int32
    private var leaseDescriptor: Int32
    private var stateDescriptor: Int32
    private var active = true
    private var releaseFailed = false

    fileprivate init(
        disk: CapsuleVmStateDisk,
        directoryURL: URL,
        directoryDescriptor: Int32,
        leaseDescriptor: Int32,
        stateDescriptor: Int32,
        directoryIdentity: CapsuleVmFileIdentity,
        leaseIdentity: CapsuleVmFileIdentity,
        stateIdentity: CapsuleVmFileIdentity,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) {
        self.disk = disk
        self.directoryURL = directoryURL
        self.directoryDescriptor = directoryDescriptor
        self.leaseDescriptor = leaseDescriptor
        self.stateDescriptor = stateDescriptor
        self.directoryIdentity = directoryIdentity
        self.leaseIdentity = leaseIdentity
        self.stateIdentity = stateIdentity
        self.allocationPolicy = allocationPolicy
    }

    deinit {
        // Process death also drops the BSD flock lease. This best-effort path
        // handles ordinary owner teardown; explicit lifecycle release remains
        // the only production success path.
        try? release()
    }

    public var isActive: Bool {
        mutex.lock()
        defer { mutex.unlock() }
        return active
    }

    /// Revalidates both the held descriptors and their fixed directory entries.
    /// VZ accepts a URL rather than an fd, so callers invoke this immediately
    /// around attachment construction to narrow that unavoidable reopen race.
    public func validateForAttachment() throws {
        mutex.lock()
        defer { mutex.unlock() }
        guard active else { throw CapsuleVmStateDiskError.leaseNotHeld }

        var directoryMetadata = stat()
        guard Darwin.fstat(directoryDescriptor, &directoryMetadata) == 0,
              CapsuleVmFileIdentity(directoryMetadata) == directoryIdentity else {
            throw CapsuleVmStateDiskError.pathChanged
        }
        try validateDirectoryMetadata(directoryMetadata)

        var reopenedDirectoryMetadata = stat()
        let reopenedDirectory = Darwin.open(
            directoryURL.path,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY
        )
        guard reopenedDirectory >= 0 else {
            throw CapsuleVmStateDiskError.pathChanged
        }
        defer { _ = Darwin.close(reopenedDirectory) }
        guard Darwin.fstat(reopenedDirectory, &reopenedDirectoryMetadata) == 0,
              CapsuleVmFileIdentity(reopenedDirectoryMetadata) == directoryIdentity else {
            throw CapsuleVmStateDiskError.pathChanged
        }

        var leaseMetadata = stat()
        guard Darwin.fstat(leaseDescriptor, &leaseMetadata) == 0,
              CapsuleVmFileIdentity(leaseMetadata) == leaseIdentity else {
            throw CapsuleVmStateDiskError.leaseNotHeld
        }
        try validateLeaseMetadata(leaseMetadata)
        try validatePathEntry(
            directoryDescriptor: directoryDescriptor,
            name: CapsuleVmStateDiskManager.leaseFileName,
            expected: leaseIdentity
        )

        var stateMetadata = stat()
        guard Darwin.fstat(stateDescriptor, &stateMetadata) == 0,
              CapsuleVmFileIdentity(stateMetadata) == stateIdentity else {
            throw CapsuleVmStateDiskError.pathChanged
        }
        try validateStateMetadata(stateMetadata, expectedSize: disk.size)
        try allocationPolicy.validateFile(descriptor: stateDescriptor, size: disk.size)
        try validatePathEntry(
            directoryDescriptor: directoryDescriptor,
            name: CapsuleVmStateDiskManager.fileName,
            expected: stateIdentity
        )
    }

    /// Explicitly relinquishes the lease. The sidecar is deliberately retained:
    /// unlinking it would permit two processes to lock different inodes.
    public func release() throws {
        mutex.lock()
        defer { mutex.unlock() }
        guard active else { return }
        guard !releaseFailed else {
            throw CapsuleVmStateDiskError.leaseReleaseFailed
        }

        // Close the state fd before unlocking the stable sidecar. Never retry a
        // failed close: Darwin may already have consumed the descriptor.
        guard Darwin.close(stateDescriptor) == 0 else {
            // close(2) has an uncertain descriptor-consumption result on error.
            // Poison ownership and intentionally leak the sidecar fd so the
            // kernel cannot release this lease before helper process exit.
            stateDescriptor = -1
            releaseFailed = true
            throw CapsuleVmStateDiskError.leaseReleaseFailed
        }
        stateDescriptor = -1

        let leaseCloseResult = Darwin.close(leaseDescriptor)
        leaseDescriptor = -1
        let directoryCloseResult = Darwin.close(directoryDescriptor)
        directoryDescriptor = -1
        guard leaseCloseResult == 0, directoryCloseResult == 0 else {
            releaseFailed = true
            throw CapsuleVmStateDiskError.leaseReleaseFailed
        }
        active = false
    }
}

/// A small lifecycle policy object that makes the stop-error rule independently
/// testable. Once a stop error makes VM termination uncertain, normal lifecycle
/// code can never release or replace the lease; helper teardown is the boundary.
final class CapsuleVmStateDiskLeaseHolder: @unchecked Sendable {
    enum Outcome: Equatable, Sendable {
        case neverStarted
        case startFailed
        case confirmedStopped
        case stopFailed
    }

    private let mutex = NSLock()
    private var lease: CapsuleVmStateDiskLease?
    private var retainedAfterStopFailure = false

    var hasLease: Bool {
        mutex.lock()
        defer { mutex.unlock() }
        return lease != nil
    }

    var mustRetainUntilProcessExit: Bool {
        mutex.lock()
        defer { mutex.unlock() }
        return retainedAfterStopFailure
    }

    func install(_ newLease: CapsuleVmStateDiskLease) throws {
        mutex.lock()
        defer { mutex.unlock() }
        guard lease == nil, !retainedAfterStopFailure else {
            throw CapsuleVmStateDiskError.leaseUnavailable
        }
        lease = newLease
    }

    func currentLease() -> CapsuleVmStateDiskLease? {
        mutex.lock()
        defer { mutex.unlock() }
        return lease
    }

    func complete(_ outcome: Outcome) throws {
        mutex.lock()
        defer { mutex.unlock() }
        guard let lease else { return }
        if outcome == .stopFailed {
            retainedAfterStopFailure = true
            return
        }
        guard !retainedAfterStopFailure else { return }
        try lease.release()
        self.lease = nil
    }
}

/// Creates or reopens the one Host-owned, non-authoritative writable Guest
/// disk and acquires its cross-process lifetime lease. Fixed filenames are
/// never derived from App input.
public enum CapsuleVmStateDiskManager {
    public static let fileName = "state.raw"
    public static let leaseFileName = "state.raw.lock"
    fileprivate static let creatingFileName = ".state.raw.creating"
    public static let minimumSize: UInt64 = 4 * 1_024 * 1_024 * 1_024
    public static let maximumSize: UInt64 = 64 * 1_024 * 1_024 * 1_024
    public static let sizeAlignment: UInt64 = 64 * 1_024 * 1_024

    public static func acquire(
        in directoryURL: URL,
        size: UInt64
    ) throws -> CapsuleVmStateDiskLease {
        let preparation = try prepare(
            in: directoryURL,
            size: size,
            allocationPolicy: .production
        )
        return try preparation.consume()
    }

    public static func prepare(
        in directoryURL: URL,
        size: UInt64
    ) throws -> CapsuleVmStateDiskPreparation {
        try prepare(
            in: directoryURL,
            size: size,
            allocationPolicy: .production
        )
    }

    /// The security/lifecycle tests use a sparse file so they can exercise
    /// GiB policy sizes without consuming GiB of the developer or CI volume.
    /// Production has no call path to this internal entry point.
    static func acquireForTesting(
        in directoryURL: URL,
        size: UInt64
    ) throws -> CapsuleVmStateDiskLease {
        let preparation = try prepare(
            in: directoryURL,
            size: size,
            allocationPolicy: .sparseTesting
        )
        return try preparation.consume()
    }

    static func acquireForTesting(
        in directoryURL: URL,
        size: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) throws -> CapsuleVmStateDiskLease {
        let preparation = try prepare(
            in: directoryURL,
            size: size,
            allocationPolicy: allocationPolicy
        )
        return try preparation.consume()
    }

    static func prepareForTesting(
        in directoryURL: URL,
        size: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy = .sparseTesting
    ) throws -> CapsuleVmStateDiskPreparation {
        try prepare(in: directoryURL, size: size, allocationPolicy: allocationPolicy)
    }

    private static func prepare(
        in directoryURL: URL,
        size: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) throws -> CapsuleVmStateDiskPreparation {
        guard directoryURL.isFileURL,
              directoryURL.path.hasPrefix("/"),
              !directoryURL.path.contains("\0") else {
            throw CapsuleVmStateDiskError.invalidDirectory
        }
        guard isValidSize(size) else {
            throw CapsuleVmStateDiskError.invalidSize
        }

        // Do not use Foundation's standardizedFileURL here: on macOS it may
        // rewrite the real /private/var path back through the /var symlink,
        // defeating O_NOFOLLOW_ANY. The Electron Host supplies a realpath and
        // this layer opens that exact absolute path without following links.
        let trustedDirectory = URL(
            fileURLWithPath: directoryURL.path,
            isDirectory: true
        )
        let directoryDescriptor = Darwin.open(
            trustedDirectory.path,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY
        )
        guard directoryDescriptor >= 0 else {
            throw CapsuleVmStateDiskError.directoryUnavailable
        }
        var keepDescriptors = false
        var leaseDescriptor: Int32 = -1
        var stateDescriptor: Int32 = -1
        defer {
            if !keepDescriptors {
                if stateDescriptor >= 0 { _ = Darwin.close(stateDescriptor) }
                if leaseDescriptor >= 0 { _ = Darwin.close(leaseDescriptor) }
                _ = Darwin.close(directoryDescriptor)
            }
        }

        var directoryMetadata = stat()
        guard Darwin.fstat(directoryDescriptor, &directoryMetadata) == 0 else {
            throw CapsuleVmStateDiskError.directoryUnavailable
        }
        try validateDirectoryMetadata(directoryMetadata)
        let directoryIdentity = CapsuleVmFileIdentity(directoryMetadata)

        leaseDescriptor = leaseFileName.withCString { name in
            Darwin.openat(
                directoryDescriptor,
                name,
                O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_EXLOCK | O_NONBLOCK,
                S_IRUSR | S_IWUSR
            )
        }
        guard leaseDescriptor >= 0 else {
            if errno == EWOULDBLOCK || errno == EAGAIN {
                throw CapsuleVmStateDiskError.leaseUnavailable
            }
            throw CapsuleVmStateDiskError.leaseFileUnavailable
        }

        var leaseMetadata = stat()
        guard Darwin.fstat(leaseDescriptor, &leaseMetadata) == 0 else {
            throw CapsuleVmStateDiskError.leaseFileUnavailable
        }
        try validateLeaseMetadata(leaseMetadata)
        let leaseIdentity = CapsuleVmFileIdentity(leaseMetadata)
        try validatePathEntry(
            directoryDescriptor: directoryDescriptor,
            name: leaseFileName,
            expected: leaseIdentity
        )

        try removeRecoverableCreatingFile(directoryDescriptor: directoryDescriptor)

        stateDescriptor = fileName.withCString { name in
            Darwin.openat(directoryDescriptor, name, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        }
        var stateIdentity: CapsuleVmFileIdentity?
        var existingSize: UInt64?
        var existingPhysicalBytes: UInt64 = 0
        var additionalPhysicalBytes: UInt64
        if stateDescriptor >= 0 {
            var stateMetadata = stat()
            guard Darwin.fstat(stateDescriptor, &stateMetadata) == 0 else {
                throw CapsuleVmStateDiskError.fileUnavailable
            }
            try validateCreatingMetadata(stateMetadata)
            guard stateMetadata.st_size >= 0 else {
                throw CapsuleVmStateDiskError.fileSizeMismatch
            }
            let validatedSize = UInt64(stateMetadata.st_size)
            guard isValidSize(validatedSize) else {
                throw CapsuleVmStateDiskError.fileSizeMismatch
            }
            let validatedIdentity = CapsuleVmFileIdentity(stateMetadata)
            try validatePathEntry(
                directoryDescriptor: directoryDescriptor,
                name: fileName,
                expected: validatedIdentity
            )
            stateIdentity = validatedIdentity
            existingSize = validatedSize
            existingPhysicalBytes = try allocationPolicy.physicalBytes(
                descriptor: stateDescriptor
            )
            additionalPhysicalBytes = validatedSize == size
                ? try allocationPolicy.additionalAllocationBytes(
                    descriptor: stateDescriptor,
                    size: size
                )
                : (allocationPolicy.requiresPhysicalAllocation ? size : 0)
        } else {
            guard errno == ENOENT else {
                throw CapsuleVmStateDiskError.fileUnavailable
            }
            stateDescriptor = -1
            additionalPhysicalBytes = allocationPolicy.requiresPhysicalAllocation ? size : 0
        }
        guard existingPhysicalBytes <= UInt64.max - additionalPhysicalBytes else {
            throw CapsuleVmStateDiskError.allocationFailed
        }

        keepDescriptors = true
        return CapsuleVmStateDiskPreparation(
            requirements: CapsuleVmStateDiskPreparationRequirements(
                stateDiskBytes: size,
                existingPhysicalBytes: existingPhysicalBytes,
                additionalPhysicalBytes: additionalPhysicalBytes,
                peakPhysicalBytes: existingPhysicalBytes + additionalPhysicalBytes
            ),
            directoryURL: trustedDirectory,
            directoryDescriptor: directoryDescriptor,
            leaseDescriptor: leaseDescriptor,
            existingStateDescriptor: stateDescriptor,
            directoryIdentity: directoryIdentity,
            leaseIdentity: leaseIdentity,
            existingStateIdentity: stateIdentity,
            existingStateSize: existingSize,
            allocationPolicy: allocationPolicy
        )
    }

    fileprivate static func materializePreparedStateDisk(
        directoryDescriptor: Int32,
        existingDescriptor: Int32,
        existingSize: UInt64?,
        requestedSize: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) throws -> Int32 {
        if existingDescriptor >= 0, let existingSize {
            if existingSize == requestedSize {
                try allocationPolicy.prepareExistingFile(
                    descriptor: existingDescriptor,
                    size: requestedSize
                )
                try allocationPolicy.validateFile(
                    descriptor: existingDescriptor,
                    size: requestedSize
                )
                return existingDescriptor
            }
            return try replaceStateDisk(
                directoryDescriptor: directoryDescriptor,
                existingDescriptor: existingDescriptor,
                size: requestedSize,
                allocationPolicy: allocationPolicy
            )
        }

        let descriptor = try createTemporaryStateDisk(
            directoryDescriptor: directoryDescriptor,
            size: requestedSize,
            allocationPolicy: allocationPolicy
        )
        var renamed = false
        defer {
            if !renamed {
                _ = Darwin.close(descriptor)
                _ = creatingFileName.withCString { name in
                    Darwin.unlinkat(directoryDescriptor, name, 0)
                }
            }
        }

        let renameResult = creatingFileName.withCString { sourceName in
            fileName.withCString { destinationName in
                Darwin.renameatx_np(
                    directoryDescriptor,
                    sourceName,
                    directoryDescriptor,
                    destinationName,
                    UInt32(RENAME_EXCL)
                )
            }
        }
        guard renameResult == 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        guard Darwin.fsync(directoryDescriptor) == 0 else {
            _ = fileName.withCString { name in
                Darwin.unlinkat(directoryDescriptor, name, 0)
            }
            _ = Darwin.fsync(directoryDescriptor)
            throw CapsuleVmStateDiskError.allocationFailed
        }
        renamed = true
        return descriptor
    }

    private static func createTemporaryStateDisk(
        directoryDescriptor: Int32,
        size: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) throws -> Int32 {
        let descriptor = creatingFileName.withCString { name in
            Darwin.openat(
                directoryDescriptor,
                name,
                O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                S_IRUSR | S_IWUSR
            )
        }
        guard descriptor >= 0 else {
            throw CapsuleVmStateDiskError.fileUnavailable
        }
        var prepared = false
        defer {
            if !prepared {
                _ = Darwin.close(descriptor)
                _ = creatingFileName.withCString { name in
                    Darwin.unlinkat(directoryDescriptor, name, 0)
                }
            }
        }

        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            throw CapsuleVmStateDiskError.fileUnavailable
        }
        try validateCreatingMetadata(metadata)
        try allocationPolicy.prepareNewFile(descriptor: descriptor, size: size)
        prepared = true
        return descriptor
    }

    private static func replaceStateDisk(
        directoryDescriptor: Int32,
        existingDescriptor: Int32,
        size: UInt64,
        allocationPolicy: CapsuleVmStateDiskAllocationPolicy
    ) throws -> Int32 {
        let replacementDescriptor = try createTemporaryStateDisk(
            directoryDescriptor: directoryDescriptor,
            size: size,
            allocationPolicy: allocationPolicy
        )
        var committed = false
        var temporaryNameContainsReplacement = true
        defer {
            if !committed {
                _ = Darwin.close(replacementDescriptor)
                // After RENAME_SWAP the temporary name contains the old disk.
                // Never unlink that inode unless rollback has first restored
                // the original namespace and put the replacement back here.
                if temporaryNameContainsReplacement {
                    _ = creatingFileName.withCString { name in
                        Darwin.unlinkat(directoryDescriptor, name, 0)
                    }
                }
            }
        }

        let swapResult = creatingFileName.withCString { temporaryName in
            fileName.withCString { stateName in
                Darwin.renameatx_np(
                    directoryDescriptor,
                    temporaryName,
                    directoryDescriptor,
                    stateName,
                    UInt32(RENAME_SWAP)
                )
            }
        }
        guard swapResult == 0 else {
            throw CapsuleVmStateDiskError.allocationFailed
        }
        temporaryNameContainsReplacement = false

        // Make the atomic new-name decision durable before deleting the old
        // inode now parked at the private temporary name. Until unlink, a
        // failed cleanup can still swap the old disk back into place.
        guard Darwin.fsync(directoryDescriptor) == 0 else {
            try rollbackStateDiskSwap(directoryDescriptor: directoryDescriptor)
            temporaryNameContainsReplacement = true
            throw CapsuleVmStateDiskError.allocationFailed
        }
        let removedOld = creatingFileName.withCString { name in
            Darwin.unlinkat(directoryDescriptor, name, 0)
        }
        guard removedOld == 0 else {
            try rollbackStateDiskSwap(directoryDescriptor: directoryDescriptor)
            temporaryNameContainsReplacement = true
            throw CapsuleVmStateDiskError.allocationFailed
        }
        guard Darwin.fsync(directoryDescriptor) == 0 else {
            // The namespace still names the fully allocated replacement. The
            // old inode was already unlinked, so fail closed; callers will not
            // attach a disk whose publication durability was not confirmed.
            throw CapsuleVmStateDiskError.allocationFailed
        }

        _ = Darwin.close(existingDescriptor)
        committed = true
        return replacementDescriptor
    }

    private static func rollbackStateDiskSwap(directoryDescriptor: Int32) throws {
        let result = creatingFileName.withCString { temporaryName in
            fileName.withCString { stateName in
                Darwin.renameatx_np(
                    directoryDescriptor,
                    temporaryName,
                    directoryDescriptor,
                    stateName,
                    UInt32(RENAME_SWAP)
                )
            }
        }
        guard result == 0, Darwin.fsync(directoryDescriptor) == 0 else {
            throw CapsuleVmStateDiskError.pathChanged
        }
    }

    private static func removeRecoverableCreatingFile(directoryDescriptor: Int32) throws {
        var metadata = stat()
        let status = creatingFileName.withCString { name in
            Darwin.fstatat(directoryDescriptor, name, &metadata, AT_SYMLINK_NOFOLLOW)
        }
        if status != 0 {
            guard errno == ENOENT else { throw CapsuleVmStateDiskError.fileUnavailable }
            return
        }
        try validateCreatingMetadata(metadata)
        guard metadata.st_size >= 0 else {
            throw CapsuleVmStateDiskError.fileSizeMismatch
        }
        let residueSize = UInt64(metadata.st_size)
        guard residueSize == 0 || isValidSize(residueSize) else {
            throw CapsuleVmStateDiskError.fileSizeMismatch
        }
        let removed = creatingFileName.withCString { name in
            Darwin.unlinkat(directoryDescriptor, name, 0)
        }
        guard removed == 0, Darwin.fsync(directoryDescriptor) == 0 else {
            throw CapsuleVmStateDiskError.fileUnavailable
        }
    }

    private static func isValidSize(_ size: UInt64) -> Bool {
        size >= minimumSize
            && size <= maximumSize
            && size.isMultiple(of: sizeAlignment)
    }
}

private func validateDirectoryMetadata(_ metadata: stat) throws {
    guard (metadata.st_mode & S_IFMT) == S_IFDIR else {
        throw CapsuleVmStateDiskError.directoryUnavailable
    }
    guard metadata.st_uid == Darwin.geteuid() else {
        throw CapsuleVmStateDiskError.directoryNotOwned
    }
    guard (metadata.st_mode & 0o077) == 0 else {
        throw CapsuleVmStateDiskError.directoryPermissions
    }
}

private func validateLeaseMetadata(_ metadata: stat) throws {
    guard (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_uid == Darwin.geteuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & 0o077) == 0,
          metadata.st_size == 0 else {
        throw CapsuleVmStateDiskError.leaseFileInvalid
    }
}

private func validateCreatingMetadata(_ metadata: stat) throws {
    guard (metadata.st_mode & S_IFMT) == S_IFREG else {
        throw CapsuleVmStateDiskError.fileNotRegular
    }
    guard metadata.st_uid == Darwin.geteuid() else {
        throw CapsuleVmStateDiskError.fileNotOwned
    }
    guard metadata.st_nlink == 1 else {
        throw CapsuleVmStateDiskError.fileHasMultipleLinks
    }
    guard (metadata.st_mode & 0o077) == 0 else {
        throw CapsuleVmStateDiskError.filePermissions
    }
}

private func validateStateMetadata(_ metadata: stat, expectedSize: UInt64) throws {
    try validateCreatingMetadata(metadata)
    guard metadata.st_size >= 0, UInt64(metadata.st_size) == expectedSize else {
        throw CapsuleVmStateDiskError.fileSizeMismatch
    }
}

private func validatePathEntry(
    directoryDescriptor: Int32,
    name: String,
    expected: CapsuleVmFileIdentity
) throws {
    var metadata = stat()
    let status = name.withCString { path in
        Darwin.fstatat(directoryDescriptor, path, &metadata, AT_SYMLINK_NOFOLLOW)
    }
    guard status == 0,
          (metadata.st_mode & S_IFMT) == S_IFREG,
          CapsuleVmFileIdentity(metadata) == expected else {
        throw CapsuleVmStateDiskError.pathChanged
    }
}
