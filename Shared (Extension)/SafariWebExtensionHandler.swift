//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Receives browser.runtime.sendNativeMessage("application.id", …) and
//  writes chapter files. Replies are property-list dictionaries.
//
//  Copyright (c) 2026 libby-downloader contributors.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let message = Self.messageDictionary(from: context)
        let action = message["action"] as? String ?? "unknown"
        let relativePath = message["relativePath"] as? String ?? ""
        os_log(
            .default,
            "Libby Downloader native message action=%{public}@ path=%{public}@",
            action,
            relativePath
        )

        let result = Self.perform(message)
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: result]
        } else {
            response.userInfo = ["message": result]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private static func perform(_ message: [String: Any]) -> [String: Any] {
        let group = DispatchGroup()
        group.enter()
        var result: [String: Any] = ["ok": false, "error": "not-completed"]
        DispatchQueue.global(qos: .userInitiated).async {
            result = DownloadStore.handle(message)
            group.leave()
        }
        if group.wait(timeout: .now() + 180) == .timedOut {
            return ["ok": false, "error": "timeout"]
        }
        return result
    }

    private static func messageDictionary(from context: NSExtensionContext) -> [String: Any] {
        let request = context.inputItems.first as? NSExtensionItem
        if #available(iOS 15.0, macOS 11.0, *),
           let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any] {
            return message
        }
        if let message = request?.userInfo?["message"] as? [String: Any] {
            return message
        }
        return [:]
    }
}
