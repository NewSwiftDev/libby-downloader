//
//  DownloadStore.swift
//  Shared (Extension)
//
//  Writes Libby chapters for the Safari extension. macOS uses
//  ~/Downloads/libby-downloads/<title>/chapter-NNN.mp3. iOS uses the app
//  group container. Paths and the host allowlist match web/lib/paths.js
//  and web/lib/urls.js.
//
//  Copyright (c) 2026 libby-downloader contributors.
//  Ported from pdugan20/libby-downloader (MIT).
//

import Foundation
import os.log

enum DownloadStore {
    static let appGroupIdentifier = "group.com.libbydownloader.safari"
    static let downloadsSubdirectory = "libby-downloads"

    static func handle(_ message: [String: Any]) -> [String: Any] {
        guard let action = message["action"] as? String else {
            return failure("invalid-message")
        }
        switch action {
        case "ping":
            return ping()
        case "saveFromUrl":
            return saveFromUrl(message)
        case "saveText":
            return saveText(message)
        case "moveFlat":
            return moveFlat(message)
        default:
            return failure("unknown-action")
        }
    }

    private static func ping() -> [String: Any] {
        do {
            let root = try storageRoot()
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            var response = baseStatus()
            response["ok"] = true
            response["path"] = root.resolvingSymlinksInPath().path
            return response
        } catch let error as StorageAccessError {
            return failure(error.code, detail: error.detail)
        } catch {
            return failure("downloads-unavailable", detail: errorText(error))
        }
    }

    private static func saveFromUrl(_ message: [String: Any]) -> [String: Any] {
        guard let relativePath = message["relativePath"] as? String,
              let urlString = message["url"] as? String
        else {
            return failure("invalid-message")
        }
        guard let url = allowedChapterURL(urlString) else {
            return failure("invalid-url")
        }
        let root: URL
        do {
            root = try storageRoot()
        } catch let error as StorageAccessError {
            return failure(error.code, detail: error.detail)
        } catch {
            return failure("io", detail: errorText(error))
        }
        guard let destination = containedDestination(relativePath, root: root, requiredSuffix: ".mp3") else {
            return failure("invalid-path")
        }

        do {
            try download(url, to: destination, cookie: safeCookieHeader(message["cookie"]))
            return ["ok": true, "path": destination.path, "platform": platformName()]
        } catch let error as DownloadStoreError {
            return error.response
        } catch {
            return failure("io", detail: errorText(error))
        }
    }

    private static func saveText(_ message: [String: Any]) -> [String: Any] {
        guard let relativePath = message["relativePath"] as? String,
              let text = message["text"] as? String
        else {
            return failure("invalid-message")
        }
        if text.utf8.count > 2_000_000 {
            return failure("invalid-message")
        }
        let root: URL
        do {
            root = try storageRoot()
        } catch let error as StorageAccessError {
            return failure(error.code, detail: error.detail)
        } catch {
            return failure("io", detail: errorText(error))
        }
        guard let destination = containedDestination(relativePath, root: root, requiredSuffix: "/metadata.json") else {
            return failure("invalid-path")
        }

        do {
            try write(text, to: destination)
            return ["ok": true, "path": destination.path, "platform": platformName()]
        } catch {
            return failure("io", detail: errorText(error))
        }
    }

    private static func downloadsDirectory() throws -> URL {
        #if os(iOS)
        throw StorageAccessError.flatDownloadsUnavailable
        #else
        if let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first {
            return downloads
        }
        return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads", isDirectory: true)
        #endif
    }

    private static func storageRoot() throws -> URL {
        #if os(iOS)
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw StorageAccessError.appGroupUnavailable
        }
        return container.appendingPathComponent(downloadsSubdirectory, isDirectory: true)
        #else
        return try downloadsDirectory().appendingPathComponent(downloadsSubdirectory, isDirectory: true)
        #endif
    }

    /// Moves ~/Downloads/<flat name> into ~/Downloads/libby-downloads/<title>/.
    /// Safari's <a download> attribute cannot create that folder.
    private static func moveFlat(_ message: [String: Any]) -> [String: Any] {
        guard let flatName = message["flatName"] as? String,
              let relativePath = message["relativePath"] as? String,
              isSafeFlatName(flatName)
        else {
            return failure("invalid-path")
        }
        let root: URL
        let downloads: URL
        do {
            downloads = try downloadsDirectory()
            root = try storageRoot()
        } catch let error as StorageAccessError {
            return failure(error.code, detail: error.detail)
        } catch {
            return failure("io", detail: errorText(error))
        }
        guard let destination = containedDestination(relativePath, root: root, requiredSuffix: ".mp3") else {
            return failure("invalid-path")
        }
        guard let source = waitForFlatFile(flatName, in: downloads, timeout: 30) else {
            return failure("missing-file", detail: "\(flatName) was not in Downloads")
        }
        do {
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: source, to: destination)
            return ["ok": true, "path": destination.path, "platform": platformName()]
        } catch {
            return failure("io", detail: errorText(error))
        }
    }

    private static func isSafeFlatName(_ name: String) -> Bool {
        if name.isEmpty || name.count > 240 { return false }
        if name.contains("/") || name.contains("\\") || name.contains("..") { return false }
        if name.hasPrefix(".") { return false }
        if name.contains("\n") || name.contains("\r") { return false }
        return name.hasSuffix(".mp3")
    }

    private static func waitForFlatFile(_ name: String, in downloads: URL, timeout: TimeInterval) -> URL? {
        let source = downloads.appendingPathComponent(name, isDirectory: false)
        let downloadsPath = downloads.standardizedFileURL.path
        let sourcePath = source.standardizedFileURL.path
        let parent = (sourcePath as NSString).deletingLastPathComponent
        if parent != downloadsPath { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: sourcePath) {
                return source
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return nil
    }

    private static func containedDestination(
        _ relativePath: String,
        root: URL,
        requiredSuffix: String
    ) -> URL? {
        let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.hasPrefix("/") || trimmed.hasPrefix("~") || trimmed.contains("\\") {
            return nil
        }
        if trimmed.contains("..") || !trimmed.hasSuffix(requiredSuffix) {
            return nil
        }
        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.count < 2 {
            return nil
        }
        if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.hasPrefix(".") }) {
            return nil
        }

        var url = root
        for part in parts {
            url.appendPathComponent(part, isDirectory: false)
        }
        let rootPath = root.standardizedFileURL.path
        let destinationPath = url.standardizedFileURL.path
        if destinationPath != rootPath && !destinationPath.hasPrefix(rootPath + "/") {
            return nil
        }
        return url
    }

    /// Keep in sync with CHAPTER_HOST_SUFFIXES in web/lib/urls.js.
    static func isAllowedFetchHost(_ host: String) -> Bool {
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let suffixes = ["libbyapp.com", "cdn.overdrive.com"]
        return suffixes.contains { suffix in
            normalized == suffix || normalized.hasSuffix("." + suffix)
        }
    }

    private static func allowedChapterURL(_ string: String) -> URL? {
        guard let url = URL(string: string),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              isAllowedFetchHost(host)
        else {
            return nil
        }
        return url
    }

    private static func safeCookieHeader(_ value: Any?) -> String? {
        guard let cookie = value as? String else { return nil }
        if cookie.isEmpty || cookie.count > 16_384 { return nil }
        if cookie.contains("\n") || cookie.contains("\r") { return nil }
        return cookie
    }

    private static func download(_ url: URL, to destination: URL, cookie: String?) throws {
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        request.httpShouldHandleCookies = false
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        if let cookie {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        os_log(.default, "Libby Downloader fetching host=%{public}@", url.host ?? "")
        try ChapterTransfer(destination: destination).run(request)
    }

    private static func write(_ text: String, to destination: URL) throws {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try text.write(to: destination, atomically: true, encoding: .utf8)
    }

    private static func platformName() -> String {
        #if os(iOS)
        return "ios"
        #else
        return "macos"
        #endif
    }

    private static func baseStatus() -> [String: Any] {
        #if os(iOS)
        let storage = "app-group"
        #else
        let storage = "downloads"
        #endif
        return [
            "platform": platformName(),
            "storage": storage,
            "appGroup": appGroupIdentifier,
            "subdirectory": downloadsSubdirectory,
        ]
    }

    fileprivate static func failure(_ error: String, detail: String? = nil, status: Int? = nil) -> [String: Any] {
        var result: [String: Any] = ["ok": false, "error": error]
        if let detail, !detail.isEmpty {
            result["detail"] = String(detail.prefix(500))
        }
        if let status {
            result["status"] = status
        }
        return result
    }

    fileprivate static func errorText(_ error: Error) -> String {
        let ns = error as NSError
        if ns.localizedDescription.isEmpty {
            return "\(ns.domain) \(ns.code)"
        }
        return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
    }

    /// URLSession follow of the signed listen.libbyapp.com URL. The CDN
    /// response is not subject to page CORS. Cookies are removed when the
    /// host changes so Libby cookies are not sent to audioclips.cdn.overdrive.com.
    private final class ChapterTransfer: NSObject, URLSessionDownloadDelegate {
        private let destination: URL
        private let semaphore = DispatchSemaphore(value: 0)
        private var redirectFailure: DownloadStoreError?
        private var recorded: Error?
        private var saved = false
        private var finished = false

        init(destination: URL) {
            self.destination = destination
        }

        func run(_ request: URLRequest) throws {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 120
            configuration.timeoutIntervalForResource = 150
            configuration.httpShouldSetCookies = false
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            let task = session.downloadTask(with: request)
            task.resume()
            if semaphore.wait(timeout: .now() + 150) == .timedOut {
                task.cancel()
                session.invalidateAndCancel()
                throw DownloadStoreError.timeout
            }
            session.finishTasksAndInvalidate()
            if let redirectFailure {
                throw redirectFailure
            }
            if saved { return }
            if let recorded { throw recorded }
            throw DownloadStoreError.http(status: 0, host: nil)
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            guard let next = request.url,
                  next.scheme?.lowercased() == "https",
                  let host = next.host,
                  DownloadStore.isAllowedFetchHost(host)
            else {
                let host = request.url?.host ?? "unknown"
                os_log(.error, "Libby Downloader blocked redirect host=%{public}@", host)
                redirectFailure = .redirectBlocked(host)
                completionHandler(nil)
                return
            }
            var redirected = request
            let originalHost = task.originalRequest?.url?.host?.lowercased()
            if originalHost != host.lowercased() {
                redirected.setValue(nil, forHTTPHeaderField: "Cookie")
            }
            os_log(.default, "Libby Downloader following redirect host=%{public}@", host)
            completionHandler(redirected)
        }

        func urlSession(
            _ session: URLSession,
            downloadTask: URLSessionDownloadTask,
            didFinishDownloadingTo location: URL
        ) {
            if redirectFailure != nil { return }
            guard let http = downloadTask.response as? HTTPURLResponse else {
                recorded = DownloadStoreError.http(status: 0, host: nil)
                return
            }
            let host = http.url?.host
            guard (200 ..< 300).contains(http.statusCode) else {
                recorded = DownloadStoreError.http(status: http.statusCode, host: host)
                return
            }
            do {
                try FileManager.default.createDirectory(
                    at: destination.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.moveItem(at: location, to: destination)
                saved = true
            } catch {
                recorded = error
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if finished { return }
            finished = true
            if recorded == nil, let error, !saved, redirectFailure == nil {
                recorded = error
            }
            semaphore.signal()
        }
    }
}

private enum DownloadStoreError: Error {
    case http(status: Int, host: String?)
    case timeout
    case redirectBlocked(String)

    var response: [String: Any] {
        switch self {
        case let .http(status, host):
            let whereFrom = host.map { " from \($0)" } ?? ""
            return DownloadStore.failure("http-\(status)", detail: "HTTP \(status)\(whereFrom)", status: status)
        case .timeout:
            return DownloadStore.failure("timeout", detail: "The chapter download timed out")
        case let .redirectBlocked(host):
            return DownloadStore.failure("redirect-blocked", detail: "Refusing redirect to \(host)")
        }
    }
}

private enum StorageAccessError: Error {
    case appGroupUnavailable
    case flatDownloadsUnavailable

    var code: String {
        switch self {
        case .appGroupUnavailable:
            return "app-group-unavailable"
        case .flatDownloadsUnavailable:
            return "flat-downloads-unavailable"
        }
    }

    var detail: String {
        switch self {
        case .appGroupUnavailable:
            return "App group \(DownloadStore.appGroupIdentifier) is not available"
        case .flatDownloadsUnavailable:
            return "Safari flat downloads are not in an app-group folder on iOS"
        }
    }
}
