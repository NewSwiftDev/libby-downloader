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

        // Download on a background queue and reply when it finishes.
        // Waiting here blocked the extension's main thread for the whole
        // transfer, and Safari dropped the native message before the file
        // was written.
        DispatchQueue.global(qos: .userInitiated).async {
            let result = DownloadStore.handle(message)
            if let error = result["error"] as? String {
                os_log(
                    .error,
                    "Libby Downloader native result error=%{public}@ detail=%{public}@",
                    error,
                    result["detail"] as? String ?? ""
                )
            } else {
                os_log(
                    .default,
                    "Libby Downloader native result ok path=%{public}@",
                    result["path"] as? String ?? ""
                )
            }
            let response = NSExtensionItem()
            if #available(iOS 15.0, macOS 11.0, *) {
                response.userInfo = [SFExtensionMessageKey: result]
            } else {
                response.userInfo = ["message": result]
            }
            DispatchQueue.main.async {
                context.completeRequest(returningItems: [response], completionHandler: nil)
            }
        }
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
