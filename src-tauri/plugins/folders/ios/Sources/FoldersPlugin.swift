import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct KeepArgs: Decodable {
  let paths: [String]
}

/// The folders a listener chooses (src/lib.rs says why): the folder itself
/// from the picker, and a bookmark for each, so that iOS gives the access back
/// at the next launch.
class FoldersPlugin: Plugin, UIDocumentPickerDelegate {
  /// Each chosen folder's bookmark, by the path it was chosen at.
  private let bookmarksKey = "ribbon.folders"
  private var picking: Invoke?

  @objc public func pick(_ invoke: Invoke) {
    DispatchQueue.main.async {
      // The folder itself, in place: as a copy, Ribbon would get a copy of every book in it.
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.picking = invoke
      self.manager.viewController?.present(picker, animated: true, completion: nil)
    }
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = picking else { return }
    picking = nil
    guard let url = urls.first else {
      invoke.resolve(["path": nil])
      return
    }
    guard url.startAccessingSecurityScopedResource() else {
      invoke.reject("iOS did not give Ribbon access to that folder")
      return
    }
    do {
      var saved = bookmarks()
      saved[url.path] = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      UserDefaults.standard.set(saved, forKey: bookmarksKey)
      invoke.resolve(["path": url.path])
    } catch {
      invoke.reject("Ribbon could not remember that folder: \(error.localizedDescription)")
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    picking?.resolve(["path": nil])
    picking = nil
  }

  /// At launch, before anything reads them: open every remembered folder again,
  /// and say which are somewhere else now, or out of reach (a share with its
  /// network off). One out of reach keeps its bookmark for next time.
  @objc public func restore(_ invoke: Invoke) {
    var saved = bookmarks()
    var moved: [[String: Any]] = []
    for (was, data) in saved {
      var stale = false
      guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale),
        url.startAccessingSecurityScopedResource()
      else {
        moved.append(["was": was, "now": NSNull()])
        continue
      }
      if stale || url.path != was {
        saved.removeValue(forKey: was)
        if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
          saved[url.path] = fresh
        }
        moved.append(["was": was, "now": url.path])
      }
    }
    UserDefaults.standard.set(saved, forKey: bookmarksKey)
    invoke.resolve(["moved": moved])
  }

  /// The folders still in the library: the bookmarks of the others are let go.
  @objc public func keep(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeepArgs.self)
    let saved = bookmarks().filter { args.paths.contains($0.key) }
    UserDefaults.standard.set(saved, forKey: bookmarksKey)
    invoke.resolve()
  }

  private func bookmarks() -> [String: Data] {
    UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: Data] ?? [:]
  }
}

@_cdecl("init_plugin_folders")
func initPlugin() -> Plugin {
  return FoldersPlugin()
}
