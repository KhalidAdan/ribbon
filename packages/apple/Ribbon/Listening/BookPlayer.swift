import AVFoundation
import MediaPlayer
import UIKit

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
/// frame (packages/server/src/library/frames.ts), and played from its own 0.
///
/// The system can stop it too: a phone call, Siri or an alarm, or the
/// headphones taken out. Apple's player pauses itself then, and says
/// nothing; this says so (`onSystemPause`), so the book is paused in
/// Ribbon too, its place kept, and resumed after a call that asks for it
/// (`onSystemResume`). A file that fails partway, as a stream does when the
/// network drops, is asked for again from the moment it reached, rather
/// than left for the queue to skip to the next file.
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
    /// The system paused it: an interruption began, the headphones went, or the stream couldn't be had again.
    var onSystemPause: (() -> Void)?
    /// An interruption ended that asks for the narration to go on, as a phone call does.
    var onSystemResume: (() -> Void)?

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
    /// Where it is with no file queued: the start, or where it was let go at.
    private var restingMs = 0
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var systemObservers: [NSObjectProtocol] = []
    /// The times a failed file was asked for again lately: a network that stays down stops the asking.
    private var retries: [Date] = []

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
        watchTheSystem()
    }

    /// Where the book is now: the file playing, and how far into it.
    var positionMs: Int {
        guard let item = player.currentItem, let file = fileOf[ObjectIdentifier(item)] else { return restingMs }
        let seconds = item.currentTime().seconds
        return files[file].startMs + (beginsAt[ObjectIdentifier(item)] ?? 0) + (seconds.isFinite ? Int(seconds * 1000) : 0)
    }

    /// Play from a moment of the book. An MP3 is asked for from the moment; any other file is sought in,
    /// within the file already playing, or once that file is queued afresh.
    func play(from ms: Int) {
        play(from: ms, afresh: false)
    }

    /// `afresh` queues the file again even when it's the one playing: it failed.
    private func play(from ms: Int, afresh: Bool) {
        let target = max(0, ms)
        let file = files.lastIndex { $0.startMs <= target } ?? 0
        let offset = target - files[file].startMs
        if isMP3(file) {
            requeue(from: file, at: offset)
        } else {
            let playing = player.currentItem.flatMap { fileOf[ObjectIdentifier($0)] }
            if afresh || playing != file { requeue(from: file, at: 0) }
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
        // Unloaded, there's no file to say where it is.
        if loaded { onTime?(positionMs) }
    }

    /// Let go of the files, keeping the player, resting at a moment: the place moved while paused, so the next play
    /// asks for it afresh.
    func unload(at ms: Int) {
        restingMs = ms
        player.pause()
        player.removeAllItems()
        fileOf = [:]
        beginsAt = [:]
        playing = false
        loaded = false
    }

    /// Stop for good: the book is closed.
    func stop() {
        player.pause()
        player.removeAllItems()
        playing = false
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        for observer in systemObservers { NotificationCenter.default.removeObserver(observer) }
        timeObserver = nil
        endObserver = nil
        systemObservers = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// What the TV's Now Playing shows: the book, the chapter, and where it is, with the cover once it's here.
    var nowPlayingTitle = ""
    var nowPlayingAuthor = ""
    var nowPlayingChapter = ""
    var nowPlayingCover: UIImage?

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

    /// Interruptions, the headphones going, and a file failing partway: Apple's player stops on its own for each.
    private func watchTheSystem() {
        let center = NotificationCenter.default
        systemObservers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let kind = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated { self?.interrupted(kind, resumes: options.contains(.shouldResume)) }
        })
        systemObservers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            // Headphones out, or a Bluetooth speaker gone: the player has paused rather than play aloud.
            guard reason == .oldDeviceUnavailable else { return }
            MainActor.assumeIsolated { self?.pausedBySystem() }
        })
        systemObservers.append(center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as? AVPlayerItem
            MainActor.assumeIsolated { self?.failed(item) }
        })
    }

    /// The narration stopped by an interruption, and, when it ends, whether it asks for the narration back.
    private var interruptedWhilePlaying = false

    private func interrupted(_ kind: AVAudioSession.InterruptionType?, resumes: Bool) {
        switch kind {
        case .began:
            interruptedWhilePlaying = playing
            pausedBySystem()
        case .ended:
            if interruptedWhilePlaying && resumes && !playing { onSystemResume?() }
            interruptedWhilePlaying = false
        default:
            break
        }
    }

    private func pausedBySystem() {
        guard playing else { return }
        playing = false
        player.pause()
        updateNowPlaying()
        onSystemPause?()
    }

    /// A file failed partway, its stream gone: ask for it again from the moment it reached, a few times a minute at most.
    private func failed(_ item: AVPlayerItem?) {
        guard let item, let file = fileOf[ObjectIdentifier(item)] else { return }
        let seconds = item.currentTime().seconds
        let reached = files[file].startMs + (beginsAt[ObjectIdentifier(item)] ?? 0) + (seconds.isFinite ? Int(seconds * 1000) : 0)
        retries = retries.filter { Date().timeIntervalSince($0) < 60 } + [Date()]
        guard playing, retries.count <= 3 else {
            unload(at: reached)
            onSystemPause?()
            return
        }
        play(from: reached, afresh: true)
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

    /// Tell the TV's Now Playing, and the phone's lock screen, where the book is.
    func updateNowPlaying() {
        let total = files.last.map { $0.startMs + $0.durationMs } ?? 0
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: nowPlayingTitle,
            MPMediaItemPropertyArtist: nowPlayingAuthor,
            MPMediaItemPropertyAlbumTitle: nowPlayingChapter,
            MPMediaItemPropertyPlaybackDuration: Double(total) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(positionMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? speed : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: speed,
        ]
        if let cover = nowPlayingCover {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: cover.size) { _ in cover }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
