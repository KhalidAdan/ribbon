import AVFoundation
import MediaPlayer
import UIKit

/// What Listening asks of whatever plays the book: BookPlayer, which streams
/// it from the server, or a stand-in the tests drive, which keeps
/// BookPlayer's rules without its audio (RibbonTests/Support/FakePlayer.swift).
@MainActor
protocol Player: AnyObject {
    var onTime: ((Int) -> Void)? { get set }
    var onEnd: (() -> Void)? { get set }
    var onSystemPause: (() -> Void)? { get set }
    var onSystemResume: (() -> Void)? { get set }
    var loaded: Bool { get }
    var positionMs: Int { get }
    var speed: Double { get set }
    var volume: Float { get set }
    var nowPlayingTitle: String { get set }
    var nowPlayingAuthor: String { get set }
    var nowPlayingChapter: String { get set }
    var nowPlayingCover: UIImage? { get set }
    func play(from ms: Int)
    func resume()
    /// Paused a moment by Ribbon, while a chapter's card shows: to the system it still plays.
    func hold()
    func pause()
    func unload(at ms: Int)
    func stop()
    func updateNowPlaying()
}

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
/// Every file plays at the book's gain (Loudness), so every book is as
/// loud as the last.
///
/// The system can stop it too: a phone call, Siri or an alarm, or the
/// headphones taken out. Apple's player pauses itself then, and says
/// nothing; this says so (`onSystemPause`), so the book is paused in
/// Ribbon too, its place kept, and resumed after a call that asks for it
/// (`onSystemResume`). A file that fails partway, as a stream does when the
/// network drops, is asked for again from the moment it reached, rather
/// than left for the queue to skip to the next file.
///
/// Where it is, is one state, changed in one place (`State`, `next`;
/// docs/STATE-MACHINES.md):
///
/// ```
///  resting ── play from a moment, or on ──▶ playing ── pause ──▶ paused ── on ──▶ playing
///  playing ── hold ──▶ held ── on ──▶ playing          (a chapter's card)
///  playing, held ── the system stops it ──▶ paused     (a call, the headphones going: said, onSystemPause)
///  any ── let go, the last file's end ──▶ resting
/// ```
@MainActor
final class BookPlayer: Player {
    struct File {
        let url: URL
        /// Where it starts in the book, and how long it is, as the server measured.
        let startMs: Int
        let durationMs: Int
    }

    enum State: Equatable {
        /// No file queued, resting at a moment of the book: before anything has played, after a move while paused,
        /// after the book's end, and after a file that couldn't be had again. Playing on asks for the book from there.
        case resting(at: Int)
        /// A file queued, paused.
        case paused
        /// A file queued, playing.
        case playing
        /// A file queued, paused a moment by Ribbon while a chapter's card shows. To the system it still plays, so a
        /// call, or the headphones going, stops it and is said, as it would be while it played.
        case held

        /// Playing, as far as the system is concerned.
        var plays: Bool { self == .playing || self == .held }
    }

    /// What happens to the player: what it's asked to do, and what the system and its files do.
    enum Event {
        case play, resume, pause, hold
        case unload(at: Int)
        /// A call began, or the headphones went: Apple's player has paused itself.
        case systemStop
        /// The last file played to its end.
        case ended(at: Int)
    }

    /// What each event makes of each state; nil when it changes nothing.
    static func next(_ state: State, on event: Event) -> State? {
        switch (state, event) {
        case (_, .play), (_, .resume): return .playing
        case (.playing, .pause), (.held, .pause): return .paused
        case (_, .pause): return nil
        case (.playing, .hold): return .held
        case (_, .hold): return nil
        case (_, .unload(let ms)), (_, .ended(let ms)): return .resting(at: ms)
        case (.playing, .systemStop), (.held, .systemStop): return .paused
        case (_, .systemStop): return nil
        }
    }

    /// The moment of the book being played, a few times a second, and once more on every pause.
    var onTime: ((Int) -> Void)?
    /// The last file played to its end.
    var onEnd: (() -> Void)?
    /// The system paused it: an interruption began, the headphones went, or the stream couldn't be had again.
    var onSystemPause: (() -> Void)?
    /// An interruption ended that asks for the narration to go on, as a phone call does.
    var onSystemResume: (() -> Void)?

    /// Where the player is, changed only by `on`.
    private(set) var state: State = .resting(at: 0)
    var playing: Bool { state == .playing }
    /// Whether a file is queued: anything but resting.
    var loaded: Bool {
        if case .resting = state { return false }
        return true
    }

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
    /// The book's loudness gain, as a factor on each sample.
    private let gain: Float
    private let player = AVQueuePlayer()
    /// The file each queued item plays, and where in the file it begins: an MP3 asked for from a moment begins there.
    private var fileOf: [ObjectIdentifier: Int] = [:]
    private var beginsAt: [ObjectIdentifier: Int] = [:]
    /// Where it was last asked to play from: where it is, until a file says.
    private var askedMs = 0
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var systemObservers: [NSObjectProtocol] = []
    /// The times a failed file was asked for again lately: a network that stays down stops the asking.
    private var retries: [Date] = []

    init(files: [File], cookie: HTTPCookie?, gainDb: Double = 0) {
        self.files = files
        self.cookie = cookie
        gain = Loudness.linear(gainDb)
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

    /// Where the book is now: where it rests, or the file playing and how far into it.
    var positionMs: Int {
        if case .resting(let ms) = state { return ms }
        guard let item = player.currentItem, let file = fileOf[ObjectIdentifier(item)] else { return askedMs }
        let seconds = item.currentTime().seconds
        return files[file].startMs + (beginsAt[ObjectIdentifier(item)] ?? 0) + (seconds.isFinite ? Int(seconds * 1000) : 0)
    }

    /// The one place the state changes. False when the event changes nothing.
    @discardableResult
    private func on(_ event: Event) -> Bool {
        guard let next = Self.next(state, on: event) else { return false }
        state = next
        return true
    }

    /// Play from a moment of the book. An MP3 is asked for from the moment; any other file is sought in,
    /// within the file already playing, or once that file is queued afresh.
    func play(from ms: Int) {
        play(from: ms, afresh: false)
    }

    /// `afresh` queues the file again even when it's the one playing: it failed.
    private func play(from ms: Int, afresh: Bool) {
        let target = max(0, ms)
        askedMs = target
        let file = files.lastIndex { $0.startMs <= target } ?? 0
        let offset = target - files[file].startMs
        if isMP3(file) {
            requeue(from: file, at: offset)
        } else {
            let playing = player.currentItem.flatMap { fileOf[ObjectIdentifier($0)] }
            if afresh || playing != file { requeue(from: file, at: 0) }
            player.seek(to: CMTime(value: CMTimeValue(offset), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        on(.play)
        sound()
    }

    /// Play on from where it is. With no file queued, there's nothing to play on: the book is asked for again, from
    /// where it rests.
    func resume() {
        if case .resting(let ms) = state { return play(from: ms) }
        on(.resume)
        sound()
    }

    /// Apple's player plays, in the audio session a spoken book asks for.
    private func sound() {
        // Played again during an interruption: whatever happens to it after is the person's, not the interruption's to undo.
        interruptedWhilePlaying = false
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.defaultRate = Float(speed)
        player.play()
        updateNowPlaying()
    }

    func pause() {
        on(.pause)
        player.pause()
        updateNowPlaying()
        // Unloaded, there's no file to say where it is.
        if loaded { onTime?(positionMs) }
    }

    func hold() {
        guard on(.hold) else { return }
        player.pause()
        updateNowPlaying()
        onTime?(positionMs)
    }

    /// Let go of the files, keeping the player, resting at a moment: the place moved while paused, so the next play
    /// asks for it afresh.
    func unload(at ms: Int) {
        on(.unload(at: ms))
        player.pause()
        player.removeAllItems()
        fileOf = [:]
        beginsAt = [:]
    }

    /// Stop for good: the book is closed.
    func stop() {
        on(.unload(at: positionMs))
        player.pause()
        player.removeAllItems()
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
        if gain != 1 { bringToLoudness(item) }
        fileOf[ObjectIdentifier(item)] = file
        if isMP3(file) { beginsAt[ObjectIdentifier(item)] = offset }
        player.insert(item, after: nil)
    }

    /// The book's gain on a file, once its sound is known: the asset reads it from the start of the stream, before the
    /// file has much to play.
    private func bringToLoudness(_ item: AVPlayerItem) {
        let gain = gain
        Task { @MainActor in
            guard let track = try? await item.asset.loadTracks(withMediaType: .audio).first else { return }
            item.audioMix = Loudness.mix(for: track, gain: gain)
        }
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

    /// The narration stopped by an interruption and not played since: when the interruption ends, it may ask for the
    /// narration back.
    private var interruptedWhilePlaying = false

    private func interrupted(_ kind: AVAudioSession.InterruptionType?, resumes: Bool) {
        switch kind {
        case .began:
            interruptedWhilePlaying = state.plays
            pausedBySystem()
        case .ended:
            if interruptedWhilePlaying && resumes && !playing { onSystemResume?() }
            interruptedWhilePlaying = false
        default:
            break
        }
    }

    /// Playing, or held for a chapter's card: the system has stopped it, and it says so.
    private func pausedBySystem() {
        guard on(.systemStop) else { return }
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
            // Nothing left queued: it rests at the end, so a pause or a play from here says the end, not the start.
            on(.ended(at: files[file].startMs + files[file].durationMs))
            fileOf = [:]
            beginsAt = [:]
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
