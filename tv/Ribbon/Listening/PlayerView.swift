import SwiftUI

/// The full player, as the desktop's (src/ui/PlayerPane.tsx), laid out
/// across the TV: where you are as a sentence at the top; the book, the
/// chapter's progress and the transport on the left; what you can change
/// about listening, and the book's chapters, on the right. The focus starts
/// on play; Menu goes back where you came from, and the narration plays on.
struct PlayerView: View {
    @Environment(AppModel.self) private var model
    @State private var chapters = false
    @State private var bookmarks = false
    @FocusState private var playFocused: Bool

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            if let listening = model.listening {
                VStack(alignment: .leading, spacing: 48) {
                    Header(listening: listening)
                    HStack(alignment: .top, spacing: 96) {
                        NowPlaying(listening: listening, playFocused: $playFocused)
                            .frame(width: 660)
                        ScrollView {
                            VStack(alignment: .leading, spacing: 40) {
                                ListeningGroup(listening: listening)
                                ThisBookGroup(listening: listening, chapters: $chapters, bookmarks: $bookmarks)
                            }
                            .padding(24)
                        }
                        .padding(-24)
                        .scrollClipDisabled()
                    }
                }
                .padding(.horizontal, 96)
                .padding(.vertical, 56)
                .defaultFocus($playFocused, true)
                // Come to from the end of the book before, the focus would stay where that card's button was.
                .onAppear { playFocused = true }
                .sheet(isPresented: $chapters) { ChapterSheet(listening: listening) { chapters = false } }
                .sheet(isPresented: $bookmarks) { BookmarkSheet(listening: listening) { bookmarks = false } }
                // Bookmarks made on other devices since.
                .task(id: listening.book.id) { await listening.bookmarks.load() }
            } else {
                Text("Choose a book from your library to start listening.").font(.ui(28)).foregroundStyle(Color.ink2)
            }
        }
    }
}

/// The way back, and where you are, in one sentence beside a rule.
private struct Header: View {
    let listening: Listening

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("Library").foregroundStyle(Color.ink3)
                Text("›").foregroundStyle(Color.ink3)
                Text(listening.book.title).foregroundStyle(Color.ink2)
            }
            .font(.ui(22))
            .lineLimit(1)
            Text(sentence)
                .font(.ui(26)).foregroundStyle(Color.ink).monospacedDigit()
                .padding(.leading, 18)
                .overlay(alignment: .leading) { Rectangle().fill(Color.lineStrong).frame(width: 2) }
        }
    }

    /// "Chapter 4 of 37, 12% through, 9h 40m left at 1.25×."
    private var sentence: String {
        let percent = listening.durationMs > 0 ? listening.positionMs * 100 / listening.durationMs : 0
        let left = Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))
        let where_ = listening.chapters.count > 1 ? "Chapter \(listening.chapterIndex + 1) of \(listening.chapters.count), " : ""
        return "\(where_)\(percent)% through, \(left) left\(listening.speed != 1 ? " at \(Format.speed(listening.speed))" : "")."
    }
}

/// The book in the middle: its cover, title and who wrote and reads it, the chapter's progress, and the transport.
private struct NowPlaying: View {
    let listening: Listening
    var playFocused: FocusState<Bool>.Binding

    var body: some View {
        let book = listening.book
        // The timeline is the chapter: books run ten hours and more, and a whole-book line barely moves.
        let chapter = listening.chapter
        let start = chapter?.startMs ?? 0
        let length = chapter.map { $0.endMs - $0.startMs } ?? listening.durationMs
        let inChapter = min(length, max(0, listening.positionMs - start))
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 36) {
                CoverView(book: book, size: 300)
                VStack(alignment: .leading, spacing: 10) {
                    Text(book.title).font(.ui(36, weight: 600)).foregroundStyle(Color.ink).lineLimit(3)
                    Text("\(book.author.isEmpty ? "Unknown author" : book.author)\(book.narrator.isEmpty ? "" : ", read by \(book.narrator)")").font(.ui(24)).foregroundStyle(Color.ink2).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 12) {
                if let chapter {
                    HStack(alignment: .firstTextBaseline) {
                        Text(chapter.title).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).lineLimit(1)
                        Spacer()
                        Text("-\(Format.duration(Format.atSpeed(length - inChapter, listening.speed)))").font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit()
                    }
                }
                ProgressLine(fraction: length > 0 ? Double(inChapter) / Double(length) : 0).frame(height: 6)
                HStack {
                    Text(Format.duration(inChapter))
                    Spacer()
                    Text(Format.duration(length))
                }
                .font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit()
            }
            .padding(.top, 56)
            HStack(spacing: 36) {
                Button { listening.chapter(by: -1) } label: { Image(systemName: "backward.end.fill") }
                    .buttonStyle(RoundButtonStyle(size: 72))
                Button { listening.skip(by: -30_000) } label: { Image(systemName: "gobackward.30") }
                    .buttonStyle(RoundButtonStyle(size: 80))
                Button { listening.playPause() } label: { Image(systemName: listening.playing ? "pause.fill" : "play.fill") }
                    .buttonStyle(RoundButtonStyle(size: 112, primary: true))
                    .focused(playFocused)
                Button { listening.skip(by: 30_000) } label: { Image(systemName: "goforward.30") }
                    .buttonStyle(RoundButtonStyle(size: 80))
                Button { listening.chapter(by: 1) } label: { Image(systemName: "forward.end.fill") }
                    .buttonStyle(RoundButtonStyle(size: 72))
            }
            .padding(.top, 40)
            if let ms = listening.dozedOffer {
                Offer(words: "You dozed off around \(Format.duration(ms))\(chapterOf(ms).map { ", in chapter \($0 + 1)" } ?? "").", take: "Go back to where you dozed off", action: listening.goBackToDozed, dismiss: listening.dozing.forget)
                    .padding(.top, 28)
            } else if let offer = listening.resumeOffer {
                Offer(words: "You were away for \(Format.away(offer.awayMs)). Start this chapter over?", take: "Start it over", action: listening.restartChapter, dismiss: listening.dismissResumeOffer)
                    .padding(.top, 28)
            } else {
                Text(listening.playing ? " " : "Paused").font(.ui(22)).foregroundStyle(Color.ink3).padding(.top, 20)
            }
        }
    }

    private func chapterOf(_ ms: Int) -> Int? {
        listening.chapters.count > 1 ? listening.chapters.lastIndex { $0.startMs <= ms } : nil
    }
}

/// Something offered on resuming, once, quietly, as the desktop's (src/ui/ResumeOffer.tsx): a line, the way to take
/// it, and Keep going, which lets it go. Down from the transport reaches it.
private struct Offer: View {
    let words: String
    let take: String
    let action: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text(words).font(.ui(22)).foregroundStyle(Color.ink2).multilineTextAlignment(.center).monospacedDigit()
            HStack(spacing: 14) {
                Button(take, action: action).buttonStyle(SmallButtonStyle())
                Button("Keep going", action: dismiss).buttonStyle(SmallButtonStyle())
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.surface))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.line))
    }
}

/// Speed and the sleep timer, as the desktop's Listening group.
private struct ListeningGroup: View {
    let listening: Listening

    var body: some View {
        Rows(label: "Listening") {
            Row(title: "Speed", description: listening.speed != 1 ? "Kept for this book. \(Format.left(Format.atSpeed(listening.durationMs - listening.positionMs, listening.speed))) left at this speed." : "Kept for this book.") {
                HStack(spacing: 18) {
                    Button { listening.setSpeed(listening.speed - Listening.speedStep) } label: { Image(systemName: "minus") }
                        .buttonStyle(RoundButtonStyle(size: 52))
                    Text(Format.speed(listening.speed)).font(.ui(26, weight: 500)).foregroundStyle(Color.ink).frame(width: 90)
                    Button { listening.setSpeed(listening.speed + Listening.speedStep) } label: { Image(systemName: "plus") }
                        .buttonStyle(RoundButtonStyle(size: 52))
                }
            }
            SleepRow(listening: listening)
        }
    }
}

/// The sleep timer as one row: the choices, or what is left with a way to add time or stop (src/ui/SleepControl.tsx).
private struct SleepRow: View {
    let listening: Listening

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Image(systemName: "moon.fill").font(.system(size: 22)).foregroundStyle(listening.sleep == nil ? Color.ink3 : Color.ink)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sleep timer").font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                    // Counting down by the second while it's on.
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        Text(status).font(.ui(22)).foregroundStyle(Color.ink2).monospacedDigit()
                    }
                }
            }
            HStack(spacing: 12) {
                if listening.sleep == nil {
                    ForEach([15, 30, 45, 60], id: \.self) { minutes in
                        Button("\(minutes) min") { listening.sleep(after: minutes) }.buttonStyle(SmallButtonStyle())
                    }
                    Button("End of chapter") { listening.sleepAtChapterEnd() }.buttonStyle(SmallButtonStyle())
                } else {
                    if case .at = listening.sleep {
                        Button("+15 min") { listening.extendSleep(by: 15) }.buttonStyle(SmallButtonStyle())
                    }
                    Button("Turn off") { listening.sleep(after: nil) }.buttonStyle(SmallButtonStyle())
                }
            }
            .padding(.leading, 36)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.raised))
    }

    private var status: String {
        switch listening.sleep {
        case nil: "Fades out, and stops at a chapter's end if you like."
        case .endOfChapter: "At the end of this chapter"
        case .at(let date): "\(Format.duration(Int(max(0, date.timeIntervalSinceNow) * 1000))) left"
        }
    }
}

/// The book's chapters, reading along, and what it says about itself.
private struct ThisBookGroup: View {
    @Environment(AppModel.self) private var model
    let listening: Listening
    @Binding var chapters: Bool
    @Binding var bookmarks: Bool
    @State private var moreAbout = false

    var body: some View {
        let count = listening.chapters.count
        Rows(label: "This book") {
            Button { chapters = true } label: {
                Row(title: "Chapters") { Text(count > 1 ? "\(listening.chapterIndex + 1) of \(count)" : String(count)) }
            }
            .buttonStyle(LiftStyle.row())
            Button { bookmarks = true } label: {
                Row(title: "Bookmarks", description: listening.bookmarks.all.isEmpty ? "Hold Select on the words in Read along to keep them." : nil) { Text(String(listening.bookmarks.all.count)) }
            }
            .buttonStyle(LiftStyle.row())
            if listening.book.ebook {
                Button { Task { await model.readAlong(listening.book) } } label: {
                    Row(title: model.opening == listening.book.id ? "Opening…" : "Read along", description: "The text, with the sentence being read marked.") { Image(systemName: "book") }
                }
                .buttonStyle(LiftStyle.row())
            }
            if let about = listening.detail.book.description, !about.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.2)) { moreAbout.toggle() } } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("About").font(.ui(26, weight: 500)).foregroundStyle(Color.ink)
                        Text(about).font(.ui(22)).foregroundStyle(Color.ink2).lineSpacing(6).lineLimit(moreAbout ? nil : 4).multilineTextAlignment(.leading)
                        Text(moreAbout ? "Less" : "More").font(.ui(20, weight: 500)).foregroundStyle(Color.ink3)
                    }
                    .padding(.horizontal, 22)
                    .padding(.vertical, 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.raised))
                }
                .buttonStyle(LiftStyle.row())
            }
        }
    }
}

/// Every chapter, the one playing marked in amber: choosing one plays from its start.
private struct ChapterSheet: View {
    let listening: Listening
    let onDone: () -> Void
    @FocusState private var focused: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            SectionHeader(title: "Chapters", description: "\(listening.chapters.count) in \(listening.book.title).")
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(Array(listening.chapters.enumerated()), id: \.offset) { index, chapter in
                        let now = index == listening.chapterIndex
                        Button {
                            listening.play(from: chapter.startMs)
                            onDone()
                        } label: {
                            HStack(spacing: 24) {
                                Text(String(index + 1)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit().frame(width: 56, alignment: .trailing)
                                Text(chapter.title).font(.ui(26, weight: now ? 500 : 400)).foregroundStyle(Color.ink).lineLimit(1)
                                Spacer(minLength: 24)
                                Text(Format.duration(chapter.endMs - chapter.startMs)).font(.ui(22)).foregroundStyle(Color.ink3).monospacedDigit()
                            }
                            .padding(.vertical, 16)
                            .padding(.leading, 16)
                            .padding(.trailing, 24)
                            .background(RoundedRectangle(cornerRadius: 12).fill(now ? Color.raised : Color.clear))
                            .overlay(alignment: .leading) {
                                if now { Capsule().fill(Color.place).frame(width: 4).padding(.vertical, 14) }
                            }
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                        .focused($focused, equals: index)
                    }
                }
                .padding(24)
            }
            .padding(-24)
        }
        .padding(64)
        .frame(width: 1100)
        .background(Color.surface.ignoresSafeArea())
        .defaultFocus($focused, listening.chapterIndex)
    }
}

/// The book's bookmarks from every device, in the order of the book, as the desktop lists them
/// (src/ui/BookmarkList.tsx): the words, or the note, with the chapter and the time. Choosing one
/// listens from it; holding Select on one offers to delete it.
private struct BookmarkSheet: View {
    let listening: Listening
    let onDone: () -> Void

    var body: some View {
        let all = listening.bookmarks.all
        VStack(alignment: .leading, spacing: 28) {
            SectionHeader(title: "Bookmarks", description: all.isEmpty ? "None yet. In Read along, hold Select on a sentence to keep it." : "\(all.count) in \(listening.book.title), on every device.")
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(all) { bookmark in
                        Button {
                            if let ms = bookmark.ms { listening.play(from: ms) }
                            onDone()
                        } label: {
                            HStack(alignment: .top, spacing: 20) {
                                Image(systemName: "bookmark.fill").font(.system(size: 20)).foregroundStyle(Color.place).padding(.top, 4)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(words(of: bookmark)).font(.ui(24)).foregroundStyle(Color.ink).lineLimit(3).multilineTextAlignment(.leading)
                                    Text(whereIs(bookmark)).font(.ui(20)).foregroundStyle(Color.ink3).monospacedDigit().lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 16)
                            .padding(.horizontal, 20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(LiftStyle.row(radius: 12))
                        .contextMenu {
                            Button("Delete bookmark", role: .destructive) {
                                Task { try? await listening.bookmarks.remove(bookmark) }
                            }
                        }
                    }
                }
                .padding(24)
            }
            .padding(-24)
        }
        .padding(64)
        .frame(width: 1100)
        .background(Color.surface.ignoresSafeArea())
    }

    /// The words it marks, or its note, or that it's a moment.
    private func words(of bookmark: ServerBookmark) -> String {
        if let quote = bookmark.quote { return "\u{201C}\(quote.replacingOccurrences(of: "\n\n", with: " "))\u{201D}" }
        if !bookmark.note.isEmpty { return bookmark.note }
        return "Bookmark at \(Format.duration(bookmark.ms ?? 0))"
    }

    /// "Chapter II The Council with the Munchkins · 11:03", as the desktop's list says it.
    private func whereIs(_ bookmark: ServerBookmark) -> String {
        guard let ms = bookmark.ms else { return "In the text" }
        let chapter = listening.chapters.last { $0.startMs <= ms }?.title
        return [chapter, Format.duration(ms)].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A small raised button, as the sleep timer's choices are: lit in inverted ink with the focus.
struct SmallButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Lift(configuration: configuration)
    }

    private struct Lift: View {
        let configuration: Configuration
        @Environment(\.isFocused) private var focused

        var body: some View {
            configuration.label
                .font(.ui(22, weight: 500))
                .lineLimit(1)
                .fixedSize()
                .foregroundStyle(focused ? Color.canvas : Color.ink)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(focused ? Color.ink : Color.white.opacity(0.06)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(focused ? Color.clear : Color.line))
                .scaleEffect(configuration.isPressed ? 1.02 : focused ? 1.08 : 1)
                .lifts(focused: focused, pressed: configuration.isPressed)
        }
    }
}
