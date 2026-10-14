//
//  DownloadLibrary.swift
//  Shared (App)
//
//  Shows the user where Safari saved audiobooks. iOS copies the app-group
//  folder into Documents so Files and the share sheet can see it.
//
//  Copyright (c) 2026 libby-downloader contributors.
//

import Foundation

enum DownloadLibrary {
    static let appGroupIdentifier = "group.com.libbydownloader.safari"
    static let subdirectory = "libby-downloads"

    static func macOSDownloadsURL() -> URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads", isDirectory: true)
        return downloads.appendingPathComponent(subdirectory, isDirectory: true)
    }

    static func appGroupDownloadsURL() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appendingPathComponent(subdirectory, isDirectory: true)
    }

    /// Copy the app-group library into Documents/libby-downloads for the Files app.
    static func mirrorAppGroupIntoDocuments() -> URL? {
        guard let source = appGroupDownloadsURL(),
              FileManager.default.fileExists(atPath: source.path)
        else {
            return nil
        }
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(subdirectory, isDirectory: true)
        do {
            if FileManager.default.fileExists(atPath: documents.path) {
                try FileManager.default.removeItem(at: documents)
            }
            try FileManager.default.copyItem(at: source, to: documents)
            return documents
        } catch {
            return nil
        }
    }
}
