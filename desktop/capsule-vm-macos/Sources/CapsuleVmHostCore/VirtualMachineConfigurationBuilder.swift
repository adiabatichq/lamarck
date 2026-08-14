import Foundation
import Virtualization

public struct CapsuleVmSerialConsole {
    public let input: FileHandle?
    public let output: FileHandle

    public init(input: FileHandle?, output: FileHandle) {
        self.input = input
        self.output = output
    }
}

public enum CapsuleVmConfigurationError: Error, Equatable, CustomStringConvertible, Sendable {
    case invalidCPUCount(minimum: Int, maximum: Int)
    case invalidMemorySize(minimum: UInt64, maximum: UInt64)
    case configurationValidationFailed(String)

    public var description: String {
        switch self {
        case .invalidCPUCount(let minimum, let maximum):
            return "Capsule VM CPU count must be between \(minimum) and \(maximum)"
        case .invalidMemorySize(let minimum, let maximum):
            return "Capsule VM memory must be MiB-aligned and between \(minimum) and \(maximum) bytes"
        case .configurationValidationFailed(let message):
            return "Capsule VM configuration validation failed: \(message)"
        }
    }
}

public enum CapsuleVmConfigurationBuilder {
    public static let baseKernelCommandLine = "console=hvc0 root=/dev/vda ro panic=-1"
    public static let rootBlockDeviceIdentifier = "lamarck-rootfs"
    public static let stateBlockDeviceIdentifier = "lamarck-state"
    public static let stateDevicePath = "/dev/vdb"
    public static let stateFilesystemLabel = "LAMARCK_STATE"
    public static let workspaceFilesShareTag = "lamarck-files"

    public static func kernelCommandLine(for image: VerifiedGuestImage) -> String {
        [
            baseKernelCommandLine,
            "lamarck.image_digest=\(image.imageDigest)",
            "lamarck.state_device=\(stateDevicePath)",
            "lamarck.state_label=\(stateFilesystemLabel)",
        ].joined(separator: " ")
    }

    /// Builds and validates the closed macOS Linux-Guest hardware policy.
    /// Raw paths are intentionally not accepted; only a signed VerifiedGuestImage
    /// can reach the Virtualization.framework configuration boundary.
    public static func build(
        image: VerifiedGuestImage,
        workspaceFilesURL: URL,
        stateDiskLease: CapsuleVmStateDiskLease,
        cpuCount: Int,
        memorySize: UInt64,
        serialConsole: CapsuleVmSerialConsole
    ) throws -> VZVirtualMachineConfiguration {
        let configuration = try makeUnvalidatedConfiguration(
            image: image,
            workspaceFilesURL: workspaceFilesURL,
            stateDiskLease: stateDiskLease,
            cpuCount: cpuCount,
            memorySize: memorySize,
            serialConsole: serialConsole
        )
        do {
            try configuration.validate()
        } catch {
            throw CapsuleVmConfigurationError.configurationValidationFailed(
                String(describing: error)
            )
        }
        return configuration
    }

    /// Internal seam for structural unit tests. Production callers only receive
    /// the public builder above, which always invokes framework validation.
    static func makeUnvalidatedConfiguration(
        image: VerifiedGuestImage,
        workspaceFilesURL: URL,
        stateDiskLease: CapsuleVmStateDiskLease,
        cpuCount: Int,
        memorySize: UInt64,
        serialConsole: CapsuleVmSerialConsole
    ) throws -> VZVirtualMachineConfiguration {
        let minimumCPUCount = VZVirtualMachineConfiguration.minimumAllowedCPUCount
        let maximumCPUCount = VZVirtualMachineConfiguration.maximumAllowedCPUCount
        guard (minimumCPUCount...maximumCPUCount).contains(cpuCount) else {
            throw CapsuleVmConfigurationError.invalidCPUCount(
                minimum: minimumCPUCount,
                maximum: maximumCPUCount
            )
        }

        let minimumMemorySize = VZVirtualMachineConfiguration.minimumAllowedMemorySize
        let maximumMemorySize = VZVirtualMachineConfiguration.maximumAllowedMemorySize
        let mebibyte: UInt64 = 1_024 * 1_024
        guard memorySize.isMultiple(of: mebibyte),
              (minimumMemorySize...maximumMemorySize).contains(memorySize) else {
            throw CapsuleVmConfigurationError.invalidMemorySize(
                minimum: minimumMemorySize,
                maximum: maximumMemorySize
            )
        }

        let configuration = VZVirtualMachineConfiguration()
        configuration.platform = VZGenericPlatformConfiguration()
        configuration.cpuCount = cpuCount
        configuration.memorySize = memorySize

        let bootLoader = VZLinuxBootLoader(kernelURL: image.kernelURL)
        bootLoader.initialRamdiskURL = image.initialRamdiskURL
        bootLoader.commandLine = kernelCommandLine(for: image)
        configuration.bootLoader = bootLoader

        let rootAttachment = try VZDiskImageStorageDeviceAttachment(
            url: image.rootfsURL,
            readOnly: true
        )
        let rootDevice = VZVirtioBlockDeviceConfiguration(attachment: rootAttachment)
        rootDevice.blockDeviceIdentifier = rootBlockDeviceIdentifier
        try stateDiskLease.validateForAttachment()
        let stateAttachment = try VZDiskImageStorageDeviceAttachment(
            url: stateDiskLease.disk.url,
            readOnly: false
        )
        try stateDiskLease.validateForAttachment()
        let stateDevice = VZVirtioBlockDeviceConfiguration(attachment: stateAttachment)
        stateDevice.blockDeviceIdentifier = stateBlockDeviceIdentifier
        configuration.storageDevices = [rootDevice, stateDevice]

        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
        serialPort.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: serialConsole.input,
            fileHandleForWriting: serialConsole.output
        )
        configuration.serialPorts = [serialPort]

        let workspaceShare = VZVirtioFileSystemDeviceConfiguration(
            tag: workspaceFilesShareTag
        )
        workspaceShare.share = VZSingleDirectoryShare(
            directory: VZSharedDirectory(url: workspaceFilesURL, readOnly: true)
        )

        // The single directory surface is the selected Workspace's D1 root and
        // Virtualization.framework enforces it read-only. All other Host/Guest
        // traffic is carried only by the virtio socket above.
        configuration.networkDevices = []
        configuration.directorySharingDevices = [workspaceShare]
        configuration.graphicsDevices = []
        configuration.audioDevices = []
        configuration.consoleDevices = []
        configuration.keyboards = []
        configuration.pointingDevices = []
        if #available(macOS 15.0, *) {
            configuration.usbControllers = []
        }

        return configuration
    }
}
