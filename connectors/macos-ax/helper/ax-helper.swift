import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let helperVersion = 5
let maxTreeDepth = 6
let maxTreeNodes = 600
let maxChildrenPerNode = 120
let maxStringChars = 20_000
let maxTextExcerpts = 300
let defaultAXTimeoutMs = 500
let defaultSnapshotBudgetMs = 850

struct Options {
  var mode: Mode = .jsonl
  var intervalMs: Int = 1_000
  var count: Int?
  var captureText = true
  var axTimeoutMs = defaultAXTimeoutMs
  var snapshotBudgetMs = defaultSnapshotBudgetMs
}

enum Mode {
  case checkPermission
  case requestPermission
  case once
  case jsonl
}

final class TextCollector {
  private var seen = Set<String>()
  private(set) var excerpts: [String] = []
  private(set) var totalChars = 0
  private(set) var sourceCount = 0

  func add(_ value: String?) {
    guard let value else { return }
    let normalized = normalizeWhitespace(value)
    guard !normalized.isEmpty else { return }
    sourceCount += 1
    totalChars += normalized.count
    guard excerpts.count < maxTextExcerpts else { return }
    let capped = capString(normalized, maxStringChars) ?? normalized
    guard !seen.contains(capped) else { return }
    seen.insert(capped)
    excerpts.append(capped)
  }
}

final class AXCaptureContext {
  let messagingTimeoutSeconds: Float
  private let deadline: Date
  private var timeoutApplied = Set<String>()
  private(set) var budgetExceeded = false
  private(set) var skippedAfterBudget = 0
  private(set) var timeoutApplyErrors = 0
  private(set) var axErrorCounts: [String: Int] = [:]

  init(options: Options) {
    messagingTimeoutSeconds = max(0.05, Float(options.axTimeoutMs) / 1_000.0)
    deadline = Date().addingTimeInterval(max(0.05, Double(options.snapshotBudgetMs) / 1_000.0))
  }

  func beforeAXCall(_ element: AXUIElement, operation: String) -> Bool {
    guard withinBudget() else {
      skippedAfterBudget += 1
      return false
    }

    let key = String(CFHash(element as CFTypeRef))
    if !timeoutApplied.contains(key) {
      let result = AXUIElementSetMessagingTimeout(element, messagingTimeoutSeconds)
      if result == .success {
        timeoutApplied.insert(key)
      } else {
        timeoutApplyErrors += 1
        record(result, operation: "setMessagingTimeout")
      }
    }
    return true
  }

  func withinBudget() -> Bool {
    if Date() <= deadline {
      return true
    }
    budgetExceeded = true
    return false
  }

  func record(_ result: AXError, operation: String) {
    guard result != .success else { return }
    let key = "\(operation):\(String(describing: result))"
    axErrorCounts[key, default: 0] += 1
    if result == .cannotComplete {
      budgetExceeded = true
    }
  }

  func diagnostics(nodeBudgetRemaining: Int) -> [String: Any] {
    return [
      "messagingTimeoutMs": Int((messagingTimeoutSeconds * 1_000).rounded()),
      "budgetExceeded": budgetExceeded,
      "skippedAfterBudget": skippedAfterBudget,
      "timeoutApplyErrors": timeoutApplyErrors,
      "nodeBudgetRemaining": nodeBudgetRemaining,
      "axErrorCounts": axErrorCounts,
    ]
  }
}

struct FrontmostSelection {
  let app: NSRunningApplication?
  let source: String
  let window: [String: Any]?
  let workspaceApp: NSRunningApplication?
}

final class DesktopAvailabilityMonitor {
  private let notificationCenter = NSWorkspace.shared.notificationCenter
  private var observerTokens: [NSObjectProtocol] = []
  private var unavailableReasons = Set<String>()

  init() {
    observe(NSWorkspace.willSleepNotification) { monitor in
      monitor.setReason("system_sleep", active: true, trigger: "will_sleep")
    }
    observe(NSWorkspace.didWakeNotification) { monitor in
      monitor.refreshScreenLock()
      monitor.setReason("system_sleep", active: false, trigger: "did_wake")
    }
    observe(NSWorkspace.screensDidSleepNotification) { monitor in
      monitor.setReason("screen_off", active: true, trigger: "screens_did_sleep")
    }
    observe(NSWorkspace.screensDidWakeNotification) { monitor in
      monitor.refreshScreenLock()
      monitor.setReason("screen_off", active: false, trigger: "screens_did_wake")
    }
    observe(NSWorkspace.sessionDidResignActiveNotification) { monitor in
      monitor.setReason("session_inactive", active: true, trigger: "session_did_resign_active")
    }
    observe(NSWorkspace.sessionDidBecomeActiveNotification) { monitor in
      monitor.refreshScreenLock()
      monitor.setReason("session_inactive", active: false, trigger: "session_did_become_active")
    }
    observe(NSWorkspace.willPowerOffNotification) { monitor in
      monitor.setReason("logout_or_poweroff", active: true, trigger: "will_power_off")
    }
  }

  deinit {
    for token in observerTokens {
      notificationCenter.removeObserver(token)
    }
  }

  var isAvailable: Bool {
    unavailableReasons.isEmpty
  }

  func refreshScreenLock() {
    setReason("locked", active: currentScreenLocked(), trigger: "screen_lock_sample")
  }

  private func observe(_ name: NSNotification.Name, handler: @escaping (DesktopAvailabilityMonitor) -> Void) {
    let token = notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      handler(self)
    }
    observerTokens.append(token)
  }

  private func setReason(_ reason: String, active: Bool, trigger: String) {
    let changed: Bool
    if active {
      changed = unavailableReasons.insert(reason).inserted
    } else {
      changed = unavailableReasons.remove(reason) != nil
    }
    guard changed else { return }
    emitJSON([
      "schema": "macos-ax.lifecycle.v1",
      "type": "desktop_availability",
      "timestamp": Int64(Date().timeIntervalSince1970 * 1_000),
      "available": unavailableReasons.isEmpty,
      "reasons": unavailableReasons.sorted(),
      "trigger": trigger,
    ])
  }
}

func parseOptions(_ args: [String]) -> Options {
  var options = Options()
  var index = 0
  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--check-permission":
      options.mode = .checkPermission
    case "--request-permission":
      options.mode = .requestPermission
    case "--once":
      options.mode = .once
    case "--jsonl":
      options.mode = .jsonl
    case "--interval-ms":
      index += 1
      if index < args.count, let value = Int(args[index]), value > 0 {
        options.intervalMs = value
      }
    case "--count":
      index += 1
      if index < args.count, let value = Int(args[index]), value > 0 {
        options.count = value
      }
    case "--capture-text":
      index += 1
      if index < args.count {
        options.captureText = parseBool(args[index], fallback: options.captureText)
      }
    case "--ax-timeout-ms":
      index += 1
      if index < args.count, let value = Int(args[index]), value > 0 {
        options.axTimeoutMs = value
      }
    case "--snapshot-budget-ms":
      index += 1
      if index < args.count, let value = Int(args[index]), value > 0 {
        options.snapshotBudgetMs = value
      }
    default:
      break
    }
    index += 1
  }
  return options
}

func parseBool(_ value: String, fallback: Bool) -> Bool {
  switch value.lowercased() {
  case "1", "true", "yes", "on":
    return true
  case "0", "false", "no", "off":
    return false
  default:
    return fallback
  }
}

func main() {
  let options = parseOptions(Array(CommandLine.arguments.dropFirst()))

  switch options.mode {
  case .checkPermission:
    let trusted = AXIsProcessTrusted()
    emitJSON([
      "type": "permission",
      "permission": "macos-accessibility",
      "trusted": trusted,
    ])
    exit(trusted ? 0 : 2)

  case .requestPermission:
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
    emitJSON([
      "type": "permission",
      "permission": "macos-accessibility",
      "trusted": trusted,
    ])
    exit(trusted ? 0 : 2)

  case .once:
    emitJSON(buildSnapshot(options: options))

  case .jsonl:
    let availability = DesktopAvailabilityMonitor()
    var emitted = 0
    let intervalSeconds = Double(max(1, options.intervalMs)) / 1_000.0
    var nextTickAt = ProcessInfo.processInfo.systemUptime
    while true {
      let remainingSeconds = nextTickAt - ProcessInfo.processInfo.systemUptime
      if remainingSeconds > 0 {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: remainingSeconds))
      }
      availability.refreshScreenLock()
      if availability.isAvailable {
        emitJSON(buildSnapshot(options: options))
        emitted += 1
        if let count = options.count, emitted >= count {
          break
        }
      }
      nextTickAt += intervalSeconds
      let emittedAt = ProcessInfo.processInfo.systemUptime
      if nextTickAt < emittedAt {
        nextTickAt = emittedAt
      }
    }
  }
}

func buildSnapshot(options: Options) -> [String: Any] {
  let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
  let trusted = AXIsProcessTrusted()
  let displays = activeDisplays()
  let windows = visibleWindowInventory(displays: displays)
  let mouse = mouseSnapshot(windows: windows)
  let screenLocked = currentScreenLocked()
  let idleSeconds = systemIdleSeconds()

  let selection = frontmostSelection(windows: windows)
  let frontmost = selection.app
  let app = appSnapshot(frontmost)
  let ax = trusted ? frontmostAXSnapshot(frontmost, options: options) : emptyAXSnapshot()
  let frontmostSource: [String: Any] = [
    "source": selection.source,
    "window": selection.window ?? NSNull(),
    "workspaceApp": appSnapshot(selection.workspaceApp),
    "workspaceMatched": frontmost?.processIdentifier == selection.workspaceApp?.processIdentifier,
  ]

  let normalized: [String: Any] = [
    "timestamp": nowMs,
    "permission": [
      "accessibility": trusted,
    ],
    "session": [
      "screenLocked": screenLocked,
    ],
    "idle": [
      "seconds": idleSeconds as Any,
    ],
    "mouse": mouse,
    "app": app,
    "frontmostSource": frontmostSource,
    "window": ax["window"] ?? NSNull(),
    "focus": ax["focus"] ?? NSNull(),
    "text": ax["text"] ?? [
      "captureEnabled": options.captureText,
      "excerpts": [],
      "totalChars": 0,
      "sourceCount": 0,
    ],
    "visibleWindows": windows,
  ]

  let raw: [String: Any] = [
    "frontmost": [
      "source": frontmostSource,
      "app": app,
      "ax": ax["raw"] ?? NSNull(),
    ],
    "visibleWindows": windows,
    "displays": displays,
  ]

  return [
    "schema": "macos-ax.snapshot.v1",
    "helperVersion": helperVersion,
    "capture": [
      "mode": "raw-first",
      "maxTreeDepth": maxTreeDepth,
      "maxTreeNodes": maxTreeNodes,
      "maxChildrenPerNode": maxChildrenPerNode,
      "maxStringChars": maxStringChars,
      "maxTextExcerpts": maxTextExcerpts,
      "captureText": options.captureText,
      "axTimeoutMs": options.axTimeoutMs,
      "snapshotBudgetMs": options.snapshotBudgetMs,
    ],
    "timestamp": nowMs,
    "raw": raw,
    "normalized": normalized,
  ]
}

func frontmostSelection(windows: [[String: Any]]) -> FrontmostSelection {
  let workspaceApp = NSWorkspace.shared.frontmostApplication
  if let window = topForegroundWindow(windows: windows),
     let ownerPid = window["ownerPid"] as? Int,
     let app = NSRunningApplication(processIdentifier: pid_t(ownerPid)) {
    return FrontmostSelection(
      app: app,
      source: "cg-window",
      window: window,
      workspaceApp: workspaceApp
    )
  }

  return FrontmostSelection(
    app: workspaceApp,
    source: "ns-workspace",
    window: nil,
    workspaceApp: workspaceApp
  )
}

func topForegroundWindow(windows: [[String: Any]]) -> [String: Any]? {
  for window in windows {
    guard
      let layer = window["layer"] as? Int,
      layer == 0,
      ((window["onscreen"] as? Bool) ?? true),
      (numberToDouble(window["alpha"]) ?? 1) > 0,
      windowArea(window) > 1,
      let ownerPid = window["ownerPid"] as? Int,
      let app = NSRunningApplication(processIdentifier: pid_t(ownerPid)),
      app.activationPolicy == .regular
    else {
      continue
    }
    return window
  }

  for window in windows {
    guard
      let layer = window["layer"] as? Int,
      layer == 0,
      ((window["onscreen"] as? Bool) ?? true),
      (numberToDouble(window["alpha"]) ?? 1) > 0,
      windowArea(window) > 1
    else {
      continue
    }
    return window
  }

  return nil
}

func appSnapshot(_ app: NSRunningApplication?) -> [String: Any] {
  guard let app else {
    return [
      "pid": NSNull(),
      "name": NSNull(),
      "bundleId": NSNull(),
    ]
  }

  return [
    "pid": Int(app.processIdentifier),
    "name": app.localizedName ?? NSNull(),
    "bundleId": app.bundleIdentifier ?? NSNull(),
    "executableUrl": app.executableURL?.path ?? NSNull(),
    "activationPolicy": activationPolicyName(app.activationPolicy),
  ]
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
  switch policy {
  case .regular:
    return "regular"
  case .accessory:
    return "accessory"
  case .prohibited:
    return "prohibited"
  @unknown default:
    return "unknown"
  }
}

func frontmostAXSnapshot(_ app: NSRunningApplication?, options: Options) -> [String: Any] {
  guard let app else { return emptyAXSnapshot() }

  let context = AXCaptureContext(options: options)
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  let focusedWindow = axElementAttribute(axApp, kAXFocusedWindowAttribute, context: context) ?? axElementAttribute(axApp, kAXMainWindowAttribute, context: context)
  let focusedElement = axElementAttribute(axApp, kAXFocusedUIElementAttribute, context: context)
  let collector = TextCollector()
  var nodeBudget = maxTreeNodes

  var windowPayload: [String: Any] = [:]
  if let focusedWindow {
    windowPayload = elementSummary(focusedWindow, captureText: false, collector: nil, context: context)
  }

  var focusPayload: [String: Any] = [:]
  if let focusedElement {
    focusPayload = elementSummary(focusedElement, captureText: options.captureText, collector: collector, context: context)
  }

  var tree: [String: Any]?
  if options.captureText, let focusedWindow, context.withinBudget() {
    tree = elementTree(
      focusedWindow,
      depth: maxTreeDepth,
      path: "window",
      nodeBudget: &nodeBudget,
      collector: collector,
      context: context
    )
  }

  let textPayload: [String: Any] = [
    "captureEnabled": options.captureText,
    "excerpts": collector.excerpts,
    "totalChars": collector.totalChars,
    "sourceCount": collector.sourceCount,
    "truncated": nodeBudget <= 0 || collector.excerpts.count >= maxTextExcerpts || context.budgetExceeded,
  ]

  return [
    "window": windowPayload.isEmpty ? NSNull() : windowPayload,
    "focus": focusPayload.isEmpty ? NSNull() : focusPayload,
    "text": textPayload,
    "raw": [
      "window": windowPayload.isEmpty ? (NSNull() as Any) : windowPayload,
      "focus": focusPayload.isEmpty ? (NSNull() as Any) : focusPayload,
      "tree": tree ?? (NSNull() as Any),
    ],
    "diagnostics": context.diagnostics(nodeBudgetRemaining: nodeBudget),
  ]
}

func emptyAXSnapshot() -> [String: Any] {
  return [
    "window": NSNull(),
    "focus": NSNull(),
    "text": [
      "captureEnabled": false,
      "excerpts": [],
      "totalChars": 0,
      "sourceCount": 0,
      "truncated": false,
    ],
    "raw": NSNull(),
  ]
}

func elementTree(
  _ element: AXUIElement,
  depth: Int,
  path: String,
  nodeBudget: inout Int,
  collector: TextCollector,
  context: AXCaptureContext
) -> [String: Any]? {
  guard nodeBudget > 0, context.withinBudget() else { return nil }
  nodeBudget -= 1

  var node = elementSummary(element, captureText: true, collector: collector, context: context)
  node["path"] = path

  if depth > 0, context.withinBudget() {
    let children = axChildren(element, context: context).prefix(maxChildrenPerNode)
    var childPayloads: [[String: Any]] = []
    for (index, child) in children.enumerated() {
      if let payload = elementTree(
        child,
        depth: depth - 1,
        path: "\(path).\(index)",
        nodeBudget: &nodeBudget,
        collector: collector,
        context: context
      ) {
        childPayloads.append(payload)
      }
      if nodeBudget <= 0 || !context.withinBudget() {
        break
      }
    }
    if !childPayloads.isEmpty {
      node["children"] = childPayloads
    }
  }

  return node
}

func elementSummary(_ element: AXUIElement, captureText: Bool, collector: TextCollector?, context: AXCaptureContext) -> [String: Any] {
  let attributeNames = axAttributeNames(element, context: context)
  let role = axStringAttribute(element, kAXRoleAttribute, context: context)
  let subrole = axStringAttribute(element, kAXSubroleAttribute, context: context)
  let isSecure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
  var payload: [String: Any] = [
    "attributeNames": attributeNames,
    "parameterizedAttributeNames": axParameterizedAttributeNames(element, context: context),
    "role": role ?? NSNull(),
    "subrole": subrole ?? NSNull(),
    "title": capString(axStringAttribute(element, kAXTitleAttribute, context: context), maxStringChars) ?? NSNull(),
    "identifier": capString(axStringAttribute(element, "AXIdentifier", context: context), 512) ?? NSNull(),
    "position": axPointAttribute(element, kAXPositionAttribute, context: context) ?? NSNull(),
    "size": axSizeAttribute(element, kAXSizeAttribute, context: context) ?? NSNull(),
    "secure": isSecure,
  ]
  if let childCount = axChildrenCount(element, context: context) {
    payload["childrenCount"] = childCount
  }

  guard !isSecure else { return payload }

  let url = axURLAttribute(element, "AXURL", context: context)
  let document = axURLAttribute(element, kAXDocumentAttribute, context: context)
  if let url, !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    payload["url"] = capString(url, maxStringChars)
  }
  if let document, !document.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    payload["document"] = capString(document, maxStringChars)
  }

  guard captureText else { return payload }

  let visible = axVisibleText(element, context: context)
  let rawValue = axAttribute(element, kAXValueAttribute, context: context)
  let value = visible ?? stringFromAXValue(rawValue)
  let selected = axStringAttribute(element, kAXSelectedTextAttribute, context: context)
  let description = axStringAttribute(element, kAXDescriptionAttribute, context: context)
  let help = axStringAttribute(element, kAXHelpAttribute, context: context)

  collector?.add(payload["title"] as? String)
  collector?.add(value)
  collector?.add(selected)
  collector?.add(description)
  collector?.add(help)

  if let visible {
    payload["visibleText"] = capString(visible, maxStringChars)
  }
  if let rawValue {
    payload["valueType"] = describeAXValue(rawValue)
  }
  if let value {
    payload["value"] = capString(value, maxStringChars)
  }
  if let selected {
    payload["selectedText"] = capString(selected, maxStringChars)
  }
  if let description {
    payload["description"] = capString(description, maxStringChars)
  }
  if let help {
    payload["help"] = capString(help, maxStringChars)
  }

  return payload
}

func axAttributeNames(_ element: AXUIElement, context: AXCaptureContext) -> [String] {
  guard context.beforeAXCall(element, operation: "attributeNames") else { return [] }
  var names: CFArray?
  let result = AXUIElementCopyAttributeNames(element, &names)
  context.record(result, operation: "attributeNames")
  guard result == .success, let names else { return [] }
  return (names as? [String] ?? []).sorted()
}

func axParameterizedAttributeNames(_ element: AXUIElement, context: AXCaptureContext) -> [String] {
  guard context.beforeAXCall(element, operation: "parameterizedAttributeNames") else { return [] }
  var names: CFArray?
  let result = AXUIElementCopyParameterizedAttributeNames(element, &names)
  context.record(result, operation: "parameterizedAttributeNames")
  guard result == .success, let names else { return [] }
  return (names as? [String] ?? []).sorted()
}

func axChildrenCount(_ element: AXUIElement, context: AXCaptureContext) -> Int? {
  guard context.beforeAXCall(element, operation: "childrenCount") else { return nil }
  var count: CFIndex = 0
  let result = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
  context.record(result, operation: "childrenCount")
  guard result == .success else { return nil }
  return count
}

func axStringAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> String? {
  guard let value = axAttribute(element, attribute, context: context) else { return nil }
  if let string = value as? String {
    return string
  }
  if let attributed = value as? NSAttributedString {
    return attributed.string
  }
  return nil
}

func axElementAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> AXUIElement? {
  guard let value = axAttribute(element, attribute, context: context) else { return nil }
  if CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() {
    return (value as! AXUIElement)
  }
  return nil
}

func axAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> Any? {
  guard context.beforeAXCall(element, operation: "attribute:\(attribute)") else { return nil }
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  context.record(result, operation: "attribute:\(attribute)")
  guard result == .success, let value else { return nil }
  return value
}

func axURLAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> String? {
  return stringFromAXValue(axAttribute(element, attribute, context: context))
}

func stringFromAXValue(_ value: Any?) -> String? {
  guard let value else { return nil }
  if let string = value as? String {
    return string
  }
  if let attributed = value as? NSAttributedString {
    return attributed.string
  }
  return nil
}

func describeAXValue(_ value: Any) -> String {
  let typeId = CFGetTypeID(value as CFTypeRef)
  if typeId == AXUIElementGetTypeID() {
    return "AXUIElement"
  }
  if typeId == AXValueGetTypeID() {
    let axValue = value as! AXValue
    switch AXValueGetType(axValue) {
    case .cgPoint:
      return "AXValue.cgPoint"
    case .cgSize:
      return "AXValue.cgSize"
    case .cgRect:
      return "AXValue.cgRect"
    case .cfRange:
      return "AXValue.cfRange"
    case .illegal:
      return "AXValue.illegal"
    case .axError:
      return "AXValue.axError"
    @unknown default:
      return "AXValue.unknown"
    }
  }
  return String(describing: type(of: value))
}

func axChildren(_ element: AXUIElement, context: AXCaptureContext) -> [AXUIElement] {
  if let value = axAttribute(element, kAXChildrenAttribute, context: context) {
    let children = axElementArray(value)
    if !children.isEmpty {
      return children
    }
  }

  guard let childCount = axChildrenCount(element, context: context), childCount > 0 else { return [] }
  guard context.beforeAXCall(element, operation: "childrenValues") else { return [] }
  var values: CFArray?
  let result = AXUIElementCopyAttributeValues(
    element,
    kAXChildrenAttribute as CFString,
    0,
    min(childCount, maxChildrenPerNode),
    &values
  )
  context.record(result, operation: "childrenValues")
  guard result == .success, let values else { return [] }
  return axElementArray(values)
}

func axElementArray(_ value: Any) -> [AXUIElement] {
  guard let array = value as? [Any] else { return [] }
  return array.compactMap { item -> AXUIElement? in
    guard CFGetTypeID(item as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
    return (item as! AXUIElement)
  }
}

func axPointAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> [String: Double]? {
  guard let value = axAttribute(element, attribute, context: context) else { return nil }
  guard CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgPoint else { return nil }
  var point = CGPoint.zero
  guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
  return [
    "x": roundDouble(point.x),
    "y": roundDouble(point.y),
  ]
}

func axSizeAttribute(_ element: AXUIElement, _ attribute: String, context: AXCaptureContext) -> [String: Double]? {
  guard let value = axAttribute(element, attribute, context: context) else { return nil }
  guard CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgSize else { return nil }
  var size = CGSize.zero
  guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
  return [
    "width": roundDouble(size.width),
    "height": roundDouble(size.height),
  ]
}

func axVisibleText(_ element: AXUIElement, context: AXCaptureContext) -> String? {
  guard
    let rangeObject = axAttribute(element, kAXVisibleCharacterRangeAttribute, context: context),
    CFGetTypeID(rangeObject as CFTypeRef) == AXValueGetTypeID(),
    AXValueGetType(rangeObject as! AXValue) == .cfRange
  else {
    return nil
  }

  let rangeValue = rangeObject as! AXValue
  var range = CFRange()
  guard AXValueGetValue(rangeValue, .cfRange, &range) else { return nil }
  guard range.length > 0 else { return nil }
  guard let rangeParam = AXValueCreate(.cfRange, &range) else { return nil }

  guard context.beforeAXCall(element, operation: "stringForRange") else { return nil }
  var value: CFTypeRef?
  let result = AXUIElementCopyParameterizedAttributeValue(
    element,
    kAXStringForRangeParameterizedAttribute as CFString,
    rangeParam,
    &value
  )
  context.record(result, operation: "stringForRange")
  guard result == .success else { return nil }
  return value as? String
}

func activeDisplays() -> [[String: Any]] {
  let maxDisplays: UInt32 = 16
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(maxDisplays, &ids, &count) == .success else {
    return []
  }

  return ids.prefix(Int(count)).map { id in
    let bounds = CGDisplayBounds(id)
    return [
      "id": Int(id),
      "bounds": rectPayload(bounds),
      "pixelsWide": Int(CGDisplayPixelsWide(id)),
      "pixelsHigh": Int(CGDisplayPixelsHigh(id)),
      "main": CGDisplayIsMain(id) != 0,
    ]
  }
}

func visibleWindowInventory(displays: [[String: Any]]) -> [[String: Any]] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    return []
  }

  return list.compactMap { info in
    guard let ownerPid = numberToInt(info[kCGWindowOwnerPID as String]) else { return nil }
    let app = NSRunningApplication(processIdentifier: pid_t(ownerPid))
    let title = (info[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let ownerName = (info[kCGWindowOwnerName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let layer = numberToInt(info[kCGWindowLayer as String]) ?? 0
    guard let rect = cgWindowBounds(info[kCGWindowBounds as String]) else { return nil }

    return [
      "windowId": numberToInt(info[kCGWindowNumber as String]) ?? 0,
      "ownerPid": ownerPid,
      "ownerName": ownerName ?? app?.localizedName ?? NSNull(),
      "bundleId": app?.bundleIdentifier ?? NSNull(),
      "title": capString(title, maxStringChars) ?? NSNull(),
      "bounds": rectPayload(rect),
      "displayId": displayIdForRect(rect, displays: displays) ?? NSNull(),
      "layer": layer,
      "alpha": numberToDouble(info[kCGWindowAlpha as String]) ?? NSNull(),
      "onscreen": (info[kCGWindowIsOnscreen as String] as? Bool) ?? true,
    ]
  }
}

func mouseSnapshot(windows: [[String: Any]]) -> [String: Any] {
  let point = CGEvent(source: nil)?.location ?? .zero
  let hovered = hoveredWindowId(point: point, windows: windows)
  return [
    "x": roundDouble(point.x),
    "y": roundDouble(point.y),
    "hoveredWindowId": hovered ?? NSNull(),
  ]
}

func hoveredWindowId(point: CGPoint, windows: [[String: Any]]) -> Int? {
  for window in windows {
    guard
      let layer = window["layer"] as? Int,
      layer == 0,
      let bounds = window["bounds"] as? [String: Any],
      let x = numberToDouble(bounds["x"]),
      let y = numberToDouble(bounds["y"]),
      let width = numberToDouble(bounds["width"]),
      let height = numberToDouble(bounds["height"])
    else {
      continue
    }
    let rect = CGRect(x: x, y: y, width: width, height: height)
    if rect.contains(point) {
      return window["windowId"] as? Int
    }
  }
  return nil
}

func currentScreenLocked() -> Bool {
  guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else {
    return false
  }
  return (dict["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func systemIdleSeconds() -> Double? {
  let anyInput = CGEventType(rawValue: UInt32.max)!
  let value = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
  guard value.isFinite && value >= 0 else { return nil }
  return roundDouble(value)
}

func cgWindowBounds(_ value: Any?) -> CGRect? {
  guard let dict = value as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: dict as CFDictionary)
}

func displayIdForRect(_ rect: CGRect, displays: [[String: Any]]) -> Int? {
  var bestId: Int?
  var bestArea = 0.0
  for display in displays {
    guard
      let displayId = display["id"] as? Int,
      let bounds = display["bounds"] as? [String: Any],
      let x = numberToDouble(bounds["x"]),
      let y = numberToDouble(bounds["y"]),
      let width = numberToDouble(bounds["width"]),
      let height = numberToDouble(bounds["height"])
    else {
      continue
    }
    let displayRect = CGRect(x: x, y: y, width: width, height: height)
    let area = rect.intersection(displayRect).area
    if area > bestArea {
      bestArea = area
      bestId = displayId
    }
  }
  return bestId
}

func windowArea(_ window: [String: Any]) -> Double {
  guard
    let bounds = window["bounds"] as? [String: Any],
    let width = numberToDouble(bounds["width"]),
    let height = numberToDouble(bounds["height"])
  else {
    return 0
  }
  return max(0, width) * max(0, height)
}

func rectPayload(_ rect: CGRect) -> [String: Double] {
  return [
    "x": roundDouble(rect.origin.x),
    "y": roundDouble(rect.origin.y),
    "width": roundDouble(rect.size.width),
    "height": roundDouble(rect.size.height),
  ]
}

func emitJSON(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object) else {
    fputs("{\"error\":\"invalid-json-object\"}\n", stderr)
    return
  }
  do {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  } catch {
    fputs("{\"error\":\"json-serialization-failed\"}\n", stderr)
  }
  fflush(stdout)
}

func capString(_ value: String?, _ maxChars: Int) -> String? {
  guard let value else { return nil }
  if value.count <= maxChars {
    return value
  }
  let end = value.index(value.startIndex, offsetBy: maxChars)
  return String(value[..<end])
}

func normalizeWhitespace(_ value: String) -> String {
  return value
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

func numberToInt(_ value: Any?) -> Int? {
  if let int = value as? Int { return int }
  if let number = value as? NSNumber { return number.intValue }
  return nil
}

func numberToDouble(_ value: Any?) -> Double? {
  if let double = value as? Double { return double }
  if let int = value as? Int { return Double(int) }
  if let number = value as? NSNumber { return number.doubleValue }
  return nil
}

func roundDouble(_ value: Double) -> Double {
  return (value * 100).rounded() / 100
}

extension CGRect {
  var area: Double {
    if isNull || isInfinite || width <= 0 || height <= 0 {
      return 0
    }
    return Double(width * height)
  }
}

main()
