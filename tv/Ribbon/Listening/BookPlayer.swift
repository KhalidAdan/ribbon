import AVFoundation
import MediaPlayer

/// A book's narration, streamed from the server: its files one after
/// another, as one recording timed from its start, the way every place in
/// Ribbon is timed (docs/POSITION-FORMAT.md, `ms`). The TV keeps nothing,
/// so nothing is downloaded first (docs/SERVER.md, section 8).
///
/// Apple's queue player plays each file into the next; two are queued at a
/// time, and the next goes on as one ends.
///
/// An MP3 is never sought in: Apple's player seeks in one with no seek table
/// by its average bitrate, minutes off in a long VBR book. It's asked of the
/// server from the moment instead, which sends it from that moment's own
/// frame (server/src/library/frames.ts), and played from its own 0.
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

    /// How fast the narrator reads, with the voice's pitch kept.
    var speed: Double = 1 {
        didSet {
            player.defaultRate = Float(speed)
            if playing { player.rate = Float(speed) }
        }
    }

    /// How loud, 0 to 1: the sleep timer fades it out.
    var volume: Float {
        get { player.volume }
        set { player.volume = newValue }
    }

    private let files: [File]
    private let cookie: HTTPCookie?
    private let player = AVQueuePlayer()
    /// The file each queued item plays, and where in the file it begins: an MP3 asked for from a moment begins there.
    private var fileOf: [ObjectIdentifier: Int] = [:]
    private var beginsAt: [ObjectIdentifier: Int] = [:]
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
        return files[file].startMs + (beginsAt[ObjectIdentifier(item)] ?? 0) + (seconds.isFinite ? Int(seconds * 1000) : 0)
    }

    /// Play from a moment of the book. An MP3 is asked for from the moment; any other file is sought in,
    /// within the file already playing, or once that file is queued afresh.
    func play(from ms: Int) {
        let target = max(0, ms)
        let file = files.lastIndex { $0.startMs <= target } ?? 0
        let offset = target - files[file].startMs
        if isMP3(file) {
            requeue(from: file, at: offset)
        } else {
            let playing = player.currentItem.flatMap { fileOf[ObjectIdentifier($0)] }
            if playing != file { requeue(from: file, at: 0) }
            player.seek(to: CMTime(value: CMTimeValue(offset), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        loaded = true
        resume()
    }

    func resume() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.defaultRate = Float(speed)
        player.play()
        playing = true
        updateNowPlaying()
    }

    func pause() {
        player.pause()
        playing = false
        updateNowPlaying()
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

    /// What the TV's Now Playing shows: the book, the chapter, and where it is.
    var nowPlayingTitle = ""
    var nowPlayingAuthor = ""
    var nowPlayingChapter = ""

    /// The queue made again: this file, from a moment of it, then the next.
    private func requeue(from file: Int, at offset: Int) {
        player.removeAllItems()
        fileOf = [:]
        beginsAt = [:]
        enqueue(file, from: offset)
        enqueue(file + 1)
    }

    private func isMP3(_ file: Int) -> Bool {
        files[file].url.pathExtension.lowercased() == "mp3"
    }

    private func enqueue(_ file: Int, from offset: Int = 0) {
        guard files.indices.contains(file) else { return }
        var url = files[file].url
        if offset > 0 && isMP3(file) { url.append(queryItems: [URLQueryItem(name: "ms", value: String(offset))]) }
        // Apple's player can't send a sign-in header, but it sends the session's cookie.
        let options: [String: Any] = cookie.map { [AVURLAssetHTTPCookiesKey: [$0]] } ?? [:]
        let item = AVPlayerItem(asset: AVURLAsset(url: url, options: options))
        // A voice sped up or slowed down, without the chipmunk.
        item.audioTimePitchAlgorithm = .timeDomain
        fileOf[ObjectIdentifier(item)] = file
        if isMP3(file) { beginsAt[ObjectIdentifier(item)] = offset }
        player.insert(item, after: nil)
    }

    private func tick() {
        guard playing else { return }
        onTime?(positionMs)
    }

    private func ended(_ item: AVPlayerItem?) {
        guard let item, let file = fileOf.removeValue(forKey: ObjectIdentifier(item)) else { return }
        beginsAt[ObjectIdentifier(item)] = nil
        if file == files.count - 1 {
            playing = false
            onEnd?()
        } else {
            // The next one is playing now; queue the one after it.
            enqueue(file + 2)
        }
    }

    /// Tell the TV's Now Playing where the book is.
    func updateNowPlaying() {
        let total = files.last.map { $0.startMs + $0.durationMs } ?? 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: nowPlayingTitle,
            MPMediaItemPropertyArtist: nowPlayingAuthor,
            MPMediaItemPropertyAlbumTitle: nowPlayingChapter,
            MPMediaItemPropertyPlaybackDuration: Double(total) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(positionMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? speed : 0.0,
        ]
    }
}
