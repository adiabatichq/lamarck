// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LamarckCapsuleVmHost",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "lamarck-capsule-vm-host",
            targets: ["CapsuleVmHost"]
        ),
    ],
    targets: [
        .target(
            name: "CapsuleVmHostCore",
            linkerSettings: [
                .linkedFramework("Virtualization"),
            ]
        ),
        .executableTarget(
            name: "CapsuleVmHost",
            dependencies: ["CapsuleVmHostCore"]
        ),
        .testTarget(
            name: "CapsuleVmHostCoreTests",
            dependencies: ["CapsuleVmHostCore"]
        ),
    ]
)
