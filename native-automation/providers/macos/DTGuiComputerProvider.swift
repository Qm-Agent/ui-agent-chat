import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import CoreGraphics
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import Vision

private struct AppSelector: Decodable {
    let kind: String
    let value: String
}

private struct NativeAction: Decodable {
    let kind: String
    let elementId: String?
    let value: String?
    let key: String?
    let direction: String?
    let pages: Int?
    let x: Double?
    let y: Double?
    let allowCoordinateFallback: Bool?
    let focused: Bool?
    let visualText: String?
    let matchMode: String?
    let occurrence: Int?
}

private struct ExpectedElement: Decodable {
    let role: String
    let name: String
    let secure: Bool
    let bounds: [String: Double]?
}

private struct ProviderRequest: Decodable {
    let command: String
    let app: AppSelector?
    let deliveryMode: String?
    let action: NativeAction?
    let providerPath: String?
    let expectedElement: ExpectedElement?
    let maxDepth: Int?
    let maxElements: Int?
    let visibleOnly: Bool?
    let screenshotPath: String?
    let snapshotWindowBounds: [String: Double]?
    let postScreenshotPath: String?
    let diagnosticPath: String?
}

private struct TargetWindowInfo {
    let id: CGWindowID
    let bounds: CGRect
}

private struct InteractionState {
    let frontmostProcessId: pid_t?
    let cursorPosition: CGPoint
}

private struct WindowMinimizationResult {
    let attempted: Int
    let minimized: Int
}

private struct OcrMatch {
    let text: String
    let confidence: Float
    let bounds: CGRect
}

private final class SendableBox<Value>: @unchecked Sendable {
    var value: Value?
}

@available(macOS 12.3, *)
private final class SingleFrameReceiver: NSObject, SCStreamOutput, SCStreamDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private(set) var image: CGImage?
    private(set) var gap: String?
    private var finished = false

    private func finish(_ image: CGImage?, gap: String? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return }
        self.image = image
        self.gap = gap
        finished = true
        semaphore.signal()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        // ScreenCaptureKit may emit idle/status samples before the first frame.
        // Keep waiting until a sample carries a real image buffer.
        guard CMSampleBufferIsValid(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let source = CIImage(cvPixelBuffer: pixelBuffer)
        guard let image = CIContext().createCGImage(source, from: source.extent) else { return }
        finish(image)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(nil, gap: "screen-capture-kit-stopped:\(error.localizedDescription)")
    }
}

@available(macOS 12.3, *)
private final class ContinuousFrameReceiver: NSObject, SCStreamOutput, SCStreamDelegate {
    private let streamDirectory: URL
    private let app: NSRunningApplication
    private let windowID: CGWindowID
    private let configuredFramesPerSecond: Int
    private let ciContext = CIContext()
    private let lock = NSLock()
    private var sequence = 0
    private var stopped = false
    private var streamFrameReceived = false

    init(
        streamDirectory: URL,
        app: NSRunningApplication,
        windowID: CGWindowID,
        configuredFramesPerSecond: Int
    ) {
        self.streamDirectory = streamDirectory
        self.app = app
        self.windowID = windowID
        self.configuredFramesPerSecond = configuredFramesPerSecond
    }

    private func updateStopped(_ value: Bool) {
        lock.lock()
        stopped = value
        lock.unlock()
    }

    func hasStopped() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func hasReceivedStreamFrame() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return streamFrameReceived
    }

    private func nextSequence(isStreamFrame: Bool) -> Int {
        lock.lock()
        defer { lock.unlock() }
        if isStreamFrame {
            streamFrameReceived = true
        }
        sequence += 1
        return sequence
    }

    func writeFrame(_ image: CGImage, backend: String, isStreamFrame: Bool) {
        guard !hasStopped() else { return }
        autoreleasepool {
            guard let jpeg = NSBitmapImageRep(cgImage: image).representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.72]
            ) else {
                return
            }
            let frameSequence = nextSequence(isStreamFrame: isStreamFrame)
            let frameUrl = streamDirectory.appendingPathComponent("latest-frame.jpg")
            do {
                try jpeg.write(to: frameUrl, options: .atomic)
                var metadata: [String: Any] = [
                    "status": "live",
                    "sequence": frameSequence,
                    "capturedAt": ISO8601DateFormatter().string(from: Date()),
                    "width": image.width,
                    "height": image.height,
                    "windowId": Int(windowID),
                    "processId": Int(app.processIdentifier),
                    "configuredFps": configuredFramesPerSecond,
                    "captureBackend": backend,
                ]
                if let currentWindow = targetWindowInfo(for: app) {
                    metadata["windowBounds"] = [
                        "x": currentWindow.bounds.minX,
                        "y": currentWindow.bounds.minY,
                        "width": currentWindow.bounds.width,
                        "height": currentWindow.bounds.height,
                    ]
                    metadata["targetWindowChanged"] = currentWindow.id != windowID
                }
                try writeStreamMetadata(metadata, directory: streamDirectory)
            } catch {
                updateStopped(true)
                try? writeStreamMetadata([
                    "status": "failed",
                    "error": "frame-write-failed:\(error.localizedDescription)",
                ], directory: streamDirectory)
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              !hasStopped(),
              CMSampleBufferIsValid(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        autoreleasepool {
            let source = CIImage(cvPixelBuffer: pixelBuffer)
            guard let image = ciContext.createCGImage(source, from: source.extent) else {
                return
            }
            writeFrame(image, backend: "screen-capture-kit", isStreamFrame: true)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        updateStopped(true)
        try? writeStreamMetadata([
            "status": "failed",
            "error": "screen-capture-kit-stopped:\(error.localizedDescription)",
        ], directory: streamDirectory)
    }
}

private enum ProviderFailure: Error {
    case structured(code: String, message: String, details: [String: Any] = [:])
}

private let processArguments = CommandLine.arguments

private func argumentValue(_ name: String) -> String? {
    guard let index = processArguments.firstIndex(of: name), processArguments.indices.contains(index + 1) else {
        return nil
    }
    return processArguments[index + 1]
}

private func appendDiagnosticStage(
    _ stage: String,
    request: ProviderRequest? = nil,
    details: [String: Any] = [:]
) {
    guard let diagnosticPath = request?.diagnosticPath ?? argumentValue("--diagnostics") else {
        return
    }
    var payload: [String: Any] = [
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "stage": stage,
        "providerPid": Int(getpid()),
    ]
    for (key, value) in details {
        payload[key] = value
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          var line = String(data: data, encoding: .utf8) else {
        return
    }
    line.append("\n")
    let url = URL(fileURLWithPath: diagnosticPath)
    if !FileManager.default.fileExists(atPath: diagnosticPath) {
        FileManager.default.createFile(
            atPath: diagnosticPath,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        )
    }
    guard let handle = try? FileHandle(forWritingTo: url) else { return }
    defer { try? handle.close() }
    do {
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(line.utf8))
    } catch {
        return
    }
}

private func emit(_ value: [String: Any]) {
    appendDiagnosticStage("response-write-start", details: [
        "ok": value["ok"] as? Bool ?? false,
    ])
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    if let responsePath = argumentValue("--response") {
        let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        guard FileManager.default.createFile(atPath: responsePath, contents: data, attributes: attributes) else {
            exit(3)
        }
    } else {
        FileHandle.standardOutput.write(data)
    }
    appendDiagnosticStage("response-write-complete", details: [
        "bytes": data.count,
    ])
}

private func succeed(_ data: Any) -> Never {
    emit(["ok": true, "data": data])
    exit(0)
}

private func fail(_ code: String, _ message: String, details: [String: Any] = [:]) -> Never {
    let error: [String: Any] = ["code": code, "message": message, "details": details]
    emit(["ok": false, "error": error])
    exit(2)
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    attribute(element, name) as? String
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    let direct = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
    if !direct.isEmpty { return direct }
    // Some modern AppKit/SwiftUI controls expose virtual descendants through
    // AXContents while AXChildren stays empty (for example Calculator displays).
    return attribute(element, "AXContents" as CFString) as? [AXUIElement] ?? []
}

private func actions(_ element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success else { return [] }
    return value as? [String] ?? []
}

private func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && !$0.isTerminated }
        .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
}

private func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    [
        "id": app.bundleIdentifier ?? app.bundleURL?.path ?? String(app.processIdentifier),
        "displayName": app.localizedName ?? app.bundleIdentifier ?? "Unknown App",
        "isRunning": !app.isTerminated,
        "processId": Int(app.processIdentifier),
    ]
}

private func installedApplicationURLs() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let roots = [
        URL(fileURLWithPath: "/Applications", isDirectory: true),
        home.appendingPathComponent("Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Applications/Utilities", isDirectory: true),
    ]
    var seen = Set<String>()
    return roots.flatMap { root -> [URL] in
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        return entries.filter { url in
            guard url.pathExtension.localizedCaseInsensitiveCompare("app") == .orderedSame else { return false }
            return seen.insert(url.standardizedFileURL.path).inserted
        }
    }
}

private func installedAppInfo(_ url: URL) -> [String: Any]? {
    guard let bundle = Bundle(url: url) else { return nil }
    let identifier = bundle.bundleIdentifier ?? url.path
    let displayName = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)
        ?? url.deletingPathExtension().lastPathComponent
    return [
        "id": identifier,
        "displayName": displayName,
        "isRunning": false,
    ]
}

private func availableApps() -> [[String: Any]] {
    let running = runningApps().map(appInfo)
    let runningIds = Set(running.compactMap { $0["id"] as? String })
    let installed = installedApplicationURLs().compactMap(installedAppInfo).filter { app in
        guard let id = app["id"] as? String else { return false }
        return !runningIds.contains(id)
    }
    return running + installed.sorted {
        ($0["displayName"] as? String ?? "") < ($1["displayName"] as? String ?? "")
    }
}

private func resolveApp(_ selector: AppSelector) throws -> NSRunningApplication {
    let match = runningApps().first { app in
        switch selector.kind {
        case "bundle-id": return app.bundleIdentifier == selector.value
        case "path": return app.bundleURL?.path == selector.value
        case "process-id": return String(app.processIdentifier) == selector.value
        default:
            return app.localizedName?.localizedCaseInsensitiveCompare(selector.value) == .orderedSame
                || app.bundleIdentifier == selector.value
        }
    }
    guard let match else {
        throw ProviderFailure.structured(
            code: "APP_NOT_FOUND",
            message: "目标应用未运行或不可见：\(selector.value)"
        )
    }
    return match
}

private func applicationUrl(for selector: AppSelector) -> URL? {
    switch selector.kind {
    case "path":
        let url = URL(fileURLWithPath: selector.value)
        return url.pathExtension.localizedCaseInsensitiveCompare("app") == .orderedSame ? url : nil
    case "bundle-id":
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: selector.value)
    case "name":
        return installedApplicationURLs().first { url in
            let bundle = Bundle(url: url)
            let displayName = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle?.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)
                ?? url.deletingPathExtension().lastPathComponent
            return displayName.localizedCaseInsensitiveCompare(selector.value) == .orderedSame
                || url.deletingPathExtension().lastPathComponent.localizedCaseInsensitiveCompare(selector.value) == .orderedSame
        }
    default:
        return nil
    }
}

private func launchApplication(_ selector: AppSelector, deliveryMode: String) throws -> [String: Any] {
    let before = deliveryMode == "background-safe" ? interactionState() : nil
    if let running = try? resolveApp(selector) {
        if deliveryMode != "background-safe" {
            activateTargetApp(running)
        }
        var result = appInfo(running)
        if deliveryMode == "background-safe" {
            result["windowPresentation"] = "existing-window-preserved"
        }
        return try before.map {
            try appendBackgroundAudit(
                result,
                before: $0,
                targetProcessId: running.processIdentifier,
                settleTime: 0.5
            )
        } ?? result
    }
    guard selector.kind != "process-id", let url = applicationUrl(for: selector) else {
        throw ProviderFailure.structured(
            code: "APP_LAUNCH_FAILED",
            message: "找不到可启动的应用：\(selector.value)"
        )
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = deliveryMode != "background-safe"
    configuration.addsToRecentItems = false
    let semaphore = DispatchSemaphore(value: 0)
    let launched = SendableBox<NSRunningApplication>()
    let launchError = SendableBox<Error>()
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        launched.value = app
        launchError.value = error
        semaphore.signal()
    }
    let deadline = Date().addingTimeInterval(10)
    var completed = false
    while !completed && Date() < deadline {
        completed = semaphore.wait(timeout: .now()) == .success
        if !completed {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
    }
    if let error = launchError.value {
        throw ProviderFailure.structured(
            code: "APP_LAUNCH_FAILED",
            message: "应用启动失败：\(error.localizedDescription)"
        )
    }
    guard completed, let app = launched.value else {
        throw ProviderFailure.structured(code: "APP_LAUNCH_FAILED", message: "应用启动超时：\(selector.value)")
    }
    var result = appInfo(app)
    if deliveryMode == "background-safe" {
        let minimization = minimizeApplicationWindows(app, timeout: 2)
        result["windowPresentation"] = minimization.minimized > 0
            ? "minimized"
            : "background-visible"
        result["windowMinimizeAttemptedCount"] = minimization.attempted
        result["windowMinimizedCount"] = minimization.minimized
    }
    return try before.map {
        try appendBackgroundAudit(
            result,
            before: $0,
            targetProcessId: app.processIdentifier,
            settleTime: 0.5
        )
    } ?? result
}

private func applicationElement(for app: NSRunningApplication) -> AXUIElement {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return application
}

private func rootElement(for app: NSRunningApplication) -> AXUIElement {
    let application = applicationElement(for: app)
    return (attribute(application, kAXFocusedWindowAttribute as CFString) as! AXUIElement?) ?? application
}

private func focusedElement(for app: NSRunningApplication) -> AXUIElement? {
    let application = applicationElement(for: app)
    return attribute(application, kAXFocusedUIElementAttribute as CFString) as! AXUIElement?
}

private func applicationWindows(_ app: NSRunningApplication) -> [AXUIElement] {
    let application = applicationElement(for: app)
    return attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
}

private func minimizedState(_ window: AXUIElement) -> Bool {
    (attribute(window, kAXMinimizedAttribute as CFString) as? Bool) == true
}

private func setWindowMinimized(_ window: AXUIElement, minimized: Bool) -> Bool {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(
        window,
        kAXMinimizedAttribute as CFString,
        &settable
    ) == .success, settable.boolValue else {
        return false
    }
    return AXUIElementSetAttributeValue(
        window,
        kAXMinimizedAttribute as CFString,
        minimized ? kCFBooleanTrue : kCFBooleanFalse
    ) == .success
}

private func minimizeApplicationWindows(
    _ app: NSRunningApplication,
    timeout: TimeInterval
) -> WindowMinimizationResult {
    let deadline = Date().addingTimeInterval(timeout)
    var windows = applicationWindows(app)
    while windows.isEmpty && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        windows = applicationWindows(app)
    }
    var minimized = 0
    for window in windows where minimizedState(window) || setWindowMinimized(window, minimized: true) {
        minimized += 1
    }
    return WindowMinimizationResult(attempted: windows.count, minimized: minimized)
}

private func restoreApplicationWindows(_ app: NSRunningApplication) {
    for window in applicationWindows(app) where minimizedState(window) {
        _ = setWindowMinimized(window, minimized: false)
    }
}

private func hasMinimizedWindows(_ app: NSRunningApplication) -> Bool {
    applicationWindows(app).contains(where: minimizedState)
}

private func activateTargetApp(_ app: NSRunningApplication) {
    _ = app.unhide()
    restoreApplicationWindows(app)
    app.activate(options: [.activateAllWindows])
    Thread.sleep(forTimeInterval: 0.15)
}

private func targetWindowInfo(for app: NSRunningApplication) -> TargetWindowInfo? {
    let options: CGWindowListOption = [.excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
    let candidates = windows.compactMap { window -> (info: TargetWindowInfo, layer: Int, onScreen: Bool)? in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
              let number = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
              bounds.width >= 2,
              bounds.height >= 2 else {
            return nil
        }
        let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let onScreen = (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true
        return (TargetWindowInfo(id: CGWindowID(number), bounds: bounds), layer, onScreen)
    }
    let visibleNormalWindows = candidates.filter { $0.layer == 0 && $0.onScreen }
    let normalWindows = candidates.filter { $0.layer == 0 }
    let visibleWindows = candidates.filter { $0.onScreen }
    let eligible = !visibleNormalWindows.isEmpty
        ? visibleNormalWindows
        : !normalWindows.isEmpty
            ? normalWindows
            : !visibleWindows.isEmpty
                ? visibleWindows
                : candidates
    if let applicationWindow = attribute(
        applicationElement(for: app),
        kAXFocusedWindowAttribute as CFString
    ) as! AXUIElement?,
       let focusedValues = elementBounds(applicationWindow),
       let focusedX = focusedValues["x"],
       let focusedY = focusedValues["y"],
       let focusedWidth = focusedValues["width"],
       let focusedHeight = focusedValues["height"],
       case let focusedBounds = CGRect(
           x: focusedX,
           y: focusedY,
           width: focusedWidth,
           height: focusedHeight
       ),
       let focusedWindow = eligible.min(by: {
           windowDistance($0.info.bounds, focusedBounds) < windowDistance($1.info.bounds, focusedBounds)
       }),
       windowDistance(focusedWindow.info.bounds, focusedBounds) < 120 {
        return focusedWindow.info
    }
    return eligible.max(by: {
        $0.info.bounds.width * $0.info.bounds.height < $1.info.bounds.width * $1.info.bounds.height
    })?.info
}

private func windowDistance(_ left: CGRect, _ right: CGRect) -> CGFloat {
    abs(left.minX - right.minX)
        + abs(left.minY - right.minY)
        + abs(left.width - right.width)
        + abs(left.height - right.height)
}

private func writeStreamMetadata(_ value: [String: Any], directory: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("stream.json"), options: .atomic)
}

private func requestScreenCaptureAccessIfNeeded() -> Bool {
    if CGPreflightScreenCaptureAccess() {
        return true
    }
    return CGRequestScreenCaptureAccess() && CGPreflightScreenCaptureAccess()
}

@available(macOS 12.3, *)
private func shareableWindow(windowID: CGWindowID) throws -> SCWindow {
    let contentSemaphore = DispatchSemaphore(value: 0)
    let shareableContent = SendableBox<SCShareableContent>()
    let contentError = SendableBox<Error>()
    Task {
        do {
            shareableContent.value = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            contentError.value = error
        }
        contentSemaphore.signal()
    }
    guard contentSemaphore.wait(timeout: .now() + 8) == .success else {
        throw ProviderFailure.structured(
            code: "STREAM_START_TIMEOUT",
            message: "ScreenCaptureKit 获取窗口列表超时"
        )
    }
    if let error = contentError.value {
        throw ProviderFailure.structured(
            code: "STREAM_UNAVAILABLE",
            message: "ScreenCaptureKit 获取窗口失败",
            details: ["cause": error.localizedDescription]
        )
    }
    guard let target = shareableContent.value?.windows.first(where: { $0.windowID == windowID }) else {
        throw ProviderFailure.structured(
            code: "TARGET_WINDOW_NOT_FOUND",
            message: "ScreenCaptureKit 未找到目标窗口"
        )
    }
    return target
}

@available(macOS 12.3, *)
private func runContinuousWindowStream(
    selector: AppSelector,
    streamDirectoryPath: String,
    framesPerSecond: Int,
    maximumWidth: Int
) throws -> Never {
    guard requestScreenCaptureAccessIfNeeded() else {
        throw ProviderFailure.structured(
            code: "PERMISSION_DENIED",
            message: "尚未授予屏幕录制权限"
        )
    }
    let app = try resolveApp(selector)
    guard let window = targetWindowInfo(for: app) else {
        throw ProviderFailure.structured(
            code: "TARGET_WINDOW_NOT_FOUND",
            message: "目标应用当前没有可捕获窗口"
        )
    }
    let streamDirectory = URL(fileURLWithPath: streamDirectoryPath, isDirectory: true)
    try FileManager.default.createDirectory(at: streamDirectory, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: streamDirectory.appendingPathComponent("stop"))
    try writeStreamMetadata([
        "status": "starting",
        "processId": Int(app.processIdentifier),
        "windowId": Int(window.id),
    ], directory: streamDirectory)

    let target = try shareableWindow(windowID: window.id)
    let sourceWidth = max(2, Int(target.frame.width * 2))
    let sourceHeight = max(2, Int(target.frame.height * 2))
    let width = min(max(320, maximumWidth), sourceWidth)
    let height = max(2, Int((Double(sourceHeight) * Double(width) / Double(sourceWidth)).rounded()))
    let fps = min(30, max(15, framesPerSecond))
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.queueDepth = 4
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    configuration.scalesToFit = true
    configuration.showsCursor = true
    configuration.capturesAudio = false

    let receiver = ContinuousFrameReceiver(
        streamDirectory: streamDirectory,
        app: app,
        windowID: window.id,
        configuredFramesPerSecond: fps
    )
    let stream = SCStream(
        filter: SCContentFilter(desktopIndependentWindow: target),
        configuration: configuration,
        delegate: receiver
    )
    let outputQueue = DispatchQueue(
        label: "com.dt.gui.computer.provider.window-stream",
        qos: .userInteractive
    )
    try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: outputQueue)
    let startSemaphore = DispatchSemaphore(value: 0)
    let startError = SendableBox<Error>()
    stream.startCapture { error in
        startError.value = error
        startSemaphore.signal()
    }
    guard startSemaphore.wait(timeout: .now() + 8) == .success else {
        throw ProviderFailure.structured(
            code: "STREAM_START_TIMEOUT",
            message: "ScreenCaptureKit 启动超时"
        )
    }
    if let error = startError.value {
        throw ProviderFailure.structured(
            code: "STREAM_UNAVAILABLE",
            message: "ScreenCaptureKit 启动失败",
            details: ["cause": error.localizedDescription]
        )
    }

    let stopUrl = streamDirectory.appendingPathComponent("stop")
    let streamStartedAt = Date()
    var nextFallbackFrameAt = streamStartedAt.addingTimeInterval(1)
    while !receiver.hasStopped()
        && !app.isTerminated
        && !FileManager.default.fileExists(atPath: stopUrl.path) {
        let now = Date()
        if !receiver.hasReceivedStreamFrame(), now >= nextFallbackFrameAt {
            if let image = CGWindowListCreateImage(
                .null,
                .optionIncludingWindow,
                window.id,
                [.boundsIgnoreFraming, .bestResolution]
            ) {
                receiver.writeFrame(
                    image,
                    backend: "core-graphics-window-fallback",
                    isStreamFrame: false
                )
            } else {
                let fallbackPath = streamDirectory
                    .appendingPathComponent("fallback-frame.png")
                    .path
                if captureWindowWithSystemTool(
                    windowID: window.id,
                    outputPath: fallbackPath
                ) == nil,
                   let image = NSImage(contentsOfFile: fallbackPath)?
                    .cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    receiver.writeFrame(
                        image,
                        backend: "screencapture-window-fallback",
                        isStreamFrame: false
                    )
                }
                try? FileManager.default.removeItem(atPath: fallbackPath)
            }
            nextFallbackFrameAt = now.addingTimeInterval(0.2)
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.08))
    }
    let stopSemaphore = DispatchSemaphore(value: 0)
    stream.stopCapture { _ in stopSemaphore.signal() }
    _ = stopSemaphore.wait(timeout: .now() + 3)
    try? writeStreamMetadata([
        "status": app.isTerminated ? "target-closed" : "stopped",
        "sequence": 0,
    ], directory: streamDirectory)
    exit(0)
}

@available(macOS 12.3, *)
private func screenCaptureKitImage(windowID: CGWindowID) -> (image: CGImage?, gap: String) {
    _ = NSApplication.shared
    let contentSemaphore = DispatchSemaphore(value: 0)
    let shareableContent = SendableBox<SCShareableContent>()
    let contentError = SendableBox<Error>()
    Task {
        do {
            shareableContent.value = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            contentError.value = error
        }
        contentSemaphore.signal()
    }
    guard contentSemaphore.wait(timeout: .now() + 5) == .success else {
        return (nil, "screen-capture-kit-content-timeout")
    }
    if let error = contentError.value {
        return (nil, "screen-capture-kit-content-failed:\(error.localizedDescription)")
    }
    guard let target = shareableContent.value?.windows.first(where: { $0.windowID == windowID }) else {
        return (nil, "screen-capture-kit-target-not-found")
    }

    let configuration = SCStreamConfiguration()
    configuration.width = max(2, Int(target.frame.width * 2))
    configuration.height = max(2, Int(target.frame.height * 2))
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.queueDepth = 3
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    configuration.scalesToFit = true
    configuration.showsCursor = false

    let receiver = SingleFrameReceiver()
    let stream = SCStream(
        filter: SCContentFilter(desktopIndependentWindow: target),
        configuration: configuration,
        delegate: receiver
    )
    let outputQueue = DispatchQueue(label: "com.dt.gui.computer.provider.single-frame")
    do {
        try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: outputQueue)
    } catch {
        return (nil, "screen-capture-kit-output-failed:\(error.localizedDescription)")
    }

    let startSemaphore = DispatchSemaphore(value: 0)
    let startError = SendableBox<Error>()
    stream.startCapture { error in
        startError.value = error
        startSemaphore.signal()
    }
    guard startSemaphore.wait(timeout: .now() + 5) == .success, startError.value == nil else {
        stream.stopCapture(completionHandler: nil)
        return (
            nil,
            startError.value.map { "screen-capture-kit-start-failed:\($0.localizedDescription)" }
                ?? "screen-capture-kit-start-timeout"
        )
    }
    let frameDeadline = Date().addingTimeInterval(5)
    var receivedFrame = false
    while !receivedFrame && Date() < frameDeadline {
        receivedFrame = receiver.semaphore.wait(timeout: .now()) == .success
        if !receivedFrame {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
    }
    stream.stopCapture(completionHandler: nil)
    guard receivedFrame, let image = receiver.image else {
        return (nil, receiver.gap ?? "screen-capture-kit-frame-timeout")
    }
    return (image, "")
}

private func writePng(_ image: CGImage, outputPath: String) -> String? {
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        return "png-encoding-failed"
    }
    do {
        let outputUrl = URL(fileURLWithPath: outputPath)
        try FileManager.default.createDirectory(
            at: outputUrl.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: outputUrl, options: .atomic)
        return nil
    } catch {
        return "screenshot-write-failed"
    }
}

private func captureWindowWithSystemTool(windowID: CGWindowID, outputPath: String) -> String? {
    let outputUrl = URL(fileURLWithPath: outputPath)
    do {
        try FileManager.default.createDirectory(
            at: outputUrl.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: outputUrl)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(windowID), outputPath]
        let stderr = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus == 0,
           let attributes = try? FileManager.default.attributesOfItem(atPath: outputPath),
           (attributes[.size] as? NSNumber)?.intValue ?? 0 > 0 {
            return nil
        }
        try? FileManager.default.removeItem(at: outputUrl)
        let detail = String(
            data: stderr.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(160) ?? ""
        return "screencapture-window-failed:\(process.terminationStatus):\(detail)"
    } catch {
        try? FileManager.default.removeItem(at: outputUrl)
        return "screencapture-window-failed:\(error.localizedDescription)"
    }
}

private func captureWindow(for app: NSRunningApplication, outputPath: String) -> String? {
    guard CGPreflightScreenCaptureAccess() else { return "screen-recording-permission-denied" }
    guard let window = targetWindowInfo(for: app) else { return "target-window-not-found" }
    let legacyImage = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        window.id,
        [.boundsIgnoreFraming, .bestResolution]
    )
    if let legacyImage {
        return writePng(legacyImage, outputPath: outputPath)
    }
    if captureWindowWithSystemTool(windowID: window.id, outputPath: outputPath) == nil {
        return nil
    }
    if #available(macOS 12.3, *) {
        let fallback = screenCaptureKitImage(windowID: window.id)
        if let image = fallback.image {
            return writePng(image, outputPath: outputPath)
        }
        return fallback.gap
    }
    return "window-image-unavailable"
}

private func normalizedVisualText(_ value: String) -> String {
    value.lowercased().filter { !$0.isWhitespace && !$0.isNewline }
}

private func interactionState() -> InteractionState {
    InteractionState(
        frontmostProcessId: NSWorkspace.shared.frontmostApplication?.processIdentifier,
        cursorPosition: CGEvent(source: nil)?.location ?? .zero
    )
}

private func appendBackgroundAudit(
    _ result: [String: Any],
    before: InteractionState,
    targetProcessId: pid_t,
    settleTime: TimeInterval = 0.04
) throws -> [String: Any] {
    Thread.sleep(forTimeInterval: settleTime)
    let after = interactionState()
    let frontmostUnchanged = before.frontmostProcessId == after.frontmostProcessId
    let cursorUnchanged = abs(before.cursorPosition.x - after.cursorPosition.x) < 0.5
        && abs(before.cursorPosition.y - after.cursorPosition.y) < 0.5
    let targetWasActivated = before.frontmostProcessId != targetProcessId
        && after.frontmostProcessId == targetProcessId
    guard !targetWasActivated else {
        throw ProviderFailure.structured(
            code: "BACKGROUND_INTERFERENCE_DETECTED",
            message: "后台动作激活了目标应用，已停止以保护用户当前操作",
            details: [
                "frontmostBefore": before.frontmostProcessId.map(Int.init) ?? -1,
                "frontmostAfter": after.frontmostProcessId.map(Int.init) ?? -1,
                "targetProcessId": Int(targetProcessId),
                "cursorBefore": ["x": before.cursorPosition.x, "y": before.cursorPosition.y],
                "cursorAfter": ["x": after.cursorPosition.x, "y": after.cursorPosition.y],
            ]
        )
    }
    var audited = result
    audited["deliveryMode"] = "background-safe"
    audited["backgroundSafetyVerified"] = true
    audited["frontmostApplicationUnchanged"] = frontmostUnchanged
    audited["cursorUnchanged"] = cursorUnchanged
    audited["targetApplicationActivated"] = false
    audited["concurrentUserActivityObserved"] = !frontmostUnchanged || !cursorUnchanged
    return audited
}

private func assertBackgroundTargetIsNotForeground(
    _ app: NSRunningApplication,
    before: InteractionState
) throws {
    guard before.frontmostProcessId != app.processIdentifier else {
        throw ProviderFailure.structured(
            code: "BACKGROUND_ACTION_UNSUPPORTED",
            message: "目标应用当前位于前台；严格后台模式不会修改用户正在使用的页面，请切换到其他应用后重试",
            details: ["targetProcessId": Int(app.processIdentifier)]
        )
    }
}

private func postMouseClick(_ point: CGPoint, app: NSRunningApplication, background: Bool) throws {
    guard let down = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
    ), let up = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        throw ProviderFailure.structured(code: "INTERNAL", message: "无法创建鼠标事件")
    }
    if background {
        down.postToPid(app.processIdentifier)
        up.postToPid(app.processIdentifier)
    } else {
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func recognizeText(at path: String) throws -> [OcrMatch] {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw ProviderFailure.structured(code: "SCREENSHOT_UNAVAILABLE", message: "visual-click 无法读取最新截图")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try VNImageRequestHandler(cgImage: cgImage).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return OcrMatch(text: candidate.string, confidence: candidate.confidence, bounds: observation.boundingBox)
    }.sorted { left, right in
        abs(left.bounds.midY - right.bounds.midY) > 0.01
            ? left.bounds.midY > right.bounds.midY
            : left.bounds.midX < right.bounds.midX
    }
}

private func visualClick(
    _ request: ProviderRequest,
    action: NativeAction,
    app: NSRunningApplication,
    background: Bool
) throws -> [String: Any] {
    guard let screenshotPath = request.screenshotPath,
          let expectedWindow = request.snapshotWindowBounds,
          let currentWindow = targetWindowInfo(for: app),
          let expectedWidth = expectedWindow["width"],
          let expectedHeight = expectedWindow["height"] else {
        throw ProviderFailure.structured(code: "SCREENSHOT_UNAVAILABLE", message: "visual-click 需要带窗口边界的最新截图")
    }
    guard abs(currentWindow.bounds.width - expectedWidth) < 1,
          abs(currentWindow.bounds.height - expectedHeight) < 1 else {
        throw ProviderFailure.structured(code: "STALE_SNAPSHOT", message: "目标窗口尺寸已变化，请重新 observe")
    }
    let query = normalizedVisualText(action.visualText ?? "")
    let mode = action.matchMode ?? "contains"
    let matches = try recognizeText(at: screenshotPath).filter { candidate in
        let value = normalizedVisualText(candidate.text)
        return mode == "exact" ? value == query : value.contains(query)
    }
    let occurrence = max(1, action.occurrence ?? 1)
    guard matches.indices.contains(occurrence - 1) else {
        throw ProviderFailure.structured(
            code: matches.isEmpty ? "VISUAL_TARGET_NOT_FOUND" : "VISUAL_TARGET_OCCURRENCE_MISSING",
            message: matches.isEmpty ? "截图中未识别到目标文本" : "目标文本匹配数量不足",
            details: ["query": action.visualText ?? "", "matchCount": matches.count]
        )
    }
    let match = matches[occurrence - 1]
    let point = CGPoint(
        x: currentWindow.bounds.minX + match.bounds.midX * currentWindow.bounds.width,
        y: currentWindow.bounds.minY + (1 - match.bounds.midY) * currentWindow.bounds.height
    )
    try postMouseClick(point, app: app, background: background)
    Thread.sleep(forTimeInterval: 0.2)
    var postScreenshotPath: String?
    var visualChanged: Bool?
    if let requestedPostPath = request.postScreenshotPath,
       captureWindow(for: app, outputPath: requestedPostPath) == nil {
        postScreenshotPath = requestedPostPath
        if let before = try? Data(contentsOf: URL(fileURLWithPath: screenshotPath)),
           let after = try? Data(contentsOf: URL(fileURLWithPath: requestedPostPath)) {
            visualChanged = before != after
        }
    }
    var result: [String: Any] = [
        "performed": true,
        "kind": action.kind,
        "matchedText": match.text,
        "confidence": match.confidence,
        "matchCount": matches.count,
        "occurrence": occurrence,
        "normalizedBounds": ["x": match.bounds.minX, "y": match.bounds.minY, "width": match.bounds.width, "height": match.bounds.height],
        "point": ["x": point.x, "y": point.y],
        "deliveryMethod": background ? "targeted-mouse" : "global-mouse",
    ]
    if let postScreenshotPath { result["postScreenshotPath"] = postScreenshotPath }
    if let visualChanged { result["visualChanged"] = visualChanged }
    return result
}

private func appendPostActionVisualEvidence(
    _ result: [String: Any],
    request: ProviderRequest,
    app: NSRunningApplication
) -> [String: Any] {
    guard let requestedPostPath = request.postScreenshotPath,
          captureWindow(for: app, outputPath: requestedPostPath) == nil else {
        return result
    }
    var enriched = result
    enriched["postScreenshotPath"] = requestedPostPath
    if let screenshotPath = request.screenshotPath,
       let before = try? Data(contentsOf: URL(fileURLWithPath: screenshotPath)),
       let after = try? Data(contentsOf: URL(fileURLWithPath: requestedPostPath)) {
        enriched["visualChanged"] = before != after
    }
    return enriched
}

private func secureElement(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = stringAttribute(element, kAXSubroleAttribute as CFString) ?? ""
    return role == "AXSecureTextField" || subrole.localizedCaseInsensitiveContains("secure")
}

private func elementName(_ element: AXUIElement) -> String {
    for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXHelpAttribute, kAXIdentifierAttribute] {
        if let value = stringAttribute(element, name as CFString), !value.isEmpty { return value }
    }
    return ""
}

private func serializableValue(_ element: AXUIElement, secure: Bool) -> Any {
    if secure { return "[REDACTED]" }
    guard let value = attribute(element, kAXValueAttribute as CFString) else { return NSNull() }
    if let string = value as? String { return String(string.prefix(2_000)) }
    if let number = value as? NSNumber { return number.stringValue }
    return NSNull()
}

private func elementBounds(_ element: AXUIElement) -> [String: Double]? {
    guard let positionRaw = attribute(element, kAXPositionAttribute as CFString),
          let sizeRaw = attribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
    let positionValue = positionRaw as! AXValue
    let sizeValue = sizeRaw as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size),
          size.width > 0,
          size.height > 0 else { return nil }
    return ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
}

private func clickElementCenter(
    _ element: AXUIElement,
    app: NSRunningApplication,
    background: Bool
) throws -> [String: Double] {
    guard let bounds = elementBounds(element),
          let x = bounds["x"], let y = bounds["y"],
          let width = bounds["width"], let height = bounds["height"] else {
        throw ProviderFailure.structured(code: "UNSUPPORTED_ACTION", message: "目标元素没有可用的屏幕边界")
    }
    let point = CGPoint(x: x + width / 2, y: y + height / 2)
    try postMouseClick(point, app: app, background: background)
    return ["x": point.x, "y": point.y]
}

private func collectElements(
    _ element: AXUIElement,
    path: String,
    maxDepth: Int,
    maxElements: Int,
    visibleBounds: CGRect?,
    focusedElement: AXUIElement?,
    output: inout [[String: Any]],
    text: inout [String]
) {
    var queue: [(element: AXUIElement, path: String, depth: Int)] = [(element, path, 0)]
    var queueIndex = 0
    while queueIndex < queue.count && output.count < maxElements {
        let item = queue[queueIndex]
        queueIndex += 1
        guard item.depth <= maxDepth else { continue }

        let role = stringAttribute(item.element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let name = elementName(item.element)
        let secure = secureElement(item.element)
        let enabled = (attribute(item.element, kAXEnabledAttribute as CFString) as? NSNumber)?.boolValue ?? true
        let focused = focusedElement.map { CFEqual(item.element, $0) } ?? false
        let bounds = elementBounds(item.element)
        var exposedActions = actions(item.element)
        if bounds != nil && !exposedActions.contains(kAXPressAction as String) {
            exposedActions.append("UIWardenCenterClick")
        }
        let value = serializableValue(item.element, secure: secure)
        let elementId = "ax-\(item.path.replacingOccurrences(of: ".", with: "-"))"
        var serialized: [String: Any] = [
            "elementId": elementId,
            "providerPath": item.path,
            "role": role,
            "name": name,
            "value": value,
            "secure": secure,
            "enabled": enabled,
            "actions": exposedActions,
            "focused": focused,
        ]
        if let bounds { serialized["bounds"] = bounds }
        output.append(serialized)
        let valueText = value is NSNull ? "" : " value=\(value)"
        text.append("\(String(repeating: "  ", count: item.depth))\(elementId) \(role) \(name)\(valueText)")

        if item.depth < maxDepth {
            for (index, child) in children(item.element).enumerated() {
                if let visibleBounds,
                   let childValues = elementBounds(child),
                   let childX = childValues["x"],
                   let childY = childValues["y"],
                   let childWidth = childValues["width"],
                   let childHeight = childValues["height"],
                   !CGRect(
                       x: childX,
                       y: childY,
                       width: childWidth,
                       height: childHeight
                   ).intersects(visibleBounds) {
                    continue
                }
                queue.append((child, "\(item.path).\(index)", item.depth + 1))
            }
        }
    }
}

private func elementAtPath(_ root: AXUIElement, path: String) -> AXUIElement? {
    let indexes = path.split(separator: ".").compactMap { Int($0) }
    guard indexes.first == 0 else { return nil }
    var current = root
    for index in indexes.dropFirst() {
        let items = children(current)
        guard items.indices.contains(index) else { return nil }
        current = items[index]
    }
    return current
}

private func findElement(
    _ element: AXUIElement,
    expected: ExpectedElement,
    depth: Int = 0,
    maxDepth: Int = 8
) -> AXUIElement? {
    guard depth <= maxDepth else { return nil }
    let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    if role == expected.role,
       elementName(element) == expected.name,
       secureElement(element) == expected.secure {
        return element
    }
    for child in children(element) {
        if let match = findElement(child, expected: expected, depth: depth + 1, maxDepth: maxDepth) {
            return match
        }
    }
    return nil
}

private func postKey(_ key: String, processId: pid_t? = nil) throws {
    let parts = key.lowercased().split(separator: "+").map(String.init)
    let keyName = parts.last ?? key.lowercased()
    let keyCodes: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53,
        "delete": 51, "backspace": 51, "forward-delete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "equal": 24, "=": 24, "plus": 24,
        "minus": 27, "-": 27,
        "left-bracket": 33, "[": 33, "right-bracket": 30, "]": 30,
        "semicolon": 41, ";": 41, "quote": 39, "'": 39,
        "comma": 43, ",": 43, "period": 47, ".": 47,
        "slash": 44, "/": 44, "backslash": 42, "\\": 42,
        "grave": 50, "`": 50,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "9": 25, "7": 26, "8": 28, "0": 29,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118,
        "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
    guard let keyCode = keyCodes[keyName] else {
        throw ProviderFailure.structured(code: "UNSUPPORTED_ACTION", message: "不支持该按键；可使用字母、数字、常用符号、导航键、F1-F12 和组合快捷键")
    }
    var flags = CGEventFlags()
    if parts.contains("cmd") || parts.contains("command") || parts.contains("super") { flags.insert(.maskCommand) }
    if parts.contains("shift") { flags.insert(.maskShift) }
    if parts.contains("alt") || parts.contains("option") { flags.insert(.maskAlternate) }
    if parts.contains("ctrl") || parts.contains("control") { flags.insert(.maskControl) }
    if keyName == "plus" { flags.insert(.maskShift) }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw ProviderFailure.structured(code: "INTERNAL", message: "无法创建键盘事件")
    }
    down.flags = flags
    up.flags = flags
    if let processId {
        down.postToPid(processId)
        up.postToPid(processId)
    } else {
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

private func postText(_ text: String, processId: pid_t) throws {
    guard !text.isEmpty else {
        throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "输入文本不能为空")
    }
    let characters = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        throw ProviderFailure.structured(code: "INTERNAL", message: "无法创建定向文本事件")
    }
    characters.withUnsafeBufferPointer { buffer in
        guard let address = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: address)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: address)
    }
    down.postToPid(processId)
    up.postToPid(processId)
}

private func postScroll(
    direction: String,
    pages: Int,
    point: CGPoint?,
    processId: pid_t?
) throws {
    let sign: Int32 = direction == "up" ? 1 : -1
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 1,
        wheel1: sign * Int32(pages * 720),
        wheel2: 0,
        wheel3: 0
    ) else {
        throw ProviderFailure.structured(code: "INTERNAL", message: "无法创建滚动事件")
    }
    if let point { event.location = point }
    if let processId {
        event.postToPid(processId)
    } else {
        event.post(tap: .cghidEventTap)
    }
}

private struct PasteboardItemSnapshot {
    let values: [NSPasteboard.PasteboardType: Data]
}

private func capturePasteboard(_ pasteboard: NSPasteboard) -> [PasteboardItemSnapshot] {
    (pasteboard.pasteboardItems ?? []).map { item in
        PasteboardItemSnapshot(values: Dictionary(
            uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            }
        ))
    }
}

private func restorePasteboard(_ snapshots: [PasteboardItemSnapshot], to pasteboard: NSPasteboard) {
    pasteboard.clearContents()
    guard !snapshots.isEmpty else { return }
    let items = snapshots.map { snapshot -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in snapshot.values {
            item.setData(data, forType: type)
        }
        return item
    }
    pasteboard.writeObjects(items)
}

private func pasteTextPreservingClipboard(_ text: String) throws {
    guard !text.isEmpty else {
        throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "输入文本不能为空")
    }
    let pasteboard = NSPasteboard.general
    let previousItems = capturePasteboard(pasteboard)
    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        restorePasteboard(previousItems, to: pasteboard)
        throw ProviderFailure.structured(code: "INTERNAL", message: "无法准备聚焦输入文本")
    }
    let injectedChangeCount = pasteboard.changeCount
    do {
        try postKey("command+v")
        Thread.sleep(forTimeInterval: 0.15)
        if pasteboard.changeCount == injectedChangeCount {
            restorePasteboard(previousItems, to: pasteboard)
        }
    } catch {
        if pasteboard.changeCount == injectedChangeCount {
            restorePasteboard(previousItems, to: pasteboard)
        }
        throw error
    }
}

private func perform(_ request: ProviderRequest) throws -> Any {
    appendDiagnosticStage("perform-start", request: request, details: [
        "actionKind": request.action?.kind ?? "unknown",
    ])
    guard AXIsProcessTrusted() else {
        throw ProviderFailure.structured(code: "PERMISSION_DENIED", message: "尚未授予 Accessibility 权限")
    }
    guard let selector = request.app, let action = request.action else {
        throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "perform 缺少 app 或 action")
    }
    let app = try resolveApp(selector)
    appendDiagnosticStage("app-resolved", request: request, details: [
        "processId": Int(app.processIdentifier),
        "bundleIdentifier": app.bundleIdentifier ?? "",
    ])
    let background = request.deliveryMode == "background-safe"
    let before = background ? interactionState() : nil
    if let before {
        try assertBackgroundTargetIsNotForeground(app, before: before)
    }
    if action.kind == "visual-click" {
        if background && hasMinimizedWindows(app) {
            throw ProviderFailure.structured(
                code: "BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW",
                message: "目标窗口已最小化，视觉点击不可用；请改用 AX 语义动作，禁止恢复窗口或降级为前台执行"
            )
        }
        if !background { activateTargetApp(app) }
        appendDiagnosticStage("visual-click-start", request: request)
        let result = try visualClick(request, action: action, app: app, background: background)
        appendDiagnosticStage("visual-click-complete", request: request)
        return try before.map {
            try appendBackgroundAudit(result, before: $0, targetProcessId: app.processIdentifier)
        } ?? result
    }
    let root = rootElement(for: app)
    appendDiagnosticStage("element-resolution-start", request: request, details: [
        "providerPath": request.providerPath ?? "",
    ])
    let target = request.providerPath.flatMap { elementAtPath(root, path: $0) }
        ?? request.expectedElement.flatMap { findElement(root, expected: $0) }
        ?? (action.focused == true ? focusedElement(for: app) : nil)
    appendDiagnosticStage("element-resolution-complete", request: request, details: [
        "found": target != nil,
    ])
    if let target, let expected = request.expectedElement {
        let currentRole = stringAttribute(target, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let currentName = elementName(target)
        let currentSecure = secureElement(target)
        guard currentRole == expected.role, currentName == expected.name, currentSecure == expected.secure else {
            throw ProviderFailure.structured(
                code: "STALE_SNAPSHOT",
                message: "目标元素已变化，请重新观察",
                details: ["expectedRole": expected.role, "currentRole": currentRole]
            )
        }
    }
    var deliveryMethod = ""
    switch action.kind {
    case "click":
        if let target {
            appendDiagnosticStage("ax-call-start", request: request, details: [
                "operation": "AXPress",
            ])
            let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
            appendDiagnosticStage("ax-call-complete", request: request, details: [
                "operation": "AXPress",
                "axError": result.rawValue,
            ])
            if result != .success && action.allowCoordinateFallback == true {
                if !background { activateTargetApp(app) }
                let point = try clickElementCenter(target, app: app, background: background)
                let fallbackResult: [String: Any] = [
                    "performed": true,
                    "kind": action.kind,
                    "fallback": "semantic-center",
                    "point": point,
                    "deliveryMethod": background ? "targeted-mouse" : "global-mouse",
                ]
                Thread.sleep(forTimeInterval: 0.2)
                let evidencedResult = appendPostActionVisualEvidence(
                    fallbackResult,
                    request: request,
                    app: app
                )
                return try before.map {
                    try appendBackgroundAudit(
                        evidencedResult,
                        before: $0,
                        targetProcessId: app.processIdentifier
                    )
                } ?? evidencedResult
            }
            guard result == .success else {
                throw ProviderFailure.structured(code: "UNSUPPORTED_ACTION", message: "目标元素不支持 AXPress", details: ["axError": result.rawValue])
            }
            deliveryMethod = "ax-press"
        } else if let x = action.x, let y = action.y {
            guard action.allowCoordinateFallback == true else {
                throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "坐标点击未显式授权")
            }
            if background && hasMinimizedWindows(app) {
                throw ProviderFailure.structured(
                    code: "BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW",
                    message: "目标窗口已最小化，坐标点击不可用；请改用 AX 语义动作，禁止恢复窗口或降级为前台执行"
                )
            }
            if !background { activateTargetApp(app) }
            let point = CGPoint(x: x, y: y)
            try postMouseClick(point, app: app, background: background)
            deliveryMethod = background ? "targeted-mouse" : "global-mouse"
        } else {
            throw ProviderFailure.structured(code: "ELEMENT_NOT_FOUND", message: "目标元素路径已失效")
        }
    case "set-value", "type-text":
        guard let target else { throw ProviderFailure.structured(code: "ELEMENT_NOT_FOUND", message: "目标元素路径已失效") }
        guard !secureElement(target) else { throw ProviderFailure.structured(code: "HANDOFF_REQUIRED", message: "安全输入框必须由用户操作") }
        if action.kind == "type-text", action.focused == true {
            if background {
                appendDiagnosticStage("input-call-start", request: request, details: [
                    "operation": "targeted-unicode",
                ])
                try postText(action.value ?? "", processId: app.processIdentifier)
                appendDiagnosticStage("input-call-complete", request: request, details: [
                    "operation": "targeted-unicode",
                ])
                let textResult: [String: Any] = [
                    "performed": true,
                    "kind": action.kind,
                    "inputMethod": "targeted-unicode",
                    "deliveryMethod": "targeted-text",
                ]
                return try before.map {
                    try appendBackgroundAudit(
                        textResult,
                        before: $0,
                        targetProcessId: app.processIdentifier
                    )
                } ?? textResult
            }
            activateTargetApp(app)
            appendDiagnosticStage("input-call-start", request: request, details: [
                "operation": "clipboard-paste",
            ])
            try pasteTextPreservingClipboard(action.value ?? "")
            appendDiagnosticStage("input-call-complete", request: request, details: [
                "operation": "clipboard-paste",
            ])
            return [
                "performed": true,
                "kind": action.kind,
                "inputMethod": "clipboard-paste",
                "deliveryMethod": "global-clipboard-key",
            ] as [String: Any]
        }
        let current = stringAttribute(target, kAXValueAttribute as CFString) ?? ""
        let value = action.kind == "type-text" ? current + (action.value ?? "") : (action.value ?? "")
        appendDiagnosticStage("ax-call-start", request: request, details: [
            "operation": "AXSetValue",
        ])
        let result = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFTypeRef)
        appendDiagnosticStage("ax-call-complete", request: request, details: [
            "operation": "AXSetValue",
            "axError": result.rawValue,
        ])
        guard result == .success else { throw ProviderFailure.structured(code: "UNSUPPORTED_ACTION", message: "目标元素不支持 AXSetValue", details: ["axError": result.rawValue]) }
        deliveryMethod = "ax-set-value"
    case "key":
        if background && hasMinimizedWindows(app) {
            throw ProviderFailure.structured(
                code: "BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW",
                message: "目标窗口已最小化，键盘动作不可用；请改用 AXPress、AXSetValue 等语义动作，禁止恢复窗口或降级为前台执行"
            )
        }
        if !background { activateTargetApp(app) }
        appendDiagnosticStage("input-call-start", request: request, details: [
            "operation": "key",
        ])
        try postKey(action.key ?? "", processId: background ? app.processIdentifier : nil)
        appendDiagnosticStage("input-call-complete", request: request, details: [
            "operation": "key",
        ])
        deliveryMethod = background ? "targeted-key" : "global-key"
    case "scroll":
        if background && hasMinimizedWindows(app) {
            throw ProviderFailure.structured(
                code: "BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW",
                message: "目标窗口已最小化，滚动动作不可用；请改用当前 AX 投影中的可见语义元素，禁止恢复窗口或降级为前台执行"
            )
        }
        if !background { activateTargetApp(app) }
        let pages = max(1, action.pages ?? 1)
        let targetPoint = target.flatMap { element -> CGPoint? in
            guard let bounds = elementBounds(element),
                  let x = bounds["x"], let y = bounds["y"],
                  let width = bounds["width"], let height = bounds["height"] else { return nil }
            return CGPoint(x: x + width / 2, y: y + height / 2)
        } ?? targetWindowInfo(for: app).map {
            CGPoint(x: $0.bounds.midX, y: $0.bounds.midY)
        }
        appendDiagnosticStage("input-call-start", request: request, details: [
            "operation": "scroll",
        ])
        try postScroll(
            direction: action.direction ?? "down",
            pages: pages,
            point: targetPoint,
            processId: background ? app.processIdentifier : nil
        )
        appendDiagnosticStage("input-call-complete", request: request, details: [
            "operation": "scroll",
        ])
        deliveryMethod = background ? "targeted-scroll" : "global-scroll"
    default:
        throw ProviderFailure.structured(code: "UNSUPPORTED_ACTION", message: "macOS Provider 暂不支持动作：\(action.kind)")
    }
    var result: [String: Any] = [
        "performed": true,
        "kind": action.kind,
        "deliveryMethod": deliveryMethod,
    ]
    if action.kind == "click" && (deliveryMethod == "targeted-mouse" || deliveryMethod == "global-mouse") {
        Thread.sleep(forTimeInterval: 0.2)
        result = appendPostActionVisualEvidence(result, request: request, app: app)
    }
    return try before.map {
        try appendBackgroundAudit(result, before: $0, targetProcessId: app.processIdentifier)
    } ?? result
}

private func executeProviderRequest(_ request: ProviderRequest) throws -> Any {
    switch request.command {
    case "probe":
        return [
            "providerId": "macos-accessibility",
            "available": true,
            "permission": AXIsProcessTrusted() ? "granted" : "denied",
            "screenCapturePermission": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
            "capabilities": ["launch", "observe", "click", "visual-click", "set-value", "type-text", "key", "scroll"],
            "deliveryModes": ["foreground-compatible", "background-safe"],
        ] as [String: Any]
    case "listApps":
        return availableApps()
    case "launch":
        guard let selector = request.app else {
            throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "launch 缺少 app")
        }
        return try launchApplication(
            selector,
            deliveryMode: request.deliveryMode ?? "foreground-compatible"
        )
    case "observe":
        guard AXIsProcessTrusted() else {
            throw ProviderFailure.structured(code: "PERMISSION_DENIED", message: "尚未授予 Accessibility 权限")
        }
        guard let selector = request.app else {
            throw ProviderFailure.structured(code: "INVALID_ARGUMENT", message: "observe 缺少 app")
        }
        let app = try resolveApp(selector)
        let root = rootElement(for: app)
        let currentFocusedElement = focusedElement(for: app)
        let targetWindow = targetWindowInfo(for: app)
        var elements: [[String: Any]] = []
        var text: [String] = []
        collectElements(
            root,
            path: "0",
            maxDepth: max(1, request.maxDepth ?? 6),
            maxElements: max(1, request.maxElements ?? 400),
            visibleBounds: request.visibleOnly == true ? targetWindow?.bounds : nil,
            focusedElement: currentFocusedElement,
            output: &elements,
            text: &text
        )
        var captureGaps: [String] = []
        var screenshotPath: String?
        if let requestedPath = request.screenshotPath {
            if let gap = captureWindow(for: app, outputPath: requestedPath) {
                captureGaps.append(gap)
            } else {
                screenshotPath = requestedPath
            }
        } else {
            captureGaps.append("screenshot-path-not-provided")
        }
        var result: [String: Any] = [
            "app": appInfo(app),
            "text": text.joined(separator: "\n"),
            "elements": elements,
            "captureGaps": captureGaps,
        ]
        if let window = targetWindow {
            result["windowBounds"] = [
                "x": window.bounds.minX,
                "y": window.bounds.minY,
                "width": window.bounds.width,
                "height": window.bounds.height,
            ]
        }
        if let screenshotPath { result["screenshotPath"] = screenshotPath }
        return result
    case "perform":
        return try perform(request)
    default:
        throw ProviderFailure.structured(
            code: "INVALID_ARGUMENT",
            message: "未知 provider command：\(request.command)"
        )
    }
}

private func providerEnvelope(_ input: Data) -> [String: Any] {
    do {
        let request = try JSONDecoder().decode(ProviderRequest.self, from: input)
        appendDiagnosticStage("request-parsed", request: request, details: [
            "command": request.command,
        ])
        return ["ok": true, "data": try executeProviderRequest(request)]
    } catch ProviderFailure.structured(let code, let message, let details) {
        return providerFailureEnvelope(code: code, message: message, details: details)
    } catch {
        return providerFailureEnvelope(
            code: "INTERNAL",
            message: "macOS Provider 执行失败：\(error.localizedDescription)"
        )
    }
}

private func providerFailureEnvelope(
    code: String,
    message: String,
    details: [String: Any] = [:]
) -> [String: Any] {
    let error: [String: Any] = [
        "code": code,
        "message": message,
        "details": details,
    ]
    return ["ok": false, "error": error]
}

private func writeProviderJson(_ value: [String: Any], to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o600],
        ofItemAtPath: url.path
    )
}

private func parentProcessIsAlive(_ processId: Int32) -> Bool {
    guard processId > 0 else { return true }
    if kill(processId, 0) == 0 { return true }
    return errno == EPERM
}

private func runProviderDaemon(directoryPath: String, parentProcessId: Int32) throws {
    guard parentProcessId > 0 else {
        throw ProviderFailure.structured(
            code: "INVALID_ARGUMENT",
            message: "macOS Provider 常驻服务缺少有效父进程"
        )
    }
    _ = NSApplication.shared
    let fileManager = FileManager.default
    let directory = URL(fileURLWithPath: directoryPath, isDirectory: true)
    try fileManager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let readyUrl = directory.appendingPathComponent("ready.json")
    let stopUrl = directory.appendingPathComponent("stop")
    try? fileManager.removeItem(at: stopUrl)
    try writeProviderJson([
        "ready": true,
        "providerId": "macos-accessibility",
        "providerPid": Int(getpid()),
        "ownerPid": Int(parentProcessId),
        "protocolVersion": 1,
        "startedAt": ISO8601DateFormatter().string(from: Date()),
    ], to: readyUrl)
    defer {
        try? fileManager.removeItem(at: readyUrl)
    }

    while parentProcessIsAlive(parentProcessId)
        && !fileManager.fileExists(atPath: stopUrl.path) {
        let requests = ((try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".request.json") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for requestUrl in requests {
            let baseName = String(requestUrl.lastPathComponent.dropLast(".request.json".count))
            let responseUrl = directory.appendingPathComponent("\(baseName).response.json")
            do {
                let input = try Data(contentsOf: requestUrl)
                let request = try? JSONDecoder().decode(ProviderRequest.self, from: input)
                let response = providerEnvelope(input)
                appendDiagnosticStage("response-write-start", request: request, details: [
                    "ok": response["ok"] as? Bool ?? false,
                ])
                try writeProviderJson(response, to: responseUrl)
                appendDiagnosticStage("response-write-complete", request: request)
            } catch {
                try? writeProviderJson(providerFailureEnvelope(
                    code: "INTERNAL",
                    message: "macOS Provider mailbox 处理失败：\(error.localizedDescription)"
                ), to: responseUrl)
            }
            try? fileManager.removeItem(at: requestUrl)
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005))
    }
}

if let streamDirectory = argumentValue("--stream-dir") {
    guard #available(macOS 12.3, *) else {
        fail("STREAM_UNAVAILABLE", "连续窗口画中画需要 macOS 12.3 或更高版本")
    }
    let providerApplication = NSApplication.shared
    providerApplication.setActivationPolicy(.accessory)
    providerApplication.finishLaunching()
    guard let selectorKind = argumentValue("--app-kind"),
          let selectorValue = argumentValue("--app") else {
        fail("INVALID_ARGUMENT", "连续窗口画中画缺少应用选择器")
    }
    do {
        try runContinuousWindowStream(
            selector: AppSelector(kind: selectorKind, value: selectorValue),
            streamDirectoryPath: streamDirectory,
            framesPerSecond: Int(argumentValue("--fps") ?? "") ?? 20,
            maximumWidth: Int(argumentValue("--max-width") ?? "") ?? 1280
        )
    } catch ProviderFailure.structured(let code, let message, let details) {
        try? writeStreamMetadata([
            "status": "failed",
            "error": "\(code):\(message)",
            "details": details,
        ], directory: URL(fileURLWithPath: streamDirectory, isDirectory: true))
        fail(code, message, details: details)
    } catch {
        try? writeStreamMetadata([
            "status": "failed",
            "error": error.localizedDescription,
        ], directory: URL(fileURLWithPath: streamDirectory, isDirectory: true))
        fail("INTERNAL", "连续窗口画中画启动失败：\(error.localizedDescription)")
    }
}

if let daemonDirectory = argumentValue("--daemon-dir") {
    do {
        try runProviderDaemon(
            directoryPath: daemonDirectory,
            parentProcessId: Int32(argumentValue("--parent-pid") ?? "") ?? 0
        )
        exit(0)
    } catch {
        fail("PROVIDER_UNAVAILABLE", "macOS Provider 常驻服务启动失败：\(error.localizedDescription)")
    }
}

do {
    appendDiagnosticStage("process-start", details: [
        "arguments": CommandLine.arguments.count,
    ])
    let input: Data
    if let requestPath = argumentValue("--request") {
        input = try Data(contentsOf: URL(fileURLWithPath: requestPath))
    } else {
        input = FileHandle.standardInput.readDataToEndOfFile()
    }
    let response = providerEnvelope(input)
    emit(response)
    exit(response["ok"] as? Bool == true ? 0 : 2)
} catch {
    fail("INTERNAL", "macOS Provider 执行失败：\(error.localizedDescription)")
}
