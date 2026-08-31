import Darwin
import Foundation
import Testing
import Virtualization
@testable import CapsuleVmHostCore

@Test func buildsClosedLinuxVirtualMachinePolicy() throws {
    let fixture = try SignedGuestImageFixture()
    let image = try GuestImageVerifier.verify(
        fixture.install(fixture.standardManifest())
    )
    let stateDirectory = try makeTemporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: stateDirectory) }
    let stateDiskLease = try CapsuleVmStateDiskManager.acquireForTesting(
        in: stateDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    defer { try? stateDiskLease.release() }
    let console = Pipe()
    let cpuCount = min(
        max(2, VZVirtualMachineConfiguration.minimumAllowedCPUCount),
        VZVirtualMachineConfiguration.maximumAllowedCPUCount
    )
    let memorySize = alignedAllowedMemorySize()

    let configuration = try CapsuleVmConfigurationBuilder.makeUnvalidatedConfiguration(
        image: image,
        workspaceFilesURL: stateDirectory,
        appVersionsURL: stateDirectory,
        stateDiskLease: stateDiskLease,
        cpuCount: cpuCount,
        memorySize: memorySize,
        serialConsole: CapsuleVmSerialConsole(
            input: nil,
            output: console.fileHandleForWriting
        )
    )

    #expect(configuration.platform is VZGenericPlatformConfiguration)
    #expect(configuration.cpuCount == cpuCount)
    #expect(configuration.memorySize == memorySize)

    let bootLoader = try #require(configuration.bootLoader as? VZLinuxBootLoader)
    #expect(bootLoader.kernelURL == image.kernelURL)
    #expect(bootLoader.initialRamdiskURL == image.initialRamdiskURL)
    #expect(bootLoader.commandLine == CapsuleVmConfigurationBuilder.kernelCommandLine(for: image))
    #expect(bootLoader.commandLine.contains("lamarck.image_digest=\(image.imageDigest)"))
    #expect(bootLoader.commandLine.contains("lamarck.state_device=/dev/vdb"))
    #expect(bootLoader.commandLine.contains("lamarck.state_label=LAMARCK_STATE"))

    #expect(configuration.storageDevices.count == 2)
    let rootDevice = try #require(
        configuration.storageDevices.first as? VZVirtioBlockDeviceConfiguration
    )
    #expect(rootDevice.blockDeviceIdentifier == CapsuleVmConfigurationBuilder.rootBlockDeviceIdentifier)
    let rootAttachment = try #require(
        rootDevice.attachment as? VZDiskImageStorageDeviceAttachment
    )
    #expect(rootAttachment.url == image.rootfsURL)
    #expect(rootAttachment.isReadOnly)
    let stateDevice = try #require(
        configuration.storageDevices.last as? VZVirtioBlockDeviceConfiguration
    )
    #expect(stateDevice.blockDeviceIdentifier == CapsuleVmConfigurationBuilder.stateBlockDeviceIdentifier)
    let stateAttachment = try #require(
        stateDevice.attachment as? VZDiskImageStorageDeviceAttachment
    )
    #expect(stateAttachment.url == stateDiskLease.disk.url)
    #expect(!stateAttachment.isReadOnly)

    #expect(configuration.entropyDevices.count == 1)
    #expect(configuration.entropyDevices.first is VZVirtioEntropyDeviceConfiguration)
    #expect(configuration.socketDevices.count == 1)
    #expect(configuration.socketDevices.first is VZVirtioSocketDeviceConfiguration)
    #expect(configuration.serialPorts.count == 1)
    #expect(configuration.serialPorts.first is VZVirtioConsoleDeviceSerialPortConfiguration)

    #expect(configuration.networkDevices.isEmpty)
    #expect(configuration.directorySharingDevices.count == 2)
    let filesShare = try #require(
        configuration.directorySharingDevices.first as? VZVirtioFileSystemDeviceConfiguration
    )
    #expect(filesShare.tag == CapsuleVmConfigurationBuilder.workspaceFilesShareTag)
    let sharedDirectory = try #require(filesShare.share as? VZSingleDirectoryShare)
    #expect(sharedDirectory.directory.url == stateDirectory)
    #expect(sharedDirectory.directory.isReadOnly)
    let appsShare = try #require(
        configuration.directorySharingDevices.last as? VZVirtioFileSystemDeviceConfiguration
    )
    #expect(appsShare.tag == CapsuleVmConfigurationBuilder.appVersionsShareTag)
    let sharedAppsDirectory = try #require(appsShare.share as? VZSingleDirectoryShare)
    #expect(sharedAppsDirectory.directory.url == stateDirectory)
    #expect(sharedAppsDirectory.directory.isReadOnly)
    #expect(configuration.graphicsDevices.isEmpty)
    #expect(configuration.audioDevices.isEmpty)
    #expect(configuration.consoleDevices.isEmpty)
    #expect(configuration.keyboards.isEmpty)
    #expect(configuration.pointingDevices.isEmpty)
    if #available(macOS 15.0, *) {
        #expect(configuration.usbControllers.isEmpty)
    }
}

@Test func rejectsInvalidCpuAndMemoryBeforeFrameworkValidation() throws {
    let fixture = try SignedGuestImageFixture()
    let image = try GuestImageVerifier.verify(
        fixture.install(fixture.standardManifest(includeInitialRamdisk: false))
    )
    let stateDirectory = try makeTemporaryStateDirectory()
    defer { try? FileManager.default.removeItem(at: stateDirectory) }
    let stateDiskLease = try CapsuleVmStateDiskManager.acquireForTesting(
        in: stateDirectory,
        size: CapsuleVmStateDiskManager.minimumSize
    )
    defer { try? stateDiskLease.release() }
    let console = Pipe()
    let serialConsole = CapsuleVmSerialConsole(
        input: nil,
        output: console.fileHandleForWriting
    )
    let memorySize = alignedAllowedMemorySize()

    #expect(throws: CapsuleVmConfigurationError.self) {
        try CapsuleVmConfigurationBuilder.makeUnvalidatedConfiguration(
            image: image,
            workspaceFilesURL: stateDirectory,
            appVersionsURL: stateDirectory,
            stateDiskLease: stateDiskLease,
            cpuCount: VZVirtualMachineConfiguration.minimumAllowedCPUCount - 1,
            memorySize: memorySize,
            serialConsole: serialConsole
        )
    }
    #expect(throws: CapsuleVmConfigurationError.self) {
        try CapsuleVmConfigurationBuilder.makeUnvalidatedConfiguration(
            image: image,
            workspaceFilesURL: stateDirectory,
            appVersionsURL: stateDirectory,
            stateDiskLease: stateDiskLease,
            cpuCount: VZVirtualMachineConfiguration.minimumAllowedCPUCount,
            memorySize: VZVirtualMachineConfiguration.minimumAllowedMemorySize + 1,
            serialConsole: serialConsole
        )
    }
}

private func makeTemporaryStateDirectory() throws -> URL {
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
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: url.path
    )
    return url
}

private func alignedAllowedMemorySize() -> UInt64 {
    let mebibyte: UInt64 = 1_024 * 1_024
    let minimum = VZVirtualMachineConfiguration.minimumAllowedMemorySize
    let roundedMinimum = ((minimum + mebibyte - 1) / mebibyte) * mebibyte
    return min(2 * 1_024 * 1_024 * 1_024, max(roundedMinimum, minimum))
}
