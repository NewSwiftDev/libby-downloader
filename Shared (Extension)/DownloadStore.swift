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
        default:
            return failure("unknown-action")
        }
    }

    private static func ping() -> [String: Any] {
        var response = baseStatus()
        do {
            _ = try storageRoot()
            response["ok"] = true
        } catch let error as StorageAccessError {
            response["ok"] = false
            response["error"] = error.code
        } catch {
            response["ok"] = false
            response["error"] = "io"
        }
        return response
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
            return failure(error.code)
        } catch {
            return failure("io")
        }
        guard let destination = containedDestination(relativePath, root: root, requiredSuffix: ".mp3") else {
            return failure("invalid-path")
        }

        do {
            try download(url, to: destination, cookie: safeCookieHeader(message["cookie"]))
            return ["ok": true, "path": destination.path, "platform": platformName()]
        } catch DownloadStoreError.http(let status) {
            return ["ok": false, "error": "http-\(status)", "status": status]
        } catch DownloadStoreError.timeout {
            return failure("timeout")
        } catch {
            return failure("io")
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
            return failure(error.code)
        } catch {
            return failure("io")
        }
        guard let destination = containedDestination(relativePath, root: root, requiredSuffix: "/metadata.json") else {
            return failure("invalid-path")
        }

        do {
            try write(text, to: destination)
            return ["ok": true, "path": destination.path, "platform": platformName()]
        } catch {
            return failure("io")
        }
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
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads", isDirectory: true)
        return downloads.appendingPathComponent(downloadsSubdirectory, isDirectory: true)
        #endif
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

    private static func allowedChapterURL(_ string: String) -> URL? {
        guard let url = URL(string: string),
              let scheme = url.scheme?.lowercased(),
              scheme == "https",
              let host = url.host?.lowercased()
        else {
            return nil
        }
        if host == "libbyapp.com" || host.hasSuffix(".libbyapp.com") {
            return url
        }
        return nil
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
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        if let cookie {
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
        }

        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error> = .failure(DownloadStoreError.timeout)
        let task = URLSession.shared.downloadTask(with: request) { temporary, response, error in
            defer { semaphore.signal() }
            if let error {
                outcome = .failure(error)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                outcome = .failure(DownloadStoreError.http(0))
                return
            }
            guard (200 ..< 300).contains(http.statusCode), let temporary else {
                outcome = .failure(DownloadStoreError.http(http.statusCode))
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
                try FileManager.default.moveItem(at: temporary, to: destination)
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
        }
        task.resume()
        if semaphore.wait(timeout: .now() + 150) == .timedOut {
            task.cancel()
            throw DownloadStoreError.timeout
        }
        try outcome.get()
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

    private static func failure(_ error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }
}

private enum DownloadStoreError: Error {
    case http(Int)
    case timeout
}

private enum StorageAccessError: Error {
    case appGroupUnavailable

    var code: String {
        switch self {
        case .appGroupUnavailable:
            return "app-group-unavailable"
        }
    }
}
