import AVFoundation
import MediaPlayer

/// A book's narration, streamed from the server: its files one after
/// another, as one recording timed from its start, the way every place in
/// Ribbon is timed (docs/POSITION-FORMAT.md, `ms`). The TV keeps nothing,
/// so nothing is downloaded first (docs/SERVER.md, section 8).
///
/// Apple's queue player plays each file into the next; two are queued at a
/// time, and the next goes on as one ends.
@MainActor
final class BookPlayer {
    struct File {
        let url: URL
        /// Where it starts in the book, and how long it is, as the server measured.
        let startMs: Int
        let durationMs: Int
    }

    /// The moment of the book being played, a few times a second, and once more on every pause.
    var onTime: ((Int) -> Void)?
    /// The last file played to its end.
    var onEnd: (() -> Void)?

    private(set) var playing = false
    private(set) var loaded = false

    private let files: [File]
    private let cookie: HTTPCookie?
    private let player = AVQueuePlayer()
    /// The file each queued item plays.
    private var fileOf: [ObjectIdentifier: Int] = [:]
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?

    init(files: [File], cookie: HTTPCookie?) {
        self.files = files
        self.cookie = cookie
        player.actionAtItemEnd = .advance
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 5), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as? AVPlayerItem
            MainActor.assumeIsolated { self?.ended(item) }
        }
    }

    /// Where the book is now: the file playing, and how far into it.
    var positionMs: Int {
        guard let item = player.currentItem, let file = fileOf[ObjectIdentifier(item)] else { return 0 }
        let seconds = item.currentTime().seconds
        return files[file].startMs + (seconds.isFinite ? Int(seconds * 1000) : 0)
    }

    /// Play from a moment of the book: within the file already playing it seeks, otherwise it queues that file afresh.
    func play(from ms: Int) {
        let target = max(0, ms)
        let file = files.lastIndex { $0.startMs <= target } ?? 0
        let offset = CMTime(value: CMTimeValue(target - files[file].startMs), timescale: 1000)
        if let item = player.currentItem, fileOf[ObjectIdentifier(item)] == file {
            player.seek(to: offset, toleranceBefore: .zero, toleranceAfter: .zero)
        } else {
            player.removeAllItems()
            fileOf = [:]
            enqueue(file)
            enqueue(file + 1)
            player.seek(to: offset, toleranceBefore: .zero, toleranceAfter: .zero)
        }
        loaded = true
        resume()
    }

    func resume() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        playing = true
        nowPlaying()
    }

    func pause() {
        player.pause()
        playing = false
        nowPlaying()
        onTime?(positionMs)
    }

    /// Stop for good: the book is closed.
    func stop() {
        player.pause()
        player.removeAllItems()
        playing = false
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil
        endObserver = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// What the TV's Now Playing shows: the book, and where it is.
    var nowPlayingTitle = ""
    var nowPlayingAuthor = ""

    private func enqueue(_ file: Int) {
        guard files.indices.contains(file) else { return }
        // Apple's player can't send a sign-in header, but it sends the session's cookie.
        let options: [String: Any] = cookie.map { [AVURLAssetHTTPCookiesKey: [$0]] } ?? [:]
        let item = AVPlayerItem(asset: AVURLAsset(url: files[file].url, options: options))
        fileOf[ObjectIdentifier(item)] = file
        player.insert(item, after: nil)
    }

    private func tick() {
        guard playing else { return }
        onTime?(positionMs)
    }

    private func ended(_ item: AVPlayerItem?) {
        guard let item, let file = fileOf.removeValue(forKey: ObjectIdentifier(item)) else { return }
        if file == files.count - 1 {
            playing = false
            onEnd?()
        } else {
            // The next one is playing now; queue the one after it.
            enqueue(file + 2)
        }
    }

    private func nowPlaying() {
        let total = files.last.map { $0.startMs + $0.durationMs } ?? 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: nowPlayingTitle,
            MPMediaItemPropertyArtist: nowPlayingAuthor,
            MPMediaItemPropertyPlaybackDuration: Double(total) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(positionMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
    }
}
